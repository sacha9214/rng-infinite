// Photo de profil des chaînes (YouTube, TikTok) : carré 1024 px, tout le motif tient dans le cercle de recadrage.
//   node tools/avatar.mjs   →   brand/avatar.png, brand/avatar-rng.png (+ aperçu rond brand/avatar-preview.png)
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(ROOT, 'tools/.deps/package.json'));
const { firefox } = require('playwright');

// Lemniscate de Bernoulli, tracée en points : ne dépend d'aucune police.
const loop = (cx, cy, a) => { let d = ''; for (let i = 0; i <= 240; i++) { const t = (i / 240) * Math.PI * 2, s = Math.sin(t), c = Math.cos(t), k = a / (1 + s * s); d += `${i ? 'L' : 'M'}${(cx + k * c).toFixed(1)} ${(cy + k * s * c * 1.18).toFixed(1)}`; } return d + 'Z'; };
const svg = withText => {
  const cy = withText ? 590 : 512, a = withText ? 250 : 285, w = withText ? 58 : 66;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <radialGradient id="bg" cx="50%" cy="46%" r="72%"><stop offset="0" stop-color="#241a3d"/><stop offset=".55" stop-color="#14101f"/><stop offset="1" stop-color="#0a0810"/></radialGradient>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f472b6"/><stop offset=".5" stop-color="#c084fc"/><stop offset="1" stop-color="#818cf8"/></linearGradient>
    <filter id="glow" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="34"/></filter>
    <filter id="soft" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="10"/></filter>
  </defs>
  <rect width="1024" height="1024" fill="url(#bg)"/>
  <g fill="#fff" opacity=".5">${[[190, 300, 3], [820, 250, 4], [760, 800, 3], [250, 770, 4], [512, 160, 3], [880, 540, 2.5], [140, 540, 2.5], [640, 880, 2.5], [380, 860, 2]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('')}</g>
  <path d="${loop(512, cy, a)}" fill="none" stroke="url(#g)" stroke-width="${w + 30}" stroke-linejoin="round" filter="url(#glow)" opacity=".75"/>
  <path d="${loop(512, cy, a)}" fill="none" stroke="url(#g)" stroke-width="${w}" stroke-linejoin="round"/>
  <path d="${loop(512, cy, a)}" fill="none" stroke="#fff" stroke-width="${w * .16}" stroke-linejoin="round" opacity=".55" filter="url(#soft)"/>
  ${withText ? `<text x="512" y="372" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-weight="900" font-size="210" letter-spacing="14" fill="#fff">RNG</text>` : ''}
</svg>`;
};
fs.mkdirSync(path.join(ROOT, 'brand'), { recursive: true });
const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
for (const [name, withText] of [['avatar', false], ['avatar-rng', true]]) {
  await page.setContent(`<link href="https://fonts.googleapis.com/css2?family=Inter:wght@900&display=swap" rel="stylesheet"><style>body{margin:0}</style>${svg(withText)}`);
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(ROOT, 'brand', name + '.png') });
}
// Aperçu : les deux versions recadrées en rond, en grand et à la taille d'un commentaire.
await page.setViewportSize({ width: 900, height: 420 });
await page.setContent(`<style>body{margin:0;background:#1b1b1f;display:flex;gap:28px;align-items:center;justify-content:center;height:420px}img{border-radius:50%}</style>
  ${['avatar', 'avatar-rng'].map(n => { const u = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'brand', n + '.png')).toString('base64'); return `<img src="${u}" width="300"><img src="${u}" width="88"><img src="${u}" width="36">`; }).join('')}`);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(ROOT, 'brand', 'avatar-preview.png') });
await browser.close();
console.log('brand/avatar.png, brand/avatar-rng.png');
