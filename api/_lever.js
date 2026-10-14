// Trading à effet de levier sur la crypto du casino (onglet Crypto, demandé par Sacha le 2026-10-14) : on parie à la
// hausse (long) ou à la baisse (short) avec 2×, 3× ou 5× sa mise, au vrai prix (api/_btc.js). Comme sur une vraie
// plateforme : frais de 0,1 % de la position à l'ouverture et à la fermeture, liquidation quand la perte atteint 95 %
// de la mise (le joueur ne peut jamais perdre plus que sa mise), stop loss et take profit facultatifs.
// Positions ouvertes : hash pos:<id> (identifiant de position → JSON) et index pos:open (« joueur:position ») que le
// serveur relit toutes les 15 s (deploy/ovh/api-server.js) et à chaque affichage, pour fermer ce qui doit l'être.
// Fermer = HDEL (répond 1 une seule fois) : une position n'est jamais payée deux fois, même fermée de deux côtés.
const crypto = require('node:crypto');
const { redis, statsKey, readStats } = require('./_lib');
const Shop = require('../js/shop.js');
const Btc = require('./_btc');

const LEVERAGES = [2, 3, 5], FEE = 0.001, MAINTENANCE = 0.05, MIN_MARGIN = 10, MAX_MARGIN = 10000, MAX_OPEN = 5, MIN_ROLLS = 30;
const posKey = id => `pos:${id}`, OPEN = 'pos:open', histKey = id => `posh:${id}`, HIST_KEEP = 20;
const refuse = (status, error) => Object.assign(new Error(error), { status });
const dir = p => (p.side === 'short' ? -1 : 1);

// Ce que vaut la position au prix P (frais d'ouverture et de fermeture déduits) ; 0 au pire.
const equity = (p, P) => p.m + p.m * p.lev * dir(p) * (P / p.entry - 1) - p.m * p.lev * FEE * 2;
// Prix de liquidation : là où il ne reste que 5 % de la mise.
const liqPrice = p => p.entry * (1 - dir(p) * (1 - MAINTENANCE - p.lev * FEE * 2) / p.lev);
const round = v => Math.round(v * 100) / 100;

// Pourquoi la position doit être fermée au prix P, ou null.
function trigger(p, P) {
  const long = p.side !== 'short';
  if (long ? P <= p.liq : P >= p.liq) return 'liquidated';
  if (p.sl && (long ? P <= p.sl : P >= p.sl)) return 'stop';
  if (p.tp && (long ? P >= p.tp : P <= p.tp)) return 'take';
  return null;
}

async function close(id, posId, P, why) {
  const [raw] = await redis([['HGET', posKey(id), posId]]);
  if (!raw) return null;
  const [gone] = await redis([['HDEL', posKey(id), posId]]);
  if (Number(gone) !== 1) return null; // déjà fermée ailleurs
  const p = JSON.parse(raw), payout = why === 'liquidated' ? 0 : Math.max(0, Math.floor(equity(p, P)));
  const row = { a: p.a, side: p.side, lev: p.lev, m: p.m, entry: p.entry, exit: round(P), payout, why, t: Date.now() };
  await redis([
    ['ZREM', OPEN, `${id}:${posId}`],
    ...(payout ? [['HINCRBY', statsKey(id), 'bonus', payout]] : []), ['HINCRBY', statsKey(id), 'levOut', payout],
    ['RPUSH', histKey(id), JSON.stringify(row)], ['LTRIM', histKey(id), -HIST_KEEP, -1],
  ]);
  return row;
}

// Relit toutes les positions ouvertes et ferme celles qui ont atteint leur stop, leur objectif ou la liquidation.
async function tick(now = Date.now()) {
  const [members] = await redis([['ZRANGE', OPEN, 0, -1]]);
  if (!members || !members.length) return 0;
  const prices = {};
  for (const k of Object.keys(Btc.ASSETS)) { const p = await Btc.price(now, Btc.ASSETS[k]); if (p) prices[k] = p.p; }
  let closed = 0;
  for (const m of members) {
    const [id, posId] = m.split(':');
    const [raw] = await redis([['HGET', posKey(id), posId]]);
    if (!raw) { await redis([['ZREM', OPEN, m]]); continue; }
    const p = JSON.parse(raw), P = prices[p.a];
    if (!P) continue;
    const why = trigger(p, P);
    if (why && await close(id, posId, P, why)) closed++;
  }
  return closed;
}

async function view(id) {
  await tick();
  const [flat, hist] = await redis([['HGETALL', posKey(id)], ['LRANGE', histKey(id), 0, -1]]);
  const prices = {};
  for (const k of Object.keys(Btc.ASSETS)) { const p = await Btc.price(Date.now(), Btc.ASSETS[k]); prices[k] = p ? p.p : null; }
  const open = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    const p = JSON.parse(flat[i + 1]), P = prices[p.a];
    open.push({ ...p, price: P, value: P ? Math.max(0, Math.floor(equity(p, P))) : null });
  }
  open.sort((a, b) => a.t - b.t);
  return { positions: open, history: (hist || []).map(x => JSON.parse(x)).reverse(), leverages: LEVERAGES, fee: FEE, min: MIN_MARGIN, max: MAX_MARGIN, maxOpen: MAX_OPEN };
}

const level = v => (v === null || v === undefined || v === '' || Number(v) === 0 ? null : Number(v));

async function act(id, body) {
  const move = String(body.move || 'state');
  if (move === 'state') return view(id);
  if (move === 'open') {
    const a = Btc.assetOf(body.asset), side = body.side === 'short' ? 'short' : body.side === 'long' ? 'long' : null, lev = Number(body.lev), m = Number(body.margin);
    if (!a || !side) throw refuse(400, 'Pick a coin and long or short');
    if (!LEVERAGES.includes(lev)) throw refuse(400, `Leverage must be ${LEVERAGES.join('×, ')}×`);
    if (!Number.isInteger(m) || m < MIN_MARGIN || m > MAX_MARGIN) throw refuse(400, `Margin between ${MIN_MARGIN} and ${MAX_MARGIN.toLocaleString('en-US')} coins`);
    const st = await readStats(id), coins = Shop.balance(st), rolls = Number(st.rolls) || 0;
    if (rolls < MIN_ROLLS) throw refuse(422, `Crypto unlocks after ${MIN_ROLLS} rolls (you have ${rolls})`);
    if (m > coins) throw refuse(422, `Not enough coins: ${m - coins} more needed`);
    const [count] = await redis([['HLEN', posKey(id)]]);
    if (Number(count) >= MAX_OPEN) throw refuse(422, `At most ${MAX_OPEN} open positions`);
    const pr = await Btc.price(Date.now(), a, Btc.TRADE_FRESH_MS);
    if (!pr) throw refuse(503, `The ${a.name} price is unavailable right now: try again in a minute`);
    const p = { id: crypto.randomBytes(5).toString('hex'), a: body.asset.toLowerCase(), side, lev, m, entry: pr.p, t: Date.now(), sl: level(body.sl), tp: level(body.tp) };
    p.liq = round(liqPrice(p));
    checkLevels(p);
    await redis([['HINCRBY', statsKey(id), 'spent', m], ['HINCRBY', statsKey(id), 'levIn', m], ['HSET', posKey(id), p.id, JSON.stringify(p)], ['ZADD', OPEN, p.t, `${id}:${p.id}`]]);
    return { ...(await view(id)), opened: p };
  }
  const posId = String(body.id || '');
  const [raw] = await redis([['HGET', posKey(id), posId]]);
  if (!raw) throw refuse(404, 'This position is already closed');
  const p = JSON.parse(raw);
  if (move === 'close') {
    const pr = await Btc.price(Date.now(), Btc.ASSETS[p.a], Btc.TRADE_FRESH_MS);
    if (!pr) throw refuse(503, 'The price is unavailable right now: try again in a minute');
    const row = await close(id, posId, pr.p, trigger(p, pr.p) || 'manual');
    return { ...(await view(id)), closed: row };
  }
  if (move === 'edit') {
    p.sl = level(body.sl); p.tp = level(body.tp);
    checkLevels(p);
    await redis([['HSET', posKey(id), posId, JSON.stringify(p)]]);
    return view(id);
  }
  throw refuse(400, 'Unknown move');
}

// Un stop loss doit être entre la liquidation et le prix d'entrée ; un take profit au-delà du prix d'entrée.
function checkLevels(p) {
  const long = p.side !== 'short';
  for (const k of ['sl', 'tp']) if (p[k] !== null && !(p[k] > 0)) throw refuse(400, 'Stop loss and take profit must be prices');
  if (p.sl !== null && (long ? !(p.sl < p.entry && p.sl > p.liq) : !(p.sl > p.entry && p.sl < p.liq))) throw refuse(422, `Stop loss must be between ${fmtP(p.liq)} and ${fmtP(p.entry)}`);
  if (p.tp !== null && (long ? !(p.tp > p.entry) : !(p.tp < p.entry))) throw refuse(422, `Take profit must be ${long ? 'above' : 'below'} ${fmtP(p.entry)}`);
}
const fmtP = v => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));

module.exports = { act, tick, view, equity, liqPrice, trigger, LEVERAGES, FEE, MAINTENANCE, OPEN };
