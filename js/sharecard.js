/* RNG∞ — carte de tirage à partager (Discord, story) : une image 1200 × 630 dessinée dans un canvas.
 * Aucune dépendance : RNGShareCard.draw(canvas, data) puis canvas.toBlob().
 * data = { str, tier, rank, badges: [{ emoji, label, tier }], more, xp, name, host }
 */
(function (root) {
  'use strict';

  const W = 1200, H = 630;
  // Couleurs des raretés (mêmes teintes que le site en thème sombre) : [clair, vif].
  const TIERS = {
    trash: ['#c8a87c', '#7c5a2e'], common: ['#d1d5db', '#6b7280'], uncommon: ['#6ee7b7', '#059669'], rare: ['#93c5fd', '#2563eb'],
    epic: ['#c4b5fd', '#7c3aed'], anomaly: ['#fdba74', '#ea580c'], mythic: ['#f9a8d4', '#db2777'],
    celestial: ['#a5f3fc', '#0891b2'], divine: ['#fef08a', '#ca8a04'], infinite: ['#ffffff', '#8b5cf6'],
  };
  const SANS = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
  const MONO = "'Space Mono', ui-monospace, Menlo, monospace";

  function rr(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  // Texte réduit jusqu'à tenir dans maxW (taille de départ `size`).
  function fit(c, text, weight, size, family, maxW) {
    do { c.font = `${weight} ${size}px ${family}`; if (c.measureText(text).width <= maxW) break; size -= 2; } while (size > 12);
    return size;
  }
  // Générateur déterministe : les étoiles du fond ne bougent pas d'un rendu à l'autre pour un même nombre.
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  function draw(canvas, d) {
    canvas.width = W; canvas.height = H;
    const c = canvas.getContext('2d');
    const [hl, vivid] = TIERS[d.tier] || TIERS.common;

    // Fond : nuit violette, halo de la couleur de rareté derrière le nombre, étoiles.
    c.fillStyle = '#0d0b14'; c.fillRect(0, 0, W, H);
    let g = c.createRadialGradient(360, 300, 20, 360, 300, 720);
    g.addColorStop(0, vivid + '66'); g.addColorStop(.45, vivid + '1c'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, 'rgba(244,114,182,.10)'); g.addColorStop(1, 'rgba(129,140,248,.10)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const rand = rng(Number(String(d.str).replace(/\D/g, '')) + 7);
    for (let i = 0; i < 70; i++) { c.globalAlpha = .12 + rand() * .4; c.fillStyle = '#fff'; c.beginPath(); c.arc(rand() * W, rand() * H, .6 + rand() * 1.5, 0, 7); c.fill(); }
    c.globalAlpha = 1;

    // Cadre : filet en dégradé rose → violet, comme le bouton Generate.
    g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#f472b6'); g.addColorStop(.5, '#c084fc'); g.addColorStop(1, '#818cf8');
    c.strokeStyle = g; c.lineWidth = 6; rr(c, 15, 15, W - 30, H - 30, 30); c.stroke();

    // En-tête : logo à gauche, joueur à droite.
    c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    c.fillStyle = '#fff'; c.font = `900 46px ${SANS}`; c.fillText('RNG∞', 60, 96);
    if (d.name) {
      c.textAlign = 'right'; c.font = `600 26px ${SANS}`; c.fillStyle = 'rgba(255,255,255,.55)';
      const nameSize = fit(c, d.name, 800, 32, SANS, 380), nw = c.measureText(d.name).width;
      c.fillStyle = '#fff'; c.fillText(d.name, W - 60, 94);
      c.font = `600 24px ${SANS}`; c.fillStyle = 'rgba(255,255,255,.55)'; c.fillText('rolled by', W - 60 - nw - 12, 94);
      void nameSize;
    }

    // Carte du nombre.
    const cx = 60, cy = 150, cw = 600, ch = 250;
    c.save(); c.shadowColor = vivid; c.shadowBlur = 60; c.fillStyle = '#15121f'; rr(c, cx, cy, cw, ch, 28); c.fill(); c.restore();
    g = c.createLinearGradient(cx, cy, cx, cy + ch); g.addColorStop(0, vivid + '38'); g.addColorStop(1, vivid + '0c');
    c.fillStyle = g; rr(c, cx, cy, cw, ch, 28); c.fill();
    c.strokeStyle = hl; c.lineWidth = 5; rr(c, cx, cy, cw, ch, 28); c.stroke();
    c.textAlign = 'center'; c.textBaseline = 'middle';
    const size = fit(c, d.str, 700, 170, MONO, cw - 70);
    c.save(); c.shadowColor = vivid; c.shadowBlur = 34; c.fillStyle = hl; c.fillText(d.str, cx + cw / 2, cy + ch / 2 + size * .04); c.restore();

    // Rareté et rang sous la carte.
    c.textBaseline = 'alphabetic'; c.textAlign = 'left';
    const tier = String(d.tier).toUpperCase();
    c.font = `900 30px ${SANS}`;
    const tw = c.measureText(tier).width + 44;
    c.fillStyle = vivid; rr(c, cx, 432, tw, 54, 27); c.fill();
    c.fillStyle = '#fff'; c.fillText(tier, cx + 22, 470);
    if (d.rank) { c.font = `700 30px ${SANS}`; c.fillStyle = hl; c.fillText(d.rank, cx + tw + 20, 470); }

    // XP en bas à gauche.
    c.font = `700 64px ${MONO}`; c.fillStyle = '#fff'; c.fillText(d.xp, cx, 566);
    const xw = c.measureText(d.xp).width;
    c.font = `800 30px ${SANS}`; c.fillStyle = 'rgba(255,255,255,.6)'; c.fillText('XP', cx + xw + 14, 566);

    // Colonne de droite : badges (les plus forts d'abord).
    const bx = 720, bw = W - 60 - bx;
    c.font = `800 22px ${SANS}`; c.fillStyle = 'rgba(255,255,255,.5)'; c.fillText(d.badges.length ? 'BADGES' : 'NO BADGE', bx, 180);
    let y = 200;
    d.badges.slice(0, 5).forEach(b => {
      const [bh, bv] = TIERS[b.tier] || TIERS.common;
      c.fillStyle = 'rgba(255,255,255,.06)'; rr(c, bx, y, bw, 52, 14); c.fill();
      c.fillStyle = bv; rr(c, bx, y, 8, 52, 4); c.fill();
      c.font = `30px ${SANS}`; c.fillStyle = '#fff'; c.fillText(b.emoji, bx + 24, y + 37);
      // Libellé réduit jusqu'à 18 px, puis coupé avec des points de suspension s'il dépasse encore.
      let label = b.label;
      if (fit(c, label, 700, 26, SANS, bw - 90) <= 18) { c.font = `700 18px ${SANS}`; while (label.length > 4 && c.measureText(label + '…').width > bw - 90) label = label.slice(0, -1); if (label !== b.label) label = label.trimEnd() + '…'; }
      c.fillStyle = bh; c.fillText(label, bx + 72, y + 36);
      y += 62;
    });
    if (d.more > 0) { c.textAlign = 'right'; c.font = `600 22px ${SANS}`; c.fillStyle = 'rgba(255,255,255,.5)'; c.fillText(`+${d.more} more`, bx + bw, 180); c.textAlign = 'left'; }

    // Pied : adresse du site.
    c.textAlign = 'right'; c.font = `600 24px ${SANS}`; c.fillStyle = 'rgba(255,255,255,.55)'; c.fillText('Can you beat it?', W - 60, 532);
    c.font = `800 32px ${SANS}`; c.fillStyle = '#fff'; c.fillText(d.host || 'rng-infinite.com', W - 60, 572);
    return canvas;
  }

  const api = { draw, W, H };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNGShareCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
