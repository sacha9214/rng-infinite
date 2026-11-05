// Planche de contrôle d'un fond d'écran animé (2026-11-05), comme tools/skin-preview.mjs pour les skins.
//   Une fois :  npm i --prefix tools/.deps playwright@1  &&  npx --prefix tools/.deps playwright install firefox
//   Serveur :   PORT=8136 node tools/dev.mjs   (RNG_BASE=http://localhost:8136, c'est la valeur par défaut)
//   Ensuite :   node tools/wall-preview.mjs <fond> [autre fond…]   →   wall-previews/<fond>.png
//               node tools/wall-preview.mjs blueskies:jet,prop   filme aussi des évènements forcés (debug de la scène)
// Sur la planche : la page des tirages en sombre et en clair (ordinateur), trois images à 0,4 s d'écart (le mouvement),
// la réaction à un tirage Rare / Mythic / Infinite si le fond en a une, le téléphone à 390 et 320 px, l'image fixe
// (mouvement réduit) et l'aperçu de la boutique. Elle mesure aussi :
//   - le contraste du texte posé directement sur le fond (slogan, ligne des stats, tirage auto, bande-annonce) contre
//     les pixels les plus défavorables du fond à cet endroit (WCAG ≥ 3 pour ce texte, gros ou gras pour la plupart) ;
//   - les images par seconde et le temps de dessin moyen d'une image du canevas.
// Navigateur muet. Le joueur de test reçoit le fond par la base de dev (/__dev/redis), comme un fond acheté.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'tools/.deps/package.json'));
const { firefox } = require('playwright');
const B = process.env.RNG_BASE || 'http://localhost:8136';
const OUT = path.join(ROOT, 'wall-previews');
fs.mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2), ids = args.map(a => a.split(':')[0]), events = Object.fromEntries(args.map(a => [a.split(':')[0], (a.split(':')[1] || '').split(',').filter(Boolean)]));
if (!ids.length) { console.error('usage : node tools/wall-preview.mjs <fond> [autre fond…]'); process.exit(1); }
const redis = cmds => fetch(B + '/__dev/redis', { method: 'POST', body: JSON.stringify(cmds) }).then(r => r.json());
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

const browser = await firefox.launch({ firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
let bad = 0;

// Une page avec le fond mis, au thème voulu. reduced : mouvement réduit (image fixe).
async function open(id, { w, h, theme, reduced }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference', locale: 'en-US' });
  const player = { id: hex(8), secret: hex(16), name: 'Wp' + hex(3) };
  await redis([['SET', `player:${player.id}:secret`, createHash('sha256').update(player.secret).digest('hex')], ['HSET', 'wall', player.id, id], ['SADD', `walls:${player.id}`, id]]);
  await ctx.addInitScript(([pl, wall, th]) => {
    if (localStorage.getItem('rnginf.v1')) return;
    localStorage.setItem('rnginf.v1', JSON.stringify({ version: 1, player: pl, settings: { speed: 'normal', theme: th, sound: 'off', onboarded: true, achSeen: ['rookie', 'year2026'], perfHint: 1, wall } }));
  }, [player, id, theme]);
  const p = await ctx.newPage();
  p.on('pageerror', e => { bad++; console.log(`  ✗ ${id} (${w}×${h} ${theme}) : erreur ${e.message}`); });
  await p.goto(B + '/');
  await p.waitForFunction(w => (document.getElementById('wallpaper') || {}).className === `wp wp-${w}`, id, { timeout: 15000 });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(1200);
  return { p, ctx };
}

// Contraste : le texte posé sur le fond, contre les pixels les plus défavorables (5 % les pires) derrière lui.
async function contrast(p, theme) {
  const boxes = await p.evaluate(() => {
    const els = [...document.querySelectorAll('#app *')].filter(el => {
      if (!el.childNodes.length || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || r.top > innerHeight * .7 || r.bottom < 0 || el.closest('.num-card, .slot, .qmarks')) return false; // les ?????? sont pâles exprès
      // seulement le texte sans panneau derrière lui : on remonte jusqu'à #app sans rencontrer de fond
      for (let a = el; a && a.id !== 'app'; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') return false;
        if (cs.backgroundImage !== 'none') return false;
      }
      return true;
    });
    return els.map(el => { const r = el.getBoundingClientRect(), c = getComputedStyle(el).color; return { x: r.left, y: r.top, w: r.width, h: r.height, c, t: el.textContent.trim().slice(0, 24) }; });
  });
  if (!boxes.length) return [];
  const hide = await p.addStyleTag({ content: '#app, .wall-try-bar, .fab, .corner-btns { visibility: hidden !important; }' });
  await p.waitForTimeout(250);
  const png = (await p.screenshot()).toString('base64');
  // la référence : le même texte sur le fond d'origine du site (sans fond d'écran)
  const none = await p.addStyleTag({ content: '#wallpaper { display: none !important; }' });
  await p.waitForTimeout(100);
  const ref = (await p.screenshot()).toString('base64');
  await none.evaluate(s => s.remove()); await hide.evaluate(s => s.remove());
  const measure = png => p.evaluate(async ([png, boxes]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
    const c = document.createElement('canvas'); c.width = innerWidth; c.height = innerHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, innerWidth, innerHeight);
    const lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
    const L = (r, gg, b) => .2126 * lin(r) + .7152 * lin(gg) + .0722 * lin(b);
    return boxes.map(bx => {
      const d = g.getImageData(Math.max(0, bx.x | 0), Math.max(0, bx.y | 0), Math.max(1, bx.w | 0), Math.max(1, bx.h | 0)).data;
      const m = bx.c.match(/[\d.]+/g).map(Number), Lt = L(m[0], m[1], m[2]);
      const ls = []; for (let i = 0; i < d.length; i += 16) ls.push(L(d[i], d[i + 1], d[i + 2]));
      ls.sort((a, b) => a - b);
      const worst = Lt > .4 ? ls[Math.floor(ls.length * .95)] : ls[Math.floor(ls.length * .05)];
      const cr = (Math.max(Lt, worst) + .05) / (Math.min(Lt, worst) + .05);
      return { t: bx.t, cr: Math.round(cr * 10) / 10 };
    });
  }, [png, boxes]);
  const [mine, base] = [await measure(png), await measure(ref)];
  // en défaut : sous 3:1 ET nettement moins lisible que sur le fond d'origine (du texte gris clair y est déjà sous 3:1)
  return mine.map((x, i) => ({ ...x, base: base[i].cr, low: x.cr < 3 && x.cr < base[i].cr * .8 }));
}

for (const id of ids) {
  console.log(`🖼️  ${id}`);
  const shots = [];
  const add = (label, buf) => shots.push({ label, src: 'data:image/png;base64,' + buf.toString('base64') });
  for (const theme of ['dark', 'light']) {
    const { p, ctx } = await open(id, { w: 1280, h: 800, theme });
    add(`ordinateur ${theme}`, await p.screenshot());
    const cr = await contrast(p, theme);
    const low = cr.filter(x => x.low), worst = cr.reduce((a, x) => (!a || x.cr / x.base < a.cr / a.base ? x : a), null);
    console.log(`  ${low.length ? '✗' : '✓'} contraste ${theme} : pire « ${worst ? worst.t : '—'} » ${worst ? `${worst.cr} (sans fond ${worst.base})` : ''}${low.length ? ' — en défaut : ' + low.map(x => `« ${x.t} » ${x.cr} (${x.base})`).join(', ') : ''}`);
    if (low.length) bad++;
    if (theme === 'dark') {
      for (let i = 0; i < 3; i++) { await p.waitForTimeout(400); add(`+${((i + 1) * .4).toFixed(1)} s`, await p.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 800 }, scale: 'css' })); }
      // vitesse : images par seconde et temps de dessin moyen d'une image (frame de la scène, mesuré dans la page)
      const perf = await p.evaluate(() => new Promise(done => {
        let n = 0; const t0 = performance.now();
        const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else done({ fps: Math.round(n / 2) }); };
        requestAnimationFrame(f);
      }));
      // le temps de dessin d'une image (moyenne glissante de la scène) : il dépend peu de la charge de la machine, au
      // contraire des images par seconde. Firefox sans tête dessine sans carte graphique : ici Thunderstorm prend ~24 ms et
      // Party ~13 ms (le 2026-11-05) ; on vise moins de 16 ms
      const ms = await p.evaluate(() => { const c = window.RNGWallFX && RNGWallFX._cur(); return c && c.S && c.S.ms; });
      console.log(`  ${ms == null || ms < 16 ? '✓' : '✗'} ${perf.fps} images par seconde (Firefox sans tête)${ms == null ? '' : `, ${ms.toFixed(2)} ms de dessin par image`}`);
      if (ms != null && ms >= 16) bad++;
      for (const ev of events[id]) {
        await p.evaluate(e => RNGWallFX._cur()._debug(e), ev);
        await p.waitForTimeout(300); add(`${ev} +0,3 s`, await p.screenshot());
        await p.waitForTimeout(1500); add(`${ev} +1,8 s`, await p.screenshot());
      }
      const reacts = await p.evaluate(w => !!(window.RNGWallFX && RNGWallFX._cur() && RNGShop.wallById.get(w).premium), id); // les fonds légendaires réagissent aux tirages
      if (reacts) {
        for (const [tier, n, rank] of [['rare', 123456, 3], ['mythic', 777777, 6], ['infinite', 1000000, 10]]) {
          await p.evaluate(([t, n, r]) => RNGWallFX.roll(t, n, r), [tier, n, rank]);
          await p.waitForTimeout(350); add(`${tier} +0,35 s`, await p.screenshot());
          await p.waitForTimeout(900); add(`${tier} +1,25 s`, await p.screenshot());
          await p.waitForTimeout(2600);
        }
        // le texte reste lisible quand le fond garde la couleur du dernier tirage
        const cr2 = await contrast(p, theme), low2 = cr2.filter(x => x.low);
        console.log(`  ${low2.length ? '✗' : '✓'} contraste après un tirage${low2.length ? ' : ' + low2.map(x => `« ${x.t} » ${x.cr} (${x.base})`).join(', ') : ''}`);
        if (low2.length) bad++;
      }
    }
    // l'aperçu de la boutique
    await p.goto(B + '/#/shop'); await p.waitForTimeout(700);
    await p.locator('[data-shop-tab="walls"]').click(); await p.waitForTimeout(500);
    const tile = p.locator(`.wall-tile:has(.wp-${id})`).first();
    await tile.waitFor({ timeout: 8000 }).catch(() => {});
    if (await tile.count()) { await tile.scrollIntoViewIfNeeded(); add(`boutique ${theme}`, await tile.screenshot()); } else { console.log(`  ✗ pas de tuile ${id} dans la boutique`); bad++; }
    await ctx.close();
  }
  for (const [w, h, theme] of [[390, 844, 'dark'], [390, 844, 'light'], [320, 640, 'dark']]) {
    const { p, ctx } = await open(id, { w, h, theme });
    add(`${w} px ${theme}`, await p.screenshot());
    const cr = await contrast(p, theme), low = cr.filter(x => x.low);
    if (low.length) { bad++; console.log(`  ✗ contraste ${w} px ${theme} : ${low.map(x => `« ${x.t} » ${x.cr} (${x.base})`).join(', ')}`); }
    await ctx.close();
  }
  {
    const { p, ctx } = await open(id, { w: 1280, h: 800, theme: 'dark', reduced: true });
    const a = await p.screenshot(); await p.waitForTimeout(1000); const b = await p.screenshot();
    console.log(`  ${a.equals(b) ? '✓' : '✗'} mouvement réduit : image fixe`); if (!a.equals(b)) bad++;
    add('mouvement réduit', a);
    await ctx.close();
  }
  // la planche
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 900 } });
  const p = await ctx.newPage();
  await p.setContent(`<style>body{margin:0;background:#111;color:#ddd;font:13px system-ui;display:flex;flex-wrap:wrap;gap:8px;padding:8px}
    figure{margin:0}img{display:block;max-height:330px;max-width:540px;border:1px solid #333}figcaption{padding:2px 0}</style>` +
    shots.map(s => `<figure><img src="${s.src}"><figcaption>${s.label}</figcaption></figure>`).join(''));
  await p.waitForTimeout(300);
  const out = path.join(OUT, `${id}.png`);
  await p.screenshot({ path: out, fullPage: true });
  await ctx.close();
  console.log(`  → ${out}`);
}
await browser.close();
console.log(bad ? `\n${bad} problème(s)` : '\nTout est bon');
process.exit(bad ? 1 : 0);
