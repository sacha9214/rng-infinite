// Débordement horizontal : chaque page du site, à plusieurs largeurs de téléphone, en français (libellés les plus
// longs) — la page ne doit jamais être plus large que l'écran.   node tools/audit/overflow-check.mjs [largeurs…]
import { createRequire } from 'node:module';
const require = createRequire(new URL('../.deps/package.json', import.meta.url));
const { firefox } = require('playwright');
const B = process.env.RNG_BASE || process.env.BASE || 'http://localhost:8124'; // RNG_BASE ou BASE : autre port (plusieurs serveurs de dev)
const widths = process.argv.slice(2).map(Number).filter(Boolean);
const browser = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
const ctx = await browser.newContext({ viewport: { width: 375, height: 760 }, colorScheme: 'dark', locale: 'fr-FR' });
const p = await ctx.newPage();
await p.goto(B + '/'); await p.waitForTimeout(700); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
await p.getByRole('button', { name: /Générer|Generate/ }).click(); await p.fill('#modal-root input', 'Ov' + (Date.now() % 100000)); await p.getByRole('button', { name: /Enregistrer|Save/ }).click();
await p.waitForTimeout(13500);
let bad = 0;
for (const w of widths.length ? widths : [320, 360, 375, 414]) {
  await p.setViewportSize({ width: w, height: 760 });
  const line = [];
  for (const hash of ['#/', '#/duel', '#/leaderboard', '#/badges', '#/stats', '#/history', '#/shop', '#/friends', '#/clan', '#/me', '#/tournament', '#/about', '#/roadmap']) {
    await p.goto(B + '/' + hash); await p.waitForTimeout(hash === '#/shop' || hash === '#/badges' ? 1400 : 900);
    const r = await p.evaluate(() => { const over = document.documentElement.scrollWidth - innerWidth; const who = over > 0 ? [...document.querySelectorAll('.app *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 2).map(e => `${e.tagName.toLowerCase()}.${String(e.className).split(' ').slice(0, 2).join('.')}`) : []; return { over, who }; });
    if (r.over > 0) bad++;
    line.push(`${hash.slice(2) || 'home'} ${r.over > 0 ? `+${r.over}px (${r.who.join(', ')})` : 'ok'}`);
  }
  console.log(String(w).padStart(4), '·', line.join(' · '));
}
console.log(bad ? `${bad} page(s) débordent` : 'aucune page ne déborde');
await browser.close();
