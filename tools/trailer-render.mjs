// Rendu du trailer image par image.
// Playwright ouvre trailer/index.html?export à la taille du film, appelle window.__seek(t) pour chaque image et envoie
// les captures à ffmpeg : le résultat ne dépend pas de la vitesse de la machine.
//   node tools/trailer-render.mjs               → trailer/out/rng-infinite-trailer-16x9.mp4 et -9x16.mp4
//   node tools/trailer-render.mjs h | v         → un seul format
//   options : --fps 60  --from 0  --to 27  --crf 16  --out dossier  --browser chrome|firefox
//   node tools/trailer-render.mjs h --sheet 0:27:0.5    → planche d'images (début:fin:pas, ou liste 1.2,4.4,…) pour juger le film
//   node tools/trailer-render.mjs h --frame 4.4         → une image en taille réelle
//   node tools/trailer-render.mjs --check a.mp4 [b.mp4] → contrôle de fluidité seul (il est fait d'office après chaque rendu)
// Une fois : npm i --prefix tools/.deps playwright@1 (le Chrome du système suffit) ; ffmpeg doit être installé.
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'tools/.deps/package.json'));
const pw = require('playwright');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

// Contrôle de fluidité. Chaque image est rendue à l'heure exacte, donc une saccade ne vient jamais de la machine : elle
// vient d'une animation qui s'arrête net puis repart (une montée pilotée par une valeur mal répartie, une carte posée qui
// ne bouge plus du tout…). On mesure combien chaque image diffère de la précédente et on signale les arrêts nets : au
// moins 2 images quasi figées, précédées et suivies d'un mouvement franc. Une planche d'images ne montre pas ce défaut.
const STILL = 0.15, MOVING = 1.5; // écart moyen de luminosité entre deux images (0 à 255)
function motionCheck(file) {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf',
    'tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 27 });
  if (r.status) throw new Error(`ffmpeg: ${r.stderr}`);
  const t = [], v = [];
  let at = null;
  for (const line of r.stdout.split('\n')) {
    let m = /pts_time:([\d.]+)/.exec(line);
    if (m) { at = Number(m[1]); continue; }
    m = /YAVG=([\d.]+)/.exec(line);
    if (m && at !== null) { t.push(at); v.push(Number(m[1])); }
  }
  const stops = [];
  for (let i = 0; i < v.length;) {
    if (v[i] >= STILL) { i++; continue; }
    let j = i;
    while (j < v.length && v[j] < STILL) j++;
    const before = Math.max(0, ...v.slice(Math.max(0, i - 4), i)), after = Math.max(0, ...v.slice(j, j + 4));
    if (j - i >= 2 && before > MOVING && after > MOVING) stops.push(`${t[i].toFixed(2)}–${t[j - 1].toFixed(2)} s (${j - i} images figées)`);
    i = j;
  }
  console.log(stops.length ? `⚠️  ${path.basename(file)} : ${stops.length} arrêt(s) net(s) en plein mouvement → ${stops.join(', ')}`
    : `fluidité OK — ${path.basename(file)} : ${v.length} images, aucun arrêt net en plein mouvement`);
  return stops.length === 0;
}
if (args[0] === '--check') {
  const ok = args.slice(1).map(motionCheck).every(Boolean);
  process.exit(ok ? 0 : 1);
}
const formats = args[0] === 'h' || args[0] === 'v' ? [args[0]] : ['h', 'v'];
const OUT = path.resolve(opt('out', path.join(ROOT, 'trailer/out')));
const sheet = opt('sheet', null), single = opt('frame', null), still = sheet !== null || single !== null;
fs.mkdirSync(OUT, { recursive: true });

const times = spec => {
  if (!spec.includes(':')) return spec.split(',').map(Number);
  const [a, b, step] = spec.split(':').map(Number), list = [];
  for (let t = a; t <= b + 1e-9; t += step) list.push(Math.round(t * 1000) / 1000);
  return list;
};

const useFirefox = opt('browser', 'chrome') === 'firefox';
const browser = useFirefox ? await pw.firefox.launch() : await pw.chromium.launch({ channel: 'chrome' });

for (const f of formats) {
  const [width, height] = f === 'v' ? [1080, 1920] : [1920, 1080];
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('page error:', e.message); process.exitCode = 1; });
  page.on('console', m => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.goto(`file://${path.join(ROOT, 'trailer/index.html')}?export${f === 'v' ? '&format=v' : ''}${still ? '&tc' : ''}`);
  await page.waitForFunction(() => window.__trailer || window.__trailerError, null, { timeout: 60000 });
  const failed = await page.evaluate(() => window.__trailerError);
  if (failed) throw new Error(failed);
  const meta = await page.evaluate(() => window.__trailer);
  // Le badge perso du site (nombres contenant "235") ne doit jamais être à l'écran : contrôle en plus de celui de la page.
  const banned = meta.numbers.filter(n => String(n).includes('235'));
  if (banned.length) throw new Error(`Hidden badge on screen: ${banned.join(', ')}`);

  const cdp = useFirefox ? null : await ctx.newCDPSession(page);
  const shot = async t => {
    await page.evaluate(x => window.__seek(x), t);
    if (!cdp) return page.screenshot({ type: 'png' });
    // optimizeForSpeed : PNG toujours sans perte, mais peu compressé (3 à 4 fois plus rapide ; ffmpeg réencode de toute façon).
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    return Buffer.from(data, 'base64');
  };

  if (single !== null) {
    for (const t of times(single)) {
      const file = path.join(OUT, `frame-${f}-${t.toFixed(2)}.png`);
      fs.writeFileSync(file, await shot(t));
      console.log(file);
    }
  } else if (sheet !== null) {
    const list = times(sheet), dir = path.join(OUT, `.sheet-${f}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < list.length; i++) fs.writeFileSync(path.join(dir, `${String(i).padStart(4, '0')}.png`), await shot(list[i]));
    const cols = Number(opt('cols', f === 'v' ? 6 : 4)), cell = f === 'v' ? 320 : 480, rows = Math.ceil(list.length / cols);
    const file = path.join(OUT, opt('name', `sheet-${f}.png`));
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(dir, '%04d.png'),
      '-vf', `scale=${cell}:-1:flags=lanczos,tile=${cols}x${rows}:padding=6:margin=6:color=0x202020`, '-frames:v', '1', file], { stdio: 'inherit' });
    if (r.status) process.exitCode = 1;
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(file, `(${list.length} images, ${list[0]} → ${list[list.length - 1]} s)`);
  } else {
    const fps = Number(opt('fps', meta.fps)), from = Number(opt('from', 0)), to = Number(opt('to', meta.duration));
    const total = Math.round((to - from) * fps);
    const file = path.join(OUT, opt('name', `rng-infinite-trailer-${f === 'v' ? '9x16' : '16x9'}.mp4`));
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
      '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opt('crf', 16)), '-profile:v', 'high', '-level', '4.2',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', '-an', file], { stdio: ['pipe', 'inherit', 'inherit'] });
    const started = Date.now();
    for (let i = 0; i < total; i++) {
      if (!ff.stdin.write(await shot(from + i / fps))) await once(ff.stdin, 'drain');
      if (i % 120 === 0) process.stdout.write(`\r${f} ${i}/${total} images`);
    }
    ff.stdin.end();
    const [code] = await once(ff, 'close');
    if (code) process.exitCode = 1;
    console.log(`\r${file} — ${total} images à ${fps} img/s en ${Math.round((Date.now() - started) / 1000)} s`);
    if (!code && !motionCheck(file)) process.exitCode = 1;
  }
  await ctx.close();
}
await browser.close();
