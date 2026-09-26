// Génère les cartes réelles du jeu à partir d'OpenStreetMap (Overpass) et du relief SRTM 30 m (OpenTopoData) :
//   vieux-quebec.js        -> window.VIEUX_QUEBEC
//   plateau-mont-royal.js  -> window.PLATEAU_MONT_ROYAL
//
//   node tools/build-city.mjs                     (toutes les cartes, avec le cache tools/.cache)
//   node tools/build-city.mjs plateau-mont-royal  (une seule carte)
//   node tools/build-city.mjs --refresh           (retélécharge tout)
//
// Repère du jeu : 1 unité = 1 m, x = -est, z = nord (le nord est en haut de la mini-carte).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFRESH = process.argv.includes('--refresh');
const UA = 'MiniChar3D-game/1.0 (hobby project)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const DEM_STEP = 30;       // m entre deux points d'altitude
const MASK_CELL = 3;       // m par cellule du masque eau / verdure
const COIN_COUNT = 32;

const AREAS = {
  'vieux-quebec': {
    out: 'vieux-quebec.js', global: 'VIEUX_QUEBEC',
    bbox: { s: 46.8035, w: -71.2180, n: 46.8200, e: -71.1985 },   // remplacée par les limites des quartiers
    // quartiers Vieux-Québec–Cap-Blanc–Colline-Parlementaire, Saint-Jean-Baptiste et Montcalm (relations OSM)
    boundary: { rel: [8381621, 7716092, 8382027], name: 'Vieux-Québec – Montcalm', drive: 12, keep: 120 },
    river: { seed: [46.8110, -71.1990], level: 2 },
    levels: [[3, 0.35], [4, 0.45], [5, 0.2]],   // étages quand OSM ne dit rien
    maxTrees: 4200,
    spawn: { near: 'Château Frontenac', road: /^Rue Saint-Louis$/, toward: 'Porte Saint-Louis' },
    shops: 330,
    famous: /Anciens Canadiens|Paillard|Chez Temporel|Lapin Sauté|Cochon Dingue|Boutique de Noël|Continental|Chez Boulay|St-Patrick|Trois Garçons|Antiquaire|Casse-Crêpe|Simons|Pantoute|Petit Coin Latin|Moisan|Érico|Laurie Raphaël|Saint-Amour|Chic Shack|Château Fromage|Maison Smith|Tam Tam|Pub Saint-Alexandre|Bello|Il Teatro|Le Clocher Penché|Café-Boulangerie/i,
    landmarks: [
      ['Château Frontenac', /Château Frontenac/], ['Place Royale', /^Place Royale$/],
      ['Porte Saint-Jean', /^Porte Saint-Jean$/], ['Porte Saint-Louis', /^Porte Saint-Louis$/],
      ['Porte Kent', /^Porte Kent$/], ['Porte Prescott', /^Porte Prescott$/],
      ['Basilique Notre-Dame', /Basilique.*Notre-Dame/], ['Hôtel de ville', /^Hôtel de [Vv]ille/],
      ['Musée de la civilisation', /Musée de la civilisation/], ['Marché du Vieux-Port', /Marché du Vieux-Port/],
      ['Citadelle', /^(La )?Citadelle( de Québec)?$/], ['Hôtel du Parlement', /^Hôtel du Parlement/],
      ['Notre-Dame-des-Victoires', /Notre-Dame-des-Victoires/], ['Funiculaire', /Funiculaire/],
      ['Séminaire de Québec', /Séminaire de Québec/], ['Parc Montmorency', /Montmorency/],
      ['Fresque des Québécois', /Fresque des Québécois/], ["Place d'Armes", /^Place d.Armes$/],
      ['Gare du Palais', /Gare du Palais/], ['Monastère des Ursulines', /Ursulines/],
      ["Parc de l'Artillerie", /Artillerie/], ['Terrasse Dufferin', /Terrasse Dufferin/],
      ['Rue du Petit-Champlain', /Petit-Champlain/], ['Fontaine de Tourny', /Tourny/],
      ['Jardin des Gouverneurs', /Jardin des Gouverneurs/], ['Maison Chevalier', /Maison Chevalier/],
      ['Capitole', /Capitole/], ['Palais Montcalm', /Palais Montcalm/], ["Place D'Youville", /Place D.Youville/],
      ['Monastère des Augustines', /Augustines/], ['Morrin Centre', /Morrin/], ['Bassin Louise', /Bassin Louise/],
      ["Plaines d'Abraham", /Plaines d.Abraham|Parc des Champs-de-Bataille/], ['Musée national des beaux-arts', /Musée national des beaux-arts/],
      ['Avenue Cartier', /^Avenue Cartier$/], ['Grande Allée', /^Grande Allée Est$/], ['Église Saint-Jean-Baptiste', /^Église Saint-Jean-Baptiste/],
      ['Manège militaire', /Manège militaire/], ["Jardin Jeanne-d'Arc", /Jardin Jeanne-d.Arc/], ['Tour Martello', /Tour Martello/],
      ['Observatoire de la Capitale', /Observatoire de la Capitale|Édifice Marie-Guyart/], ['Rue Saint-Jean', /^Rue Saint-Jean$/],
      ['Parc des Braves', /^Parc des Braves$/], ['Avenue Cartier (Marché)', /Marché Cartier|Halles Cartier/],
    ],
  },
  'plateau-mont-royal': {
    out: 'plateau-mont-royal.js', global: 'PLATEAU_MONT_ROYAL',
    bbox: { s: 45.5130, w: -73.5960, n: 45.5310, e: -73.5660 },   // remplacée par les limites de l'arrondissement
    // Limites officielles de l'arrondissement (relation OSM) : on roule jusqu'à « drive » m au-delà (les rues
    // frontières restent entières) et on garde « keep » m de décor autour
    boundary: { rel: 1878503, drive: 12, keep: 120 },
    river: null,
    levels: [[2, 0.3], [3, 0.55], [4, 0.15]],
    maxTrees: 8000,
    spawn: { near: 'Station Mont-Royal', road: /^Rue Saint-Denis$/, toward: 'Carré Saint-Louis' },
    shops: 660,
    famous: /Schwartz|Banquise|Wilensky|St-Viateur Bagel|Fairmount Bagel|Beauty's|Moishes|L'Express|Pied de Cochon|Olimpico|Dieu du Ciel|Majestique|Patati Patata|Romados|Drawn & Quarterly|Kem Coba|Juliette & Chocolat|Juliette et Chocolat|Café Cherrier|Quartier Général|Doval|Guillaume|Casa del Popolo|Ritz PDB|Cinéma du Parc|Anecdote|Frite Alors|Santropol|Rhubarbe|Bily Kun|Laïka|Chez José|Ma Poule Mouillée|Le Sain Bol|Café Névé|Pâtisserie Au Kouign|Réservoir|Chez Claudette|Le Chien Fumant|Leméac|Lawrence|Librairie Gallimard|Renaud-Bray|Archambault|SAQ|Jean Coutu|Pharmaprix|Marché Mont-Royal|Première Moisson|Dépanneur Le Pick-Up|Cheskie|Arthurs|Chez Lévêque|Van Houtte|Club Soda|Métropolis|Théâtre La Chapelle|Espace Go|Rideau Vert|Quat'Sous/i,
    landmarks: [
      ['Parc La Fontaine', /^Parc La Fontaine$/], ['Carré Saint-Louis', /^(Carré|Square) Saint-Louis$/],
      ['Parc Jeanne-Mance', /^Parc Jeanne-Mance$/], ['Monument George-Étienne-Cartier', /Monument.*Cartier/],
      ['Station Mont-Royal', /^Mont-Royal$/], ['Station Sherbrooke', /^Sherbrooke$/], ['Station Laurier', /^Laurier$/],
      ["Schwartz's", /Schwartz/], ['La Banquise', /^La Banquise$/], ['Église Saint-Jean-Baptiste', /^Église Saint-Jean-Baptiste/],
      ['Parc Laurier', /^Parc Laurier$/], ['Parc du Portugal', /^Parc du Portugal$/], ['Théâtre du Rideau Vert', /Rideau Vert/],
      ['Rue Prince-Arthur', /^Rue Prince-Arthur/], ['Place Gérald-Godin', /Gérald-Godin/], ['Hôtel-Dieu', /Hôtel-Dieu/],
      ['Musée des Hospitalières', /Hospitalières/], ['Théâtre de Verdure', /Théâtre de Verdure/],
      ['Espace La Fontaine', /Espace La Fontaine/], ['Église Saint-Enfant-Jésus', /Saint-Enfant-Jésus/],
      ['Église Saint-Stanislas-de-Kostka', /Stanislas/], ['Église Saint-Louis-de-France', /Saint-Louis-de-France/],
      ['Parc Baldwin', /^Parc Baldwin$/], ['Parc des Amériques', /Parc des Amériques/],
      ['Rue Duluth', /^Rue Duluth/], ['Boulevard Saint-Laurent', /^Boulevard Saint-Laurent$/],
      ['Avenue du Mont-Royal', /^Avenue du Mont-Royal/], ['Fairmount Bagel', /Fairmount Bagel/],
      ['St-Viateur Bagel', /St-Viateur Bagel/], ['Wilensky', /Wilensky/],
    ],
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round1 = v => Math.round(v * 10) / 10;
function hash(n) { let h = n | 0; h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

// Grille spatiale simple
class Grid {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  k(i, j) { return i * 100003 + j; }
  add(item, x0, z0, x1, z1) {
    for (let i = Math.floor(x0 / this.cell); i <= Math.floor(x1 / this.cell); i++)
      for (let j = Math.floor(z0 / this.cell); j <= Math.floor(z1 / this.cell); j++) {
        const key = this.k(i, j); const a = this.m.get(key); if (a) a.push(item); else this.m.set(key, [item]);
      }
  }
  near(x, z, r) {
    const out = new Set();
    for (let i = Math.floor((x - r) / this.cell); i <= Math.floor((x + r) / this.cell); i++)
      for (let j = Math.floor((z - r) / this.cell); j <= Math.floor((z + r) / this.cell); j++)
        for (const it of this.m.get(this.k(i, j)) || []) out.add(it);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Géométrie
// ---------------------------------------------------------------------------
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) {
      // anneau fermé (a = b) : distance au point plutôt qu'à la droite
      const d = L > 1e-6 ? Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L : Math.hypot(pts[i][0] - ax, pts[i][1] - az);
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const key2 = p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
function joinRings(lines) {
  const pool = lines.map(l => l.slice()).filter(l => l.length > 1);
  const rings = [];
  while (pool.length) {
    let ring = pool.pop();
    for (let guard = 0; key2(ring[0]) !== key2(ring[ring.length - 1]) && guard < 10000; guard++) {
      const end = key2(ring[ring.length - 1]);
      const i = pool.findIndex(l => key2(l[0]) === end || key2(l[l.length - 1]) === end);
      if (i < 0) break;
      const l = pool.splice(i, 1)[0];
      ring = ring.concat((key2(l[0]) === end ? l : l.reverse()).slice(1));
    }
    if (key2(ring[0]) === key2(ring[ring.length - 1]) && ring.length > 3) rings.push(ring.slice(0, -1));
  }
  return rings;
}
const area = r => { let a = 0; for (let i = 0; i < r.length; i++) { const [x0, z0] = r[i], [x1, z1] = r[(i + 1) % r.length]; a += x0 * z1 - x1 * z0; } return a / 2; };
const centroid = r => r.reduce((s, p) => [s[0] + p[0] / r.length, s[1] + p[1] / r.length], [0, 0]);
function pointInRing(x, z, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  const cx = ax + dx * t, cz = az + dz * t;
  return [Math.hypot(px - cx, pz - cz), cx, cz];
}
const flat = pts => pts.flatMap(([x, z]) => [round1(x), round1(z)]);

// ---------------------------------------------------------------------------
// Une carte
// ---------------------------------------------------------------------------
async function buildArea(id, A) {
  console.log(`\n== ${id}`);
  const CACHE = path.join(ROOT, 'tools', '.cache', id + (A.boundary ? '-arrondissement' : ''));
  async function cached(name, fetcher) {
    const file = path.join(CACHE, name);
    if (!REFRESH) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* pas en cache */ } }
    const data = await fetcher();
    await fs.mkdir(CACHE, { recursive: true });
    await fs.writeFile(file, JSON.stringify(data));
    return data;
  }
  async function fetchOverpass(name, q) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const ep = OVERPASS[attempt % OVERPASS.length];
      try {
        const res = await fetch(ep, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
        const text = await res.text();
        if (res.ok && text.trimStart().startsWith('{')) { const j = JSON.parse(text); console.log(`  ${name}: ${j.elements.length} éléments`); await sleep(3000); return j; }
        console.warn(`  ${name}: ${new URL(ep).host} a répondu ${res.status}, nouvel essai…`);
      } catch (e) { console.warn(`  ${name}: ${e.message}, nouvel essai…`); }
      await sleep(10000 + attempt * 5000);
    }
    throw new Error(`Overpass indisponible pour « ${name} »`);
  }

  // Limites de l'arrondissement : elles fixent la zone à télécharger
  let BBOX = A.bbox, relEl = null;
  if (A.boundary) {
    const ids = [].concat(A.boundary.rel);
    const raw = await cached('boundary.json', () => fetchOverpass('boundary', `[out:json][timeout:120];relation(id:${ids.join(',')});out geom;`));
    const rels = raw.elements.filter(e => e.type === 'relation');
    // plusieurs quartiers : on garde leur contour commun (une frontière partagée par deux quartiers disparaît)
    const uses = new Map();
    for (const r of rels) for (const m of r.members) if (m.type === 'way' && m.role !== 'inner') uses.set(m.ref, (uses.get(m.ref) || 0) + 1);
    relEl = {
      tags: { name: A.boundary.name || (rels[0].tags || {}).name },
      members: rels.flatMap(r => r.members.filter(m => m.type === 'way' && m.role !== 'inner' && uses.get(m.ref) === 1)),
    };
    let s = 90, n = -90, w = 180, e = -180;
    for (const m of relEl.members) if (m.type === 'way' && m.role !== 'inner') for (const p of m.geometry || []) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
    const pad = A.boundary.keep + 30, pLat = pad / 111130, pLon = pad / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
    BBOX = { s: s - pLat, n: n + pLat, w: w - pLon, e: e + pLon };
    console.log(`  limites : ${(relEl.tags || {}).name}`);
  }
  const lat0 = (BBOX.s + BBOX.n) / 2, lon0 = (BBOX.w + BBOX.e) / 2;
  const phi = lat0 * Math.PI / 180;
  const kLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const kLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const proj = (lat, lon) => [-(lon - lon0) * kLon, (lat - lat0) * kLat];
  const unproj = (x, z) => [lat0 + z / kLat, lon0 - x / kLon];
  const B = { minX: proj(lat0, BBOX.e)[0], maxX: proj(lat0, BBOX.w)[0], minZ: proj(BBOX.s, lon0)[1], maxZ: proj(BBOX.n, lon0)[1] };
  const inside = (x, z, m = 0) => x >= B.minX - m && x <= B.maxX + m && z >= B.minZ - m && z <= B.maxZ + m;
  const toXZ = geom => geom.filter(Boolean).map(p => proj(p.lat, p.lon));
  const overpass = (name, body, pad = 0) => cached(`${name}.json`, () =>
    fetchOverpass(name, `[out:json][timeout:170][bbox:${BBOX.s - pad},${BBOX.w - pad},${BBOX.n + pad},${BBOX.e + pad}];${body}`));
  const margin = 90;
  const dx0 = B.minX - margin, dz0 = B.minZ - margin;
  const dnx = Math.ceil((B.maxX - B.minX + 2 * margin) / DEM_STEP) + 1, dnz = Math.ceil((B.maxZ - B.minZ + 2 * margin) / DEM_STEP) + 1;
  const elevation = () => cached(`dem-${DEM_STEP}.json`, async () => {
    const pts = [];
    for (let j = 0; j < dnz; j++) for (let i = 0; i < dnx; i++) pts.push(unproj(dx0 + i * DEM_STEP, dz0 + j * DEM_STEP));
    const h = [];
    for (let k = 0; k < pts.length; k += 100) {
      const locs = pts.slice(k, k + 100).map(([la, lo]) => `${la.toFixed(6)},${lo.toFixed(6)}`).join('|');
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locs}`, { headers: { 'User-Agent': UA } });
        if (res.ok) { const j = await res.json(); h.push(...j.results.map(r => r.elevation ?? 0)); break; }
        if (attempt > 8) throw new Error(`OpenTopoData: ${res.status}`);
        await sleep(3000 * (attempt + 1));
      }
      process.stdout.write(`\r  relief : ${Math.min(pts.length, k + 100)}/${pts.length} points`);
      await sleep(1100);
    }
    process.stdout.write('\n');
    return { x0: dx0, z0: dz0, nx: dnx, nz: dnz, step: DEM_STEP, h };
  });
  const polygonsOf = el => {
    if (el.type === 'way') {
      const r = toXZ(el.geometry || []);
      return r.length > 3 && key2(r[0]) === key2(r[r.length - 1]) ? [r.slice(0, -1)] : [];
    }
    if (el.type === 'relation') return joinRings((el.members || []).filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry).map(m => toXZ(m.geometry)));
    return [];
  };
  const clipPolyline = (pts, m) => {
    const xmin = B.minX - m, xmax = B.maxX + m, zmin = B.minZ - m, zmax = B.maxZ + m;
    const out = []; let cur = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      const dx = x1 - x0, dz = z1 - z0;
      let t0 = 0, t1 = 1, ok = true;
      for (const [p, q] of [[-dx, x0 - xmin], [dx, xmax - x0], [-dz, z0 - zmin], [dz, zmax - z0]]) {
        if (p === 0) { if (q < 0) { ok = false; break; } continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
      if (!ok) { if (cur.length > 1) out.push(cur); cur = []; continue; }
      const a = [x0 + dx * t0, z0 + dz * t0], b = [x0 + dx * t1, z0 + dz * t1];
      if (!cur.length) cur.push(a);
      cur.push(b);
      if (t1 < 1) { out.push(cur); cur = []; }
    }
    if (cur.length > 1) out.push(cur);
    return out;
  };

  // ---------- Territoire : distance signée aux limites (> 0 dedans) sur une grille de 10 m,
  // et contour roulable (limites repoussées de « drive » m) tracé par marching squares ----------
  let regionDist = null, limit = null;
  if (relEl) {
    const rings = joinRings(relEl.members.filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry).map(m => toXZ(m.geometry)));
    rings.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
    const ring = simplify(rings[0].concat([rings[0][0]]), 1).slice(0, -1);
    const RS = 10, rx0 = B.minX - RS, rz0 = B.minZ - RS;
    const rnx = Math.ceil((B.maxX - B.minX) / RS) + 3, rnz = Math.ceil((B.maxZ - B.minZ) / RS) + 3;
    const sd = new Float32Array(rnx * rnz);
    const n = ring.length, ax = new Float64Array(n), az = new Float64Array(n), ex = new Float64Array(n), ez = new Float64Array(n);
    for (let k = 0; k < n; k++) { const [x0, z0] = ring[k], [x1, z1] = ring[(k + 1) % n]; ax[k] = x0; az[k] = z0; ex[k] = x1 - x0; ez[k] = z1 - z0; }
    for (let j = 0; j < rnz; j++) for (let i = 0; i < rnx; i++) {
      const x = rx0 + i * RS, z = rz0 + j * RS;
      let d2 = Infinity, inPoly = false;
      for (let k = 0; k < n; k++) {
        const px = x - ax[k], pz = z - az[k], L2 = ex[k] * ex[k] + ez[k] * ez[k] || 1e-9;
        const t = Math.max(0, Math.min(1, (px * ex[k] + pz * ez[k]) / L2));
        const qx = px - ex[k] * t, qz = pz - ez[k] * t, q = qx * qx + qz * qz;
        if (q < d2) d2 = q;
        const z1 = az[k] + ez[k];
        if ((az[k] > z) !== (z1 > z) && x < (ex[k] * (z - az[k])) / ez[k] + ax[k]) inPoly = !inPoly;
      }
      sd[j * rnx + i] = inPoly ? Math.sqrt(d2) : -Math.sqrt(d2);
    }
    regionDist = (x, z) => {
      const fx = Math.max(0, Math.min(rnx - 1.001, (x - rx0) / RS)), fz = Math.max(0, Math.min(rnz - 1.001, (z - rz0) / RS));
      const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * rnx + i;
      return (sd[k] * (1 - tx) + sd[k + 1] * tx) * (1 - tz) + (sd[k + rnx] * (1 - tx) + sd[k + rnx + 1] * tx) * tz;
    };
    const f = (i, j) => sd[j * rnx + i] + A.boundary.drive;
    const eH = (i, j) => { const a = f(i, j), t = a / (a - f(i + 1, j)); return [rx0 + (i + t) * RS, rz0 + j * RS]; };
    const eV = (i, j) => { const a = f(i, j), t = a / (a - f(i, j + 1)); return [rx0 + i * RS, rz0 + (j + t) * RS]; };
    const lines = [];
    for (let j = 0; j < rnz - 1; j++) for (let i = 0; i < rnx - 1; i++) {
      const a = f(i, j) > 0, b = f(i + 1, j) > 0, c = f(i + 1, j + 1) > 0, d = f(i, j + 1) > 0;
      const p = [];                                       // bas, droite, haut, gauche
      if (a !== b) p.push(eH(i, j));
      if (b !== c) p.push(eV(i + 1, j));
      if (d !== c) p.push(eH(i, j + 1));
      if (a !== d) p.push(eV(i, j));
      if (p.length === 2) lines.push(p);
      else if (p.length === 4) {
        const center = f(i, j) + f(i + 1, j) + f(i + 1, j + 1) + f(i, j + 1) > 0;
        if (center === a) lines.push([p[0], p[1]], [p[2], p[3]]); else lines.push([p[0], p[3]], [p[1], p[2]]);
      }
    }
    const contours = joinRings(lines).sort((p, q) => Math.abs(area(q)) - Math.abs(area(p)));
    limit = simplify(contours[0].concat([contours[0][0]]), 0.8).slice(0, -1);
    console.log(`  territoire : ${(Math.abs(area(ring)) / 1e6).toFixed(2)} km², limite roulable de ${limit.length} points`);
  }
  const inRegion = (x, z, m = 0) => !regionDist || regionDist(x, z) >= -m;
  const splitRegion = (parts, m) => {
    if (!regionDist) return parts;
    const out = [];
    for (const part of parts) {
      let cur = [];
      for (let k = 0; k < part.length; k++) {
        const [x0, z0] = part[k], nxt = part[k + 1];
        const steps = nxt ? Math.max(1, Math.ceil(Math.hypot(nxt[0] - x0, nxt[1] - z0) / 5)) : 1;
        for (let s = 0; s < steps; s++) {
          const x = nxt ? x0 + (nxt[0] - x0) * s / steps : x0, z = nxt ? z0 + (nxt[1] - z0) * s / steps : z0;
          if (inRegion(x, z, m)) cur.push([x, z]);
          else { if (cur.length > 1) out.push(cur); cur = []; }
        }
      }
      if (cur.length > 1) out.push(cur);
    }
    return out;
  };
  const KEEP = A.boundary ? A.boundary.keep : 0;

  console.log('Téléchargement…');
  const roadsRaw = await overpass('roads', 'way["highway"];out geom tags;');
  // « out geom » (et non « out geom tags ») : sinon les relations arrivent sans leurs membres
  const buildingsRaw = await overpass('buildings', '(way["building"];relation["building"]["type"="multipolygon"];);out geom;');
  const wallsRaw = await overpass('walls', '(way["barrier"="city_wall"];node["historic"="city_gate"];);out geom;');
  const waterRaw = await overpass('water', '(way["natural"="water"];relation["natural"="water"]["water"!="river"];way["amenity"="fountain"];way["water"="fountain"];);out geom;');
  const riverRaw = A.river ? await overpass('river', 'relation["natural"="water"]["water"="river"];way(r);out geom;', 0.01) : { elements: [] };
  const greenRaw = await overpass('green', '(way["leisure"~"^(park|garden)$"];relation["leisure"="park"];way["landuse"~"^(grass|forest|recreation_ground|village_green|cemetery)$"];way["natural"~"^(wood|scrub|grassland)$"];node["natural"="tree"];);out geom;');
  const areasRaw = await overpass('areas', '(way["leisure"~"^(park|garden)$"]["name"];relation["leisure"~"^(park|garden)$"]["name"];way["place"="square"]["name"];relation["place"="square"]["name"];way["highway"="pedestrian"]["area"="yes"]["name"];);out geom;');
  const schoolsRaw = await overpass('schools', '(way["amenity"~"^(school|college|university|kindergarten)$"];relation["amenity"~"^(school|college|university)$"];);out geom;');
  const lmRaw = await overpass('landmarks', `nwr["name"~"${A.landmarks.map(l => l[1].source.replace(/[\^$]/g, '')).join('|')}"];out center tags;`);
  const dem = await elevation();

  // ---------- Relief : on retire le « sursol » (bâtiments, arbres) puis on lisse ----------
  {
    const { nx, nz } = dem;
    const ci = (v, n) => Math.max(0, Math.min(n - 1, v));
    const pass = (src, fn) => { const out = new Array(src.length); for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const v = []; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) v.push(src[ci(j + dj, nz) * nx + ci(i + di, nx)]); out[j * nx + i] = fn(v); } return out; };
    let h = dem.h;
    h = pass(h, v => Math.min(...v));
    h = pass(h, v => Math.max(...v));
    h = pass(h, v => v.reduce((s, x) => s + x, 0) / v.length);
    dem.h = h.map(round1);
  }

  // ---------- Rues ----------
  const DRIVE = {
    trunk: [11, 0], trunk_link: [7, 0], primary: [11, 0], primary_link: [7, 0],
    secondary: [10, 0], secondary_link: [7, 0], tertiary: [8.5, 0], tertiary_link: [7, 0],
    residential: [7.5, 1], unclassified: [7.5, 1], living_street: [6.5, 1],
    pedestrian: [6, 2], service: [5, 3],
  };
  const roads = [];
  for (const w of roadsRaw.elements) {
    const t = w.tags || {};
    const spec = DRIVE[t.highway];
    if (!spec || t.area === 'yes' || t.tunnel === 'yes' || t.access === 'no') continue;
    if (t.highway === 'service' && /parking_aisle|driveway|drive-through/.test(t.service || '')) continue;
    let width = spec[0];
    const lanes = parseInt(t.lanes, 10);
    if (lanes > 0 && spec[1] === 0) width = Math.min(14, lanes * 3.3 + 1);
    for (const part of splitRegion(clipPolyline(toXZ(w.geometry || []), 20), KEEP)) {
      const pts = simplify(part, 0.3);
      if (pts.length >= 2) roads.push({ n: t.name || '', w: width, k: spec[1], p: pts });
    }
  }
  // ---------- Pistes cyclables : pistes séparées + bandes peintes sur la chaussée ----------
  const offsetLine = (pts, d) => pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
    return [p[0] - tz * d, p[1] + tx * d];   // d > 0 : à droite du sens de tracé (repère x = -est)
  });
  const bikes = [];
  const isLane = v => /^(lane|track|opposite_lane|opposite_track)$/.test(v || '');
  for (const w of roadsRaw.elements) {
    const t = w.tags || {};
    const path = t.highway === 'cycleway' || (t.highway === 'path' && t.bicycle === 'designated');
    const spec = DRIVE[t.highway];
    let sides = [];
    if (!path && spec) {
      if (isLane(t.cycleway)) sides = t.oneway === 'yes' ? [1] : [1, -1];
      if (isLane(t['cycleway:both'])) sides = [1, -1];
      if (isLane(t['cycleway:right'])) sides.push(1);
      if (isLane(t['cycleway:left'])) sides.push(-1);
      sides = [...new Set(sides)];
    }
    if (!path && !sides.length) continue;
    let rw = spec ? spec[0] : 0;
    const lanes = parseInt(t.lanes, 10);
    if (spec && lanes > 0 && spec[1] === 0) rw = Math.min(14, lanes * 3.3 + 1);
    for (const part of splitRegion(clipPolyline(toXZ(w.geometry || []), 10), KEEP)) {
      const pts = simplify(part, 0.3);
      if (pts.length < 2) continue;
      if (path) bikes.push({ w: clampW(parseFloat(t.width) || 2.6), k: 0, p: flat(pts) });
      else for (const s of sides) bikes.push({ w: 1.6, k: 1, p: flat(offsetLine(pts, s * (rw / 2 - 0.95))) });
    }
  }
  function clampW(v) { return Math.max(1.6, Math.min(4, v)); }
  console.log(`  ${bikes.filter(b => b.k === 0).length} pistes cyclables, ${bikes.filter(b => b.k === 1).length} bandes cyclables`);

  const segs = [];
  const segGrid = new Grid(40);
  for (const r of roads) for (let k = 0; k < r.p.length - 1; k++) {
    const s = { a: r.p[k], b: r.p[k + 1], w: r.w, n: r.n, k: r.k };
    segs.push(s);
    segGrid.add(s, Math.min(s.a[0], s.b[0]), Math.min(s.a[1], s.b[1]), Math.max(s.a[0], s.b[0]), Math.max(s.a[1], s.b[1]));
  }
  const nearestRoad = (x, z, filter = () => true, maxR = 400) => {
    let best = null;
    for (let r = 40; r <= maxR && !best; r *= 2) {
      for (const s of segGrid.near(x, z, r)) {
        if (!filter(s)) continue;
        const [d, cx, cz] = segDist(x, z, s.a[0], s.a[1], s.b[0], s.b[1]);
        if (d <= r && (!best || d < best.d)) best = { d, x: cx, z: cz, s };
      }
    }
    return best;
  };
  console.log(`  ${roads.length} tronçons de rue`);

  // ---------- Bâtiments ----------
  const pickLevels = id => { let u = hash(id * 7 + 3); for (const [l, p] of A.levels) { if (u < p) return l; u -= p; } return A.levels[A.levels.length - 1][0]; };
  const buildings = [];
  for (const el of buildingsRaw.elements) {
    const t = el.tags || {};
    for (let ring of polygonsOf(el)) {
      ring = simplify(ring.concat([ring[0]]), 0.25).slice(0, -1);
      if (ring.length < 3 || Math.abs(area(ring)) < 8) continue;
      const [cx, cz] = centroid(ring);
      if (!inside(cx, cz) || !inRegion(cx, cz, KEEP - 10)) continue;
      const type = t.building || 'yes';
      const name = t.name || '';
      let kind = '';
      if (t.historic === 'city_gate' || /^Porte /.test(name)) kind = 'p';            // porte de la ville (on doit pouvoir passer dessous)
      else if (/Château Frontenac/i.test(name)) kind = 'f';
      else if (/church|cathedral|chapel|basilica/.test(type) || /^(Basilique|Église|Chapelle|Cathédrale)|Church/.test(name)) kind = 'c';
      else if (/^(school|university|college|kindergarten)$/.test(type) || /^(school|college|university|kindergarten)$/.test(t.amenity || '') ||
        /^(École|Ecole|Collège|Académie|Pensionnat|Cégep|Université)\b/i.test(name)) kind = 's';
      else if (/commercial|retail|office|hotel|supermarket|kiosk/.test(type) || t.shop || t.amenity === 'restaurant') kind = 'k';
      else if (/house|residential|apartments|terrace|detached|semidetached/.test(type)) kind = 'r';
      else if (/garage|shed|roof|carport|hut/.test(type)) kind = 'g';
      let h = parseFloat(t.height);
      let lv = parseFloat(t['building:levels']);
      if (!(h > 0)) {
        if (!(lv > 0)) lv = kind === 'g' ? 1 : kind === 'c' ? 0 : kind === 's' ? 3 : pickLevels(el.id);
        h = kind === 'c' && !lv ? 18 : lv * 3.15 + 0.9 + (parseFloat(t['roof:levels']) || 0) * 2.2;
        if (kind === 'f') h = Math.max(h, 55);
      }
      if (!(lv > 0)) lv = kind === 'c' ? 0 : Math.max(1, Math.round((h - 0.9) / 3.2));
      if (kind === 'p') { h = parseFloat(t.height) > 0 ? h : 10; lv = 0; }
      const b = { h: round1(Math.min(h, 140)), l: Math.min(45, Math.round(lv)), p: flat(ring) };
      if (kind) b.t = kind;
      if (name) b.n = name;
      const rs = { mansard: 'm', gambrel: 'm', hipped: 'h', half_hipped: 'h', gabled: 'g', pyramidal: 'p', flat: 'f', dome: 'd', onion: 'd' }[t['roof:shape']];
      if (rs) b.rs = rs;
      if (t['roof:colour']) b.rc = t['roof:colour'];
      buildings.push(b);
    }
  }
  const bRings = buildings.map(b => { const r = []; for (let k = 0; k < b.p.length; k += 2) r.push([b.p[k], b.p[k + 1]]); return r; });
  // cours d'école : les bâtiments qui s'y trouvent sont des écoles ; le plus grand porte le nom de l'école
  {
    let n = 0;
    for (const el of schoolsRaw.elements) {
      const gname = (el.tags || {}).name || '';
      for (const ring of polygonsOf(el)) {
        let best = -1, ba = 0;
        buildings.forEach((b, i) => {
          if (/^[cfp]$/.test(b.t || '')) return;
          const [cx, cz] = centroid(bRings[i]);
          if (!pointInRing(cx, cz, ring)) return;
          if (b.t !== 's') { b.t = 's'; n++; if (b.l < 2) { b.l = 3; b.h = Math.max(b.h, 10.4); } }
          const a = Math.abs(area(bRings[i]));
          if (a > ba) { ba = a; best = i; }
        });
        if (best >= 0 && gname && !buildings[best].n) buildings[best].n = gname;
      }
    }
    console.log(`  ${buildings.filter(b => b.t === 's').length} bâtiments scolaires (${n} trouvés par leur cour), ${buildings.filter(b => b.t === 'c').length} églises`);
  }
  const bGrid = new Grid(30);
  bRings.forEach((r, i) => { const xs = r.map(p => p[0]), zs = r.map(p => p[1]); bGrid.add(i, Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)); });
  const nearBuilding = (x, z, pad) => {
    for (const i of bGrid.near(x, z, pad + 1)) {
      const r = bRings[i];
      if (pointInRing(x, z, r)) return true;
      for (let k = 0; k < r.length; k++) { const [a, b] = [r[k], r[(k + 1) % r.length]]; if (segDist(x, z, a[0], a[1], b[0], b[1])[0] < pad) return true; }
    }
    return false;
  };
  console.log(`  ${buildings.length} bâtiments`);

  // ---------- Fortifications et portes ----------
  const walls = [], gates = [];
  for (const el of wallsRaw.elements) {
    const t = el.tags || {};
    if (el.type === 'node') { if (t.name) { const [x, z] = proj(el.lat, el.lon); gates.push({ n: t.name, x: round1(x), z: round1(z) }); } continue; }
    const h = parseFloat(t.height) > 0 ? parseFloat(t.height) : 7;
    for (const part of clipPolyline(toXZ(el.geometry || []), 0)) { const pts = simplify(part, 0.3); if (pts.length >= 2) walls.push({ h, p: flat(pts) }); }
  }
  if (walls.length) console.log(`  ${walls.length} pans de fortification, ${gates.length} portes`);

  // ---------- Lieux nommés (parcs, places) : pour le panneau quand on quitte la rue ----------
  const areas = [];
  for (const el of areasRaw.elements) {
    const n = (el.tags || {}).name;
    if (!n) continue;
    for (let ring of polygonsOf(el)) {
      ring = simplify(ring.concat([ring[0]]), 1).slice(0, -1);
      const a = Math.abs(area(ring));
      if (ring.length < 3 || a < 150) continue;
      const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
      if (Math.max(...xs) < B.minX || Math.min(...xs) > B.maxX || Math.max(...zs) < B.minZ || Math.min(...zs) > B.maxZ) continue;
      areas.push({ n, a, p: flat(ring) });
    }
  }
  areas.sort((x, y) => x.a - y.a);   // les plus petits d'abord : une place l'emporte sur le parc qui l'entoure
  console.log(`  ${areas.length} parcs et places nommés`);

  // ---------- Masque eau / verdure ----------
  const mx0 = B.minX - 60, mz0 = B.minZ - 60;
  const mnx = Math.ceil((B.maxX - B.minX + 120) / MASK_CELL), mnz = Math.ceil((B.maxZ - B.minZ + 120) / MASK_CELL);
  const mask = new Uint8Array(mnx * mnz); // 0 ville, 1 eau, 2 verdure
  const fillRing = (ring, value) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const i0 = Math.max(0, Math.floor((minX - mx0) / MASK_CELL)), i1 = Math.min(mnx - 1, Math.ceil((maxX - mx0) / MASK_CELL));
    const j0 = Math.max(0, Math.floor((minZ - mz0) / MASK_CELL)), j1 = Math.min(mnz - 1, Math.ceil((maxZ - mz0) / MASK_CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (pointInRing(mx0 + (i + 0.5) * MASK_CELL, mz0 + (j + 0.5) * MASK_CELL, ring) && (value === 1 || mask[j * mnx + i] === 0)) mask[j * mnx + i] = value;
    }
  };
  for (const el of greenRaw.elements) if (el.type !== 'node') for (const r of polygonsOf(el)) fillRing(r, 2);
  for (const el of waterRaw.elements) { if ((el.tags || {}).intermittent === 'yes') continue; for (const r of polygonsOf(el)) fillRing(r, 1); }
  if (A.river) {
    // fleuve : la rive sert de barrière, puis on remplit depuis un point du fleuve
    const wall = new Uint8Array(mnx * mnz);
    for (const w of riverRaw.elements) {
      const pts = toXZ(w.geometry || []);
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
        const n = Math.ceil(Math.hypot(bx - ax, bz - az) / (MASK_CELL * 0.4)) + 1;
        for (let s = 0; s <= n; s++) {
          const i = Math.floor((ax + (bx - ax) * s / n - mx0) / MASK_CELL), j = Math.floor((az + (bz - az) * s / n - mz0) / MASK_CELL);
          if (i >= 0 && j >= 0 && i < mnx && j < mnz) wall[j * mnx + i] = 1;
        }
      }
    }
    const [sx, sz] = proj(...A.river.seed);
    const seed = Math.floor((sz - mz0) / MASK_CELL) * mnx + Math.floor((sx - mx0) / MASK_CELL);
    const river = new Uint8Array(mnx * mnz);
    const queue = [seed]; river[seed] = 1;
    while (queue.length) {
      const c = queue.pop(), i = c % mnx, j = (c / mnx) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= mnx || jj >= mnz) continue;
        const n = jj * mnx + ii;
        if (!river[n] && !wall[n]) { river[n] = 1; queue.push(n); }
      }
    }
    const frac = river.reduce((s, v) => s + v, 0) / river.length;
    console.log(`  fleuve : ${(frac * 100).toFixed(0)} % de la zone`);
    if (frac < 0.6 && frac > 0.01) for (let k = 0; k < mask.length; k++) if (river[k] || (wall[k] && (river[k + 1] || river[k - 1]))) mask[k] = 1;
  }
  const rle = [];
  for (let k = 0; k < mask.length;) { let n = 1; while (k + n < mask.length && mask[k + n] === mask[k]) n++; rle.push(mask[k], n); k += n; }

  // ---------- Arbres (inventaire OSM éclairci + arbres semés dans les parcs) ----------
  const trees = [];
  const treeGrid = new Grid(6);
  const treeFree = (x, z) => {
    if (!inside(x, z, -4) || !inRegion(x, z, 60)) return false;
    for (const t of treeGrid.near(x, z, 4)) if (Math.hypot(t[0] - x, t[1] - z) < 4) return false;
    const i = Math.floor((x - mx0) / MASK_CELL), j = Math.floor((z - mz0) / MASK_CELL);
    if (mask[j * mnx + i] === 1) return false;
    const nr = nearestRoad(x, z, () => true, 40);
    if (nr && nr.d < nr.s.w / 2 + 1.8) return false;
    return !nearBuilding(x, z, 1.4);
  };
  const plant = (x, z) => { const t = [x, z]; trees.push(round1(x), round1(z)); treeGrid.add(t, x, z, x, z); };
  for (const el of greenRaw.elements) {
    if (el.type !== 'node' || trees.length / 2 >= A.maxTrees) continue;
    const [x, z] = proj(el.lat, el.lon);
    if (treeFree(x, z)) plant(x, z);
  }
  {
    let s = 12345;
    const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
    for (let tries = 0; tries < 90000 && trees.length / 2 < A.maxTrees + 800; tries++) {
      const x = B.minX + rnd() * (B.maxX - B.minX), z = B.minZ + rnd() * (B.maxZ - B.minZ);
      const i = Math.floor((x - mx0) / MASK_CELL), j = Math.floor((z - mz0) / MASK_CELL);
      if (mask[j * mnx + i] !== 2 || rnd() > 0.5) continue;
      if (treeFree(x, z)) plant(x, z);
    }
  }
  console.log(`  ${trees.length / 2} arbres`);

  // ---------- Pièces : lieux célèbres, puis on complète le long des rues ----------
  const coins = [];
  const drivable = s => s.k !== 3;
  const farFromCoins = (x, z, d) => coins.every(c => Math.hypot(c.x - x, c.z - z) >= d);
  const score = e => { const t = e.tags || {}; return (e.type !== 'node' ? 1 : 0) + (t.railway === 'station' || t.station === 'subway' || t.public_transport === 'station' ? 4 : 0) + (t.tourism || t.historic || t.leisure || t.amenity || t.building ? 2 : 0) - (t.highway ? 1 : 0); };
  const landmarks = [];
  for (const [label, re] of A.landmarks) {
    const cands = lmRaw.elements.filter(e => re.test((e.tags || {}).name || '')).map(e => ({ e, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon })).filter(c => c.lat != null && inside(...proj(c.lat, c.lon), -10) && inRegion(...proj(c.lat, c.lon), 5));
    cands.sort((a, b) => score(b.e) - score(a.e));
    if (!cands.length) continue;
    const [x, z] = proj(cands[0].lat, cands[0].lon);
    landmarks.push({ n: label, x: round1(x), z: round1(z) });
    const nr = nearestRoad(x, z, drivable, 400);
    const reach = (cands[0].e.tags || {}).leisure ? 350 : 150;
    if (!nr || nr.d > reach || !inRegion(nr.x, nr.z, -15) || !farFromCoins(nr.x, nr.z, 45) || coins.length >= COIN_COUNT - 4) continue;
    coins.push({ x: round1(nr.x), z: round1(nr.z), n: label });
  }
  const landmarkCoins = coins.length;
  {
    const cands = [];
    for (const s of segs) {
      if (!drivable(s)) continue;
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      for (let d = 5; d < L; d += 25) { const t = d / L; cands.push({ x: s.a[0] + (s.b[0] - s.a[0]) * t, z: s.a[1] + (s.b[1] - s.a[1]) * t, n: s.n }); }
    }
    const pool = cands.filter(c => inside(c.x, c.z, -25) && inRegion(c.x, c.z, -25));
    while (coins.length < COIN_COUNT && pool.length) {
      let best = null, bd = -1;
      for (const c of pool) {
        let d = Infinity;
        for (const o of coins) d = Math.min(d, Math.hypot(o.x - c.x, o.z - c.z));
        if (d > bd) { bd = d; best = c; }
      }
      coins.push({ x: round1(best.x), z: round1(best.z), n: best.n || 'Ruelle' });
    }
  }
  console.log(`  ${coins.length} pièces (${landmarkCoins} près de lieux célèbres : ${coins.slice(0, landmarkCoins).map(c => c.n).join(', ')})`);

  // ---------- Commerces : les plus connus d'abord, accrochés au bâtiment qui les abrite ----------
  const shops = [];
  if (A.shops) {
    const shopsRaw = await overpass('shops', '(nwr["name"]["shop"];nwr["name"]["amenity"~"^(restaurant|cafe|bar|pub|fast_food|ice_cream|pharmacy|bank|cinema|theatre|nightclub)$"];);out center tags;');
    const category = t => {
      const a = t.amenity || '', s = t.shop || '';
      if (a === 'restaurant') return 'r';
      if (a === 'fast_food') return 'f';
      if (/^(cafe|ice_cream)$/.test(a) || /^(bakery|pastry|confectionery|chocolate|coffee|tea)$/.test(s)) return 'c';
      if (/^(bar|pub|nightclub)$/.test(a)) return 'b';
      if (a === 'pharmacy' || s === 'chemist') return 'p';
      if (a === 'bank') return 'k';
      if (/^(cinema|theatre)$/.test(a)) return 't';
      if (/^(supermarket|convenience|greengrocer|butcher|deli|alcohol|wine|beverages|cheese|seafood|farm|health_food|spices)$/.test(s)) return 'g';
      return 's';
    };
    const BASE = { r: 3, f: 2, c: 3, b: 3, t: 5, p: 2.5, k: 2, g: 2, s: 1 };
    const cands = [];
    for (const el of shopsRaw.elements) {
      const t = el.tags || {};
      if (/^(vacant|no|disused)$/.test(t.shop || '') || t.disused || t['disused:shop']) continue;
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const [x, z] = proj(lat, lon);
      if (!inside(x, z, -5) || !inRegion(x, z, -2)) continue;
      const name = t.name.replace(/\s+/g, ' ').trim();
      if (name.length < 2 || name.length > 34) continue;
      let bi = -1, bd = 10;                                            // le bâtiment qui le contient, sinon le plus proche
      for (const i of bGrid.near(x, z, 11)) {
        const r = bRings[i];
        if (pointInRing(x, z, r)) { bi = i; bd = 0; break; }
        for (let k = 0; k < r.length; k++) { const a = r[k], b = r[(k + 1) % r.length], d = segDist(x, z, a[0], a[1], b[0], b[1])[0]; if (d < bd) { bd = d; bi = i; } }
      }
      if (bi < 0 || /^[pfc]$/.test(buildings[bi].t || '')) continue;
      const nr = nearestRoad(x, z, drivable, 80);
      if (!nr || nr.d > 40) continue;
      const c = category(t);
      const sc = BASE[c] + (A.famous && A.famous.test(name) ? 20 : 0) + (t.wikidata ? 3 : 0) + (t.brand ? 1 : 0) +
        (t.website || t['contact:website'] ? 1 : 0) + (nr.s.k === 0 && nr.d < 25 ? 2 : 0) + hash(el.id) * 0.5;
      cands.push({ n: name, c, b: bi, x, z, sc });
    }
    cands.sort((p, q) => q.sc - p.sc);
    const perBuilding = new Map();
    for (const s of cands) {
      if (shops.length >= A.shops) break;
      if (shops.some(o => o.n === s.n && Math.hypot(o.x - s.x, o.z - s.z) < 80)) continue;   // doublon nœud + bâtiment
      const k = perBuilding.get(s.b) || 0;
      if (k >= 3) continue;
      perBuilding.set(s.b, k + 1);
      shops.push(s);
    }
    const byCat = {};
    for (const s of shops) byCat[s.c] = (byCat[s.c] || 0) + 1;
    console.log(`  ${shops.length} commerces nommés sur ${cands.length} (${Object.entries(byCat).map(([k, v]) => `${k}:${v}`).join(' ')}) — ${shops.slice(0, 12).map(s => s.n).join(', ')}…`);
  }

  // ---------- Adresses civiques (pour « Aller à… ») ----------
  const addr = {};
  {
    const raw = await overpass('addresses', 'nwr["addr:housenumber"]["addr:street"];out center tags;');
    for (const el of raw.elements) {
      const t = el.tags || {}, lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const [x, z] = proj(lat, lon);
      if (!inside(x, z) || !inRegion(x, z, 0)) continue;
      for (const part of String(t['addr:housenumber']).split(/[;,]/)) {
        const num = parseInt(part, 10);
        if (num > 0 && num < 100000) (addr[t['addr:street'].trim()] ||= []).push([num, Math.round(x), Math.round(z)]);
      }
    }
    let n = 0;
    for (const k of Object.keys(addr)) {
      const seen = new Set(), flatA = [];
      for (const [num, x, z] of addr[k].sort((a, b) => a[0] - b[0])) { if (seen.has(num)) continue; seen.add(num); flatA.push(num, x, z); n++; }
      addr[k] = flatA;
    }
    console.log(`  ${n} adresses sur ${Object.keys(addr).length} rues`);
  }
  // ---------- Statues et monuments ----------
  const statues = [];
  {
    const raw = await overpass('statues', '(nwr["historic"~"^(memorial|monument)$"];nwr["tourism"="artwork"];);out center tags;');
    for (const el of raw.elements) {
      const t = el.tags || {};
      const kind = `${t.memorial || ''} ${t.artwork_type || ''} ${t.historic === 'monument' ? 'monument' : ''}`;
      if (/plaque|mural|graffiti|stolperstein|bench|tree|painting|mosaic|stained/.test(kind)) continue;
      const name = String(t.name || t['subject:fr'] || t.subject || t.inscription || '').replace(/\s+/g, ' ').trim().slice(0, 42);
      // la plupart des « monuments » sont des statues sur socle ; obélisque seulement quand c'en est un
      let k = /bust/.test(kind) ? 'b' : /obelisk|column|stele|cross/.test(kind) || /Obélisque|Colonne|Stèle|Croix|Wolfe/i.test(name) ? 'o' :
        /statue|monument|war_memorial/.test(kind) ? 's' : /sculpture|installation/.test(kind) ? 'a' : '';
      if (!k) continue;
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const [x, z] = proj(lat, lon);
      if (!inside(x, z, -5) || !inRegion(x, z, 10) || nearBuilding(x, z, 0.6)) continue;
      if (/équestre|equestrian/i.test(`${name} ${t.description || ''} ${t.artwork_subject || ''}`) || /Jeanne.?d.?Arc/i.test(name)) k = 'e';
      if (statues.some(o => Math.hypot(o.x - x, o.z - z) < 4)) continue;
      statues.push({ n: name, k, x: round1(x), z: round1(z) });
    }
    console.log(`  ${statues.length} statues et monuments (${statues.filter(q => q.n).slice(0, 8).map(q => q.n).join(', ')}…)`);
  }

  // ---------- Départ ----------
  let spawn = { x: coins[0].x, z: coins[0].z, yaw: 0 };
  {
    const near = landmarks.find(l => l.n === A.spawn.near) || coins[0];
    const toward = landmarks.find(l => l.n === A.spawn.toward);
    const nr = nearestRoad(near.x, near.z, s => A.spawn.road.test(s.n), 800) || nearestRoad(near.x, near.z, drivable);
    if (nr) {
      let dx = nr.s.b[0] - nr.s.a[0], dz = nr.s.b[1] - nr.s.a[1];
      const tx = toward ? toward.x - nr.x : 1, tz = toward ? toward.z - nr.z : 0;
      if (dx * tx + dz * tz < 0) { dx = -dx; dz = -dz; }
      spawn = { x: round1(nr.x), z: round1(nr.z), yaw: Math.round(Math.atan2(dx, dz) * 1000) / 1000 };
    }
  }

  const data = {
    attribution: 'Données © les contributeurs d\'OpenStreetMap (ODbL) · Relief : SRTM 30 m via OpenTopoData',
    generated: new Date().toISOString().slice(0, 10),
    origin: { lat: lat0, lon: lon0 },
    bounds: { minX: round1(B.minX), maxX: round1(B.maxX), minZ: round1(B.minZ), maxZ: round1(B.maxZ) },
    dem: { x0: round1(dem.x0), z0: round1(dem.z0), nx: dem.nx, nz: dem.nz, step: dem.step, h: dem.h },
    mask: { x0: round1(mx0), z0: round1(mz0), nx: mnx, nz: mnz, cell: MASK_CELL, rle },
    waterLevel: A.river ? A.river.level : null,
    roads: roads.map(r => ({ n: r.n, w: r.w, k: r.k, p: flat(r.p) })),
    buildings, walls, gates, trees, landmarks, coins, spawn,
    areas: areas.map(({ n, p }) => ({ n, p })),
    bikes,
    shops: shops.map(s => ({ n: s.n, c: s.c, b: s.b, x: round1(s.x), z: round1(s.z) })),
    addr, statues,
    limit: limit ? flat(limit) : null,
    district: relEl ? (relEl.tags || {}).name : null,
  };
  const js = `// Généré par tools/build-city.mjs le ${data.generated}. ${data.attribution}.\nwindow.${A.global} = ${JSON.stringify(data)};\n`;
  await fs.writeFile(path.join(ROOT, A.out), js);
  console.log(`Écrit ${A.out} (${(js.length / 1024).toFixed(0)} Ko)`);
}

const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
for (const id of wanted.length ? wanted : Object.keys(AREAS)) {
  if (!AREAS[id]) { console.error(`Carte inconnue : ${id} (choix : ${Object.keys(AREAS).join(', ')})`); process.exit(1); }
  await buildArea(id, AREAS[id]);
}
