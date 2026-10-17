// Carte image des grands tirages pour le Discord (2026-10-17) : la même carte 1200 × 630 que le bouton « Share » du
// site (js/sharecard.js), dessinée sur le VPS avec @napi-rs/canvas et les polices du site (Inter, Space Mono) plus
// Noto Color Emoji pour les badges. Module et polices dans ~/rng-deps (hors du dépôt, installés à la main : le VPS
// n'a pas npm). Absents (tests, Vercel) : render() rend null et l'annonce part en texte seul.
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const ShareCard = require('../js/sharecard.js');

const DEPS = process.env.RNG_DEPS || path.join(os.homedir(), 'rng-deps');
let Canvas = null;
try {
  Canvas = require(path.join(DEPS, 'node_modules/@napi-rs/canvas'));
  const fonts = path.join(DEPS, 'fonts');
  for (const f of fs.readdirSync(fonts)) {
    const family = f.startsWith('Inter') ? 'Inter' : f.startsWith('SpaceMono') ? 'Space Mono' : f.startsWith('NotoColorEmoji') ? 'Noto Color Emoji' : null;
    if (family) Canvas.GlobalFonts.registerFromPath(path.join(fonts, f), family);
  }
} catch (e) { Canvas = null; }

// data : le même objet que la carte du site (str, tier, rank, xp, name, host, badges, more).
function render(data) {
  if (!Canvas) return null;
  try {
    const canvas = Canvas.createCanvas(ShareCard.W, ShareCard.H), ctx = canvas.getContext('2d');
    // Polices de secours ajoutées à chaque police demandée : les emojis des badges et le « ∞ » du logo n'existent pas
    // dans Inter (« NO GLYPH » sinon).
    const proto = Object.getPrototypeOf(ctx), font = Object.getOwnPropertyDescriptor(proto, 'font');
    Object.defineProperty(ctx, 'font', { configurable: true, get() { return font.get.call(this); }, set(v) { font.set.call(this, `${v}, "Noto Color Emoji", "Noto Sans", "Noto Sans Math"`); } });
    ShareCard.draw(canvas, data);
    return canvas.toBuffer('image/png');
  } catch (e) { return null; }
}

module.exports = { render, available: () => !!Canvas };
