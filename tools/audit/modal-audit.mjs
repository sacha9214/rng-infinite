// Audit des fenêtres (modales) : sur chaque taille d'écran, la fenêtre tient dans la largeur, rien n'en sort,
// aucun bouton n'en recouvre un autre, et la croix reste atteignable.   node tools/audit/modal-audit.mjs
import { createRequire } from 'node:module';
const require = createRequire(new URL('../.deps/package.json', import.meta.url));
const { firefox } = require('playwright');
const B = process.env.RNG_BASE || process.env.BASE || 'http://localhost:8124', SHOTS = process.argv[2];
const sizes = [[320, 568], [360, 640], [390, 780], [667, 375], [844, 390], [768, 900], [1280, 620], [1440, 900]];
const modals = [['#/', '#news-btn'], ['#/', '[data-idea]'], ['#/', '[data-coffee]'], ['#/', '#gear-btn'], ['#/history', '[data-roll]'], ['#/badges', '[data-badge]'],
  ['#/shop', '[data-skin-preview] >> visible=true'], ['#/about', '[data-trailer]'], ['#/leaderboard', '[data-number], .lb-row [data-n], .lb-row button']];
const browser = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
let total = 0;
for (const locale of ['fr-FR', 'en-US']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', locale });
  const p = await ctx.newPage();
  const check = async (label, w, h) => {
    const found = await p.evaluate(() => {
      const m = document.querySelector('#modal-root .modal'); if (!m) return ['fenêtre absente'];
      const out = [], vw = innerWidth, R = m.getBoundingClientRect();
      const name = e => `${e.tagName.toLowerCase()}.${String(e.className.baseVal === undefined ? e.className : '').split(' ').filter(Boolean).slice(0, 2).join('.')} "${(e.innerText || e.value || '').trim().slice(0, 18)}"`;
      const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && Number(s.opacity) > .05; };
      const clipped = e => { for (let a = e.parentElement; a && a !== m.parentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible') return true; } return false; };
      if (R.left < -1 || R.right > vw + 1) out.push(`fenêtre plus large que l'écran (${Math.round(R.left)} → ${Math.round(R.right)} / ${vw})`);
      if (document.documentElement.scrollWidth > vw + 1) out.push('la page défile en largeur');
      for (const e of m.querySelectorAll('*')) { if (!vis(e) || clipped(e) || e.closest('canvas, svg')) continue; const r = e.getBoundingClientRect(); if (r.right > R.right + 1.5 || r.left < R.left - 1.5) { out.push(`sort de la fenêtre : ${name(e)} (${Math.round(r.left - R.left)} → ${Math.round(r.right - R.right)})`); break; } }
      const ctl = [...m.querySelectorAll('button, a[href], input, select, textarea, h2')].filter(vis);
      for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
        const a = ctl[i], b = ctl[j]; if (a.contains(b) || b.contains(a)) continue;
        const box = e => { if (e.tagName !== 'H2') return e.getBoundingClientRect(); const g = document.createRange(); g.selectNodeContents(e); return g.getBoundingClientRect(); };
        const x = box(a), y = box(b);
        const ow = Math.min(x.right, y.right) - Math.max(x.left, y.left), oh = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
        if (ow > 3 && oh > 3) out.push(`se recouvrent : ${name(a)} / ${name(b)} (${Math.round(ow)}×${Math.round(oh)})`);
      }
      return out.slice(0, 6);
    });
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/${locale.slice(0, 2)}-${w}x${h}-${label.replace(/[^a-z]/gi, '')}.png` });
    for (const f of found) { total++; console.log(`${locale.slice(0, 2)} ${w}x${h} ${label} → ${f}`); }
  };
  // Premier passage : l'accueil en trois écrans, puis le choix du nom (visiteur tout neuf).
  for (const [w, h] of sizes) {
    await p.setViewportSize({ width: w, height: h });
    await p.evaluate(() => { try { localStorage.clear(); } catch (e) { /* page vide */ } }).catch(() => {});
    await p.goto(B + '/'); await p.reload(); await p.waitForTimeout(1200);
    for (let step = 0; step < 3; step++) { if (!await p.locator('#modal-root .modal').count()) break; await check('accueil ' + (step + 1), w, h); const next = p.locator('#modal-root .intro button').last(); if (!await next.count()) break; await next.click(); await p.waitForTimeout(500); }
    await p.keyboard.press('Escape'); await p.waitForTimeout(250);
    await p.getByRole('button', { name: /^(Générer|Generate)/ }).first().click(); await p.waitForTimeout(400); await check('nom', w, h); await p.keyboard.press('Escape');
  }
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.getByRole('button', { name: /^(Générer|Generate)/ }).first().click(); await p.fill('#modal-root input', 'Mo' + (Date.now() % 100000)); await p.getByRole('button', { name: /Enregistrer|Save/ }).click();
  await p.waitForTimeout(13500);
  for (const [w, h] of sizes) {
    await p.setViewportSize({ width: w, height: h });
    for (const [hash, sel] of modals) {
      await p.goto(B + '/' + hash); await p.waitForTimeout(hash === '#/shop' || hash === '#/badges' ? 1400 : 800);
      const t = p.locator(sel).first(); if (!await t.count()) { console.log(`?? ${hash} ${sel} introuvable`); continue; }
      await t.scrollIntoViewIfNeeded(); await t.click({ force: true }); await p.waitForTimeout(600);
      await check(`${hash} ${sel.split(',')[0]}`, w, h);
      await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    }
  }
  await ctx.close();
}
console.log(total + ' défaut(s)');
await browser.close();
