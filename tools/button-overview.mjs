// Planche de tous les boutons « Generate » (ou de ceux passés en argument) : pour chacun, la carte du skin assorti,
// le bouton au repos, survolé, enfoncé, en petit (« Roll again ») et en thème clair — pour comparer et critiquer.
//   node tools/button-overview.mjs [id…]   →   skin-previews/buttons.png (+ buttons-light.png)
//   node tools/button-overview.mjs --catalogue   →   skin-previews/buttons-catalogue.png : tous les boutons au repos, sur une page
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const require = createRequire(path.join(ROOT, 'tools/.deps/package.json'));
const { firefox } = require('playwright');
const Shop = require(path.join(ROOT, 'js/shop.js'));
const all = ['classic', ...Shop.SKINS.map(s => s.id).filter(id => id !== 'classic'), 'owner', ...Shop.BUTTONS.map(b => b.id)];
const args = process.argv.slice(2).filter(a => a !== '--catalogue');
const ids = args.length ? args : all;
const out = path.join(ROOT, 'skin-previews', args.length ? `buttons-${ids.join('-')}.png` : 'buttons.png');
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await firefox.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 300 }, colorScheme: 'dark', deviceScaleFactor: 2 });
await page.route('**/api/**', r => r.fulfill({ status: 503, body: '{}' }));
await page.goto('file://' + path.join(ROOT, 'index.html') + '#/about');
await page.waitForTimeout(900);
const height = await page.evaluate(({ ids, skins, css }) => {
  document.body.innerHTML = '';
  const sheet = document.createElement('div');
  sheet.style.cssText = 'padding:14px;display:grid;gap:6px;font:11px system-ui;color:#999;background:var(--site-bg)';
  const cls = id => (id === 'classic' ? '' : ` gen-${id}`);
  const card = id => (skins.includes(id) || id === 'owner'
    ? `<div class="num-card md ${id === 'owner' ? 'owner-ruby' : id === 'classic' ? '' : `skin-${id}`}" data-tier="rare" style="font-size:1.3rem">${'235711'.split('').map(c => `<span class="slot">${c}</span>`).join('')}</div>` : '');
  const cell = (html, w, extra = '') => `<div style="width:${w}px;display:grid;place-items:center;min-height:86px;${extra}">${html}</div>`;
  sheet.innerHTML = `<div style="display:flex;gap:10px;align-items:center;color:#777"><b style="width:74px"></b>${cell('skin', 190)}${cell('repos', 300)}${cell('survol', 300)}${cell('enfoncé', 300)}${cell('petit', 190)}</div>`
    + ids.map(id => `<div style="display:flex;gap:10px;align-items:center">
      <b style="color:var(--prose);width:74px">${id}</b>${cell(card(id), 190)}
      ${cell(`<button class="btn-roll${cls(id)}">Generate</button>`, 300)}
      ${cell(`<button class="btn-roll${cls(id)} sim-hover">Generate</button>`, 300)}
      ${cell(`<button class="btn-roll${cls(id)} sim-active">Generate</button>`, 300)}
      ${cell(`<button class="btn-roll small${cls(id)}">Roll again</button>`, 190)}
    </div>`).join('');
  document.body.append(sheet);
  // Une capture ne peut pas survoler ni enfoncer 30 boutons à la fois : on double les règles :hover / :active
  // par des classes (.sim-hover / .sim-active) portées par les boutons des colonnes correspondantes.
  const sim = document.createElement('style');
  sim.textContent = css.replace(/:hover/g, '.sim-hover').replace(/:active/g, '.sim-active');
  document.head.append(sim);
  return sheet.scrollHeight;
}, { ids, skins: Shop.SKINS.map(s => s.id), css: fs.readFileSync(path.join(ROOT, 'css/buttons.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8').split('\n').filter(l => /^\.btn-roll:(hover|active)/.test(l)).join('\n') });
if (process.argv.includes('--catalogue')) {
  // Catalogue : une vignette par bouton (nom, prix ou « avec le skin »), quatre par ligne.
  const h = await page.evaluate(({ ids, names }) => {
    const sheet = document.querySelector('body > div');
    sheet.style.cssText = 'padding:26px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px;background:var(--site-bg);font-family:var(--font-sans)';
    sheet.innerHTML = ids.map(id => `<div style="display:grid;place-items:center;gap:10px;padding:22px 8px 14px;border:1px solid var(--outline);border-radius:12px;background:var(--surface-dim)">
      <div style="min-height:86px;display:grid;place-items:center"><button class="btn-roll${id === 'classic' ? '' : ` gen-${id}`}">Generate</button></div>
      <div style="font-size:13px;color:var(--prose);font-weight:700">${names[id][0]} <span style="font-weight:500;color:var(--prose-3)">· ${names[id][1]}</span></div></div>`).join('');
    return sheet.scrollHeight;
  }, { ids, names: Object.fromEntries([...Shop.SKINS.map(s => [s.id, [`${s.emoji} ${s.name}`, s.price ? 'with the skin' : 'free']]), ['owner', ['♛ Owner', 'creator only']], ...Shop.BUTTONS.map(b => [b.id, [`${b.emoji} ${b.name}`, `${b.price} coins`]])]) });
  await page.setViewportSize({ width: 1700, height: h + 10 });
  await page.waitForTimeout(500);
  await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = 400; } catch (e) { /* sans durée */ } } });
  const file = path.join(ROOT, 'skin-previews', 'buttons-catalogue.png');
  await page.screenshot({ path: file });
  await browser.close();
  console.log(file);
  process.exit(0);
}
await page.setViewportSize({ width: 1500, height: height + 10 });
await page.waitForTimeout(500);
// Animations figées à un instant représentatif, pour que deux planches successives se comparent.
await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = 400; } catch (e) { /* animation sans durée */ } } });
await page.screenshot({ path: out });
// Même planche en thème clair.
await page.emulateMedia({ colorScheme: 'light' });
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.body.style.background = '#f4f4f5'; document.querySelector('body > div').style.background = 'var(--site-bg)'; });
await page.waitForTimeout(300);
await page.screenshot({ path: out.replace('.png', '-light.png') });
await browser.close();
console.log(out);
