// Vue d'ensemble de tous les skins (ou de ceux passés en argument) : une ligne par skin avec la carte au repos,
// 3 images du défilement, 4 de la révélation et le cadre de duel — pour comparer et repérer les plus faibles.
//   node tools/skin-overview.mjs [skin…]   →   skin-previews/overview.png
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(ROOT, 'tools/.deps/package.json'));
const { firefox } = require('playwright');
const Shop = require(path.join(ROOT, 'js/shop.js'));
const skins = process.argv.slice(2).length ? process.argv.slice(2) : Shop.SKINS.map(s => s.id).filter(id => id !== 'classic');
const out = path.join(ROOT, 'skin-previews', process.argv.slice(2).length ? `overview-${skins.join('-')}.png` : 'overview.png');
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 300 }, colorScheme: 'dark' });
await page.route('**/api/**', r => r.fulfill({ status: 503, body: '{}' }));
await page.goto('file://' + path.join(ROOT, 'index.html') + '#/about');
await page.waitForTimeout(800);
const height = await page.evaluate(skins => {
  document.body.innerHTML = '';
  const sheet = document.createElement('div');
  sheet.style.cssText = 'padding:12px;display:grid;gap:8px;font:11px system-ui;color:#999;background:#0f0f14';
  const card = (skin, cls) => `<div class="num-card md skin-${skin}" data-tier="rare" style="font-size:1.6rem">${'372368'.split('').map(c => `<span class="slot ${cls}">${c}</span>`).join('')}</div>`;
  const cell = (html, t) => `<div class="frame" style="text-align:center"${t == null ? '' : ` data-t="${t}"`}>${html}</div>`;
  sheet.innerHTML = skins.map(skin => `<div style="display:flex;gap:8px;align-items:center">
      <b style="color:#fff;width:74px">${skin}</b>${cell(card(skin, ''))}
      <span>spin</span>${[40, 120, 200].map(t => cell(card(skin, 'spinning'), t)).join('')}
      <span>reveal</span>${[0, 120, 260, 500].map(t => cell(card(skin, 'revealed'), t)).join('')}
      <div class="room-side side-${skin}" style="width:170px;padding:.5rem .3rem"><div class="room-name" style="font-size:.7rem;margin-bottom:.3rem">Player</div>${card(skin, '').replace('font-size:1.6rem', 'font-size:1.1rem')}</div>
    </div>`).join('');
  document.body.append(sheet);
  for (const f of document.querySelectorAll('.frame[data-t]')) {
    for (const a of f.getAnimations({ subtree: true })) { a.pause(); a.currentTime = Number(f.dataset.t); }
  }
  return sheet.scrollHeight;
}, skins);
await page.setViewportSize({ width: 1500, height: height + 10 });
await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: true });
console.log(out);
await browser.close();
