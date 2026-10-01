// Rendu du trailer image par image.
// Playwright ouvre trailer/index.html?export à la taille du film, appelle window.__seek(t) pour chaque image et envoie
// les captures à ffmpeg : le résultat ne dépend pas de la vitesse de la machine.
//   node tools/trailer-render.mjs               → trailer/out/rng-infinite-trailer-16x9.mp4 et -9x16.mp4 (rendu rapide)
//   node tools/trailer-render.mjs --pro         → rendu final : flou de mouvement, grain fin, bande-son, 6 navigateurs
//   node tools/trailer-render.mjs h | v         → un seul format
//   node tools/trailer-render.mjs --cut 15      → version courte de 15 s (ou --cut 6) ; fichiers "-15s" / "-6s"
// Options :
//   --blur N     flou de mouvement réel : N instants par image, moyennés en lumière linéaire (16 avec --pro)
//   --shutter A  angle d'obturateur en degrés (180 = l'image "voit" la moitié de son intervalle)
//   --grain S    grain fin sur la luminance : casse les paliers des dégradés sombres après compression (4 avec --pro)
//   --jobs J     J navigateurs en parallèle : le film est rendu en J segments, recollés sans réencodage
//   --sound      ajoute la bande-son synthétisée (tools/trailer-audio.mjs) : musique + effets dans le fichier principal ;
//                dans variants/ : "-sfx" (effets seuls, pour poser une autre musique) et "-silent" (muet)
//   --light      ajoute une copie légère (~9 Mo) pour Discord, dans variants/
//   --fps 60  --from 0  --to 27  --crf 16  --out dossier  --name fichier.mp4
// Outils :
//   node tools/trailer-render.mjs h --sheet 0:27:0.5    → planche d'images (début:fin:pas, ou liste 1.2,4.4,…)
//   node tools/trailer-render.mjs h --frame 4.4         → une image en taille réelle (--clean : sans l'heure incrustée)
//   node tools/trailer-render.mjs --check a.mp4 [b.mp4] → contrôle de fluidité d'un fichier (sans grain)
// Une fois : npm i --prefix tools/.deps playwright@1 (le Chrome du système suffit) ; ffmpeg doit être installé.
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderAudio, writeWav } from './trailer-audio.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const require = createRequire(path.join(ROOT, 'tools/.deps/package.json'));

const args = process.argv.slice(2);
const has = name => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const PRO = has('pro');
const BLUR = Number(opt('blur', PRO ? 16 : 1)), SHUTTER = Number(opt('shutter', 180)), GRAIN = Number(opt('grain', PRO ? 4 : 0));
const JOBS = Number(opt('jobs', PRO ? 6 : 1)), SOUND = PRO || has('sound'), LIGHT = PRO || has('light'), CRF = String(opt('crf', 16));
const OUT = path.resolve(opt('out', path.join(ROOT, 'trailer/out'))), VARIANTS = path.join(OUT, 'variants');
const CUT = opt('cut', ''); // '' = film complet, '15' ou '6' = version courte
const X264 = ['-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
const ffmpeg = (list, o = {}) => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...list], { encoding: 'utf8', maxBuffer: 1 << 27, ...o });
  if (r.status) throw new Error(`ffmpeg ${list.join(' ').slice(0, 200)}…\n${r.stderr}`);
  return r;
};

// ------------------------------------------------------------------ contrôle de fluidité
// Chaque image est rendue à l'heure exacte, donc une saccade ne vient jamais de la machine : elle vient d'une animation
// qui s'arrête net puis repart (une montée pilotée par une valeur mal répartie, une carte posée qui ne bouge plus du
// tout…). On mesure combien chaque image diffère de la précédente et on signale les arrêts nets : au moins 2 images
// quasi figées, précédées et suivies d'un mouvement franc. Une planche d'images ne montre pas ce défaut.
const STILL = 0.15, MOVING = 1.5; // écart moyen de luminosité entre deux images (0 à 255)
function readDiffs(text, offset = 0) {
  const out = [];
  let at = null;
  for (const line of text.split('\n')) {
    let m = /pts_time:([\d.]+)/.exec(line);
    if (m) { at = Number(m[1]) + offset; continue; }
    m = /YAVG=([\d.]+)/.exec(line);
    if (m && at !== null) out.push([at, Number(m[1])]);
  }
  return out;
}
function reportStops(name, diffs) {
  const stops = [];
  for (let i = 0; i < diffs.length;) {
    if (diffs[i][1] >= STILL) { i++; continue; }
    let j = i;
    while (j < diffs.length && diffs[j][1] < STILL) j++;
    const near = (a, b) => Math.max(0, ...diffs.slice(Math.max(0, a), b).map(d => d[1]));
    if (j - i >= 2 && near(i - 4, i) > MOVING && near(j, j + 4) > MOVING) stops.push(`${diffs[i][0].toFixed(2)}–${diffs[j - 1][0].toFixed(2)} s (${j - i} images figées)`);
    i = j;
  }
  console.log(stops.length ? `⚠️  ${name} : ${stops.length} arrêt(s) net(s) en plein mouvement → ${stops.join(', ')}`
    : `fluidité OK — ${name} : ${diffs.length} images, aucun arrêt net en plein mouvement`);
  return stops.length === 0;
}
const DIFF = 'tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG';
// Sur un fichier déjà encodé (sans grain : le grain fait différer toutes les images et masque les arrêts).
const motionCheck = file => reportStops(path.basename(file), readDiffs(ffmpeg(['-i', file, '-vf', `${DIFF}:file=-`, '-f', 'null', '-']).stdout));

if (args[0] === '--check') process.exit(args.slice(1).map(motionCheck).every(Boolean) ? 0 : 1);

// ------------------------------------------------------------------ navigateur
const pw = require('playwright');
const useFirefox = opt('browser', 'chrome') === 'firefox';
const launch = () => (useFirefox ? pw.firefox.launch() : pw.chromium.launch({ channel: 'chrome' }));
async function openStage(browser, f, timecode) {
  const [width, height] = f === 'v' ? [1080, 1920] : [1920, 1080];
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'no-preference' });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('page error:', e.message); process.exitCode = 1; });
  page.on('console', m => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.goto(`file://${path.join(ROOT, 'trailer/index.html')}?export${f === 'v' ? '&format=v' : ''}${CUT ? `&cut=${CUT}` : ''}${timecode ? '&tc' : ''}`);
  await page.waitForFunction(() => window.__trailer || window.__trailerError, null, { timeout: 60000 });
  const failed = await page.evaluate(() => window.__trailerError);
  if (failed) throw new Error(failed);
  const meta = await page.evaluate(() => window.__trailer);
  if (CUT && meta.cut !== CUT) throw new Error(`Unknown cut: ${CUT}`);
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
  return { ctx, meta, shot };
}

// ------------------------------------------------------------------ un segment du film
// Flou de mouvement : chaque image est la moyenne de BLUR instants pris pendant que "l'obturateur est ouvert". La moyenne
// se fait en lumière linéaire (sinon ce qui est clair et rapide s'assombrit), sur 16 bits.
const GAMMA = e => `lutrgb=r='pow(val/maxval,${e})*maxval':g='pow(val/maxval,${e})*maxval':b='pow(val/maxval,${e})*maxval'`;
async function renderSegment(f, first, count, fps, mp4, diffFile) {
  const browser = await launch();
  const { shot } = await openStage(browser, f, false);
  const open = SHUTTER / 360 / fps; // durée d'ouverture de l'obturateur
  const blur = BLUR > 1 ? `format=gbrp16le,${GAMMA('2.2')},tmix=frames=${BLUR},select='not(mod(n+1,${BLUR}))',setpts=N/(${fps}*TB),${GAMMA('1/2.2')},` : '';
  // Deux sorties : le film (avec le grain), et la mesure image par image prise AVANT le grain pour le contrôle de fluidité.
  const graph = `[0:v]${blur}split[film][probe];`
    + `[film]scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv444p${GRAIN ? `,noise=c0s=${GRAIN}:c0f=t+u` : ''},format=yuv420p[v];`
    + `[probe]scale=480:-2:flags=bilinear,format=yuv420p,${DIFF}:file=${diffFile}[chk]`;
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps * BLUR), '-c:v', 'png', '-i', '-', '-filter_complex', graph,
    '-map', '[v]', '-r', String(fps), ...X264, '-crf', CRF, '-an', mp4, '-map', '[chk]', '-f', 'null', '-'], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < count; i++) {
    const t = (first + i) / fps;
    for (let k = 0; k < BLUR; k++) if (!ff.stdin.write(await shot(t + (k * open) / BLUR))) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await once(ff, 'close');
  await browser.close();
  if (code) throw new Error(`ffmpeg: code ${code}`);
}
if (args[0] === '--segment') { // lancé par le rendu principal, un par navigateur
  const [f, first, count, fps, mp4, diffFile] = args.slice(1);
  await renderSegment(f, Number(first), Number(count), Number(fps), mp4, diffFile);
  process.exit(0);
}

// ------------------------------------------------------------------ rendu principal
const formats = args[0] === 'h' || args[0] === 'v' ? [args[0]] : ['h', 'v'];
const sheet = opt('sheet', null), single = opt('frame', null);
fs.mkdirSync(OUT, { recursive: true });
const times = spec => {
  if (!spec.includes(':')) return spec.split(',').map(Number);
  const [a, b, step] = spec.split(':').map(Number), list = [];
  for (let t = a; t <= b + 1e-9; t += step) list.push(Math.round(t * 1000) / 1000);
  return list;
};

if (sheet !== null || single !== null) {
  const browser = await launch();
  for (const f of formats) {
    const { ctx, shot } = await openStage(browser, f, !has('clean'));
    if (single !== null) {
      for (const t of times(single)) {
        const file = path.join(OUT, `frame-${f}-${t.toFixed(2)}.png`);
        fs.writeFileSync(file, await shot(t));
        console.log(file);
      }
    } else {
      const list = times(sheet), dir = path.join(OUT, `.sheet-${f}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < list.length; i++) fs.writeFileSync(path.join(dir, `${String(i).padStart(4, '0')}.png`), await shot(list[i]));
      const cols = Number(opt('cols', f === 'v' ? 6 : 4)), cell = f === 'v' ? 320 : 480, rows = Math.ceil(list.length / cols);
      const file = path.join(OUT, opt('name', `sheet-${f}.png`));
      ffmpeg(['-framerate', '1', '-i', path.join(dir, '%04d.png'), '-vf', `scale=${cell}:-1:flags=lanczos,tile=${cols}x${rows}:padding=6:margin=6:color=0x202020`, '-frames:v', '1', file]);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(file, `(${list.length} images, ${list[0]} → ${list[list.length - 1]} s)`);
    }
    await ctx.close();
  }
  await browser.close();
  process.exit(process.exitCode || 0);
}

// Le film décrit lui-même sa durée, sa cadence et ses repères sonores.
const probe = await launch();
const { meta } = await openStage(probe, formats[0], false);
await probe.close();
const fps = Number(opt('fps', meta.fps)), first = Math.round(Number(opt('from', 0)) * fps), total = Math.round(Number(opt('to', meta.duration)) * fps) - first;
const whole = first === 0 && total === Math.round(meta.duration * fps);

// Bande-son : synthétisée une fois par mixage (musique + effets, et effets seuls), puis montée à −15 LUFS (niveau courant
// sur les plateformes), crêtes retenues à −1,5 dB.
function soundtrack(name, withMusic) {
  const wav = path.join(OUT, `.trailer-${name}.wav`);
  const { L, R } = renderAudio(meta.cues, meta.duration, { withMusic });
  writeWav(wav, L, R);
  const summary = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.split('Summary:')[1] || '';
  const loud = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  const boost = loud ? Math.max(0, Math.min(9, -15 - Number(loud[1]))) : 0;
  console.log(`bande-son (${name}) : ${meta.cues.length} repères, ${loud ? loud[1] : '?'} LUFS → montée de ${boost.toFixed(1)} dB`);
  return { wav, filter: `volume=${boost.toFixed(2)}dB,alimiter=limit=0.84:attack=2:release=80:level=false` };
}
const audio = SOUND && whole ? { full: soundtrack('full', true), sfx: soundtrack('sfx', false) } : null;
const mux = (video, track, file, rate = '192k') => ffmpeg(['-i', video, '-i', track.wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', track.filter, '-c:a', 'aac', '-b:a', rate, '-ar', '48000', '-movflags', '+faststart', file]);
if (audio || LIGHT) fs.mkdirSync(VARIANTS, { recursive: true });

for (const f of formats) {
  const started = Date.now(), tag = `${f === 'v' ? '9x16' : '16x9'}${CUT ? `-${CUT}s` : ''}`, base = `rng-infinite-trailer-${tag}`;
  const final = path.join(OUT, opt('name', `${base}.mp4`)), variant = suffix => path.join(VARIANTS, `${base}-${suffix}.mp4`);
  const jobs = Math.max(1, Math.min(JOBS, Math.floor(total / 30)));
  const parts = Array.from({ length: jobs }, (_, j) => {
    const a = first + Math.floor((total * j) / jobs), b = first + Math.floor((total * (j + 1)) / jobs);
    return { a, n: b - a, mp4: path.join(OUT, `.seg-${f}-${j}.mp4`), diff: path.join(OUT, `.seg-${f}-${j}.txt`) };
  });
  console.log(`${tag} : ${total} images${BLUR > 1 ? ` × ${BLUR} instants (flou de mouvement)` : ''}, ${jobs} navigateur(s)…`);
  if (jobs === 1) await renderSegment(f, parts[0].a, parts[0].n, fps, parts[0].mp4, parts[0].diff);
  else {
    await Promise.all(parts.map(p => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SELF, '--segment', f, p.a, p.n, fps, p.mp4, p.diff, '--blur', BLUR, '--shutter', SHUTTER, '--grain', GRAIN, '--crf', CRF, ...(CUT ? ['--cut', CUT] : [])].map(String), { stdio: 'inherit' });
      child.on('close', code => (code ? reject(new Error(`segment ${p.a} : code ${code}`)) : resolve()));
    })));
  }
  // Recollage des segments (chacun commence par une image clé : copie sans réencodage).
  const video = path.join(OUT, `.video-${f}.mp4`), list = path.join(OUT, `.seg-${f}.txt`);
  fs.writeFileSync(list, parts.map(p => `file '${p.mp4}'`).join('\n'));
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video]);
  const ok = reportStops(path.basename(final), parts.flatMap(p => readDiffs(fs.readFileSync(p.diff, 'utf8'), (p.a - first) / fps)));
  if (!ok) process.exitCode = 1;
  [list, ...parts.flatMap(p => [p.mp4, p.diff])].forEach(x => fs.rmSync(x, { force: true }));

  if (audio) {
    mux(video, audio.full, final);
    mux(video, audio.sfx, variant('sfx'));
    fs.renameSync(video, variant('silent'));
  } else fs.renameSync(video, final);

  if (LIGHT && whole && fs.statSync(final).size > 9.5e6) { // copie légère : deux passes à débit fixe pour tomber juste sous 10 Mo ; le grain est retiré (il coûte trop cher à ce débit)
    const light = variant('light'), log = path.join(OUT, `.2pass-${f}`);
    const rate = Math.floor((9.3e6 * 8) / meta.duration / 1000) - (audio ? 128 : 0);
    const common = ['-i', final, '-vf', GRAIN ? 'hqdn3d=2:1.5:4:3' : 'null', ...X264, '-b:v', `${rate}k`, '-passlogfile', log];
    ffmpeg([...common, '-pass', '1', '-an', '-f', 'null', '-']);
    ffmpeg([...common, '-pass', '2', ...(audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']), '-movflags', '+faststart', light]);
    fs.readdirSync(OUT).filter(x => x.startsWith(`.2pass-${f}`)).forEach(x => fs.rmSync(path.join(OUT, x)));
  }
  const mb = x => (fs.statSync(x).size / 1e6).toFixed(1);
  console.log(`${final} — ${mb(final)} Mo, ${total} images à ${fps} img/s en ${Math.round((Date.now() - started) / 1000)} s`);
}
if (audio) [audio.full.wav, audio.sfx.wav].forEach(x => fs.rmSync(x, { force: true }));
