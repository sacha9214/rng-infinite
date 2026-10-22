// Fluidité de la fusée du Crash : position de la fusée à chaque image pendant 1,5 s de vol. Une animation fluide donne
// une position différente à (presque) chaque image ; des à-coups donnent de longues suites d'images identiques.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../.deps/package.json', import.meta.url));
const { firefox } = require('playwright');
const B = 'http://localhost:8124';
const redis = cmds => fetch(B + '/__dev/redis', { method: 'POST', body: JSON.stringify(cmds) }).then(r => r.json());
const browser = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
const p = await (await browser.newContext({ viewport: { width: 390, height: 780 } })).newPage();
await p.addInitScript(() => { const tr = CanvasRenderingContext2D.prototype.translate; window.__rocket = []; CanvasRenderingContext2D.prototype.translate = function (x, y) { if (this.canvas && this.canvas.id === 'cr-canvas') window.__rocket.push([performance.now(), x, y]); return tr.call(this, x, y); }; });
await p.goto(B + '/'); await p.waitForTimeout(700); await p.keyboard.press('Escape'); await p.waitForTimeout(300);
await p.getByRole('button', { name: /^Generate/ }).first().click(); await p.fill('#modal-root input', 'Sm' + (Date.now() % 100000)); await p.getByRole('button', { name: /Save/ }).click();
await p.waitForTimeout(2500); await p.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 120000 });
const id = await p.evaluate(() => JSON.parse(localStorage.getItem('rnginf.v1')).player.id);
await redis([['HINCRBY', `stats:${id}`, 'bonus', 30000], ['HSET', `stats:${id}`, 'rolls', 40]]);
await p.goto(B + '/#/gamble'); await p.waitForSelector('#cr-go'); await p.waitForTimeout(1500);
for (let tries = 0; tries < 6; tries++) {
  await p.evaluate(() => { window.__rocket.length = 0; document.querySelector('#cr-result').textContent = ''; });
  await p.locator('#cr-go').click(); await p.waitForTimeout(1700);
  const s = await p.evaluate(() => ({ state: document.querySelector('#cr-screen').dataset.state, pts: window.__rocket.slice() }));
  if (s.state !== 'run' || s.pts.length < 60) { await p.waitForTimeout(1500); if (s.state === 'run') await p.locator('#cr-go').click(); await p.waitForTimeout(800); continue; }
  const pts = s.pts.slice(-80); let moved = 0, longest = 0, run = 0;
  for (let i = 1; i < pts.length; i++) { if (Math.abs(pts[i][1] - pts[i - 1][1]) > 1e-6 || Math.abs(pts[i][2] - pts[i - 1][2]) > 1e-6) { moved++; run = 0; } else longest = Math.max(longest, ++run); }
  console.log(JSON.stringify({ images: pts.length - 1, 'images où la fusée a bougé': moved, 'plus longue suite d\'images figées': longest }));
  break;
}
await browser.close();
