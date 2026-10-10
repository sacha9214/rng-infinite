// Carte du monde de la page Owner : contours des pays (Natural Earth 1:110m, domaine public, via le paquet
// world-atlas) et point de repère de chaque pays (codes ISO et coordonnées du paquet world-countries), réduits à un
// petit fichier que le site charge seulement sur cette page.   node tools/world-build.mjs   →   data/world-map.json
// Projection plate carrée, 1 000 unités de large, latitudes 84° N à 58° S (sans l'Antarctique).
import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const get = async url => (await fetch(url)).json();
const topo = await get('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
const list = await get('https://cdn.jsdelivr.net/npm/world-countries@5/countries.json');
const W = 1000, TOP = 84, BOTTOM = -58, H = Math.round(((TOP - BOTTOM) / 360) * W);
const X = lon => ((lon + 180) / 360) * W, Y = lat => ((TOP - lat) / 360) * W;
const { scale, translate } = topo.transform;
// Arcs TopoJSON : coordonnées entières cumulées, à remettre à l'échelle.
const arcs = topo.arcs.map(arc => { let x = 0, y = 0; return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * scale[0] + translate[0], y * scale[1] + translate[1]]; }); });
const ring = idx => idx.flatMap((i, k) => { const pts = i < 0 ? arcs[~i].slice().reverse() : arcs[i]; return k ? pts.slice(1) : pts; });
const byNum = new Map(list.map(c => [c.ccn3, c]));
const r1 = v => Math.round(v * 10) / 10;
const countries = [];
for (const g of topo.objects.countries.geometries) {
  const info = byNum.get(String(g.id).padStart(3, '0'));
  const polys = g.type === 'Polygon' ? [g.arcs] : g.arcs;
  let d = '';
  for (const poly of polys) for (const idx of poly) {
    const pts = ring(idx).map(([lon, lat]) => [r1(X(lon)), r1(Y(Math.max(BOTTOM, Math.min(TOP, lat))))]);
    if (pts.every(p => p[1] >= H)) continue; // Antarctique
    // Points successifs identiques après arrondi : retirés.
    const kept = pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
    // Un contour qui franchit le méridien 180° (Russie, Fidji) tracerait un trait d'un bord à l'autre de la carte :
    // il est coupé là où deux points voisins sont à plus d'une demi-carte l'un de l'autre, et chaque morceau fermé.
    const parts = [[]];
    kept.forEach((p, i) => { if (i && Math.abs(p[0] - kept[i - 1][0]) > W / 2) parts.push([]); parts[parts.length - 1].push(p); });
    if (parts.length > 1 && Math.abs(kept[0][0] - kept[kept.length - 1][0]) <= W / 2) parts[0] = parts.pop().concat(parts[0]);
    for (const part of parts) if (part.length > 2) d += 'M' + part.map(p => p.join(' ')).join('L') + 'Z';
  }
  if (d) countries.push({ c: info ? info.cca2 : '', n: g.properties.name, d });
}
// Repère de chaque pays et territoire (250), y compris ceux trop petits pour avoir un contour à cette échelle.
const points = Object.fromEntries(list.filter(c => c.latlng && c.latlng.length === 2).map(c => [c.cca2, [r1(X(c.latlng[1])), r1(Y(c.latlng[0])), c.name.common]]));
const out = { w: W, h: H, top: TOP, countries, points };
fs.writeFileSync(path.join(ROOT, 'data/world-map.json'), JSON.stringify(out));
console.log(`${countries.length} contours (${countries.filter(c => !c.c).map(c => c.n).join(', ') || 'tous avec un code'} sans code), ${Object.keys(points).length} repères, ${(fs.statSync(path.join(ROOT, 'data/world-map.json')).size / 1024).toFixed(0)} Ko, ${W}×${H}`);
