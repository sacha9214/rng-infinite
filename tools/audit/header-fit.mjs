import { createRequire } from 'node:module';
const require = createRequire(new URL('../.deps/package.json', import.meta.url));
const { firefox } = require('playwright');
const B = process.env.RNG_BASE || process.env.BASE || 'http://localhost:8124';
const browser = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
const widths = process.argv.slice(2).map(Number);
for (const locale of ['fr-FR', 'en-US']) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 740 }, colorScheme: 'dark', locale });
  const p = await ctx.newPage();
  await p.goto(B + '/'); await p.waitForTimeout(700);
  await p.keyboard.press('Escape'); await p.waitForTimeout(250);
  // Un pseudo long (20 caractères) : le pire cas pour la place à droite.
  await p.evaluate(() => { document.querySelector('#player-name').textContent = 'WWWWWWWWWWWWWWWWWWWW'; });
  for (const w of widths) {
    await p.setViewportSize({ width: w, height: 740 }); await p.waitForTimeout(120);
    const r = await p.evaluate(() => {
      const nav = document.querySelector('.nav'), first = document.querySelector('.topbar-right').firstElementChild;
      const visibleFirst = [...document.querySelector('.topbar-right').children].find(e => getComputedStyle(e).display !== 'none').getBoundingClientRect();
      const last = nav.lastElementChild.getBoundingClientRect();
      // Menu regroupé (2026-10-29) : sous 1000 px le menu passe sur sa propre ligne, l'écart avec la droite ne compte plus ;
      // on vérifie alors qu'aucun libellé n'est coupé (cut).
      const wrapped = nav.getBoundingClientRect().top >= document.querySelector('.topbar-right').getBoundingClientRect().bottom - 1;
      const cut = [...nav.querySelectorAll('span')].filter(x => x.offsetWidth && x.scrollWidth > x.offsetWidth + 1).map(x => x.textContent);
      return { pageOverflow: document.documentElement.scrollWidth - innerWidth, gap: wrapped ? 'row2' : Math.round(visibleFirst.left - last.right), navScroll: nav.scrollWidth - nav.clientWidth, labels: getComputedStyle(nav.querySelector('span')).display !== 'none', cut };
    });
    console.log(locale, w, JSON.stringify(r));
  }
  await ctx.close();
}
await browser.close();
