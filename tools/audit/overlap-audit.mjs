// Audit de mise en page : pour chaque page et chaque largeur d'écran, (1) la page ne dépasse pas l'écran,
// (2) aucun élément visible ne sort de l'écran, (3) aucun bouton / lien / champ n'en recouvre un autre,
// (4) aucun texte n'est coupé par son conteneur (hors points de suspension voulus).   node tools/audit/overlap-audit.mjs [largeurs…]
import { createRequire } from 'node:module';
const require = createRequire(new URL('../.deps/package.json', import.meta.url));
const { firefox } = require('playwright');
const B = process.env.BASE || 'http://localhost:8124'; // BASE : autre port (plusieurs serveurs de dev en même temps)
// Une taille s'écrit « 390 » (hauteur par défaut) ou « 844x390 » (téléphone couché, petit portable).
const widths = process.argv.slice(2).filter(a => /^\d+(x\d+)?$/.test(a));
const HEIGHTS = {};
for (let i = 0; i < widths.length; i++) { const [w, h] = String(widths[i]).split('x').map(Number); widths[i] = h ? w + h / 10000 : w; if (h) HEIGHTS[widths[i]] = h; }
const browser = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
const redis = cmds => fetch(B + '/__dev/redis', { method: 'POST', body: JSON.stringify(cmds) }).then(r => r.json());
let total = 0;
for (const locale of ['fr-FR', 'en-US']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', locale });
  const p = await ctx.newPage();
  await p.goto(B + '/'); await p.waitForTimeout(700); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.getByRole('button', { name: /Générer|Generate/ }).click(); await p.fill('#modal-root input', 'Au' + (Date.now() % 100000)); await p.getByRole('button', { name: /Enregistrer|Save/ }).click();
  await p.waitForTimeout(13500);
  const id = await p.evaluate(() => JSON.parse(localStorage.getItem('rnginf.v1')).player.id);
  await redis([['HINCRBY', `stats:${id}`, 'bonus', '3000'], ['HSET', `stats:${id}`, 'rolls', '40']]);
  // une salle de duel contre un bot, pour auditer aussi cette page
  await p.goto(B + '/#/duel'); await p.waitForSelector('#d-go'); await p.locator('[data-pref="opp"][data-v="bots"]').click(); await p.locator('#d-go').click(); await p.waitForURL(/#\/room\//); const room = new URL(p.url()).hash;
  const pages = [['#/', null], ['#/duel', null], [room, null], ['#/leaderboard', null], ['#/leaderboard', '[data-tab="coins"]'], ['#/badges', null], ['#/stats', null], ['#/history', null], ['#/shop', null], ['#/friends', null], ['#/about', null],
    ['#/gamble', '[data-game-tab="crash"]'], ['#/gamble', '[data-game-tab="mines"]'], ['#/gamble', '[data-game-tab="plinko"]'], ['#/gamble', '[data-game-tab="roulette"]'], ['#/gamble', '[data-game-tab="bj"]']];
  for (const w of widths.length ? widths : [320, 360, 390, 414, 600, 768, 1024, 1180, 1280, 1440, 1920]) {
    await p.setViewportSize({ width: Math.floor(w), height: HEIGHTS[w] || (w < 700 ? 780 : 900) });
    for (const [hash, click] of pages) {
      await p.goto(B + '/' + hash); await p.waitForTimeout(hash === '#/shop' || hash === '#/badges' ? 1500 : 900);
      if (click) { await p.locator(click).click().catch(() => {}); await p.waitForTimeout(500); }
      const found = await p.evaluate(() => {
        const out = [], vw = innerWidth, name = e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${String(e.className && e.className.baseVal === undefined ? e.className : '').split(' ').filter(Boolean).slice(0, 2).join('.')}`;
        const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > .05; };
        const over = document.documentElement.scrollWidth - vw;
        if (over > 0) out.push(`page +${over}px`);
        // la zone de défilement horizontal voulue (onglets du menu à 320 px) est exclue
        const inScroller = e => { for (let a = e.parentElement; a; a = a.parentElement) { const s = getComputedStyle(a); if ((s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden' || s.overflow === 'hidden') ) return true; } return false; };
        for (const e of document.querySelectorAll('.app *, .topbar *')) { if (!visible(e) || e.closest('canvas, svg, .skin-fx-out, .react-layer')) continue; const r = e.getBoundingClientRect(); if ((r.right > vw + 2 || r.left < -2) && !inScroller(e)) { out.push(`hors écran ${name(e)} (${Math.round(r.left)}→${Math.round(r.right)})`); if (out.length > 6) break; } }
        // contrôles qui se recouvrent
        const ctl = [...document.querySelectorAll('.topbar a, .topbar button, .app button, .app a, .app input, .app select, .gh-corner')].filter(e => visible(e) && !e.closest('[hidden]'));
        const rects = ctl.map(e => [e, e.getBoundingClientRect()]);
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const [a, ra] = rects[i], [b, rb] = rects[j];
          if (a.contains(b) || b.contains(a)) continue;
          const fixed = x => !!x.closest('.gh-corner');
          if (fixed(a) !== fixed(b)) { /* un rond fixe au-dessus d'un contrôle : signalé seulement s'il le couvre vraiment */ }
          const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (ix > 4 && iy > 4) { const top = document.elementFromPoint(Math.max(ra.left, rb.left) + ix / 2, Math.max(ra.top, rb.top) + iy / 2); if (ra.top < innerHeight && rb.top < innerHeight && ra.bottom > 0 && rb.bottom > 0 && top && (a.contains(top) || b.contains(top))) out.push(`recouvrement ${name(a)} × ${name(b)} (${Math.round(ix)}×${Math.round(iy)})`); }
          if (out.length > 8) break;
        }
        // texte qui déborde de son bouton (« BLACKJACK » plus large que son onglet)
        const textBox = e => { const g = document.createRange(); g.selectNodeContents(e); return g.getBoundingClientRect(); };
        for (const e of document.querySelectorAll('.app button, .topbar button, .app .pill, .app a.btn')) {
          if (!visible(e) || e.querySelector('canvas, svg, img') || inScroller(e) && getComputedStyle(e).overflow !== 'visible') continue;
          const r = e.getBoundingClientRect(), g = textBox(e); if (!g.width) continue;
          if (getComputedStyle(e).overflow === 'visible' && (g.right > r.right + 1.5 || g.left < r.left - 1.5)) out.push(`texte qui déborde ${name(e)} "${(e.innerText || '').trim().slice(0, 16)}" (+${Math.round(Math.max(g.right - r.right, r.left - g.left))}px)`);
        }
        // un texte qui passe sous une boîte ou un contrôle voisin (paragraphe sous la boîte « Your coins »)
        const texts = [...document.querySelectorAll('.app p, .app h1, .app h2, .app h3')].filter(e => visible(e) && (e.innerText || '').trim());
        const boxes = [...document.querySelectorAll('.app button, .app input, .app select, .app .g-wallet, .app .pill, .app .num-card, .app .panel')].filter(visible);
        for (const tEl of texts) { const lines = [...(() => { const g = document.createRange(); g.selectNodeContents(tEl); return g.getClientRects(); })()];
          for (const b of boxes) { if (b.contains(tEl) || tEl.contains(b)) continue; const rb = b.getBoundingClientRect();
            if (lines.some(l => Math.min(l.right, rb.right) - Math.max(l.left, rb.left) > 3 && Math.min(l.bottom, rb.bottom) - Math.max(l.top, rb.top) > 3)) { out.push(`texte sous une boîte ${name(tEl)} "${tEl.innerText.trim().slice(0, 18)}" × ${name(b)}`); break; } } }
        // texte coupé dans un bouton ou une pastille
        for (const e of document.querySelectorAll('.app button, .app .pill, .app .panel-title, .topbar button')) { if (!visible(e)) continue; if (e.matches('.trailer-thumb')) continue; /* affiche zoomée au survol, rognée exprès */ const s = getComputedStyle(e); if (s.textOverflow === 'ellipsis') continue; if (e.scrollWidth > e.clientWidth + 3 && s.overflow !== 'visible') out.push(`texte coupé ${name(e)} "${e.textContent.trim().slice(0, 20)}"`); if (out.length > 10) break; }
        return [...new Set(out)].slice(0, 6);
      });
      if (found.length) { total += found.length; console.log(`${locale.slice(0, 2)} ${String(Math.floor(w) + (HEIGHTS[w] ? "x" + HEIGHTS[w] : "")).padStart(8)} ${(hash.startsWith('#/room') ? '#/room' : hash) + (click ? ' ' + click.replace(/.*"(.*)".*/, '$1') : '')} → ${found.join(' ; ')}`); }
    }
  }
  await ctx.close();
}
console.log(total ? `${total} défaut(s)` : 'aucun défaut');
await browser.close();
