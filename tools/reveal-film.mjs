// Film de la révélation d'un tirage, dans le vrai jeu. Pour juger une animation avant de la publier : une description
// ne suffit pas, il faut la voir image par image, mesurer sa fluidité, et la montrer.
//   node tools/dev.mjs                              (dans un autre terminal)
//   node tools/reveal-film.mjs                      → planches d'images aux temps forts : reveal-films/<nom>-roll.png,
//                                                     -badges.png, -rarity.png (chiffres, dernier rouleau, badges, rareté)
//   node tools/reveal-film.mjs --at 2040,2100,8250  → une seule planche, aux instants donnés (ms depuis le début)
//   node tools/reveal-film.mjs --measure            → aucune capture, seulement la fluidité (les captures ralentissent la page)
//   node tools/reveal-film.mjs --video [--sound]    → reveal-films/<nom>.mp4 : les images produites par le navigateur, à leurs
//                                                     instants réels, avec le son du jeu si --sound
// Réglages : --n 777777 (le nombre tiré)  --skin fire  --theme dark|light  --speed normal|dramatic  --phone
//            --view 1280x760 (taille de la fenêtre)  --crop (cadré sur la carte : 640 × 360 autour d'elle, deux fois plus fin)
//            --reduced (« réduire les animations »)  --name essai  --out dossier  --site http://localhost:8124
// Le nombre est fourni par l'outil : aucun tirage n'est demandé au serveur. Le haut-parleur de la machine ne sert pas.
// Une fois : npm i --prefix tools/.deps playwright@1 (le Chrome du système suffit) ; ffmpeg doit être installé.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { TAP } from './audio-tap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pw = createRequire(path.join(ROOT, 'tools/.deps/package.json'))('playwright');
const { engine } = createRequire(import.meta.url)(path.join(ROOT, 'api/_lib.js'));

const args = process.argv.slice(2);
const has = name => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const N = Number(opt('n', 777777)), THEME = opt('theme', 'dark'), PHONE = has('phone'), SKIN = opt('skin', ''), SPEED = opt('speed', 'normal');
const SITE = opt('site', 'http://localhost:8124').replace(/\/$/, ''), OUT = path.resolve(opt('out', path.join(ROOT, 'reveal-films')));
const MEASURE = has('measure'), VIDEO = has('video') && !MEASURE, SOUND = VIDEO && has('sound'), CROP = has('crop');
const NAME = opt('name', [N, THEME, PHONE && 'phone', SKIN, SPEED !== 'normal' && SPEED].filter(Boolean).join('-'));
const [VW, VH] = opt('view', PHONE ? '390x780' : '1280x760').split('x').map(Number), DSF = PHONE || VIDEO ? 2 : 1;
fs.mkdirSync(OUT, { recursive: true });
const ffmpeg = list => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...list], { encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); };

// Les instants de la révélation : mêmes valeurs que REVEAL, SPEEDS, digitDelay et badgeDelay dans js/app.js.
const REVEAL = { digitStart: 2000, digitBase: 1000, digitMax: 2000, badgeStart: 1000, badgeBase: 500, badgeMax: 1500, summary: 1500, rarity: 1000, stats: 250, lifetimeShow: 1000, lifetimePause: 1500, lifetimeTick: 1500, end: 500 };
const { badges: kb, base: k } = { dramatic: { badges: 1, base: 1 }, normal: { badges: .85, base: .6 } }[SPEED];
const a = engine.analyze(N), slots = Math.max(6, a.str.length), count = a.groups.length;
const locks = [REVEAL.digitStart];
for (let i = 1; i < slots; i++) locks.push(locks[i - 1] + REVEAL.digitBase + (REVEAL.digitMax - REVEAL.digitBase) * Math.pow((i - 1) / (slots - 1), 2));
const last = locks[slots - 1], badgeAt = [];
let clock = last;
for (let i = 0; i < count; i++) {
  clock += (i === 0 ? REVEAL.badgeStart : count <= 1 ? REVEAL.badgeBase : REVEAL.badgeBase + (REVEAL.badgeMax - REVEAL.badgeBase) * Math.pow((i - 1) / (count - 1), 1.5)) * kb;
  badgeAt.push(clock);
}
const rarity = clock + (REVEAL.summary + REVEAL.rarity) * k;
const end = rarity + (REVEAL.stats + REVEAL.lifetimeShow + REVEAL.lifetimePause + REVEAL.lifetimeTick + REVEAL.end) * k;

// Les planches : [nom, instants en ms depuis le début de la révélation]. Aucune pendant une vidéo ou une mesure.
const custom = opt('at', '');
const SHEETS = MEASURE || VIDEO ? [] : custom ? [['at', custom.split(',').map(Number)]] : [
  ['roll', [60, 500, 1500, locks[0] + 30, locks[0] + 110, locks[0] + 260, locks[1] + 60, locks[2] + 60, locks[3] + 60, locks[4] + 60, locks[4] + 400,
    last - 900, last - 650, last - 400, last - 200, last - 60, last + 20, last + 70, last + 130, last + 220, last + 350, last + 550, last + 800, last + 950]],
  ['badges', count ? [badgeAt[0] + 60, badgeAt[0] + 200, badgeAt[0] + 450, badgeAt[Math.min(1, count - 1)] + 120, badgeAt[Math.floor(count / 2)] + 120, badgeAt[count - 1] + 60, badgeAt[count - 1] + 200, badgeAt[count - 1] + 500, rarity - 500, rarity - 120] : []],
  ['rarity', [rarity + 20, rarity + 60, rarity + 110, rarity + 170, rarity + 240, rarity + 330, rarity + 450, rarity + 600, rarity + 800, rarity + 1100, rarity + 1500, rarity + 2100, rarity + 3000, end + 600, end + 2500]],
].filter(s => s[1].length);

const browser = await pw.chromium.launch({ channel: 'chrome', args: ['--mute-audio'] });
const context = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, isMobile: PHONE, hasTouch: PHONE, colorScheme: THEME === 'light' ? 'light' : 'dark', reducedMotion: has('reduced') ? 'reduce' : 'no-preference' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
if (SOUND) await page.addInitScript(TAP);
await page.addInitScript(([saved, tagged]) => {
  localStorage.setItem('rnginf.v1', saved);
  // Début de la révélation (apparition de la carte) et premier chiffre posé, à l'heure de l'horloge murale ; puis la
  // durée de chaque image affichée, et l'heure dans le coin des planches.
  const film = (window.__film = { began: 0, epoch: 0, firstLock: 0, frames: [], slow: [] });
  document.addEventListener('DOMContentLoaded', () => {
    const tag = document.createElement('div');
    tag.style.cssText = 'position:fixed;left:6px;top:6px;z-index:99999;padding:3px 7px;border-radius:5px;background:rgba(0,0,0,.72);color:#fff;font:700 13px/1.2 ui-monospace,Menlo,monospace;pointer-events:none';
    new MutationObserver(() => {
      if (!film.began && document.querySelector('#num-card')) { film.began = performance.now(); film.epoch = performance.timeOrigin + film.began; if (tagged) document.body.appendChild(tag); }
      if (!film.firstLock && document.querySelector('#num-card .slot.revealed')) film.firstLock = performance.timeOrigin + performance.now();
    }).observe(document.querySelector('#app'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    let prev = 0;
    const loop = now => {
      if (film.began) { if (prev) { film.frames.push(now - prev); if (now - prev > 25) film.slow.push([Math.round(now - film.began), Math.round(now - prev)]); } prev = now; tag.textContent = `${Math.round(now - film.began)} ms`; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}, [JSON.stringify({ version: 1, player: { id: 'a1b2c3d4e5f60718', secret: '00112233445566778899aabbccddeeff', name: 'Film' }, settings: { speed: SPEED, theme: THEME, sound: SOUND ? 'on' : 'off', achSeen: [], ...(SKIN ? { skin: SKIN } : {}) }, rolls: [] }), !VIDEO]);
await page.route('**/api/roll', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ n: N, s: engine.scoreOf(N), t: Date.now(), bestToday: false, dayRank: null, achievements: [] }) }));
await page.goto(`${SITE}/`, { waitUntil: 'load' });
await page.waitForTimeout(1500);

const cdp = await context.newCDPSession(page), shots = [], tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rng-film-')), made = [];
if (VIDEO) {
  cdp.on('Page.screencastFrame', f => { shots.push({ data: f.data, t: f.metadata.timestamp }); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, everyNthFrame: 1 });
}
await page.click('#roll-btn');
await page.waitForFunction(() => window.__film.began > 0, null, { timeout: 15000 });
// Cadrage sur la carte : sa position ne change pas pendant la révélation (la page s'allonge vers le bas).
const clip = CROP ? await page.evaluate(([w, h]) => {
  const r = document.querySelector('#card-stage').getBoundingClientRect(), cw = Math.min(w, innerWidth), chh = Math.min(h, innerHeight);
  return { x: Math.round(Math.max(0, Math.min(innerWidth - cw, r.left + r.width / 2 - cw / 2))), y: Math.round(Math.max(0, r.top + r.height / 2 - chh * .42)), width: cw, height: chh, scale: 2 };
}, [640, 360]) : null;

for (const [sheet, times] of SHEETS) {
  for (const [i, t] of times.entries()) {
    await page.waitForFunction(at => performance.now() - window.__film.began >= at, t, { timeout: 120000, polling: 'raf' });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, ...(clip ? { clip } : {}) });
    fs.writeFileSync(path.join(tmp, `${sheet}-${String(i).padStart(2, '0')}.png`), Buffer.from(shot.data, 'base64'));
  }
  const cols = CROP ? 4 : PHONE ? 6 : 4, w = CROP ? Math.round(clip.width) : PHONE ? 390 : 640, target = path.join(OUT, `${NAME}-${sheet}.png`);
  ffmpeg(['-framerate', '1', '-i', path.join(tmp, `${sheet}-%02d.png`), '-vf', `scale=${w}:-1,tile=${cols}x${Math.ceil(times.length / cols)}:padding=6:color=0x202028`, '-frames:v', '1', target]);
  made.push(target);
}
await page.waitForFunction(at => performance.now() - window.__film.began >= at, end + (VIDEO ? 3500 : 1500), { timeout: 180000 });

if (VIDEO) {
  await cdp.send('Page.stopScreencast');
  const list = shots.map((s, i) => { fs.writeFileSync(path.join(tmp, `v${i}.jpg`), Buffer.from(s.data, 'base64')); return `file '${path.join(tmp, `v${i}.jpg`)}'\nduration ${Math.max(.001, ((shots[i + 1] || s).t - s.t)).toFixed(4)}`; });
  fs.writeFileSync(path.join(tmp, 'list.txt'), `${list.join('\n')}\nfile '${path.join(tmp, `v${shots.length - 1}.jpg`)}'\n`);
  // Les captures n'ont pas forcément la taille de l'écran en pixels réels : le cadrage est donné en fractions de l'image.
  const crop = clip ? `crop=iw*${clip.width / VW}:ih*${clip.height / VH}:iw*${clip.x / VW}:ih*${clip.y / VH},` : '';
  const input = ['-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt')], sound = [];
  if (SOUND) {
    // Calage du son : le premier chiffre posé est le premier son fort de l'enregistrement ; on connaît son instant à l'image.
    const info = await page.evaluate(() => {
      const { L } = window.__rec.flat();
      let first = -1;
      for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > .15) { first = i; break; }
      return { wav: window.__rec.wav(), first, rate: window.__rec.rate, lock: window.__film.firstLock };
    });
    fs.writeFileSync(path.join(tmp, 'sound.wav'), Buffer.from(info.wav, 'base64'));
    const offset = info.first < 0 ? 0 : (info.lock / 1000 - shots[0].t) - info.first / info.rate; // retard du son sur l'image, en secondes
    console.log(`calage du son : ${offset.toFixed(3)} s (premier son fort à ${(info.first / info.rate).toFixed(2)} s, ${shots.length} images)`);
    sound.push(...(offset >= 0 ? ['-itsoffset', offset.toFixed(4)] : ['-ss', (-offset).toFixed(4)]), '-i', path.join(tmp, 'sound.wav'));
  }
  const target = path.join(OUT, `${NAME}.mp4`);
  ffmpeg([...input, ...sound, '-vf', `${crop}fps=60,scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', ...(SOUND ? ['-c:a', 'aac', '-b:a', '192k', '-shortest'] : []), '-movflags', '+faststart', target]);
  made.push(target);
}
// Fluidité : part des images restées plus de 25 ms à l'écran (une image dure 16,7 ms à 60 par seconde).
const { frames, slow: slowAt } = await page.evaluate(() => ({ frames: window.__film.frames, slow: window.__film.slow }));
const slow = frames.filter(f => f > 25).length, worst = Math.max(0, ...frames);
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`${N} (${a.tier}, ${count} badges) — chiffres à ${locks.map(Math.round).join(', ')} ms ; rareté à ${Math.round(rarity)} ms ; fin à ${Math.round(end)} ms`);
console.log(`fluidité : ${frames.length} images, ${(100 * slow / Math.max(1, frames.length)).toFixed(1)} % au-dessus de 25 ms, la pire ${worst.toFixed(0)} ms${VIDEO ? ` ; vidéo : ${shots.length} captures en ${(shots[shots.length - 1].t - shots[0].t).toFixed(1)} s` : ''}`);
if (slowAt.length) console.log(`images lentes [instant, durée en ms] : ${slowAt.slice(0, 12).map(x => `[${x}]`).join(' ')}`);
if (errors.length) console.log(`ERREURS dans la page : ${errors.join(' | ')}`);
made.forEach(f => console.log(path.relative(process.cwd(), f)));
process.exit(errors.length ? 1 : 0);
