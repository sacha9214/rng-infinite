// Bannière de la page de dons (Ko-fi) : 1500 × 500, aux couleurs du site.   node tools/kofi-cover.mjs → brand/kofi-cover.png
import path from 'node:path';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(ROOT, 'tools/.deps/package.json'));
const { firefox } = require('playwright');
const loop = (cx, cy, a) => { let d = ''; for (let i = 0; i <= 240; i++) { const t = (i / 240) * Math.PI * 2, s = Math.sin(t), c = Math.cos(t), k = a / (1 + s * s); d += `${i ? 'L' : 'M'}${(cx + k * c).toFixed(1)} ${(cy + k * s * c * 1.18).toFixed(1)}`; } return d + 'Z'; };
const card = (x, y, n, a, b, rot) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(.82)"><rect x="-150" y="-52" width="300" height="104" rx="20" fill="#15121f" stroke="${a}" stroke-width="4"/><rect x="-150" y="-52" width="300" height="104" rx="20" fill="${b}" opacity=".16"/><text y="26" text-anchor="middle" font-family="'Space Mono', monospace" font-weight="700" font-size="74" fill="${a}">${n}</text></g>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 500" width="1500" height="500">
  <defs>
    <radialGradient id="bg" cx="30%" cy="40%" r="90%"><stop offset="0" stop-color="#2a1d47"/><stop offset=".5" stop-color="#14101f"/><stop offset="1" stop-color="#0a0810"/></radialGradient>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f472b6"/><stop offset=".5" stop-color="#c084fc"/><stop offset="1" stop-color="#818cf8"/></linearGradient>
    <filter id="glow" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="22"/></filter>
  </defs>
  <rect width="1500" height="500" fill="url(#bg)"/>
  <g fill="#fff" opacity=".45">${Array.from({ length: 60 }, (_, i) => `<circle cx="${(i * 197) % 1500}" cy="${(i * 113) % 500}" r="${1 + (i % 3) * .7}"/>`).join('')}</g>
  <path d="${loop(260, 250, 150)}" fill="none" stroke="url(#g)" stroke-width="58" filter="url(#glow)" opacity=".7"/>
  <path d="${loop(260, 250, 150)}" fill="none" stroke="url(#g)" stroke-width="38" stroke-linejoin="round"/>
  <text x="470" y="215" font-family="Inter, sans-serif" font-weight="900" font-size="118" letter-spacing="6" fill="#fff">RNG∞</text>
  <text x="474" y="278" font-family="Inter, sans-serif" font-weight="600" font-size="30" fill="#d4d4d8">A free random number game. No ads.</text>
  <text x="474" y="336" font-family="Inter, sans-serif" font-weight="700" font-size="26" fill="#fda4af">💗 Server fund · tips keep the game online</text>
  <text x="474" y="392" font-family="'Space Mono', monospace" font-weight="700" font-size="28" fill="#a5b4fc">rng-infinite.com</text>
  ${card(1310, 140, '777777', '#f9a8d4', '#db2777', 6)}${card(1280, 262, '314159', '#c4b5fd', '#7c3aed', -5)}${card(1320, 380, '123456', '#93c5fd', '#2563eb', 4)}
</svg>`;
const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 500 } });
await page.setContent(`<link href="https://fonts.googleapis.com/css2?family=Inter:wght@600;700;900&family=Space+Mono:wght@700&display=swap" rel="stylesheet"><style>body{margin:0}</style>${svg}`);
await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700);
await page.screenshot({ path: path.join(ROOT, 'brand/kofi-cover.png') });
await browser.close();
console.log('brand/kofi-cover.png');
