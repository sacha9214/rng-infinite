// Banc d'essai des sons du tirage (js/sound.js). Un son se juge à l'oreille, mais tout le reste se mesure : ce banc lance
// de vrais tirages dans un navigateur, note chaque appel à Sound (quel son, à quel moment) et enregistre les échantillons
// qui partent vers la sortie audio. Il contrôle que chaque évènement du jeu a son son, à l'heure ; que rien ne sature ;
// que le haut du spectre reste doux ; que couper le son coupe tout ; et que ce qui sort du navigateur est identique au
// mixage du trailer (la même recette passée par reverb + finish, comme tools/trailer-audio.mjs).
//   node tools/dev.mjs                        (dans un autre terminal : le site et l'API en mémoire)
//   node tools/sound-check.mjs                → tous les contrôles sur http://localhost:8124 (~4 min)
//   node tools/sound-check.mjs --only mythic,mute        (common uncommon rare4 epic anomaly mythic trash isolated mute reroll duel)
//   node tools/sound-check.mjs --firefox      → dans Firefox (une fois : npx --prefix tools/.deps playwright install firefox)
//   node tools/sound-check.mjs --keep dossier → garde les enregistrements (.wav) pour les écouter
//   node tools/sound-check.mjs https://rng-infinite.com  → le site en ligne, sans rien y écrire : toutes les requêtes /api/
//                                                sont bloquées (les nombres sont fournis par le banc ; pas de duel)
// Le haut-parleur de la machine ne sert pas : la sortie du navigateur est coupée, l'enregistrement est pris juste avant.
// Une fois : npm i --prefix tools/.deps playwright@1 (le Chrome du système suffit).
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pw = createRequire(path.join(ROOT, 'tools/.deps/package.json'))('playwright');
const { engine } = createRequire(import.meta.url)(path.join(ROOT, 'api/_lib.js'));

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const SITE = (args.find(a => /^https?:/.test(a)) || 'http://localhost:8124').replace(/\/$/, '');
const LIVE = !/\/\/(localhost|127\.0\.0\.1)/.test(SITE);
const ONLY = opt('only', '').split(',').filter(Boolean), KEEP = opt('keep', ''), FIREFOX = args.includes('--firefox');
const wanted = name => !ONLY.length || ONLY.includes(name);
const LEVEL = .7; // niveau général attendu (LEVEL dans js/sound.js)
if (KEEP) fs.mkdirSync(KEEP, { recursive: true });

let failures = 0;
const check = (ok, label, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'ÉCHEC'} ${label}${detail ? ` — ${detail}` : ''}`); return ok; };
const db = v => (20 * Math.log10(Math.max(v, 1e-12))).toFixed(1);

// ------------------------------------------------------------------ dans la page
// Posé avant les scripts du site : un enregistreur branché sur tout ce qui va vers la sortie audio, le journal des
// appels à Sound, et les mesures (faites dans la page : les échantillons n'ont pas à en sortir).
const INIT = () => {
  const Orig = window.AudioContext, connect = AudioNode.prototype.connect;
  const rec = (window.__rec = { L: [], R: [], rate: 0, ctx: null, contexts: 0, log: [], long: [], missing: false });
  window.AudioContext = function (opts) {
    const ctx = opts ? new Orig(opts) : new Orig();
    rec.ctx = ctx; rec.rate = ctx.sampleRate; rec.contexts++;
    const tap = ctx.createScriptProcessor(4096, 2, 2), mute = ctx.createGain();
    mute.gain.value = 0;
    tap.onaudioprocess = e => { rec.L.push(new Float32Array(e.inputBuffer.getChannelData(0))); rec.R.push(new Float32Array(e.inputBuffer.getChannelData(1))); };
    connect.call(tap, mute);
    connect.call(mute, ctx.destination);
    ctx.__tap = tap;
    return ctx;
  };
  window.AudioContext.prototype = Orig.prototype;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && this.context.__tap) connect.call(this, this.context.__tap);
    return connect.apply(this, [dest, ...rest]);
  };
  try { new PerformanceObserver(l => l.getEntries().forEach(e => rec.long.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ entryTypes: ['longtask'] }); } catch (e) { /* Firefox ne les mesure pas */ }
  document.addEventListener('DOMContentLoaded', () => {
    const snd = window.Sound;
    if (!snd) { rec.missing = true; return; }
    for (const name of ['play', 'tick', 'badge', 'stop', 'warm', 'unlock', 'enable']) {
      const fn = snd[name];
      snd[name] = function (...a) { rec.log.push({ t: performance.now(), name, a: JSON.parse(JSON.stringify(a)) }); return fn.apply(this, a); };
    }
  });

  rec.samples = () => rec.L.reduce((s, c) => s + c.length, 0);
  const flat = (from = 0) => {
    const n = rec.samples(), L = new Float32Array(n), R = new Float32Array(n);
    let at = 0;
    rec.L.forEach((c, i) => { L.set(c, at); R.set(rec.R[i], at); at += c.length; });
    return { L: L.subarray(from), R: R.subarray(from) };
  };
  // Crête, part de l'énergie au-dessus de 7 kHz, et débuts de sons forts (montée brusque de l'énergie, fenêtres de 5 ms).
  rec.measure = () => {
    const { L, R } = flat(), rate = rec.rate, n = L.length;
    let peak = 0, all = 0, high = 0;
    for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); all += L[i] * L[i]; }
    for (const v of window.RNGSynth.create(rate).filter(L, 'hp', 7000, .707)) high += v * v;
    const w = Math.round(.005 * rate), onsets = [];
    let prev = 0, lastAt = -1e9;
    for (let i = 0; i + w <= n; i += w) {
      let e = 0;
      for (let k = i; k < i + w; k++) e += L[k] * L[k] + R[k] * R[k];
      e = Math.sqrt(e / (2 * w));
      if (e > .04 && e > prev * 2.5 && i - lastAt > .25 * rate) { onsets.push(+(i / rate).toFixed(3)); lastAt = i; }
      prev = Math.max(e, prev * .8);
    }
    return { peak, high: all ? high / all : 0, onsets, seconds: n / rate, rate, contexts: rec.contexts, state: rec.ctx ? rec.ctx.state : null, log: rec.log, long: rec.long, missing: rec.missing };
  };
  // Le même son mixé hors ligne comme dans le trailer (add + reverb + finish), puis l'écart avec l'enregistrement une
  // fois calés à l'échantillon près : résidu / référence, en dB.
  rec.nullTest = (type, o, from, level) => {
    const rate = rec.rate, S = window.RNGSynth.create(rate), voices = window.Sound.recipes[type](o);
    const n = Math.max(...voices.map(([x, dt]) => x.length + Math.round(dt * rate))) + Math.round(2.4 * rate);
    const L = new Float32Array(n), R = new Float32Array(n), send = new Float32Array(n);
    for (const [x, dt, lvl, pan, wet] of voices) {
      const i0 = Math.round(dt * rate), p = ((pan + 1) * Math.PI) / 4;
      for (let i = 0; i < x.length; i++) { const v = x[i] * lvl; L[i0 + i] += v * Math.cos(p) * 1.414; R[i0 + i] += v * Math.sin(p) * 1.414; send[i0 + i] += v * wet; }
    }
    const wl = S.reverb(send, 0), wr = S.reverb(send, 23);
    for (let i = 0; i < n; i++) { L[i] += wl[i] * 2.4; R[i] += wr[i] * 2.4; }
    const refL = S.finish(L), refR = S.finish(R), cap = flat(from);
    for (let i = 0; i < n; i++) { refL[i] *= level; refR[i] *= level; }
    const firstOf = x => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 1e-5) return i; return -1; };
    const first = firstOf(cap.L), refFirst = firstOf(refL);
    if (first < 0) return { silent: true };
    let best = { residual: Infinity };
    for (let shift = -64; shift <= 64; shift++) {
      const off = first - refFirst + shift, len = Math.min(n, cap.L.length - off);
      if (off < 0 || len < rate / 4) continue;
      let res = 0, tot = 0;
      for (let i = 0; i < len; i++) {
        const dl = cap.L[off + i] - refL[i], dr = cap.R[off + i] - refR[i];
        res += dl * dl + dr * dr;
        tot += refL[i] * refL[i] + refR[i] * refR[i];
      }
      const residual = 10 * Math.log10(res / tot + 1e-30);
      if (residual < best.residual) best = { residual, seconds: len / rate };
    }
    return best;
  };
  // Fichier WAV 16 bits de tout l'enregistrement, en base64.
  rec.wav = () => {
    const { L, R } = flat(), n = L.length, bytes = new Uint8Array(44 + n * 4), v = new DataView(bytes.buffer);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
    text(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); text(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, rec.rate, true); v.setUint32(28, rec.rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) { v.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), true); v.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), true); }
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(bin);
  };
};

// ------------------------------------------------------------------ navigateur
const browser = FIREFOX ? await pw.firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } }) : await pw.chromium.launch({ channel: 'chrome', args: ['--mute-audio'] });
// Une sauvegarde de joueur déjà nommé. sound : false = l'ancienne valeur par défaut, qui doit valoir « activé ».
const saved = sound => JSON.stringify({ version: 1, player: { id: 'a1b2c3d4e5f60718', secret: '00112233445566778899aabbccddeeff', name: `SoundCheck${Math.floor(Math.random() * 1e6)}` }, settings: { speed: 'normal', theme: 'system', sound, achSeen: [] }, rolls: [] });
async function open({ sound = false, forced = null, hash = '' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(INIT);
  await page.addInitScript(s => { if (!localStorage.getItem('rnginf.v1')) localStorage.setItem('rnginf.v1', s); }, saved(sound));
  if (LIVE) await page.route('**/api/**', route => route.abort());
  if (forced !== null) await page.route('**/api/roll', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ n: forced, s: engine.scoreOf(forced), t: Date.now(), bestToday: false, dayRank: null, achievements: [] }) }));
  await page.goto(`${SITE}/${hash}`, { waitUntil: 'load' });
  return { context, page, errors };
}
const keep = async (page, name) => { if (KEEP) fs.writeFileSync(path.join(KEEP, `${name}.wav`), Buffer.from(await page.evaluate(() => window.__rec.wav()), 'base64')); };
const played = type => e => e.name === 'play' && e.a[0] === type;
const button = page => page.evaluate(() => ({ pressed: document.querySelector('#sound-btn').getAttribute('aria-pressed'), title: document.querySelector('#sound-btn').title, setting: JSON.parse(localStorage.getItem('rnginf.v1')).settings.sound }));

// ------------------------------------------------------------------ un tirage complet
async function rollCase(name, n) {
  const a = engine.analyze(n), slotCount = Math.max(6, a.str.length), lead = slotCount - a.str.length, big = ['epic', 'anomaly', 'mythic'].includes(a.tier);
  const { context, page, errors } = await open({ forced: n });
  await page.waitForTimeout(2500); // le temps que les sons soient fabriqués à l'avance
  await page.click('#roll-btn');
  await page.waitForFunction(() => window.__rec.log.some(e => e.name === 'play' && e.a[0] === 'tier'), null, { timeout: 90000 });
  await page.waitForTimeout(big ? 11500 : 5000);
  const m = await page.evaluate(() => window.__rec.measure());
  const shown = await page.evaluate(() => ({ number: [...document.querySelectorAll('#num-card .slot:not(.collapsed)')].map(s => s.textContent).join(''), tier: document.querySelector('.result').dataset.tier, badges: document.querySelectorAll('#r-list > *').length }));
  const btn = await button(page);
  await keep(page, name);
  await context.close();

  console.log(`\n== ${name} : ${n} (${a.tier}, ${a.groups.length} badges, ${a.str.length} chiffres) — ${m.seconds.toFixed(1)} s enregistrées à ${m.rate} Hz`);
  const log = m.log, began = log.find(e => e.name === 'warm' && e.a.length).t, rel = e => e.t - began;
  check(!m.missing && !errors.length, 'aucune erreur dans la page', errors.join(' | '));
  check(shown.number === a.str && shown.tier === a.tier, 'le bon nombre est révélé', `${shown.number} ${shown.tier}`);
  check(btn.pressed === 'true' && m.contexts === 1 && m.state === 'running', 'son activé par défaut (ancienne sauvegarde sound: false), une seule sortie audio', `bouton ${btn.pressed}, ${m.contexts} sortie, ${m.state}`);
  const clicks = log.filter(played('click'));
  check(clicks.length === 1 && rel(clicks[0]) < 0, 'un clic au lancement, avant la révélation');
  // Les chiffres : mêmes instants que REVEAL et digitDelay dans js/app.js.
  const at = [2000];
  for (let i = 1; i < slotCount; i++) at.push(at[i - 1] + 1000 + 1000 * Math.pow((i - 1) / (slotCount - 1), 2));
  const locks = log.filter(played('lock'));
  check(locks.length === slotCount && locks.every((e, i) => e.a[1].i === i && !!e.a[1].soft === (i < lead) && !!e.a[1].final === (i === slotCount - 1) && Math.abs(rel(e) - at[i]) < 60),
    `${slotCount} notes de chiffres dans l'ordre, ${lead} discrète(s) pour les zéros de tête, la dernière appuyée, à l'heure`, `${locks.map((e, i) => Math.round(rel(e) - at[i])).join(' ')} ms d'écart`);
  // Le cliquetis suit la rotation des chiffres (un par changement, tous les 55 ms ; Firefox espace un peu plus ses minuteries).
  const ticks = log.filter(e => e.name === 'tick'), lastLock = rel(locks[locks.length - 1]), want = Math.round(lastLock / 55);
  check(Math.abs(ticks.length - want) <= want * .12 && ticks.every(e => rel(e) < lastLock + 5), 'cliquetis pendant toute la rotation, plus rien après le dernier chiffre', `${ticks.length} cliquetis (≈ ${want} attendus)`);
  const last = ticks.filter(e => e.a[0] && e.a[0].last).map(e => e.a[0].last);
  check(last.length >= 20 && last.every((v, i) => !i || v >= last[i - 1]) && last[0] === 1 && last[last.length - 1] === 8, 'dernier rouleau : cliquetis de plus en plus grave et fort (1 → 8)', `${last.length} cliquetis`);
  const risers = log.filter(played('riser'));
  check(risers.length === 1 && Math.abs(lastLock - rel(risers[0]) - 900) < 60, 'une montée, 900 ms avant le dernier chiffre', `${Math.round(lastLock - rel(risers[0]))} ms avant`);
  const badges = log.filter(e => e.name === 'badge');
  check(badges.length === a.groups.length && badges.every((e, i) => e.a[0] === i && e.a[1] === a.groups.length) && shown.badges === a.groups.length, 'un son par badge', `${badges.length} sons, ${shown.badges} badges affichés`);
  const tiers = log.filter(played('tier'));
  check(tiers.length === 1 && tiers[0].a[1].tier === a.tier && rel(tiers[0]) > rel(badges[badges.length - 1]) + 1000, 'un son de rareté, le bon, après les badges', `${tiers[0] && tiers[0].a[1].tier} à ${(rel(tiers[0]) / 1000).toFixed(1)} s`);
  check(m.peak > .05 && m.peak < .99, 'du son sort, sans saturer', `crête ${db(m.peak)} dB`);
  check(m.high < .01, 'presque rien au-dessus de 7 kHz', `${(10 * Math.log10(m.high)).toFixed(1)} dB de l'énergie`);
  // Dans l'enregistrement : un début de son détecté sert de premier chiffre, chaque chiffre suivant doit avoir le sien
  // à 50 ms près (les notes discrètes des zéros de tête sont sous le seuil de détection).
  if (!lead) check(m.onsets.some(first => at.every(t => m.onsets.some(o => Math.abs(o - first - (t - at[0]) / 1000) < .05))), 'dans l\'enregistrement, les notes tombent avec les écarts des chiffres', `débuts de sons : ${m.onsets.slice(0, 9).join(' ')}…`);
  const longest = Math.max(0, ...m.long.map(l => l[1]));
  check(longest < 200, 'pas de gel de la page', `tâche la plus longue : ${longest} ms${m.long.length ? ` à ${m.long.map(l => l[0]).join(', ')} ms (clic à ${Math.round(clicks[0].t)} ms : ouverture de la sortie audio)` : ''}`);
  return `${a.tier} ${db(m.peak)} dB`;
}

// ------------------------------------------------------------------ sons isolés, comparés au mixage du trailer
async function isolated() {
  console.log('\n== sons isolés : ce qui sort du navigateur, comparé au mixage du trailer');
  const { context, page, errors } = await open({ sound: 'on' });
  await page.waitForTimeout(1500);
  await page.click('#sound-btn'); // coupe
  await page.click('#sound-btn'); // remet : ouvre la sortie audio pendant un vrai clic (et joue une note)
  await page.waitForTimeout(3500);
  const rate = await page.evaluate(() => window.__rec.rate);
  if (rate !== 48000) { console.log(`  (sortie à ${rate} Hz : le navigateur rééchantillonne, la comparaison à l'échantillon près n'a pas de sens ici)`); await context.close(); return; }
  for (const [type, o, wait] of [['lock', { i: 3 }, 3], ['tick', { k: 1 }, 2], ['badge', { step: 3, last: true }, 5], ['tier', { tier: 'rare' }, 5], ['tier', { tier: 'mythic' }, 11]]) {
    const from = await page.evaluate(() => window.__rec.samples());
    await page.evaluate(([t, opt]) => window.Sound.play(t, opt), [type, o]);
    await page.waitForTimeout(wait * 1000 + 600);
    const r = await page.evaluate(([t, opt, f, level]) => window.__rec.nullTest(t, opt, f, level), [type, o, from, LEVEL]);
    check(!r.silent && r.residual < -45, `${type} ${JSON.stringify(o)} : identique au mixage du trailer`, r.silent ? 'silence' : `écart ${r.residual.toFixed(1)} dB sur ${r.seconds.toFixed(1)} s`);
  }
  check(!errors.length, 'aucune erreur dans la page', errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ couper et remettre le son
async function muting() {
  console.log('\n== couper et remettre le son');
  const { context, page, errors } = await open({ forced: NUMBERS.common });
  await page.waitForTimeout(800);
  await page.click('#sound-btn');
  const off = await button(page);
  check(off.pressed === 'false' && off.setting === 'off' && off.title === 'Sound off', 'le bouton coupe le son et le retient', JSON.stringify(off));
  await page.click('#roll-btn');
  await page.waitForTimeout(6500);
  const locked = await page.evaluate(() => `${getComputedStyle(document.querySelector('#sound-btn')).pointerEvents} / ${document.body.classList.contains('locked')}`);
  let m = await page.evaluate(() => (window.__rec.contexts ? window.__rec.measure() : { contexts: 0, peak: 0 }));
  check(m.contexts === 0 || m.peak === 0, 'tirage avec le son coupé : silence complet', `${m.contexts} sortie audio ouverte, crête ${m.peak}`);
  check(locked === 'auto / true', 'le bouton reste cliquable pendant la révélation (menu verrouillé)', locked);
  await page.click('#sound-btn'); // en pleine révélation
  await page.waitForTimeout(6000);
  m = await page.evaluate(() => window.__rec.measure());
  const on = await button(page);
  check(on.pressed === 'true' && on.setting === 'on' && m.peak > .02, 'remis en pleine révélation : le son revient', `crête ${db(m.peak)} dB`);
  await page.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 60000 });
  await page.click('#player-btn');
  const seg = await page.evaluate(() => [...document.querySelectorAll('[data-seg="sound"] button')].map(b => `${b.dataset.v}${b.classList.contains('on') ? '*' : ''}`).join(' '));
  await page.click('[data-seg="sound"] button[data-v="off"]');
  const after = await button(page);
  check(seg === 'on* off' && after.pressed === 'false' && after.setting === 'off', 'réglage Sound dans « Player & settings », synchronisé avec le bouton', `${seg} → ${JSON.stringify(after)}`);
  await page.reload({ waitUntil: 'load' });
  check((await button(page)).pressed === 'false', 'le choix « coupé » survit au rechargement');
  check(!errors.length, 'aucune erreur dans la page', errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ relancer
// Espace pendant la révélation : ignoré. Dès que la rareté est affichée : l'ancien tirage se tait, le nouveau sonne.
async function reroll() {
  console.log('\n== relancer');
  const { context, page, errors } = await open({ forced: NUMBERS.common });
  await page.waitForTimeout(1500);
  await page.click('#roll-btn');
  await page.waitForTimeout(3500);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  let log = await page.evaluate(() => window.__rec.log);
  check(log.filter(played('click')).length === 1 && !log.some(e => e.name === 'stop'), 'Espace pendant la révélation : rien (pas de clic, pas de coupure)');
  await page.waitForFunction(() => window.__rec.log.some(e => e.name === 'play' && e.a[0] === 'tier'), null, { timeout: 90000 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Space');
  await page.waitForTimeout(4500);
  log = await page.evaluate(() => window.__rec.log);
  const clicks = log.filter(played('click')), stops = log.filter(e => e.name === 'stop'), reveals = log.filter(e => e.name === 'warm' && e.a.length);
  check(clicks.length === 2 && stops.length === 1 && stops[0].t > clicks[1].t && reveals.length === 2, 'Espace après la rareté : un clic, l\'ancien tirage se tait, un nouveau commence', `${clicks.length} clics, ${stops.length} coupure, ${reveals.length} révélations`);
  const locks = log.filter(e => played('lock')(e) && e.t > reveals[reveals.length - 1].t);
  check(locks.length >= 2 && locks[0].a[1].i === 0, 'le nouveau tirage sonne depuis son premier chiffre', `${locks.length} notes`);
  check(!errors.length, 'aucune erreur dans la page', errors.join(' | '));
  await context.close();
}

// ------------------------------------------------------------------ duel contre des bots (serveur de dev seulement)
async function duel(size) {
  console.log(`\n== duel à ${size} contre des bots`);
  const { context, page, errors } = await open({ sound: 'on', hash: '#/duel' });
  await page.waitForSelector('#d-bots');
  if (size !== 2) await page.click(`[data-pref="size"] button[data-v="${size}"]`);
  await page.click('#d-bots');
  await page.waitForSelector('#room-roll', { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.click('#room-roll');
  await page.waitForFunction(() => window.__rec.log.some(e => e.name === 'play' && e.a[0] === 'reveal'), null, { timeout: 60000 });
  await page.waitForTimeout(4500);
  const m = await page.evaluate(() => window.__rec.measure());
  const state = await page.evaluate(() => ({ cards: document.querySelectorAll('#room-stage .num-card').length, winner: !!document.querySelector('.room-side.won') }));
  await keep(page, `duel-${size}`);
  await context.close();
  const log = m.log, locks = log.filter(played('lock')), ticks = log.filter(e => e.name === 'tick'), gaps = [1000, 1040, 1160, 1360, 1640], small = size > 2 ? 1 : undefined;
  check(!errors.length, 'aucune erreur dans la page', errors.join(' | '));
  check(state.cards === size, `${size} cartes révélées`);
  check(log.findIndex(e => e.name === 'unlock') >= 0 && log.findIndex(e => e.name === 'unlock') < log.findIndex(e => e.name === 'tick'), 'la sortie audio s\'ouvre au clic sur Roll, avant la manche');
  check(locks.length === 6 && locks.every((e, i) => e.a[1].i === i && e.a[1].soft === 1 && (!i || Math.abs(e.t - locks[i - 1].t - gaps[i - 1]) < 60)), '6 notes discrètes, une par chiffre, à l\'heure', `${locks.slice(1).map((e, i) => Math.round(e.t - locks[i].t - gaps[i])).join(' ')} ms d'écart`);
  check(ticks.length > 30 && ticks.every(e => e.a[0] && e.a[0].soft === 1 && e.t < locks[5].t + 5), 'cliquetis discrets, plus rien après le dernier chiffre', `${ticks.length} cliquetis`);
  const reveal = log.filter(played('reveal')), win = log.filter(played('win'));
  check(reveal.length === 1 && reveal[0].a[1].small === small && Math.abs(reveal[0].t - locks[5].t - 600) < 60, `les raretés se révèlent${small ? ' (version discrète)' : ''}, 600 ms après le dernier chiffre`, `${Math.round(reveal[0].t - locks[5].t)} ms`);
  check(win.length === (state.winner ? 1 : 0) && (!win.length || (win[0].a[1].small === small && Math.abs(win[0].t - locks[5].t - 1500) < 60)), 'son du gagnant, 1,5 s après le dernier chiffre', `${win.length} son, gagnant affiché : ${state.winner}`);
  check(m.peak > .02 && m.peak < .6, 'du son sort, plus bas qu\'en solo', `crête ${db(m.peak)} dB`);
}

// ------------------------------------------------------------------ déroulé
const find = (test, from = 100000) => { for (let n = from; n <= 1000000; n++) if (test(engine.analyze(n))) return n; throw new Error('aucun nombre'); };
const NUMBERS = {
  common: find(a => a.tier === 'common'),
  uncommon: find(a => a.tier === 'uncommon'),
  rare4: find(a => a.tier === 'rare', 1000), // 4 chiffres : deux zéros de tête
  epic: find(a => a.tier === 'epic'),
  anomaly: find(a => a.tier === 'anomaly'),
  mythic: 777777,
  trash: find(a => a.tier === 'trash'),
};
console.log(`site : ${SITE}${LIVE ? ' (requêtes /api/ bloquées)' : ''} — ${FIREFOX ? 'Firefox' : 'Chrome'}`);
const names = Object.keys(NUMBERS).filter(wanted), peaks = [];
// Deux tirages à la fois : assez pour aller vite, pas assez pour dérégler les minuteries.
for (let i = 0; i < names.length; i += 2) peaks.push(...await Promise.all(names.slice(i, i + 2).map(k => rollCase(k, NUMBERS[k]))));
if (peaks.length) console.log(`\ncrêtes par rareté : ${peaks.join(' · ')}`);
if (wanted('isolated')) await isolated();
if (wanted('mute')) await muting();
if (wanted('reroll')) await reroll();
if (wanted('duel') && !LIVE) { await duel(2); await duel(4); }
await browser.close();
console.log(failures ? `\n${failures} échec(s)` : '\nsons OK');
process.exit(failures ? 1 : 0);
