import { createRequire } from 'node:module';
const require = createRequire(new URL('../.deps/package.json', import.meta.url));
const { firefox } = require('playwright');
const B = 'http://localhost:8124';
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
      return { pageOverflow: document.documentElement.scrollWidth - innerWidth, gap: Math.round(visibleFirst.left - last.right), navScroll: nav.scrollWidth - nav.clientWidth, labels: getComputedStyle(nav.querySelector('span')).display !== 'none' };
    });
    console.log(locale, w, JSON.stringify(r));
  }
  await ctx.close();
}
await browser.close();
