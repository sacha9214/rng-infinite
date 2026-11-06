// Règles des échecs du casino (demandé par Sacha, 2026-11-06 : « can you add a chess game in the casino where we can
// bet our money with bot or against player? »). Module partagé, comme js/engine.js : window.RNGChess dans le navigateur
// (cases jouables, bot d'entraînement), module.exports pour l'API (api/_chess.js vérifie chaque coup et décide la fin).
// Plateau : tableau de 64 cases, case = rangée * 8 + colonne, a1 = 0, h8 = 63. Pièces en lettres FEN (PNBRQK blanches,
// pnbrqk noires), '' = case vide. Une position = { b, turn: 'w' | 'b', castle: 'KQkq', ep: case ou -1, half, full }.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RNGChess = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const FILES = 'abcdefgh';
  const sqName = s => FILES[s & 7] + ((s >> 3) + 1);
  const sqOf = n => (/^[a-h][1-8]$/.test(n) ? FILES.indexOf(n[0]) + 8 * (Number(n[1]) - 1) : -1);
  const isWhite = p => p !== '' && p === p.toUpperCase();
  const colorOf = p => (p === '' ? '' : isWhite(p) ? 'w' : 'b');
  const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KG = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]], LINE = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // Cases voisines précalculées : saut de cavalier ou de roi, et rayons des pièces à longue portée.
  const jumps = offs => Array.from({ length: 64 }, (_, s) => offs.map(([df, dr]) => [(s & 7) + df, (s >> 3) + dr]).filter(([f, r]) => f >= 0 && f < 8 && r >= 0 && r < 8).map(([f, r]) => r * 8 + f));
  const rays = dirs => Array.from({ length: 64 }, (_, s) => dirs.map(([df, dr]) => { const out = []; let f = (s & 7) + df, r = (s >> 3) + dr; while (f >= 0 && f < 8 && r >= 0 && r < 8) { out.push(r * 8 + f); f += df; r += dr; } return out; }).filter(x => x.length));
  const N_TO = jumps(KN), K_TO = jumps(KG), D_RAYS = rays(DIAG), L_RAYS = rays(LINE);

  // ---------------------------------------------------------------- FEN
  function parse(fen) {
    const [place, turn, castle, ep, half, full] = String(fen || START).trim().split(/\s+/);
    const b = new Array(64).fill('');
    const rows = (place || '').split('/');
    if (rows.length !== 8) throw new Error('Bad FEN');
    rows.forEach((row, k) => {
      let f = 0;
      for (const ch of row) {
        if (/[1-8]/.test(ch)) f += Number(ch);
        else if (/[pnbrqkPNBRQK]/.test(ch) && f < 8) b[(7 - k) * 8 + f++] = ch;
        else throw new Error('Bad FEN');
      }
      if (f !== 8) throw new Error('Bad FEN');
    });
    return { b, turn: turn === 'b' ? 'b' : 'w', castle: castle && castle !== '-' ? castle : '', ep: ep && ep !== '-' ? sqOf(ep) : -1, half: Number(half) || 0, full: Number(full) || 1 };
  }
  function fen(s) {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = '', gap = 0;
      for (let f = 0; f < 8; f++) { const p = s.b[r * 8 + f]; if (!p) gap++; else { if (gap) row += gap; gap = 0; row += p; } }
      rows.push(row + (gap || ''));
    }
    return `${rows.join('/')} ${s.turn} ${s.castle || '-'} ${s.ep >= 0 ? sqName(s.ep) : '-'} ${s.half} ${s.full}`;
  }

  // ---------------------------------------------------------------- attaques
  // La case s est-elle attaquée par le camp `by` ('w' ou 'b') ?
  function attacked(b, s, by) {
    const w = by === 'w';
    const pawn = w ? 'P' : 'p', knight = w ? 'N' : 'n', king = w ? 'K' : 'k';
    const bish = w ? 'B' : 'b', rook = w ? 'R' : 'r', queen = w ? 'Q' : 'q';
    const f = s & 7, r = s >> 3;
    const pr = w ? r - 1 : r + 1; // un pion blanc attaque vers le haut : il est une rangée plus bas
    if (pr >= 0 && pr < 8) { if (f > 0 && b[pr * 8 + f - 1] === pawn) return true; if (f < 7 && b[pr * 8 + f + 1] === pawn) return true; }
    for (const t of N_TO[s]) if (b[t] === knight) return true;
    for (const t of K_TO[s]) if (b[t] === king) return true;
    for (const ray of D_RAYS[s]) for (const t of ray) { const p = b[t]; if (p) { if (p === bish || p === queen) return true; break; } }
    for (const ray of L_RAYS[s]) for (const t of ray) { const p = b[t]; if (p) { if (p === rook || p === queen) return true; break; } }
    return false;
  }
  const kingSq = (b, c) => b.indexOf(c === 'w' ? 'K' : 'k');
  const inCheck = (s, c = s.turn) => { const k = kingSq(s.b, c); return k >= 0 && attacked(s.b, k, c === 'w' ? 'b' : 'w'); };

  // ---------------------------------------------------------------- coups
  // Coup : { from, to, p: pièce, x: pièce prise ('' sinon), promo: 'q'|'r'|'b'|'n' (en minuscule), ep, castle }.
  function pseudo(s) {
    const b = s.b, me = s.turn, out = [], them = me === 'w' ? 'b' : 'w';
    const add = (from, to, extra) => out.push({ from, to, p: b[from], x: b[to], ...extra });
    for (let from = 0; from < 64; from++) {
      const p = b[from];
      if (!p || colorOf(p) !== me) continue;
      const k = p.toLowerCase();
      if (k === 'p') {
        const dir = me === 'w' ? 8 : -8, r = from >> 3, f = from & 7, last = me === 'w' ? 6 : 1, home = me === 'w' ? 1 : 6;
        const push = (to, x, extra) => { if (r === last) for (const promo of ['q', 'r', 'b', 'n']) out.push({ from, to, p, x, promo, ...extra }); else out.push({ from, to, p, x, ...extra }); };
        const one = from + dir;
        if (!b[one]) { push(one, ''); if (r === home && !b[one + dir]) out.push({ from, to: one + dir, p, x: '' }); }
        for (const df of [-1, 1]) {
          if (f + df < 0 || f + df > 7) continue;
          const to = one + df;
          if (b[to] && colorOf(b[to]) === them) push(to, b[to]);
          else if (to === s.ep) out.push({ from, to, p, x: me === 'w' ? 'p' : 'P', ep: true });
        }
      } else if (k === 'n' || k === 'k') {
        for (const to of (k === 'n' ? N_TO : K_TO)[from]) if (colorOf(b[to]) !== me) add(from, to);
        if (k === 'k') {
          const base = me === 'w' ? 0 : 56, rights = me === 'w' ? ['K', 'Q'] : ['k', 'q'];
          if (from === base + 4 && !attacked(b, from, them)) {
            if (s.castle.includes(rights[0]) && b[base + 7] === (me === 'w' ? 'R' : 'r') && !b[base + 5] && !b[base + 6] && !attacked(b, base + 5, them) && !attacked(b, base + 6, them)) add(from, base + 6, { castle: 'k' });
            if (s.castle.includes(rights[1]) && b[base] === (me === 'w' ? 'R' : 'r') && !b[base + 1] && !b[base + 2] && !b[base + 3] && !attacked(b, base + 3, them) && !attacked(b, base + 2, them)) add(from, base + 2, { castle: 'q' });
          }
        }
      } else {
        const all = k === 'b' ? D_RAYS[from] : k === 'r' ? L_RAYS[from] : D_RAYS[from].concat(L_RAYS[from]);
        for (const ray of all) for (const to of ray) { const q = b[to]; if (!q) add(from, to); else { if (colorOf(q) !== me) add(from, to); break; } }
      }
    }
    return out;
  }
  // Position après un coup (sans vérifier qu'il est légal). Ne modifie jamais `s`.
  function apply(s, m) {
    const b = s.b.slice(), me = s.turn, w = me === 'w';
    b[m.to] = m.promo ? (w ? m.promo.toUpperCase() : m.promo) : m.p;
    b[m.from] = '';
    if (m.ep) b[m.to + (w ? -8 : 8)] = '';
    if (m.castle) { const base = w ? 0 : 56; if (m.castle === 'k') { b[base + 5] = b[base + 7]; b[base + 7] = ''; } else { b[base + 3] = b[base]; b[base] = ''; } }
    let castle = s.castle;
    if (castle) {
      const drop = sq => { if (sq === 4) castle = castle.replace(/[KQ]/g, ''); else if (sq === 60) castle = castle.replace(/[kq]/g, ''); else if (sq === 0) castle = castle.replace('Q', ''); else if (sq === 7) castle = castle.replace('K', ''); else if (sq === 56) castle = castle.replace('q', ''); else if (sq === 63) castle = castle.replace('k', ''); };
      drop(m.from); drop(m.to);
    }
    const pawn = m.p === 'P' || m.p === 'p';
    return { b, turn: w ? 'b' : 'w', castle, ep: pawn && Math.abs(m.to - m.from) === 16 ? (m.from + m.to) / 2 : -1, half: pawn || m.x ? 0 : s.half + 1, full: s.full + (w ? 0 : 1) };
  }
  function moves(s) {
    const me = s.turn, them = me === 'w' ? 'b' : 'w';
    return pseudo(s).filter(m => { const n = apply(s, m); const k = kingSq(n.b, me); return k >= 0 && !attacked(n.b, k, them); });
  }
  const uci = m => sqName(m.from) + sqName(m.to) + (m.promo || '');
  // Coup venu du site, en notation « e2e4 » / « e7e8q » : le coup légal correspondant, ou null.
  function find(s, text) {
    const t = String(text || '').toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(t)) return null;
    return moves(s).find(m => uci(m) === t) || null;
  }

  // ---------------------------------------------------------------- notation (SAN) pour la liste des coups
  function san(s, m, all = moves(s)) {
    let out;
    if (m.castle) out = m.castle === 'k' ? 'O-O' : 'O-O-O';
    else {
      const k = m.p.toUpperCase();
      if (k === 'P') out = (m.x ? FILES[m.from & 7] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo.toUpperCase() : '');
      else {
        const rivals = all.filter(o => o.p === m.p && o.to === m.to && o.from !== m.from);
        let dis = '';
        if (rivals.length) {
          if (!rivals.some(o => (o.from & 7) === (m.from & 7))) dis = FILES[m.from & 7];
          else if (!rivals.some(o => (o.from >> 3) === (m.from >> 3))) dis = String((m.from >> 3) + 1);
          else dis = sqName(m.from);
        }
        out = k + dis + (m.x ? 'x' : '') + sqName(m.to);
      }
    }
    const n = apply(s, m);
    if (inCheck(n)) out += moves(n).length ? '+' : '#';
    return out;
  }

  // ---------------------------------------------------------------- fin de partie
  // Clé de répétition : pièces, trait, roques, et la prise en passant seulement si elle est vraiment jouable.
  function posKey(s) {
    const epReal = s.ep >= 0 && moves(s).some(m => m.ep);
    return `${s.b.map(p => p || '.').join('')}${s.turn}${s.castle}${epReal ? s.ep : ''}`;
  }
  // Matériel insuffisant pour mater, des deux côtés : roi seul, roi + une pièce mineure, ou rois + fous tous sur la
  // même couleur de case.
  function deadDraw(b) {
    const rest = [];
    for (let s = 0; s < 64; s++) if (b[s] && b[s] !== 'K' && b[s] !== 'k') rest.push([b[s].toLowerCase(), s]);
    if (!rest.length) return true;
    if (rest.length === 1 && (rest[0][0] === 'n' || rest[0][0] === 'b')) return true;
    if (rest.every(([p]) => p === 'b')) { const shade = ([, s]) => ((s >> 3) + (s & 7)) % 2; return rest.every(x => shade(x) === shade(rest[0])); }
    return false;
  }
  // Après une chute du drapeau : le camp `c` peut-il encore mater ? Non s'il n'a que son roi, ou un roi et une seule
  // pièce mineure contre un roi seul (règle simplifiée des sites d'échecs : la partie est alors nulle).
  function canMate(b, c) {
    const mine = [], theirs = [];
    for (let s = 0; s < 64; s++) { const p = b[s]; if (!p || p.toLowerCase() === 'k') continue; (colorOf(p) === c ? mine : theirs).push(p.toLowerCase()); }
    if (!mine.length) return false;
    if (mine.length === 1 && (mine[0] === 'n' || mine[0] === 'b') && !theirs.length) return false;
    return true;
  }
  // État de la partie : keys = clés de répétition de toutes les positions déjà jouées (celle-ci comprise).
  // { over: false } ou { over: true, winner: 'w' | 'b' | null, reason: 'mate' | 'stalemate' | 'material' | 'fifty' | 'repetition' }
  function status(s, keys = []) {
    if (!moves(s).length) return inCheck(s) ? { over: true, winner: s.turn === 'w' ? 'b' : 'w', reason: 'mate' } : { over: true, winner: null, reason: 'stalemate' };
    if (deadDraw(s.b)) return { over: true, winner: null, reason: 'material' };
    if (s.half >= 100) return { over: true, winner: null, reason: 'fifty' };
    if (keys.length) { const k = keys[keys.length - 1]; if (keys.filter(x => x === k).length >= 3) return { over: true, winner: null, reason: 'repetition' }; }
    return { over: false };
  }
  // Joue une suite de coups « e2e4 » depuis le départ : position finale, clés, notations. null si un coup est illégal.
  function replay(list, from = START) {
    let s = parse(from);
    const keys = [posKey(s)], sans = [];
    for (const t of list) {
      const all = moves(s), m = all.find(x => uci(x) === t);
      if (!m) return null;
      sans.push(san(s, m, all)); s = apply(s, m); keys.push(posKey(s));
    }
    return { s, keys, sans };
  }
  function perft(s, depth) {
    if (!depth) return 1;
    const all = moves(s);
    if (depth === 1) return all.length;
    let n = 0;
    for (const m of all) n += perft(apply(s, m), depth - 1);
    return n;
  }

  // ---------------------------------------------------------------- bot d'entraînement (sans pièces : jamais de mise)
  // Recherche alpha-bêta avec tables de cases (valeurs classiques de Tomasz Michniewski), quiescence sur les prises.
  // Trois niveaux : Easy fait des fautes (bruit de ±1,5 pion), Medium voit 2 coups, Hard cherche ~0,8 s.
  const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  /* eslint-disable array-element-newline */
  const PST = {
    p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
    e: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
  };
  // Note de la position pour le camp au trait (en centièmes de pion). Les tables sont écrites rangée 8 en haut.
  function evaluate(s) {
    const b = s.b;
    let minor = 0, queens = 0;
    for (let i = 0; i < 64; i++) { const p = b[i].toLowerCase(); if (p === 'q') queens++; else if (p === 'n' || p === 'b' || p === 'r') minor++; }
    const endgame = !queens || minor <= 2;
    let score = 0;
    for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (!p) continue;
      const k = p.toLowerCase(), w = p !== k, r = i >> 3, f = i & 7;
      const t = w ? (7 - r) * 8 + f : r * 8 + f;
      const v = VAL[k] + (k === 'k' ? (endgame ? PST.e : PST.k)[t] : PST[k][t]);
      score += w ? v : -v;
    }
    return s.turn === 'w' ? score : -score;
  }
  const MATE = 100000;
  const order = all => all.sort((a, c) => ((c.x ? 10 * VAL[c.x.toLowerCase()] - VAL[c.p.toLowerCase()] / 10 : 0) + (c.promo ? 800 : 0)) - ((a.x ? 10 * VAL[a.x.toLowerCase()] - VAL[a.p.toLowerCase()] / 10 : 0) + (a.promo ? 800 : 0)));
  function bestMove(s, level = 2, rand = Math.random, keys = []) {
    const all = moves(s);
    if (!all.length) return null;
    const cfg = level <= 1 ? { depth: 1, noise: 150, ms: 0 } : level === 2 ? { depth: 2, noise: 25, ms: 0 } : { depth: 6, noise: 4, ms: 800 };
    const t0 = Date.now(), seen = new Set(keys.slice(-12));
    let nodes = 0, stop = false;
    const out = () => { if (cfg.ms && (++nodes & 1023) === 0 && Date.now() - t0 > cfg.ms) stop = true; return stop; };
    function quiesce(p, alpha, beta, qd) {
      const stand = evaluate(p);
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      if (qd > 6) return alpha;
      for (const m of order(moves(p).filter(x => x.x || x.promo))) {
        const v = -quiesce(apply(p, m), -beta, -alpha, qd + 1);
        if (v >= beta) return v;
        if (v > alpha) alpha = v;
        if (out()) break;
      }
      return alpha;
    }
    function search(p, depth, alpha, beta, ply) {
      if (out()) return 0;
      const list = moves(p);
      if (!list.length) return inCheck(p) ? -MATE + ply : 0;
      if (p.half >= 100 || deadDraw(p.b)) return 0;
      if (depth <= 0) return quiesce(p, alpha, beta, 0);
      let best = -Infinity;
      for (const m of order(list)) {
        const v = -search(apply(p, m), depth - 1, -beta, -alpha, ply + 1);
        if (v > best) best = v;
        if (v > alpha) alpha = v;
        if (alpha >= beta || stop) break;
      }
      return best;
    }
    let scored = all.map(m => ({ m, v: 0 }));
    for (let depth = 1; depth <= cfg.depth; depth++) {
      const round = [];
      for (const x of scored) {
        const n = apply(s, x.m);
        let v = -search(n, depth - 1, -Infinity, Infinity, 1);
        if (stop) break;
        if (seen.has(posKey(n)) && v > -200) v -= 30; // évite de répéter quand il est devant
        round.push({ m: x.m, v });
      }
      if (round.length < scored.length) break; // coupé par le temps : on garde la profondeur précédente
      scored = round.sort((a, c) => c.v - a.v);
      if (Math.abs(scored[0].v) > MATE - 100 || (cfg.ms && Date.now() - t0 > cfg.ms / 2)) break;
    }
    let pick = scored[0], top = -Infinity;
    for (const x of scored) { const v = x.v + (rand() * 2 - 1) * cfg.noise; if (v > top) { top = v; pick = x; } }
    return pick.m;
  }

  return { START, parse, fen, moves, apply, find, uci, san, inCheck, attacked, status, posKey, replay, perft, deadDraw, canMate, bestMove, evaluate, sqName, sqOf, colorOf };
}));
