/* RNG∞ — émotes spéciales (celles qu'on achète dans la boutique : catalogue et prix dans js/shop.js, EMOTES).
 * Contrairement aux six émotes de base (images dans img/emotes/), elles sont dessinées en SVG et animées : la même
 * mascotte, un dé crème aux gros contours dans un écusson à huit pans. Les parties qui bougent portent la classe
 * « em » et une classe d'animation (css/premium.css : elles ne tournent que dans une bulle de réaction, au survol du
 * bouton, ou dans la boutique).
 *   RNGEmotes.svg('gg')   → le dessin, à poser dans un élément .emote.emote-svg
 */
(function (root) {
  'use strict';

  const INK = '#231a14';
  const S = `stroke="${INK}" stroke-linejoin="round" stroke-linecap="round"`;
  // L'écusson : huit pans, un liseré plus clair, le bas assombri pour le volume.
  const badge = (base, rim) => `
    <polygon points="30,5 70,5 95,30 95,70 70,95 30,95 5,70 5,30" fill="${base}" ${S} stroke-width="4"/>
    <polygon points="33,12 67,12 88,33 88,67 67,88 33,88 12,67 12,33" fill="none" stroke="${rim}" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="5,58 95,58 95,70 70,95 30,95 5,70" fill="#000" opacity=".16"/>`;
  // Le dé : face crème, ombre en bas, reflet en haut à gauche.
  const cube = (face = '#fff6e6', shade = '#ead9bd') => `
    <ellipse cx="50" cy="78" rx="21" ry="4.5" fill="#000" opacity=".2"/>
    <rect x="24" y="24" width="52" height="50" rx="14" fill="${face}" ${S} stroke-width="3.5"/>
    <path d="M27 60 Q50 71 73 60 V61 A11 11 0 0 1 62 72 H38 A11 11 0 0 1 27 61 Z" fill="${shade}"/>
    <ellipse cx="38" cy="33" rx="9" ry="3.6" fill="#fff" opacity=".85" transform="rotate(-18 38 33)"/>`;
  const arcEyes = (y, up) => [36, 56].map(x => `<path d="M${x} ${y} q5 ${up ? -7 : 6} 10 0" fill="none" ${S} stroke-width="3.5"/>`).join('');
  const roundEyes = (r, pr, dx = 0, dy = 0) => [40, 60].map(x => `<circle cx="${x}" cy="46" r="${r}" fill="#fff" ${S} stroke-width="3"/><circle cx="${x + dx}" cy="${46 + dy}" r="${pr}" fill="${INK}"/>`).join('');
  const smile = (open = 14) => `<path d="M38 56 Q50 ${56 + open} 62 56 Z" fill="#7a1f2b" ${S} stroke-width="3"/><path d="M44 ${59 + open * .25} Q50 ${61 + open * .5} 56 ${59 + open * .25} Q50 ${57 + open * .2} 44 ${59 + open * .25}Z" fill="#ff7b8a"/>`;
  const heart = (x, y, s, cls = '', style = '') => `<path class="em ${cls}" style="${style}" d="M${x} ${y + s * .9} C${x - s * 1.5} ${y - s * .2} ${x - s * .6} ${y - s * 1.1} ${x} ${y - s * .3} C${x + s * .6} ${y - s * 1.1} ${x + s * 1.5} ${y - s * .2} ${x} ${y + s * .9}Z" fill="#ff3b6b" ${S} stroke-width="2.4"/>`;
  const coin = (x, y, r, cls = '', style = '') => `<g class="em ${cls}" style="${style}"><circle cx="${x}" cy="${y}" r="${r}" fill="#fbbf24" ${S} stroke-width="2.6"/><text x="${x}" y="${y + r * .42}" text-anchor="middle" font-size="${r * 1.25}" font-weight="900" font-family="Inter, system-ui, sans-serif" fill="#7a4a00">$</text></g>`;
  const puff = (x, y, cls, style) => `<g class="em ${cls}" style="${style}"><circle cx="${x}" cy="${y}" r="6" fill="#fff" ${S} stroke-width="2.4"/><circle cx="${x + 6}" cy="${y - 3}" r="4.5" fill="#fff" ${S} stroke-width="2.4"/><circle cx="${x + 2}" cy="${y - 1}" r="4.2" fill="#fff"/></g>`;
  const wrap = body => `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${body}</svg>`;

  const DRAW = {
    // GG : yeux rieurs, pouce levé qui se balance, pastille « GG » qui saute.
    gg: () => wrap(`${badge('#2563eb', '#93c5fd')}
      <g class="em em-bounce">${cube()}${arcEyes(47, true)}${smile(13)}
        <g class="em em-thumb"><rect x="77" y="38" width="9" height="17" rx="4.5" fill="#fff6e6" ${S} stroke-width="3"/><rect x="72" y="50" width="18" height="16" rx="6" fill="#fff6e6" ${S} stroke-width="3"/></g></g>
      <g class="em em-pop"><rect x="6" y="6" width="34" height="20" rx="7" fill="#fde047" ${S} stroke-width="3"/><text x="23" y="21.5" text-anchor="middle" font-size="14" font-weight="900" font-family="Inter, system-ui, sans-serif" fill="${INK}">GG</text></g>`),
    // Zzz : il dort, respire doucement, les Z montent.
    sleep: () => wrap(`${badge('#4338ca', '#a5b4fc')}
      <g class="em em-breathe">${cube()}${arcEyes(46, false)}<ellipse cx="50" cy="61" rx="4" ry="5" fill="#7a1f2b" ${S} stroke-width="2.6"/>
        <path d="M30 26 Q50 6 70 26 Z" fill="#60a5fa" ${S} stroke-width="3"/><circle cx="72" cy="27" r="5" fill="#fff" ${S} stroke-width="2.6"/></g>
      ${[[74, 30, 15, 0], [82, 20, 12, .5], [89, 12, 9, 1]].map(([x, y, s, d]) => `<text class="em em-z" style="animation-delay:${d}s" x="${x}" y="${y}" text-anchor="middle" font-size="${s}" font-weight="900" font-family="Inter, system-ui, sans-serif" fill="#fff" ${S} stroke-width="1.2" paint-order="stroke">Z</text>`).join('')}`),
    // Ouf : regard inquiet, bouche qui tremble, une grosse goutte de sueur qui glisse.
    sweat: () => wrap(`${badge('#0d9488', '#5eead4')}
      <g class="em em-tremble">${cube()}${roundEyes(6.2, 2.2, -1.6, 1)}
        <path d="M33 37 L45 40" fill="none" ${S} stroke-width="3"/><path d="M67 37 L55 40" fill="none" ${S} stroke-width="3"/>
        <path d="M40 62 q3 -5 6.5 0 t6.5 0 t6.5 0" fill="none" ${S} stroke-width="3.2"/></g>
      <path class="em em-drop" d="M76 26 C82 36 84 40 76 44 C68 40 70 36 76 26Z" fill="#7dd3fc" ${S} stroke-width="2.6"/>`),
    // Love : des cœurs à la place des yeux, et d'autres qui s'envolent.
    love: () => wrap(`${badge('#db2777', '#f9a8d4')}
      <g class="em em-bounce">${cube()}${heart(40, 46, 6.2, 'em-pulse')}${heart(60, 46, 6.2, 'em-pulse', 'animation-delay:.15s')}${smile(15)}</g>
      ${heart(16, 34, 4.4, 'em-float')}${heart(84, 28, 5, 'em-float', 'animation-delay:.7s')}${heart(78, 62, 3.6, 'em-float', 'animation-delay:1.3s')}`),
    // Rage : tout rouge, sourcils froncés, dents serrées, il tremble et fume.
    rage: () => wrap(`${badge('#b91c1c', '#fca5a5')}
      ${puff(22, 24, 'em-steam', '')}${puff(70, 22, 'em-steam', 'animation-delay:.45s')}
      <g class="em em-shake">${cube('#ff7a66', '#e2523f')}${roundEyes(5, 2.3, 0, 1.2)}
        <path d="M31 35 L47 42" fill="none" ${S} stroke-width="4.2"/><path d="M69 35 L53 42" fill="none" ${S} stroke-width="4.2"/>
        <rect x="37" y="56" width="26" height="11" rx="3.5" fill="#fff" ${S} stroke-width="3"/><path d="M43.5 56 V67 M50 56 V67 M56.5 56 V67" fill="none" stroke="${INK}" stroke-width="2"/></g>
      <path class="em em-pulse" d="M80 40 l6 3 M86 40 l-6 3 M83 37 v9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`),
    // Clown : perruque aux deux couleurs, nez rouge qui pouette, grand sourire maquillé.
    clown: () => wrap(`${badge('#f59e0b', '#fde68a')}
      <g class="em em-wobble">${[[22, 30, '#ef4444'], [17, 43, '#f97316'], [24, 55, '#ef4444'], [78, 30, '#3b82f6'], [83, 43, '#8b5cf6'], [76, 55, '#3b82f6']].map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="9" fill="${c}" ${S} stroke-width="3"/>`).join('')}</g>
      ${cube()}
      ${[40, 60].map(x => `<path d="M${x} 36 L${x + 4} 46 L${x} 56 L${x - 4} 46Z" fill="#60a5fa"/><circle cx="${x}" cy="46" r="3.2" fill="${INK}"/>`).join('')}
      <path d="M33 57 Q50 79 67 57 Q50 64 33 57Z" fill="#fff" ${S} stroke-width="3"/><path d="M38 60 Q50 73 62 60 Q50 65 38 60Z" fill="#ef4444"/>
      <g class="em em-honk"><circle cx="50" cy="52" r="6.5" fill="#ef4444" ${S} stroke-width="3"/><circle cx="48" cy="50" r="1.8" fill="#fff" opacity=".9"/></g>`),
    // Rich : des pièces à la place des yeux, qui tournent ; la langue tirée ; il pleut des pièces.
    money: () => wrap(`${badge('#15803d', '#86efac')}
      ${coin(16, 22, 6, 'em-fall', '')}${coin(86, 30, 5, 'em-fall', 'animation-delay:.6s')}${coin(80, 12, 4.4, 'em-fall', 'animation-delay:1.1s')}
      <g class="em em-bounce">${cube()}${coin(40, 46, 7.4, 'em-spinx')}${coin(60, 46, 7.4, 'em-spinx', 'animation-delay:.2s')}
        <path d="M37 57 Q50 71 63 57 Z" fill="#7a1f2b" ${S} stroke-width="3"/><path d="M45 62 Q50 76 55 62 Z" fill="#ff7b8a" ${S} stroke-width="2.4"/></g>`),
    // Mind blown : les yeux ronds, la bouche ouverte, et le dessus de la tête qui explose.
    mindblown: () => wrap(`${badge('#7c3aed', '#c4b5fd')}
      ${cube()}<path d="M26 31 l7 -5 l6 6 l7 -7 l6 7 l7 -6 l7 6 l8 -4 V20 H26 Z" fill="#7c3aed" stroke="none"/><path d="M26 31 l7 -5 l6 6 l7 -7 l6 7 l7 -6 l7 6 l8 -4" fill="none" ${S} stroke-width="3"/>
      ${roundEyes(7, 1.7)}<ellipse cx="50" cy="63" rx="5" ry="6.5" fill="#7a1f2b" ${S} stroke-width="3"/>
      <g class="em em-burst">${[[50, 14, 10, '#fde047'], [37, 18, 7.5, '#fb923c'], [63, 18, 7.5, '#fb923c'], [44, 8, 6, '#fff'], [57, 9, 6, '#fff']].map(([x, y, r, c]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" ${S} stroke-width="2.6"/>`).join('')}</g>
      ${[[14, 16, -30], [86, 16, 30], [10, 34, -70], [90, 34, 70]].map(([x, y, a], i) => `<g transform="rotate(${a} ${x} ${y})"><path class="em em-ray" style="animation-delay:${i * .12}s" d="M${x} ${y} l0 -8" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></g>`).join('')}`),
  };

  const cache = new Map();
  const svg = id => { if (!cache.has(id)) cache.set(id, DRAW[id] ? DRAW[id]() : ''); return cache.get(id); };
  root.RNGEmotes = { svg, has: id => !!DRAW[id], ids: Object.keys(DRAW) };
})(typeof window !== 'undefined' ? window : globalThis);
