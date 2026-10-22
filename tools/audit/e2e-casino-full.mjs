// Les cinq jeux du casino joués pour de vrai dans un navigateur : après chaque manche, le solde affiché doit être
// celui du serveur ; les parties laissées en cours reprennent après un rechargement ; aucun appel refusé par surprise.
//   node tools/audit/e2e-casino-full.mjs <dossier de captures>
import { createRequire } from 'node:module';
const require = createRequire(new URL('../.deps/package.json', import.meta.url));
const { firefox } = require('playwright');
const B = 'http://localhost:8124', out = process.argv[2];
const redis = cmds => fetch(B + '/__dev/redis', { method: 'POST', body: JSON.stringify(cmds) }).then(r => r.json());
const browser = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
const problems = [];
const note = (ok, what) => { if (!ok) { problems.push(what); console.log('  ✗', what); } };
for (const [locale, w, h] of [['en-US', 1280, 800], ['fr-FR', 390, 780]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale, colorScheme: 'dark' });
  const p = await ctx.newPage();
  const tag = `${locale.slice(0, 2)} ${w}`;
  p.on('pageerror', e => note(false, `${tag} erreur de page : ${e.message}`));
  const refused = [];
  p.on('response', async r => { if (r.url().includes('/api/shop') && r.request().method() === 'POST' && r.status() >= 400) refused.push(`${r.status()} ${(r.request().postData() || '').replace(/"(playerId|secret)":"[^"]*",?/g, '').slice(0, 90)}`); });
  await p.goto(B + '/'); await p.waitForTimeout(700); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.getByRole('button', { name: /^(Générer|Generate)/ }).first().click(); await p.fill('#modal-root input', 'Ca' + (Date.now() % 100000)); await p.getByRole('button', { name: /Enregistrer|Save/ }).click();
  await p.waitForTimeout(2500); await p.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 120000 });
  const id = await p.evaluate(() => JSON.parse(localStorage.getItem('rnginf.v1')).player.id);
  await redis([['HINCRBY', `stats:${id}`, 'bonus', 30000], ['HSET', `stats:${id}`, 'rolls', 40]]);
  const server = async () => (await (await fetch(`${B}/api/shop?me=${id}`)).json()).coins;
  const shown = () => p.evaluate(() => Number(document.querySelector('#g-coins').textContent.replace(/[^\d]/g, '')));
  const same = async what => { await p.waitForTimeout(250); const [a, b] = [await shown(), await server()]; note(a === b, `${tag} ${what} : solde affiché ${a}, serveur ${b}`); };
  const open = async (tab, reload) => { if (reload) { await p.reload(); await p.waitForTimeout(1600); } else { await p.goto(B + '/#/gamble'); await p.waitForSelector('#g-tabs'); await p.waitForTimeout(1200); } if (tab) { await p.locator(`[data-game-tab="${tab}"]`).click(); await p.waitForTimeout(300); } };
  const chip = c => p.locator(`.gchip[data-chip="${c}"]`).click();
  const text = sel => p.locator(sel).innerText();
  const tap = async sel => { const l = p.locator(sel).first(); await l.scrollIntoViewIfNeeded(); await l.click(); };
  await open('crash');
  await same('ouverture');

  // ---------------- Crash
  let stats = { cashed: 0, crashed: 0 };
  for (let i = 0; i < 6; i++) {
    await chip(i % 2 ? 50 : 100);
    const before = await server();
    await tap('#cr-go');
    await p.waitForFunction(() => ['run', 'crash'].includes(document.querySelector('#cr-screen').dataset.state) && !/^(Start|Démarrer)/i.test(document.querySelector('#cr-go').textContent) || document.querySelector('#cr-result').textContent, null, { timeout: 8000 }).catch(() => note(false, `${tag} crash ${i} : la manche ne démarre pas`));
    if (i === 2) { await p.waitForTimeout(500); await open('crash', true); note(/run|crash/.test(await p.locator('#cr-screen').getAttribute('data-state')) || (await text('#cr-result')).length > 0, `${tag} crash : reprise après rechargement (état ${await p.locator('#cr-screen').getAttribute('data-state')})`); }
    if (i === 4) { await p.locator('[data-game-tab="mines"]').click(); await p.waitForTimeout(500); await p.locator('[data-game-tab="crash"]').click(); }
    await p.waitForTimeout(300 + Math.random() * 2200);
    if (await p.locator('#cr-screen').getAttribute('data-state') === 'run') await tap('#cr-go');
    await p.waitForFunction(() => document.querySelector('#cr-result').textContent.length > 3, null, { timeout: 100000 });
    const res = await text('#cr-result'); /Cashed|Encaiss/.test(res) ? stats.cashed++ : stats.crashed++;
    note(/^(Start|Démarrer)/i.test(await text('#cr-go')), `${tag} crash ${i} : le bouton revient sur Start (${await text('#cr-go')})`);
    await same(`crash ${i} (${res.slice(0, 40)})`);
    const after = await server(); note(after !== before || /1\.00/.test(res), `${tag} crash ${i} : le solde n'a pas bougé`);
  }
  console.log(tag, 'crash', JSON.stringify(stats));
  if (w === 1280) await p.screenshot({ path: `${out}/crash-${w}.png` });

  // ---------------- Mines
  await p.locator('[data-game-tab="mines"]').click(); await chip(100);
  stats = { cash: 0, boom: 0 };
  for (let i = 0; i < 6; i++) {
    await tap(`#mn-count button[data-v="${i === 5 ? 24 : 3}"]`);
    await tap('#mn-go');
    await p.waitForFunction(() => !document.querySelector('.mn-cell').disabled, null, { timeout: 8000 }).catch(() => note(false, `${tag} mines ${i} : la grille ne s'ouvre pas`));
    note(await p.locator('#mn-go').isDisabled(), `${tag} mines ${i} : « encaisser » doit être bloqué avant la première case`);
    const picks = i === 5 ? [7] : [3, 11, 19].slice(0, 1 + (i % 3));
    for (const c of picks) {
      if (await p.locator(`.mn-cell[data-cell="${c}"]`).isDisabled()) break;
      await tap(`.mn-cell[data-cell="${c}"]`);
      await p.waitForFunction(c => { const e = document.querySelector(`.mn-cell[data-cell="${c}"]`); return e.classList.contains('gem') || e.classList.contains('bomb'); }, c, { timeout: 8000 });
      if (i === 1 && c === 3 && !(await text('#mn-result')).length) { await open('mines', true); note(await p.locator('.mn-cell[data-cell="3"]').evaluate(e => e.classList.contains('gem')), `${tag} mines : la case ouverte est retrouvée après rechargement`); note(/Cash|Encaiss/i.test(await text('#mn-go')), `${tag} mines : bouton d'encaissement après rechargement (${await text('#mn-go')})`); }
    }
    if (!(await text('#mn-result')).length) await tap('#mn-go');
    await p.waitForFunction(() => document.querySelector('#mn-result').textContent.length > 3, null, { timeout: 8000 });
    const res = await text('#mn-result'); /Boom/.test(res) ? stats.boom++ : stats.cash++;
    note(await p.locator('.mn-cell.bomb').count() === (i === 5 ? 24 : 3), `${tag} mines ${i} : toutes les mines sont montrées à la fin (${await p.locator('.mn-cell.bomb').count()})`);
    note(await p.locator('.mn-cell:not([disabled])').count() === 0, `${tag} mines ${i} : grille verrouillée après la fin`);
    await same(`mines ${i} (${res.slice(0, 30)})`);
  }
  console.log(tag, 'mines', JSON.stringify(stats));
  if (w === 390) await p.screenshot({ path: `${out}/mines-${w}.png` });

  // ---------------- Plinko
  await p.locator('[data-game-tab="plinko"]').click(); await chip(250);
  for (let i = 0; i < 5; i++) {
    const before = await server();
    await tap('#pk-go');
    await p.waitForFunction(() => document.querySelector('#pk-slots .hit') && document.querySelector('#pk-result').textContent.length > 2, null, { timeout: 15000 });
    await p.waitForTimeout(200);
    const res = await text('#pk-result'), mult = Number(await p.locator('#pk-slots .hit').first().innerText().then(s => s.replace(/[^\d.]/g, '')));
    const after = await server();
    note(after - before === Math.floor(250 * mult) - 250, `${tag} plinko ${i} : case ×${mult}, solde ${before} → ${after}`);
    note(await p.locator('#pk-slots .hit').count() === 1, `${tag} plinko ${i} : une seule case allumée`);
    await same(`plinko ${i} (${res.slice(0, 30)})`);
    await p.evaluate(() => { document.querySelector('#pk-result').textContent = ''; document.querySelectorAll('#pk-slots .hit').forEach(x => x.classList.remove('hit')); });
  }
  // Double clic : deux billes (le Plinko se joue en rafale ; tools/.deps/e2e-plinko.mjs teste ça en détail).
  if (w === 1280) await p.screenshot({ path: `${out}/plinko-${w}.png` });

  // ---------------- Roulette
  await p.locator('[data-game-tab="roulette"]').click(); await chip(50);
  for (let i = 0; i < 3; i++) {
    await tap('#r-clear');
    await tap('#r-bets [data-bet="red"]'); await tap('#r-bets [data-bet="d2"]'); await p.fill('#r-pick', String(7 + i)); await tap('#r-bets [data-bet="n"]');
    note(/150/.test(await text('#r-spin')), `${tag} roulette ${i} : total des mises sur le bouton (${await text('#r-spin')})`);
    const before = await server();
    await tap('#r-spin');
    await p.waitForFunction(() => document.querySelector('#r-number').textContent.length > 0 && document.querySelector('#r-result').textContent.length > 2, null, { timeout: 20000 });
    await p.waitForTimeout(200);
    const n = Number(await text('#r-number')), RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
    const win = (RED.includes(n) ? 100 : 0) + (n >= 13 && n <= 24 ? 150 : 0) + (n === 7 + i ? 1800 : 0);
    const after = await server();
    note(after - before === win - 150, `${tag} roulette ${i} : numéro ${n}, gain attendu ${win}, solde ${before} → ${after}`);
    note((await p.locator('#r-wheel').getAttribute('data-color')) === (n === 0 ? 'green' : RED.includes(n) ? 'red' : 'black'), `${tag} roulette ${i} : couleur affichée`);
    await same(`roulette ${i} (${n})`);
    await p.evaluate(() => { document.querySelector('#r-number').textContent = ''; document.querySelector('#r-result').textContent = ''; });
  }
  // Limites : 12 mises différentes, 1 000 pièces par tour, numéro invalide.
  await tap('#r-clear'); await chip(10);
  for (let v = 0; v < 13; v++) { await p.fill('#r-pick', String(v)); await tap('#r-bets [data-bet="n"]'); }
  note((await text('#r-nbets')).split('·').length === 12, `${tag} roulette : 12 mises au plus (${(await text('#r-nbets')).split('·').length})`);
  await p.fill('#r-pick', '40'); await tap('#r-bets [data-bet="n"]'); note(!/40/.test(await text('#r-nbets')), `${tag} roulette : numéro 40 refusé`);
  await tap('#r-clear'); await chip(1000); await tap('#r-bets [data-bet="red"]'); await tap('#r-bets [data-bet="black"]');
  note(/1[ ,.  ]?000/.test(await text('#r-spin')) && !/2[ ,.  ]?000/.test(await text('#r-spin')), `${tag} roulette : plafond de 1 000 par tour (${await text('#r-spin')})`);
  await tap('#r-clear');
  if (w === 390) await p.screenshot({ path: `${out}/roulette-${w}.png` });

  // ---------------- Blackjack
  await p.locator('[data-game-tab="bj"]').click(); await chip(100);
  stats = {};
  for (let i = 0; i < 8; i++) {
    const before = await server();
    await tap('#bj-actions [data-bj="deal"]');
    await p.waitForFunction(() => document.querySelectorAll('#bj-table .pcard').length >= 4, null, { timeout: 8000 }).catch(() => note(false, `${tag} blackjack ${i} : pas de cartes`));
    let guard = 0, doubled = false;
    while (await p.locator('#bj-actions [data-bj="hit"]').count() && guard++ < 12) {
      if (i === 3 && guard === 1) { const cards = await text('#bj-table'); await open('bj', true); await chip(100); note((await text('#bj-table')).replace(/\s+/g, '') === cards.replace(/\s+/g, ''), `${tag} blackjack : la main est retrouvée après rechargement`); note(await p.locator('#bj-table .pcard.down').count() === 1, `${tag} blackjack : la carte du croupier reste cachée après rechargement`); continue; }
      const value = Number((await p.locator('#bj-table .bj-row').nth(1).locator('.eyebrow').innerText()).replace(/[^\d]/g, ''));
      const n = await p.locator('#bj-table .pcard').count();
      if (i === 5 && guard === 1 && await p.locator('#bj-actions [data-bj="double"]').count()) { doubled = true; await tap('#bj-actions [data-bj="double"]'); }
      else await tap(`#bj-actions [data-bj="${value < 17 ? 'hit' : 'stand'}"]`);
      await p.waitForFunction(n => document.querySelectorAll('#bj-table .pcard').length !== n || document.querySelector('#bj-actions [data-bj="deal"]'), n, { timeout: 8000 });
      await p.waitForTimeout(150);
    }
    await p.waitForSelector('#bj-actions [data-bj="deal"]', { timeout: 8000 });
    const res = await text('#bj-result'), after = await server(), bet = doubled ? 200 : 100;
    const kind = /Blackjack/.test(res) ? 'blackjack' : /Push|Égalité/i.test(res) ? 'push' : /You win|gagnes/i.test(res) ? 'win' : 'lose';
    stats[kind] = (stats[kind] || 0) + 1;
    note(after - before === { blackjack: Math.floor(bet * 1.5), win: bet, push: 0, lose: -bet }[kind], `${tag} blackjack ${i} : « ${res} », solde ${before} → ${after}${doubled ? ' (doublé)' : ''}`);
    note(await p.locator('#bj-table .pcard.down').count() === 0, `${tag} blackjack ${i} : toutes les cartes retournées à la fin`);
    await same(`blackjack ${i} (${res.slice(0, 30)})`);
  }
  console.log(tag, 'blackjack', JSON.stringify(stats));
  if (w === 1280) await p.screenshot({ path: `${out}/blackjack-${w}.png` });
  // Sans assez de pièces : message clair, rien de débité.
  { const c = await server(); await redis([['HINCRBY', `stats:${id}`, 'spent', c - 5]]); await open('plinko'); await chip(10); await tap('#pk-go'); await p.waitForTimeout(900); const toast = await text('#toast').catch(() => ''); note(/coins|pièces/i.test(toast), `${tag} solde insuffisant : message affiché (« ${toast} »)`); note(await server() === 5, `${tag} solde insuffisant : rien de débité`); }
  note(refused.length === 1, `${tag} appels refusés par le serveur (un seul attendu, le solde insuffisant) : ${JSON.stringify(refused)}`);
  await ctx.close();
}
console.log(problems.length ? `\n${problems.length} PROBLÈME(S)` : '\nTOUT PASSE');
await browser.close();
