// Bitcoin du casino (onglet Gamble, idée de Sacha, 2026-10-14) : acheter et revendre du « bitcoin » avec les pièces du
// jeu, au vrai prix du marché (1 pièce = 1 dollar). Ce n'est pas de vrai bitcoin : rien ne sort du jeu, rien n'y entre.
// Le prix vient de Coinbase (Kraken en secours), gardé 20 s dans Redis pour tout le monde. Un écart de 1 % à l'achat
// comme à la vente (comme chez un vrai courtier) : acheter puis revendre aussitôt coûte 2 %, et un prix vieux de
// quelques secondes ne permet pas de gagner à coup sûr. Avoirs : stats.btcSats (en satoshis, 1e-8 BTC).
const { redis, statsKey, readStats } = require('./_lib');
const Shop = require('../js/shop.js');

const PRICE_KEY = 'btc:price', HIST_KEY = 'btc:hist';
const PRICE_TTL_S = 20, MAX_AGE_MS = 120000, HIST_EVERY_MS = 5 * 60000, HIST_KEEP = 288; // 24 h de points toutes les 5 min
const SPREAD = 0.01, MIN_TRADE = 10, MAX_TRADE = 50000, SATS = 1e8, MIN_ROLLS = 30;
const refuse = (status, error) => Object.assign(new Error(error), { status });

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}
const SOURCES = [
  async () => Number((await fetchJson('https://api.coinbase.com/v2/prices/BTC-USD/spot')).data.amount),
  async () => Number(Object.values((await fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')).result)[0].c[0]),
];

// Le prix du moment : celui de Redis s'il a moins de 20 s, sinon une nouvelle lecture (et un point de plus dans
// l'historique toutes les 5 min). Sans source joignable, le dernier prix connu tant qu'il a moins de 2 min ; au-delà,
// on ne peut plus acheter ni vendre (le site l'affiche).
async function price(now = Date.now()) {
  const [raw] = await redis([['GET', PRICE_KEY]]);
  let cur = null;
  try { cur = raw ? JSON.parse(raw) : null; } catch (e) { cur = null; }
  if (cur && now - cur.t < PRICE_TTL_S * 1000) return cur;
  for (const source of SOURCES) {
    try {
      const p = await source();
      if (!(p > 1000 && p < 10000000)) continue; // garde-fou : une réponse absurde est ignorée
      const fresh = { p: Math.round(p * 100) / 100, t: now };
      const [last] = await redis([['LINDEX', HIST_KEY, -1]]);
      const lastT = last ? Number(JSON.parse(last).t) : 0;
      const writes = [['SET', PRICE_KEY, JSON.stringify(fresh), 'EX', 3600]];
      if (now - lastT >= HIST_EVERY_MS) writes.push(['RPUSH', HIST_KEY, JSON.stringify(fresh)], ['LTRIM', HIST_KEY, -HIST_KEEP, -1]);
      await redis(writes);
      return fresh;
    } catch (e) { /* source suivante */ }
  }
  return cur && now - cur.t < MAX_AGE_MS ? cur : null;
}

async function view(id) {
  const p = await price(); // d'abord : il peut ajouter un point à l'historique lu juste après
  const [[hist], st] = await Promise.all([redis([['LRANGE', HIST_KEY, 0, -1]]), id ? readStats(id) : null]);
  const sats = st ? Number(st.btcSats) || 0 : 0, paid = st ? Number(st.btcCost) || 0 : 0;
  return {
    price: p ? p.p : null, t: p ? p.t : null, spread: SPREAD, min: MIN_TRADE, max: MAX_TRADE, rolls: MIN_ROLLS,
    hist: (hist || []).map(x => { try { const o = JSON.parse(x); return [o.t, o.p]; } catch (e) { return null; } }).filter(Boolean),
    sats, value: p ? Math.floor((sats / SATS) * p.p * (1 - SPREAD)) : null, cost: paid,
    coins: st ? Shop.balance(st) : null, myRolls: st ? Number(st.rolls) || 0 : 0,
  };
}

// Acheter pour `coins` pièces, ou vendre `sats` satoshis (ou tout). Appelé sous le verrou du joueur (api/shop.js).
async function trade(id, body) {
  const move = String(body.move || 'state');
  if (move === 'state') return view(id);
  const p = await price();
  if (!p) throw refuse(503, 'The Bitcoin price is unavailable right now: try again in a minute');
  const st = await readStats(id), coins = Shop.balance(st), sats = Number(st.btcSats) || 0, rolls = Number(st.rolls) || 0;
  if (rolls < MIN_ROLLS) throw refuse(422, `Bitcoin unlocks after ${MIN_ROLLS} rolls (you have ${rolls})`);
  if (move === 'buy') {
    const spend = Number(body.coins);
    if (!Number.isInteger(spend) || spend < MIN_TRADE || spend > MAX_TRADE) throw refuse(400, `Buy for ${MIN_TRADE} to ${MAX_TRADE.toLocaleString('en-US')} coins`);
    if (spend > coins) throw refuse(422, `Not enough coins: ${spend - coins} more needed`);
    const got = Math.floor((spend / (p.p * (1 + SPREAD))) * SATS);
    if (got < 1) throw refuse(422, 'Too small to buy');
    await redis([['HINCRBY', statsKey(id), 'spent', spend], ['HINCRBY', statsKey(id), 'btcSats', got], ['HINCRBY', statsKey(id), 'btcCost', spend], ['HINCRBY', statsKey(id), 'btcTrades', 1]]);
    return { ...(await view(id)), done: { move, coins: spend, sats: got, price: p.p } };
  }
  if (move === 'sell') {
    const sell = body.all ? sats : Number(body.sats);
    if (!Number.isInteger(sell) || sell < 1) throw refuse(400, 'Nothing to sell');
    if (sell > sats) throw refuse(422, 'You do not have that much Bitcoin');
    const back = Math.floor((sell / SATS) * p.p * (1 - SPREAD));
    if (back < 1) throw refuse(422, 'Too small to sell');
    // Le prix payé suit la part vendue, pour que « gagné / perdu » reste juste après une vente partielle.
    const costPart = sats ? Math.round((Number(st.btcCost) || 0) * (sell / sats)) : 0;
    await redis([['HINCRBY', statsKey(id), 'bonus', back], ['HINCRBY', statsKey(id), 'btcSats', -sell], ['HINCRBY', statsKey(id), 'btcCost', -costPart], ['HINCRBY', statsKey(id), 'btcTrades', 1]]);
    return { ...(await view(id)), done: { move, coins: back, sats: sell, price: p.p } };
  }
  throw refuse(400, 'Unknown move');
}

module.exports = { trade, view, price, SPREAD, MIN_TRADE, MAX_TRADE, SATS, PRICE_KEY, HIST_KEY };
