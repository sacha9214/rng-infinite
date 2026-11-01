// Connexion directe à Redis (protocole RESP), sans le relais HTTP Python (demandé par Sacha, 2026-11-01 : « le plus
// fluide possible »). Mesuré sur le VPS le 2026-11-01 : chaque appel passait par le relais, qui ouvrait un fil et une
// connexion Redis neufs à chaque fois (143 millions de connexions en 38 jours), avec deux encodages JSON de plus ;
// 1 ms par appel au calme, 7 ms dès que 20 appels arrivent ensemble, et un tirage en fait une dizaine.
// Ici : quelques connexions gardées ouvertes, plusieurs pipelines à la suite sur chacune (Redis répond dans l'ordre).
// Les réponses ont exactement la forme de celles du relais (deploy/ovh/redis-relay.py) : { result } ou { error } par
// commande, entiers en nombres, chaînes en texte, null pour l'absent ; une erreur dans un tableau devient son texte.
// Aucune dépendance (Node seul). Utilisé seulement si RNG_REDIS_DIRECT est posé (le serveur du VPS le pose).
'use strict';
const net = require('node:net');

const POOL = 4, TIMEOUT_MS = 10000;
// Mêmes refus que le relais : un bug ne doit jamais pouvoir vider la base.
const DENY = new Set(['FLUSHALL', 'FLUSHDB', 'CONFIG', 'SHUTDOWN', 'DEBUG', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'REPLICAOF', 'SLAVEOF',
  'MODULE', 'ACL', 'MIGRATE', 'SCRIPT', 'EVAL', 'EVALSHA', 'FUNCTION', 'FCALL', 'MONITOR', 'SYNC', 'PSYNC', 'CLIENT']);

// Lecteur RESP2 qu'on peut reprendre : une grosse réponse (100 000 tirages d'un historique) arrive en des dizaines de
// morceaux, et chaque morceau n'est lu qu'une fois (les tableaux en cours restent sur la pile).
class Reader {
  constructor() { this.buf = Buffer.alloc(0); this.pos = 0; this.stack = []; }
  push(chunk) { this.buf = this.pos >= this.buf.length ? chunk : Buffer.concat([this.buf.subarray(this.pos), chunk]); this.pos = 0; }
  // Une réponse de premier niveau complète ({ result } ou { error }), ou undefined s'il faut attendre la suite.
  next() {
    for (;;) {
      const v = this.value();
      if (v === undefined) return undefined;
      let item = v;
      // Remonte la pile tant que les tableaux en cours se remplissent.
      for (;;) {
        const top = this.stack[this.stack.length - 1];
        if (!top) return item; // réponse de premier niveau
        top.items.push(item.error !== undefined ? item.error : item.result);
        if (top.items.length < top.n) break;
        this.stack.pop();
        item = { result: top.items };
      }
    }
  }
  // Une valeur simple lue, { open } pour un tableau ouvert (empilé), ou undefined si incomplète.
  value() {
    for (;;) {
      const end = this.buf.indexOf(13, this.pos); // \r
      if (end < 0 || end + 1 >= this.buf.length) return undefined;
      const kind = this.buf[this.pos], line = this.buf.toString('utf8', this.pos + 1, end), after = end + 2;
      if (kind === 43) { this.pos = after; return { result: line }; } // +
      if (kind === 45) { this.pos = after; return { error: line }; } // -
      if (kind === 58) { this.pos = after; return { result: Number(line) }; } // :
      if (kind === 36) { // $
        const n = Number(line);
        if (n < 0) { this.pos = after; return { result: null }; }
        if (after + n + 2 > this.buf.length) return undefined;
        this.pos = after + n + 2;
        return { result: this.buf.toString('utf8', after, after + n) };
      }
      if (kind === 42) { // *
        const n = Number(line);
        this.pos = after;
        if (n < 0) return { result: null };
        if (n === 0) return { result: [] };
        this.stack.push({ n, items: [] });
        continue; // lit le premier élément
      }
      throw new Error(`Unexpected RESP reply ${String.fromCharCode(kind)}`);
    }
  }
}

const encode = commands => {
  let out = '';
  for (const cmd of commands) {
    out += `*${cmd.length}\r\n`;
    for (const a of cmd) { const s = String(a); out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
  }
  return out;
};

class Conn {
  constructor(host, port) {
    this.queue = []; // pipelines envoyés, dans l'ordre : { left, results, resolve, reject, timer }
    this.pending = 0; // commandes en attente (pour choisir la connexion la moins chargée)
    this.dead = false;
    this.reader = new Reader();
    this.ready = new Promise((resolve, reject) => {
      this.sock = net.createConnection({ host, port }, resolve);
      this.sock.once('error', reject);
    });
    this.sock.setNoDelay(true);
    this.sock.setKeepAlive(true, 30000);
    this.sock.on('data', chunk => this.onData(chunk));
    this.sock.on('error', err => this.fail(err));
    this.sock.on('close', () => this.fail(new Error('Redis closed the connection')));
  }
  onData(chunk) {
    this.reader.push(chunk);
    try {
      for (let r = this.reader.next(); r !== undefined; r = this.reader.next()) {
        const p = this.queue[0];
        if (!p) throw new Error('Unexpected reply from Redis');
        p.results.push(r);
        this.pending--;
        if (--p.left === 0) { this.queue.shift(); clearTimeout(p.timer); p.resolve(p.results); }
      }
    } catch (err) { this.fail(err); this.sock.destroy(); }
  }
  // Connexion perdue ou réponse illisible : tout ce qui attend échoue (impossible de savoir ce que Redis a fait), et
  // la connexion est remplacée au prochain appel.
  fail(err) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.queue.splice(0)) { clearTimeout(p.timer); p.reject(err); }
    this.pending = 0;
  }
  send(commands) {
    return new Promise((resolve, reject) => {
      const p = { left: commands.length, results: [], resolve, reject };
      // Pas de réponse à temps : la connexion est fermée (les réponses suivantes seraient décalées).
      p.timer = setTimeout(() => { const e = new Error('Redis timeout'); this.fail(e); this.sock.destroy(); }, TIMEOUT_MS);
      this.queue.push(p);
      this.pending += commands.length;
      this.sock.write(encode(commands));
    });
  }
}

function createClient(address) {
  const [host, port] = String(address).replace(/^redis:\/\//, '').split(':');
  const conns = [];
  // Connexion la moins chargée, ouverte au besoin (jusqu'à POOL) ; une connexion qui n'a jamais pu s'ouvrir lève
  // l'erreur avec unsent: true (rien n'a été envoyé : l'appelant peut passer par le relais sans risque de doublon).
  async function pick() {
    for (let i = conns.length - 1; i >= 0; i--) if (conns[i].dead) conns.splice(i, 1);
    const idle = conns.find(c => c.pending === 0);
    let c = idle || (conns.length < POOL ? null : conns.reduce((a, b) => (b.pending < a.pending ? b : a)));
    if (!c) { c = new Conn(host || '127.0.0.1', Number(port) || 6379); conns.push(c); }
    try { await c.ready; } catch (err) { c.dead = true; throw Object.assign(err, { unsent: true }); }
    if (c.dead) throw Object.assign(new Error('Redis connection lost'), { unsent: true });
    return c;
  }
  return {
    // Même contrat que le relais : un tableau de { result } / { error }, une entrée par commande.
    async pipeline(commands) {
      if (!commands.length) return [];
      if (commands.some(c => DENY.has(String(c[0]).toUpperCase()))) throw Object.assign(new Error('Command not allowed'), { unsent: true });
      return (await pick()).send(commands);
    },
    close() { for (const c of conns) c.sock.destroy(); conns.length = 0; },
  };
}

module.exports = { createClient, Reader, encode };
