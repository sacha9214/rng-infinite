// Bitcoin du casino (onglet Gamble, idée de Sacha, 2026-10-14) : acheter et revendre du « bitcoin » avec les pièces du
// jeu, au vrai prix du marché (1 pièce = 1 dollar). Ce n'est pas de vrai bitcoin : rien ne sort du jeu, rien n'y entre.
// Le prix vient de Coinbase (Kraken en secours), gardé 20 s dans Redis pour tout le monde. Un écart de 1 % à l'achat
// comme à la vente (comme chez un vrai courtier) : acheter puis revendre aussitôt coûte 2 %, et un prix vieux de
// quelques secondes ne permet pas de gagner à coup sûr. Avoirs : stats.btcSats (en satoshis, 1e-8 BTC).
const { redis, statsKey, readStats } = require('./_lib');
const Shop = require('../js/shop.js');

// Deux actifs (Ethereum ajouté le 2026-10-14). Avoirs en unités de 1e-8 (satoshis pour le Bitcoin) dans stats :
// <champ>Sats et <champ>Cost (pièces payées). Les clés et champs du Bitcoin restent ceux d'avant.
const ASSETS = {
  btc: { name: 'Bitcoin', sym: 'BTC', cb: 'BTC-USD', kr: 'XBTUSD', lo: 1000, hi: 10000000, price: 'btc:price', hist: 'btc:hist', sats: 'btcSats', cost: 'btcCost' },
  eth: { name: 'Ethereum', sym: 'ETH', cb: 'ETH-USD', kr: 'ETHUSD', lo: 20, hi: 1000000, price: 'eth:price', hist: 'eth:hist', sats: 'ethSats', cost: 'ethCost' },
};
const assetOf = raw => ASSETS[String(raw || 'btc').toLowerCase()] || null;
const PRICE_KEY = ASSETS.btc.price, HIST_KEY = ASSETS.btc.hist;
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
  async a => Number((await fetchJson(`https://api.coinbase.com/v2/prices/${a.cb}/spot`)).data.amount),
  async a => Number(Object.values((await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${a.kr}`)).result)[0].c[0]),
];

// Le prix du moment : celui de Redis s'il a moins de 20 s, sinon une nouvelle lecture (et un point de plus dans
// l'historique toutes les 5 min). Sans source joignable, le dernier prix connu tant qu'il a moins de 2 min ; au-delà,
// on ne peut plus acheter ni vendre (le site l'affiche).
// fresh : âge maximal accepté (ms). Pour un échange, 3 s : sinon on pourrait acheter à un prix vieux de 20 s alors
// qu'on voit déjà ailleurs que le vrai prix a monté (audit anti-triche du 2026-10-14).
const TRADE_FRESH_MS = 3000;
async function price(now = Date.now(), a = ASSETS.btc, fresh = PRICE_TTL_S * 1000) {
  const [raw] = await redis([['GET', a.price]]);
  let cur = null;
  try { cur = raw ? JSON.parse(raw) : null; } catch (e) { cur = null; }
  if (cur && now - cur.t < fresh) return cur;
  for (const source of SOURCES) {
    try {
      const p = await source(a);
      if (!(p > a.lo && p < a.hi)) continue; // garde-fou : une réponse absurde est ignorée
      const fresh = { p: Math.round(p * 100) / 100, t: now };
      const [last] = await redis([['LINDEX', a.hist, -1]]);
      const lastT = last ? Number(JSON.parse(last).t) : 0;
      const writes = [['SET', a.price, JSON.stringify(fresh), 'EX', 3600]];
      if (now - lastT >= HIST_EVERY_MS) writes.push(['RPUSH', a.hist, JSON.stringify(fresh)], ['LTRIM', a.hist, -HIST_KEEP, -1]);
      await redis(writes);
      return fresh;
    } catch (e) { /* source suivante */ }
  }
  // Sans source joignable : pour l'affichage, le dernier prix connu (moins de 2 min) ; pour un échange, rien.
  return cur && now - cur.t < Math.min(MAX_AGE_MS, Math.max(fresh, 0) || MAX_AGE_MS) && fresh >= PRICE_TTL_S * 1000 ? cur : null;
}

async function view(id, a = ASSETS.btc) {
  const p = await price(Date.now(), a); // d'abord : il peut ajouter un point à l'historique lu juste après
  const [[hist], st] = await Promise.all([redis([['LRANGE', a.hist, 0, -1]]), id ? readStats(id) : null]);
  const sats = st ? Number(st[a.sats]) || 0 : 0, paid = st ? Number(st[a.cost]) || 0 : 0;
  const other = Object.entries(ASSETS).filter(([, x]) => x !== a).map(([k, x]) => ({ asset: k, sats: st ? Number(st[x.sats]) || 0 : 0 }));
  return {
    asset: Object.keys(ASSETS).find(k => ASSETS[k] === a), name: a.name, sym: a.sym, other,
    price: p ? p.p : null, t: p ? p.t : null, spread: SPREAD, min: MIN_TRADE, max: MAX_TRADE, rolls: MIN_ROLLS,
    hist: (hist || []).map(x => { try { const o = JSON.parse(x); return [o.t, o.p]; } catch (e) { return null; } }).filter(Boolean),
    sats, value: p ? Math.floor((sats / SATS) * p.p * (1 - SPREAD)) : null, cost: paid,
    coins: st ? Shop.balance(st) : null, myRolls: st ? Number(st.rolls) || 0 : 0,
  };
}

// Acheter pour `coins` pièces, ou vendre `sats` satoshis (ou tout). Appelé sous le verrou du joueur (api/shop.js).
async function trade(id, body) {
  const a = assetOf(body.asset);
  if (!a) throw refuse(400, 'Unknown coin');
  const move = String(body.move || 'state');
  if (move === 'state') return view(id, a);
  const p = await price(Date.now(), a, TRADE_FRESH_MS);
  if (!p) throw refuse(503, `The ${a.name} price is unavailable right now: try again in a minute`);
  const st = await readStats(id), coins = Shop.balance(st), sats = Number(st[a.sats]) || 0, rolls = Number(st.rolls) || 0;
  if (rolls < MIN_ROLLS) throw refuse(422, `Crypto unlocks after ${MIN_ROLLS} rolls (you have ${rolls})`);
  if (move === 'buy') {
    const spend = Number(body.coins);
    if (!Number.isInteger(spend) || spend < MIN_TRADE || spend > MAX_TRADE) throw refuse(400, `Buy for ${MIN_TRADE} to ${MAX_TRADE.toLocaleString('en-US')} coins`);
    if (spend > coins) throw refuse(422, `Not enough coins: ${spend - coins} more needed`);
    const got = Math.floor((spend / (p.p * (1 + SPREAD))) * SATS);
    if (got < 1) throw refuse(422, 'Too small to buy');
    await redis([['HINCRBY', statsKey(id), 'spent', spend], ['HINCRBY', statsKey(id), a.sats, got], ['HINCRBY', statsKey(id), a.cost, spend], ['HINCRBY', statsKey(id), 'btcTrades', 1]]);
    return { ...(await view(id, a)), done: { move, coins: spend, sats: got, price: p.p } };
  }
  if (move === 'sell') {
    const sell = body.all ? sats : Number(body.sats);
    if (!Number.isInteger(sell) || sell < 1) throw refuse(400, 'Nothing to sell');
    if (sell > sats) throw refuse(422, `You do not have that much ${a.name}`);
    const back = Math.floor((sell / SATS) * p.p * (1 - SPREAD));
    if (back < 1) throw refuse(422, 'Too small to sell');
    // Le prix payé suit la part vendue, pour que « gagné / perdu » reste juste après une vente partielle.
    const costPart = sats ? Math.round((Number(st[a.cost]) || 0) * (sell / sats)) : 0;
    await redis([['HINCRBY', statsKey(id), 'bonus', back], ['HINCRBY', statsKey(id), a.sats, -sell], ['HINCRBY', statsKey(id), a.cost, -costPart], ['HINCRBY', statsKey(id), 'btcTrades', 1]]);
    return { ...(await view(id, a)), done: { move, coins: back, sats: sell, price: p.p } };
  }
  throw refuse(400, 'Unknown move');
}

// Bougies pour le graphique (style TradingView) : celles de Coinbase (Kraken en secours), gardées 30 s à 5 min selon
// l'unité de temps, partagées par tous les joueurs. [heure (s), ouverture, plus haut, plus bas, clôture, volume].
const TFS = { '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
async function candles(a, tf) {
  const g = TFS[tf];
  if (!g) throw refuse(400, 'Unknown time frame');
  const key = `cndl:${a.sym}:${tf}`, [raw] = await redis([['GET', key]]);
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* relue */ } }
  let rows = null;
  try {
    rows = (await fetchJson(`https://api.exchange.coinbase.com/products/${a.cb}/candles?granularity=${g}`)).map(r => [r[0], r[3], r[2], r[1], r[4], r[5]]).sort((x, y) => x[0] - y[0]);
  } catch (e) {
    try { rows = Object.values((await fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${a.kr}&interval=${g / 60 === 1440 ? 1440 : Math.min(1440, g / 60)}`)).result).find(Array.isArray).slice(-300).map(r => [r[0], +r[1], +r[2], +r[3], +r[4], +r[6]]); } catch (e2) { rows = null; }
  }
  if (!rows || !rows.length) throw refuse(503, 'The chart is unavailable right now');
  const out = { tf, rows: rows.slice(-300) };
  await redis([['SET', key, JSON.stringify(out), 'EX', Math.max(30, Math.min(300, g / 6))]]);
  return out;
}

module.exports = { TRADE_FRESH_MS, ASSETS, assetOf, candles, TFS, trade, view, price, SPREAD, MIN_TRADE, MAX_TRADE, SATS, PRICE_KEY, HIST_KEY };
