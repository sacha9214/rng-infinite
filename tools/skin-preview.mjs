// Planche d'images d'un skin : la carte au repos, le défilement et la révélation figés à plusieurs instants,
// le cadre de duel en sombre et en clair — pour juger une animation image par image avant de la publier.
//   Une fois :  npm i --prefix tools/.deps playwright@1  &&  npx --prefix tools/.deps playwright install firefox
//   Ensuite :   node tools/skin-preview.mjs <skin> [autre skin…]   →   skin-previews/<skin>.png
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(ROOT, 'tools/.deps/package.json'));
const { firefox } = require('playwright');
const skins = process.argv.slice(2);
if (!skins.length) { console.error('Usage: node tools/skin-preview.mjs <skin> [...]'); process.exit(1); }
fs.mkdirSync(path.join(ROOT, 'skin-previews'), { recursive: true });

// Instants (ms) où l'on fige chaque animation : début, montée, pic, retombée, fin.
const SPIN_T = [0, 60, 120, 180, 240];
const REVEAL_T = [0, 80, 160, 260, 400, 700];

const browser = await firefox.launch();
for (const skin of skins) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 200 }, colorScheme: 'dark' });
  await page.route('**/api/**', r => r.fulfill({ status: 503, body: '{}' })); // aucune requête au serveur
  await page.goto('file://' + path.join(ROOT, 'index.html') + '#/about');
  await page.waitForTimeout(800);
  const height = await page.evaluate(({ skin, SPIN_T, REVEAL_T }) => {
    document.body.innerHTML = '';
    const sheet = document.createElement('div');
    sheet.style.cssText = 'padding:18px;display:grid;gap:14px;font:12px system-ui;color:#aaa;background:#0f0f14';
    const card = (cls, digits = '372368') => `<div class="num-card md skin-${skin}" data-tier="rare">${digits.split('')
      .map((c, i) => `<span class="slot ${cls}${cls === '' && digits.startsWith('0') && i < 4 ? ' ghost' : ''}">${c}</span>`).join('')}</div>`;
    const cell = (html, t) => `<div style="text-align:center"><div class="frame"${t == null ? '' : ` data-t="${t}"`}>${html}</div><div>${t == null ? '' : `${t} ms`}</div></div>`;
    const row = (label, cells) => `<div><div style="margin-bottom:6px">${label}</div><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${cells}</div></div>`;
    sheet.innerHTML =
      row(`<b style="color:#fff;font-size:15px">${skin}</b> — au repos (et avec zéros de tête)`, cell(card('')) + cell(card('', '000042'))) +
      row('Défilement (.spinning)', SPIN_T.map(t => cell(card('spinning'), t)).join('')) +
      row('Révélation (.revealed)', REVEAL_T.map(t => cell(card('revealed'), t)).join('')) +
      row('Cadre de duel — sombre / clair',
        `<div class="room-side side-${skin}" style="width:320px"><div class="room-name">🏆 Player</div>${card('')}<div class="room-meta"><span class="ep-pill">3,925 XP</span></div></div>` +
        `<div style="background:#fafafa;padding:10px;border-radius:10px"><div class="room-side side-${skin}" style="width:320px;--surface:#fff;--prose:#111;color:#111"><div class="room-name">Player</div>${card('')}</div></div>`);
    document.body.append(sheet);
    // Fige chaque animation à l'instant voulu (Web Animations API) : on voit exactement l'image t.
    for (const f of document.querySelectorAll('.frame[data-t]')) {
      for (const a of f.getAnimations({ subtree: true })) { a.pause(); a.currentTime = Number(f.dataset.t); }
    }
    return sheet.scrollHeight;
  }, { skin, SPIN_T, REVEAL_T });
  await page.setViewportSize({ width: 1400, height: height + 10 });
  await page.waitForTimeout(300);
  const out = path.join(ROOT, 'skin-previews', `${skin}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log(out);
  await page.close();
}
await browser.close();
