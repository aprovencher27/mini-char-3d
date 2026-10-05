// Générateur des cartes réelles : à partir d'OpenStreetMap (Overpass) et d'une grille d'altitudes, calcule tout ce
// que le jeu affiche (rues, bâtiments, eau, verdure, arbres, pièces, commerces, adresses, statues, terrains de sport…).
// Partagé par :
//   - tools/build-city.mjs (Node) : les cartes fournies avec le jeu (vieux-quebec.js, plateau-mont-royal.js) ;
//   - le jeu (navigateur) : la carte de n'importe quelle ville, téléchargée et calculée à la demande (CityGen.generate).
//
// Repère du jeu : 1 unité = 1 m, x = -est, z = nord (le nord est en haut de la mini-carte).
(function cityGen(root) {
'use strict';

const DEM_STEP = 30;       // m entre deux points d'altitude
const VERSION = 8;         // cartes générées : on recalcule celles d'une version plus ancienne (2 : banlieue ; 3 : viaducs ; 4 : plex ; 5 : commerces ; 6 : voies ferrées ; 7 : passages inférieurs ; 8 : arbres des parcs)
const MASK_CELL = 3;       // m par cellule du masque eau / verdure
const COIN_COUNT = 32;

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
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Requêtes Overpass, une par catégorie (la zone [bbox:…] est ajoutée devant ; « pad » l'élargit, en degrés)
// ---------------------------------------------------------------------------
// lieux connus d'une carte générée : attraits, musées, gares et métros, lieux historiques, hôtels de ville…
const AUTO_LANDMARKS = '(nwr["name"]["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|theme_park|aquarium)$"];' +
  'nwr["name"]["historic"]["wikidata"];nwr["name"]["railway"="station"];nwr["name"]["station"="subway"];' +
  'nwr["name"]["amenity"~"^(townhall|theatre|arts_centre|library|marketplace|place_of_worship|university)$"]["wikidata"];' +
  'nwr["name"]["leisure"~"^(park|stadium)$"]["wikidata"];nwr["name"]["man_made"~"^(lighthouse|tower)$"]["wikidata"];);out center tags;';
function queries(A) {
  const q = [
    ['roads', 'way["highway"];out geom tags;'],
    // « out geom » (et non « out geom tags ») : sinon les relations arrivent sans leurs membres
    ['buildings', '(way["building"];relation["building"]["type"="multipolygon"];);out geom;'],
    ['walls', '(way["barrier"="city_wall"];node["historic"="city_gate"];);out geom;'],
    ['water', '(way["natural"="water"];relation["natural"="water"]["water"!="river"];way["amenity"="fountain"];way["water"="fountain"];);out geom;'],
  ];
  // fleuve : seulement ses rives (la relation entière est énorme) ; carte générée : les côtes aussi
  if (A.river === 'auto') q.push(['river', 'relation["natural"="water"]["water"="river"]->.rv;(way(r.rv);way["natural"="coastline"];);out geom;']);
  else if (A.river) q.push(['river', 'relation["natural"="water"]["water"="river"];way(r);out geom;', 0.01]);
  q.push(
    ['green', '(way["leisure"~"^(park|garden)$"];relation["leisure"="park"];way["landuse"~"^(grass|forest|recreation_ground|village_green|cemetery)$"];way["natural"~"^(wood|scrub|grassland)$"];node["natural"="tree"];);out geom;'],
    ['areas', '(way["leisure"~"^(park|garden)$"]["name"];relation["leisure"~"^(park|garden)$"]["name"];way["place"="square"]["name"];relation["place"="square"]["name"];way["highway"="pedestrian"]["area"="yes"]["name"];);out geom;'],
    ['sports', '(way["leisure"~"^(pitch|swimming_pool|ice_rink|track|playground|skatepark|water_park|sports_centre|stadium)$"];relation["leisure"~"^(pitch|swimming_pool|ice_rink|track|sports_centre|stadium)$"];);out geom;'],
    ['schools', '(way["amenity"~"^(school|college|university|kindergarten)$"];relation["amenity"~"^(school|college|university)$"];);out geom;'],
    ['landmarks', Array.isArray(A.landmarks) ? `nwr["name"~"${A.landmarks.map(l => l[1].source.replace(/[\^$]/g, '')).join('|')}"];out center tags;` : AUTO_LANDMARKS],
  );
  if (A.overpasses) q.push(['rails', 'way["railway"~"^(rail|light_rail|narrow_gauge|tram)$"];out geom tags;']);   // voies ferrées : ponts et viaducs au-dessus
  if (A.suburbs) q.push(['parking', '(way["amenity"="parking"];relation["amenity"="parking"];);out geom;']);   // restent asphaltés
  if (A.shops) q.push(['shops', '(nwr["name"]["shop"];nwr["name"]["amenity"~"^(restaurant|cafe|bar|pub|fast_food|ice_cream|pharmacy|bank|cinema|theatre|nightclub)$"];);out center tags;']);
  q.push(
    ['addresses', 'nwr["addr:housenumber"]["addr:street"];out center tags;'],
    ['statues', '(nwr["historic"~"^(memorial|monument)$"];nwr["tourism"="artwork"];);out center tags;'],
  );
  return q.map(([name, body, pad = 0]) => ({ name, body, pad }));
}

// Projection locale autour de (lat0, lon0), en mètres : x = -est, z = nord
function projection(lat0, lon0) {
  const phi = lat0 * Math.PI / 180;
  const kLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const kLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  return { proj: (lat, lon) => [-(lon - lon0) * kLon, (lat - lat0) * kLat], unproj: (x, z) => [lat0 + z / kLat, lon0 - x / kLon] };
}

// ---------------------------------------------------------------------------
// Cadre d'une carte : zone à télécharger, projection, grille d'altitudes.
// lines : le contour du territoire (lignes de points { lat, lon }), ou null (on garde A.bbox)
// ---------------------------------------------------------------------------
function frame(A, lines, district) {
  let BBOX = A.bbox;
  if (lines) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const g of lines) for (const p of g) { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lon); e = Math.max(e, p.lon); }
    const pad = A.boundary.keep + 30, pLat = pad / 111130, pLon = pad / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
    BBOX = { s: s - pLat, n: n + pLat, w: w - pLon, e: e + pLon };
  }
  const lat0 = (BBOX.s + BBOX.n) / 2, lon0 = (BBOX.w + BBOX.e) / 2;
  const { proj, unproj } = projection(lat0, lon0);
  const B = { minX: proj(lat0, BBOX.e)[0], maxX: proj(lat0, BBOX.w)[0], minZ: proj(BBOX.s, lon0)[1], maxZ: proj(BBOX.n, lon0)[1] };
  const margin = 90;
  const dem = {
    x0: B.minX - margin, z0: B.minZ - margin, step: DEM_STEP,
    nx: Math.ceil((B.maxX - B.minX + 2 * margin) / DEM_STEP) + 1, nz: Math.ceil((B.maxZ - B.minZ + 2 * margin) / DEM_STEP) + 1,
  };
  // points d'altitude à demander, rangée par rangée : [lat, lon]
  const demPoints = () => {
    const pts = [];
    for (let j = 0; j < dem.nz; j++) for (let i = 0; i < dem.nx; i++) pts.push(unproj(dem.x0 + i * DEM_STEP, dem.z0 + j * DEM_STEP));
    return pts;
  };
  return { BBOX, lat0, lon0, proj, unproj, B, dem, demPoints, lines, district };
}

// ---------------------------------------------------------------------------
// Une carte. raw : réponses Overpass par catégorie (voir queries) + dem { x0, z0, nx, nz, step, h }.
// log : messages d'avancement (peut être asynchrone : le navigateur en profite pour se redessiner)
// ---------------------------------------------------------------------------
async function compute(A, F, raw, log) {
  const { BBOX, proj, B } = F;
  const inside = (x, z, m = 0) => x >= B.minX - m && x <= B.maxX + m && z >= B.minZ - m && z <= B.maxZ + m;
  const toXZ = geom => geom.filter(Boolean).map(p => proj(p.lat, p.lon));
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
  if (F.lines) {
    const rings = joinRings(F.lines.map(toXZ));
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
    await log(`  territoire : ${(Math.abs(area(ring)) / 1e6).toFixed(2)} km², limite roulable de ${limit.length} points`);
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

  const empty = { elements: [] };
  const roadsRaw = raw.roads, buildingsRaw = raw.buildings, wallsRaw = raw.walls, waterRaw = raw.water, riverRaw = raw.river || empty;
  const greenRaw = raw.green, areasRaw = raw.areas, sportsRaw = raw.sports, schoolsRaw = raw.schools, lmRaw = raw.landmarks, dem = raw.dem;

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
  const demAt = (x, z) => {
    const fx = Math.max(0, Math.min(dem.nx - 1.001, (x - dem.x0) / dem.step)), fz = Math.max(0, Math.min(dem.nz - 1.001, (z - dem.z0) / dem.step));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, k = j * dem.nx + i, h = dem.h;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + dem.nx] * (1 - tx) + h[k + dem.nx + 1] * tx) * tz;
  };

  // ---------- Rues ----------
  const DRIVE = {
    trunk: [11, 0], trunk_link: [7, 0], primary: [11, 0], primary_link: [7, 0],
    secondary: [10, 0], secondary_link: [7, 0], tertiary: [8.5, 0], tertiary_link: [7, 0],
    residential: [7.5, 1], unclassified: [7.5, 1], living_street: [6.5, 1],
    pedestrian: [6, 2], service: [5, 3],
  };
  if (A.overpasses) Object.assign(DRIVE, { motorway: [11, 0], motorway_link: [7, 0] });   // autoroutes et bretelles
  // ---------- Ponts, viaducs, passages inférieurs (cartes générées) : hauteur de chaque point de route (et de voie
  // ferrée) par rapport au sol. OSM dit qui passe au-dessus (bridge, layer) mais pas à quelle altitude ; on décide
  // qui bouge à chaque croisement :
  //   - la voie du dessous plonge si OSM le laisse entendre : niveau négatif, petit tunnel, tranchée (cutting), ou
  //     hauteur libre affichée (maxheight) sous un pont court (pas un viaduc, ni une autoroute) ;
  //   - sous un pont ferroviaire, c'est la rue qui plonge (une voie ferrée change peu de niveau), sauf sous un vrai
  //     viaduc (bridge=viaduct, ou plus de 300 m) ;
  //   - sinon le pont monte.
  // Un pont qui monte : tablier à 6,5 m (par niveau) au-dessus de ce qu'il enjambe, en ligne droite entre ses bouts
  // s'il franchit un creux ; les approches en rampe (6 % ; 2,5 % pour un chemin de fer).
  // Une voie qui plonge : 5,5 m sous le pont, en rampe (8 % ; 2,5 %) ; le jeu creuse le sol (passage inférieur).
  // Routes et rails ont chacun leur réseau : un passage à niveau ne soulève (ni n'enfonce) pas l'un avec l'autre.
  // Les autres ponts (ruisseau, rivière) restent au ras du sol. ----------
  const elev = new Map(), railElev = new Map();                        // id de voie → { pts, e : hauteur par point (< 0 : creusé), bridge, spans }
  const RAIL = /^(rail|light_rail|narrow_gauge|tram)$/;
  const lengthOf = pts => pts.reduce((s, p, i) => s + (i ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  const shortTunnel = (t, w) => A.overpasses && t.tunnel === 'yes' && lengthOf(toXZ(w.geometry || [])) < 150;   // passage sous une voie ferrée, sous un bâtiment
  if (A.overpasses) {
    const isBridge = t => !!t.bridge && t.bridge !== 'no';
    // points tous les 8 m au plus (les nœuds OSM d'origine restent : c'est par eux que les voies se rejoignent)
    const dense = pts => {
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1], [bx, bz] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 8));
        for (let k = 1; k <= n; k++) out.push(k === n ? pts[i] : [ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
      }
      return out;
    };
    const wayOf = (w, t, rail) => {
      const pts = toXZ(w.geometry || []), layer = parseInt(t.layer, 10) || 0, tunnel = !rail && shortTunnel(t, w);
      return {
        w, rail, pts: dense(pts), raw: pts, layer, len: lengthOf(pts), bridge: isBridge(t), motorway: /^motorway/.test(t.highway || ''),
        sink: tunnel || t.cutting === 'yes',                           // toute la voie plonge
        under: !!t.maxheight || layer < 0 || tunnel || t.cutting === 'yes',   // elle passe sous quelque chose
        up: t.embankment === 'yes' || t.bridge === 'viaduct',
      };
    };
    const roadWays = [], railWays = [];
    for (const w of roadsRaw.elements) {
      const t = w.tags || {};
      if (!DRIVE[t.highway] || t.area === 'yes' || (t.tunnel === 'yes' && !shortTunnel(t, w)) || t.access === 'no') continue;
      if ((w.geometry || []).length >= 2) roadWays.push(wayOf(w, t, false));
    }
    for (const w of (raw.rails || empty).elements) {
      const t = w.tags || {};
      if (!RAIL.test(t.railway || '') || t.tunnel === 'yes') continue;
      if ((w.geometry || []).length >= 2) railWays.push(wayOf(w, t, true));
    }
    const all = roadWays.concat(railWays);
    const hit = (ax, az, bx, bz, cx, cz, dx, dz) => {
      const d = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
      if (Math.abs(d) < 1e-9) return null;
      const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / d, u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / d;
      return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999 ? [ax + (bx - ax) * t, az + (bz - az) * t] : null;
    };
    const sg = new Grid(40);
    all.forEach((o, wi) => { for (let k = 0; k < o.raw.length - 1; k++) { const [ax, az] = o.raw[k], [bx, bz] = o.raw[k + 1]; sg.add([wi, k], Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)); } });
    const raised = new Set(), sinks = [];                               // ponts qui montent ; voies qui plongent (où, et sous quoi)
    all.forEach((o, wi) => {
      if (!o.bridge) return;
      const seen = new Set();
      for (let k = 0; k < o.raw.length - 1; k++) {
        const [ax, az] = o.raw[k], [bx, bz] = o.raw[k + 1];
        for (const [wj, kj] of sg.near((ax + bx) / 2, (az + bz) / 2, Math.hypot(bx - ax, bz - az) / 2 + 1)) {
          const p = all[wj];
          if (wj === wi || seen.has(wj) || (p.bridge && p.layer >= o.layer)) continue;
          const [cx, cz] = p.raw[kj], [dx, dz] = p.raw[kj + 1], at = hit(ax, az, bx, bz, cx, cz, dx, dz);
          if (!at) continue;
          seen.add(wj);
          // tranchée, tunnel, niveau négatif : la voie du dessous plonge toujours ; sous un pont ferroviaire aussi (un
          // chemin de fer garde son niveau), sauf un vrai viaduc ; hauteur libre affichée : seulement sous un pont
          // court (pas sous un viaduc, ni une autoroute)
          const short = !(o.len > 80 || o.up || o.motorway), railKeeps = o.rail && !p.rail && (o.w.tags || {}).bridge !== 'viaduct' && o.len <= 300;
          if (p.sink || p.layer < 0 || railKeeps || (short && p.under)) { sinks.push({ way: p, x: at[0], z: at[1], r: 12 }); o.spans = true; }
          else { raised.add(o); (o.reqs ||= []).push({ x: at[0], z: at[1], H: p.bridge ? 6.5 * Math.max(1, o.layer) : 6.5 }); }
        }
      }
    });
    // un réseau : on fixe les hauteurs (tabliers) et les profondeurs (sous les ponts), puis on les propage en rampe
    const solve = (ways, upGrade, downGrade, out) => {
      const vid = new Map(), E = [], Dp = [], nbr = [];
      const vert = (x, z) => {
        const key = `${Math.round(x * 20)},${Math.round(z * 20)}`;
        let id = vid.get(key);
        if (id === undefined) { id = E.length; vid.set(key, id); E.push(0); Dp.push(0); nbr.push([]); }
        return id;
      };
      // tablier d'un pont qui monte, au-dessus du sol point par point : il relie ses deux bouts (au sol d'origine) en
      // ligne droite, et dégage d'au moins 6,5 m ce qu'il enjambe (rampe de part et d'autre, palier entre deux).
      // Un viaduc qui franchit un creux (vallée, carrière, gare de triage) arrive ainsi au niveau des rues à ses bouts.
      const deck = o => {
        const g = o.pts.map(([x, z]) => demAt(x, z)), cum = [0], n = g.length - 1;
        for (let k = 1; k <= n; k++) cum.push(cum[k - 1] + Math.hypot(o.pts[k][0] - o.pts[k - 1][0], o.pts[k][1] - o.pts[k - 1][1]));
        const L = cum[n] || 1;
        const req = (o.reqs || []).map(c => {
          let at = 0, bd = Infinity;
          o.pts.forEach(([x, z], k) => { const d = Math.hypot(x - c.x, z - c.z); if (d < bd) { bd = d; at = k; } });
          return { s: cum[at], y: demAt(c.x, c.z) + c.H };
        }).sort((a, b) => a.s - b.s);
        return g.map((gk, k) => {
          const s = cum[k];
          let y = g[0] + (g[n] - g[0]) * s / L;
          for (const c of req) y = Math.max(y, c.y - upGrade * Math.abs(s - c.s));
          for (let i = 0; i + 1 < req.length; i++) {
            const a = req[i], b = req[i + 1];
            if (s >= a.s && s <= b.s) y = Math.max(y, a.y + (b.y - a.y) * (s - a.s) / Math.max(1e-6, b.s - a.s));
          }
          return Math.max(0, y - gk);
        });
      };
      for (const o of ways) {
        o.ids = o.pts.map(([x, z]) => vert(x, z));
        const H = raised.has(o) ? deck(o) : null;
        o.ids.forEach((id, k) => {
          if (H) E[id] = Math.max(E[id], H[k]);
          if (o.sink) Dp[id] = Math.max(Dp[id], 5.5);
          if (!k) return;
          const d = Math.hypot(o.pts[k][0] - o.pts[k - 1][0], o.pts[k][1] - o.pts[k - 1][1]);
          nbr[id].push([o.ids[k - 1], d]);
          nbr[o.ids[k - 1]].push([id, d]);
        });
      }
      for (const s of sinks) if (ways.includes(s.way)) s.way.pts.forEach(([x, z], k) => { if (Math.hypot(x - s.x, z - s.z) <= s.r) Dp[s.way.ids[k]] = Math.max(Dp[s.way.ids[k]], 5.5); });
      const spread = (V, grade) => {                                    // file de priorité : le plus haut (ou le plus profond) d'abord
        const heap = [];
        const push = (e, id) => {
          heap.push([e, id]);
          for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] >= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
        };
        const pop = () => {
          const top = heap[0], last = heap.pop();
          if (heap.length) {
            heap[0] = last;
            for (let i = 0; ;) {
              const l = 2 * i + 1, r = l + 1;
              let m = i;
              if (l < heap.length && heap[l][0] > heap[m][0]) m = l;
              if (r < heap.length && heap[r][0] > heap[m][0]) m = r;
              if (m === i) break;
              [heap[m], heap[i]] = [heap[i], heap[m]];
              i = m;
            }
          }
          return top;
        };
        V.forEach((e, id) => { if (e > 0) push(e, id); });
        while (heap.length) {
          const [e0, u] = pop();
          if (e0 < V[u]) continue;
          for (const [v, d] of nbr[u]) { const e = V[u] - d * grade; if (e > V[v] + 0.01) { V[v] = e; push(e, v); } }
        }
      };
      spread(E, upGrade);
      spread(Dp, downGrade);
      for (const o of ways) {
        const e = o.ids.map(id => E[id] - Dp[id]);
        if (e.some(v => Math.abs(v) > 0.05)) out.set(o.w.id, { pts: o.pts, e, bridge: raised.has(o) });
        if (o.spans) out.set(o.w.id, { ...(out.get(o.w.id) || { pts: o.pts, e: o.pts.map(() => 0), bridge: false }), spans: true });
      }
    };
    solve(roadWays, 0.06, 0.08, elev);
    solve(railWays, 0.025, 0.025, railElev);
    await log(`  ${raised.size} ponts qui montent, ${sinks.length} passages inférieurs ; ${elev.size} routes et ${railElev.size} voies ferrées hors du sol`);
  }
  // hauteur d'une voie surélevée au point (x, z) : sur son segment le plus proche
  const elevOn = (info, x, z) => {
    let best = Infinity, e = 0;
    for (let k = 0; k < info.pts.length - 1; k++) {
      const [ax, az] = info.pts[k], [bx, bz] = info.pts[k + 1], dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (d < best) { best = d; e = info.e[k] + (info.e[k + 1] - info.e[k]) * t; }
    }
    return e;
  };
  const roads = [];
  for (const w of roadsRaw.elements) {
    const t = w.tags || {};
    const spec = DRIVE[t.highway];
    if (!spec || t.area === 'yes' || (t.tunnel === 'yes' && !shortTunnel(t, w)) || t.access === 'no') continue;
    if (t.highway === 'service' && /parking_aisle|driveway|drive-through/.test(t.service || '')) continue;
    let width = spec[0];
    const lanes = parseInt(t.lanes, 10);
    if (lanes > 0 && spec[1] === 0) width = Math.min(14, lanes * 3.3 + 1);
    const info = elev.get(w.id);
    for (const part of splitRegion(clipPolyline(toXZ(w.geometry || []), 20), KEEP)) {
      const pts = info ? part : simplify(part, 0.3);                   // surélevée : on garde tous les points (le profil de la rampe)
      if (pts.length < 2) continue;
      const r = { n: t.name || '', w: width, k: spec[1], p: pts };
      if (/^motorway/.test(t.highway)) r.x = 1;
      if (info) { const e = pts.map(([x, z]) => elevOn(info, x, z)); if (e.some(v => Math.abs(v) > 0.05)) { r.e = e; if (info.bridge) r.b = 1; } if (info.spans) r.g = 1; }
      roads.push(r);
    }
  }
  if (!roads.some(r => r.k <= 1)) throw new Error('aucune rue où rouler dans ce rayon');
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
    if (elev.has(w.id)) sides = [];                                   // pas de bande peinte sur une rampe (elle serait au sol)
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
  // ---------- Voies ferrées (cartes générées) : au sol, ou sur leur pont et leur remblai ----------
  const rails = [];
  if (A.overpasses) for (const w of (raw.rails || empty).elements) {
    const t = w.tags || {};
    if (!RAIL.test(t.railway || '') || t.tunnel === 'yes') continue;
    const info = railElev.get(w.id);
    for (const part of splitRegion(clipPolyline(toXZ(w.geometry || []), 20), KEEP)) {
      const pts = info ? part : simplify(part, 0.3);
      if (pts.length < 2) continue;
      const r = { p: pts };
      if (info) { const e = pts.map(([x, z]) => elevOn(info, x, z)); if (e.some(v => Math.abs(v) > 0.05)) { r.e = e; if (info.bridge) r.b = 1; } if (info.spans) r.g = 1; }
      rails.push(r);
    }
  }
  await log(`  ${bikes.filter(b => b.k === 0).length} pistes cyclables, ${bikes.filter(b => b.k === 1).length} bandes cyclables`);

  const segs = [];
  const segGrid = new Grid(40);
  for (const r of roads) for (let k = 0; k < r.p.length - 1; k++) {
    const s = { a: r.p[k], b: r.p[k + 1], w: r.w, n: r.n, k: r.k, el: (!!r.e && Math.max(r.e[k], r.e[k + 1]) > 0.5) || !!r.g, low: !!r.e && Math.min(r.e[k], r.e[k + 1]) < -0.5, x: !!r.x };   // el : sur un pont ; low : dans un passage inférieur
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
  await log(`  ${roads.length} tronçons de rue`);

  // ---------- Bâtiments ----------
  const pickLevels = id => { let u = hash(id * 7 + 3); for (const [l, p] of A.levels) { if (u < p) return l; u -= p; } return A.levels[A.levels.length - 1][0]; };
  const buildings = [], bTagged = [];                               // bTagged : hauteur ou étages donnés par OSM
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
      else if (/sports_hall|sports_centre|stadium|grandstand|riding_hall/.test(type) || /^(ice_rink|sports_centre|stadium|swimming_pool)$/.test(t.leisure || '') ||
        /^(Aréna|Arena|Centre sportif|Complexe sportif|Piscine|Palestre|Centre aquatique|Pavillon sportif)/i.test(name)) kind = 'a';   // aréna, centre sportif
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
      bTagged.push(parseFloat(t.height) > 0 || parseFloat(t['building:levels']) > 0);
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
    await log(`  ${buildings.filter(b => b.t === 's').length} bâtiments scolaires (${n} trouvés par leur cour), ${buildings.filter(b => b.t === 'c').length} églises`);
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
  await log(`  ${buildings.length} bâtiments`);

  // ---------- Fortifications et portes ----------
  const walls = [], gates = [];
  for (const el of wallsRaw.elements) {
    const t = el.tags || {};
    if (el.type === 'node') { if (t.name) { const [x, z] = proj(el.lat, el.lon); gates.push({ n: t.name, x: round1(x), z: round1(z) }); } continue; }
    const h = parseFloat(t.height) > 0 ? parseFloat(t.height) : 7;
    for (const part of clipPolyline(toXZ(el.geometry || []), 0)) { const pts = simplify(part, 0.3); if (pts.length >= 2) walls.push({ h, p: flat(pts) }); }
  }
  if (walls.length) await log(`  ${walls.length} pans de fortification, ${gates.length} portes`);

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
  await log(`  ${areas.length} parcs et places nommés`);

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
  // les rives (fleuve, côtes) servent de barrière
  const shoreWall = () => {
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
    return wall;
  };
  let waterLevel = A.river && A.river.level != null ? A.river.level : null;
  if (A.river && A.river !== 'auto') {
    // fleuve : la rive sert de barrière, puis on remplit depuis un point du fleuve
    const wall = shoreWall();
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
    await log(`  fleuve : ${(frac * 100).toFixed(0)} % de la zone`);
    if (frac < 0.6 && frac > 0.01) for (let k = 0; k < mask.length; k++) if (river[k] || (wall[k] && (river[k + 1] || river[k - 1]))) mask[k] = 1;
  } else if (A.river === 'auto' && riverRaw.elements.length) {
    // Carte générée : on ne sait pas d'avance où est l'eau. Les rives découpent la zone en morceaux ;
    // ceux où il n'y a ni rue, ni bâtiment, ni verdure sont un fleuve, un lac ou la mer.
    const wall = shoreWall();
    const comp = new Int32Array(mnx * mnz).fill(-1), stats = [];
    for (let s0 = 0; s0 < comp.length; s0++) {
      if (wall[s0] || comp[s0] >= 0) continue;
      const id = stats.length, queue = [s0];
      comp[s0] = id;
      let n = 0;
      while (queue.length) {
        const c = queue.pop(), i = c % mnx, j = (c / mnx) | 0;
        n++;
        if (i > 0 && !wall[c - 1] && comp[c - 1] < 0) { comp[c - 1] = id; queue.push(c - 1); }
        if (i < mnx - 1 && !wall[c + 1] && comp[c + 1] < 0) { comp[c + 1] = id; queue.push(c + 1); }
        if (j > 0 && !wall[c - mnx] && comp[c - mnx] < 0) { comp[c - mnx] = id; queue.push(c - mnx); }
        if (j < mnz - 1 && !wall[c + mnx] && comp[c + mnx] < 0) { comp[c + mnx] = id; queue.push(c + mnx); }
      }
      stats.push({ n, roads: 0, builds: 0, green: 0 });
    }
    const compAt = (x, z) => {
      const i = Math.floor((x - mx0) / MASK_CELL), j = Math.floor((z - mz0) / MASK_CELL);
      return i >= 0 && j >= 0 && i < mnx && j < mnz ? comp[j * mnx + i] : -1;
    };
    for (let k = 0; k < mask.length; k++) if (comp[k] >= 0 && mask[k] === 2) stats[comp[k]].green++;
    for (const r of bRings) { const c = compAt(...centroid(r)); if (c >= 0) stats[c].builds++; }
    for (const w of roadsRaw.elements) {                               // les ponts ne comptent pas
      const t = w.tags || {};
      if (!DRIVE[t.highway] || t.bridge === 'yes' || t.tunnel === 'yes') continue;
      const pts = toXZ(w.geometry || []);
      for (let k = 0; k < pts.length - 1; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 6);
        for (let s = 0; s < n; s++) { const c = compAt(ax + (bx - ax) * s / n, az + (bz - az) * s / n); if (c >= 0) stats[c].roads++; }
      }
    }
    const isWater = stats.map(s => s.n >= 2000 && s.roads <= 2 + s.n * 0.0005 && s.builds <= 1 + s.n * 0.0002 && s.green < s.n * 0.25);
    const wet = k => k >= 0 && k < mask.length && comp[k] >= 0 && isWater[comp[k]];
    let nWet = 0;
    for (let k = 0; k < mask.length; k++) if (wet(k)) nWet++;
    const frac = nWet / mask.length;
    await log(`  fleuve, lac ou mer : ${(frac * 100).toFixed(0)} % de la zone`);
    if (frac > 0.005 && frac < 0.85) {
      const shore = [];
      for (let k = 0; k < mask.length; k++) {
        if (wet(k)) mask[k] = 1;
        else if (wall[k] && (wet(k + 1) || wet(k - 1) || wet(k + mnx) || wet(k - mnx))) { mask[k] = 1; shore.push(k); }
      }
      // ponts : la chaussée reste sur la terre ferme (une digue au ras de l'eau plutôt qu'une rue sous l'eau)
      for (const w of roadsRaw.elements) {
        const t = w.tags || {}, spec = DRIVE[t.highway];
        if (!spec || t.bridge !== 'yes' || elev.has(w.id)) continue;          // pont surélevé : l'eau reste dessous
        const pts = toXZ(w.geometry || []), r = spec[0] / 2 + 1.5;
        for (let k = 0; k < pts.length - 1; k++) {
          const [ax, az] = pts[k], [bx, bz] = pts[k + 1], n = Math.ceil(Math.hypot(bx - ax, bz - az) / MASK_CELL) + 1;
          for (let s = 0; s <= n; s++) {
            const x = ax + (bx - ax) * s / n, z = az + (bz - az) * s / n;
            const i0 = Math.floor((x - r - mx0) / MASK_CELL), i1 = Math.floor((x + r - mx0) / MASK_CELL);
            const j0 = Math.floor((z - r - mz0) / MASK_CELL), j1 = Math.floor((z + r - mz0) / MASK_CELL);
            for (let j = Math.max(0, j0); j <= Math.min(mnz - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(mnx - 1, i1); i++) {
              if (Math.hypot(mx0 + (i + 0.5) * MASK_CELL - x, mz0 + (j + 0.5) * MASK_CELL - z) < r && mask[j * mnx + i] === 1) mask[j * mnx + i] = 0;
            }
          }
        }
      }
      // niveau de l'eau : un peu sous les rives les plus basses
      const hs = shore.map(k => demAt(mx0 + (k % mnx + 0.5) * MASK_CELL, mz0 + (((k / mnx) | 0) + 0.5) * MASK_CELL)).sort((p, q) => p - q);
      if (hs.length) waterLevel = round1(hs[Math.floor(hs.length * 0.1)] - 0.5);
    }
  }
  const parkCell = mask.map(v => (v === 2 ? 1 : 0));                  // la verdure d'OSM (parcs, bois…), avant les pelouses de banlieue
  // ---------- Banlieue (cartes générées) : dans un secteur peu bâti, les petits bâtiments résidentiels sont des maisons
  // (bungalow ou cottage : voir CityBatch.house dans le jeu) avec leur entrée asphaltée, et le terrain autour est gazonné ----------
  if (A.suburbs) {
    // part du sol couverte de bâtiments dans un carré de 90 m (cases de 10 m, tables des sommes cumulées) :
    // ~0,2 en banlieue, ~0,45 dans un quartier de plex, plus au centre-ville. On ne compte que la surface où les
    // bâtiments sont connus et où l'on peut bâtir (au-delà du territoire, il n'y en a pas, et un parc n'est pas un
    // terrain vague : sinon tout paraîtrait peu bâti près du bord et au bord des parcs).
    const C = 10, gnx = Math.ceil(mnx * MASK_CELL / C) + 1, gnz = Math.ceil(mnz * MASK_CELL / C) + 1, G1 = gnx + 1;
    const built = new Float64Array(G1 * (gnz + 1)), known = new Float64Array(G1 * (gnz + 1));
    bRings.forEach(r => {
      const [x, z] = centroid(r), i = Math.floor((x - mx0) / C), j = Math.floor((z - mz0) / C);
      if (i >= 0 && j >= 0 && i < gnx && j < gnz) built[(j + 1) * G1 + i + 1] += Math.abs(area(r));
    });
    for (let j = 0; j < gnz; j++) for (let i = 0; i < gnx; i++) {                 // terrain bâtissable : ni parc, ni eau
      const x = mx0 + (i + 0.5) * C, z = mz0 + (j + 0.5) * C, mi = Math.floor((x - mx0) / MASK_CELL), mj = Math.floor((z - mz0) / MASK_CELL);
      if (inRegion(x, z, KEEP - 10) && mi < mnx && mj < mnz && mask[mj * mnx + mi] === 0) known[(j + 1) * G1 + i + 1] = C * C;
    }
    for (const t of [built, known]) for (let j = 1; j <= gnz; j++) for (let i = 1; i <= gnx; i++) t[j * G1 + i] += t[(j - 1) * G1 + i] + t[j * G1 + i - 1] - t[(j - 1) * G1 + i - 1];
    const box = (t, i0, i1, j0, j1) => t[(j1 + 1) * G1 + i1 + 1] - t[j0 * G1 + i1 + 1] - t[(j1 + 1) * G1 + i0] + t[j0 * G1 + i0];
    const overall = box(built, 0, gnx - 1, 0, gnz - 1) / Math.max(1, box(known, 0, gnx - 1, 0, gnz - 1));
    const coverage = (x, z) => {                                       // null : trop loin de tout bâtiment connu
      const i = Math.floor((x - mx0) / C), j = Math.floor((z - mz0) / C);
      const i0 = Math.max(0, i - 4), i1 = Math.min(gnx - 1, i + 4), j0 = Math.max(0, j - 4), j1 = Math.min(gnz - 1, j + 4);
      if (i1 < i0 || j1 < j0) return null;
      const k = box(known, i0, i1, j0, j1);
      return k < 81 * C * C * 0.15 ? null : box(built, i0, i1, j0, j1) / k;
    };
    const SPARSE = 0.28, sparse = (x, z) => { const c = coverage(x, z); return (c === null ? overall : c) <= SPARSE; };
    const street = s => s.k <= 1 && !s.el && !s.low && !s.x;
    let nh = 0, nd = 0;
    buildings.forEach((b, i) => {
      if ((b.t && b.t !== 'r') || b.n || b.rs === 'f' || b.rs === 'm') return;   // nommé (école, commerce…), toit plat ou mansardé
      const r = bRings[i], a = Math.abs(area(r)), [cx, cz] = centroid(r);
      if (a < 35 || a > 320 || !sparse(cx, cz)) return;
      // isolée : un duplex, un triplex ou une maison en rangée a un mur mitoyen (une maison de banlieue, des cours tout autour)
      for (const j of bGrid.near(cx, cz, Math.sqrt(a) + 4)) {
        if (j === i) continue;
        const o = bRings[j];
        if (r.some(([x, z]) => pointInRing(x, z, o) || o.some((q, k) => segDist(x, z, q[0], q[1], o[(k + 1) % o.length][0], o[(k + 1) % o.length][1])[0] < 0.8))) return;
      }
      // étages : ceux d'OSM, sinon bungalow (plain-pied) ou cottage (deux étages) ; les grandes emprises sont plus souvent des bungalows
      const lv = bTagged[i] ? Math.max(1, Math.min(3, b.l)) : hash(i * 31 + 7) < (a > 130 ? 0.6 : a > 95 ? 0.45 : 0.25) ? 1 : 2;
      b.t = 'h';
      b.l = lv;
      if (!bTagged[i]) b.h = round1(0.5 + lv * 2.7 + 1.8);
      if (!b.rs) b.rs = hash(i * 13 + 5) < 0.45 ? 'h' : 'g';
      nh++;
      // entrée asphaltée : de la rue jusqu'à la façade qui lui fait face, à un bout (garage) ou à côté de la maison
      const nr = nearestRoad(cx, cz, street, 80);
      if (!nr) return;
      let best = null;
      for (let k = 0; k < r.length; k++) {
        const [ax, az] = r[k], [bx, bz] = r[(k + 1) % r.length], L = Math.hypot(bx - ax, bz - az);
        if (L < 4) continue;
        let nx = -(bz - az) / L, nz = (bx - ax) / L;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (pointInRing(mx + nx * 0.3, mz + nz * 0.3, r)) { nx = -nx; nz = -nz; }
        const tx = nr.x - mx, tz = nr.z - mz, f = (tx * nx + tz * nz) / (Math.hypot(tx, tz) || 1);
        if (f > 0.5 && (!best || f * Math.min(L, 12) > best.s)) best = { s: f * Math.min(L, 12), ax, az, bx, bz, L, nx, nz };
      }
      if (!best) return;
      const garage = best.L >= 9 && hash(i * 5 + 3) < 0.6, end = hash(i * 7 + 1) < 0.5;
      const ux = (best.bx - best.ax) / best.L, uz = (best.bz - best.az) / best.L, sg = end ? -1 : 1, off = garage ? 1.9 : -1.9;
      const [kx, kz] = end ? [best.bx, best.bz] : [best.ax, best.az];
      const hx = kx + ux * sg * off, hz = kz + uz * sg * off;
      const rr = nearestRoad(hx + best.nx * 2, hz + best.nz * 2, street, 80);
      if (!rr) return;
      const dx = hx - rr.x, dz = hz - rr.z, dl = Math.hypot(dx, dz);
      if (dl < rr.s.w / 2 + 1 || dl > 45) return;
      const sx = rr.x + dx / dl * (rr.s.w / 2 - 0.3), sz = rr.z + dz / dl * (rr.s.w / 2 - 0.3);   // départ : le bord de la chaussée
      for (let q = 0.05; q < 0.96; q += 0.05) {                       // ne traverse pas d'autre bâtiment
        const x = sx + (hx - sx) * q, z = sz + (hz - sz) * q;
        for (const j of bGrid.near(x, z, 2)) if (j !== i && pointInRing(x, z, bRings[j])) return;
      }
      b.dw = [round1(sx), round1(sz), round1(hx), round1(hz)];
      if (garage) b.gar = 1;
      nd++;
    });
    // pelouse autour des maisons (à moins de 70 m, dans un secteur peu bâti), sauf les rues (et un trottoir), les
    // stationnements et les entrées : ni dans les cours du Plateau, ni dans le stationnement d'un centre commercial
    const yards = new Uint8Array(gnx * gnz);
    buildings.forEach((b, i) => {
      if (b.t !== 'h') return;
      const [x, z] = centroid(bRings[i]), i0 = Math.floor((x - mx0) / C), j0 = Math.floor((z - mz0) / C);
      for (let j = Math.max(0, j0 - 7); j <= Math.min(gnz - 1, j0 + 7); j++) for (let ii = Math.max(0, i0 - 7); ii <= Math.min(gnx - 1, i0 + 7); ii++) {
        if ((ii - i0) ** 2 + (j - j0) ** 2 <= 49) yards[j * gnx + ii] = 1;
      }
    });
    const paved = new Uint8Array(mnx * mnz);
    const stamp = (x, z, rad) => {
      const i0 = Math.max(0, Math.floor((x - rad - mx0) / MASK_CELL)), i1 = Math.min(mnx - 1, Math.floor((x + rad - mx0) / MASK_CELL));
      const j0 = Math.max(0, Math.floor((z - rad - mz0) / MASK_CELL)), j1 = Math.min(mnz - 1, Math.floor((z + rad - mz0) / MASK_CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (Math.hypot(mx0 + (i + 0.5) * MASK_CELL - x, mz0 + (j + 0.5) * MASK_CELL - z) < rad) paved[j * mnx + i] = 1;
      }
    };
    const stampLine = (ax, az, bx, bz, rad) => { const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5); for (let s = 0; s <= n; s++) stamp(ax + (bx - ax) * s / n, az + (bz - az) * s / n, rad); };
    for (const r of roads) for (let k = 0; k < r.p.length - 1; k++) stampLine(r.p[k][0], r.p[k][1], r.p[k + 1][0], r.p[k + 1][1], r.w / 2 + 0.8);   // la chaussée et sa bordure
    for (const b of buildings) {
      if (!b.dw) continue;
      const [sx, sz, hx, hz] = b.dw, L = Math.hypot(hx - sx, hz - sz) || 1, ex = b.gar ? 0 : 6;   // à côté de la maison : la place de stationnement
      stampLine(sx, sz, hx + (hx - sx) / L * ex, hz + (hz - sz) / L * ex, 2);
    }
    for (const el of (raw.parking || empty).elements) for (const ring of polygonsOf(el)) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
      const i0 = Math.max(0, Math.floor((minX - mx0) / MASK_CELL)), i1 = Math.min(mnx - 1, Math.ceil((maxX - mx0) / MASK_CELL));
      const j0 = Math.max(0, Math.floor((minZ - mz0) / MASK_CELL)), j1 = Math.min(mnz - 1, Math.ceil((maxZ - mz0) / MASK_CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (pointInRing(mx0 + (i + 0.5) * MASK_CELL, mz0 + (j + 0.5) * MASK_CELL, ring)) paved[j * mnx + i] = 1;
    }
    let nl = 0;
    for (let j = 0; j < mnz; j++) for (let i = 0; i < mnx; i++) {
      const k = j * mnx + i;
      const x = mx0 + (i + 0.5) * MASK_CELL, z = mz0 + (j + 0.5) * MASK_CELL;
      if (mask[k] !== 0 || paved[k] || !yards[Math.floor((z - mz0) / C) * gnx + Math.floor((x - mx0) / C)] || !sparse(x, z)) continue;
      mask[k] = 2;
      nl++;
    }
    await log(`  banlieue : ${nh} maisons (${nd} entrées asphaltées), ${(nl * MASK_CELL * MASK_CELL / 1e6).toFixed(2)} km² de pelouse`);
  }
  const rle = [];
  for (let k = 0; k < mask.length;) { let n = 1; while (k + n < mask.length && mask[k + n] === mask[k]) n++; rle.push(mask[k], n); k += n; }

  // ---------- Arbres (inventaire OSM éclairci + arbres semés sur les pelouses et dans les parcs) ----------
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
  // hasard déterministe : hash2(i, j) dans [0, 1[, et un bruit doux à l'échelle de 40 m (bosquets et clairières)
  const hash2 = (i, j) => { let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  const smooth = t => t * t * (3 - 2 * t);
  const noise = (x, z) => {
    const fx = x / 40, fz = z / 40, i = Math.floor(fx), j = Math.floor(fz), sx = smooth(fx - i), sz = smooth(fz - j);
    const a = hash2(i, j) + (hash2(i + 1, j) - hash2(i, j)) * sx, b = hash2(i, j + 1) + (hash2(i + 1, j + 1) - hash2(i, j + 1)) * sx;
    return a + (b - a) * sz;
  };
  const inPark = (x, z) => {
    const i = Math.floor((x - mx0) / MASK_CELL), j = Math.floor((z - mz0) / MASK_CELL), k = j * mnx + i;
    return i >= 0 && j >= 0 && i < mnx && j < mnz && parkCell[k] === 1 && mask[k] === 2;
  };
  // l'inventaire d'OSM (souvent les arbres de rue, par milliers), pris dans un ordre mélangé jusqu'au budget (dans
  // l'ordre du fichier, on garderait des quartiers entiers et pas un arbre ailleurs) ; ceux des parcs, à part
  const osmTrees = greenRaw.elements.filter(el => el.type === 'node').map(el => [hash2(el.id % 1000003, (el.id / 1000003) | 0), el]).sort((a, b) => a[0] - b[0]);
  const parkOsm = [], parkOsmGrid = new Grid(6);
  for (const [h, el] of osmTrees) {
    const [x, z] = proj(el.lat, el.lon);
    if (inPark(x, z)) { const t = [x, z, h, 1]; parkOsm.push(t); parkOsmGrid.add(t, x, z, x, z); }
    else if (trees.length / 2 < A.maxTrees && treeFree(x, z)) plant(x, z);
  }
  const nOsm = trees.length / 2;
  {                                                                    // pelouses de banlieue
    let s = 12345;
    const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
    for (let tries = 0; tries < 90000 && trees.length / 2 < A.maxTrees + 800; tries++) {
      const x = B.minX + rnd() * (B.maxX - B.minX), z = B.minZ + rnd() * (B.maxZ - B.minZ);
      const i = Math.floor((x - mx0) / MASK_CELL), j = Math.floor((z - mz0) / MASK_CELL);
      if (mask[j * mnx + i] !== 2 || parkCell[j * mnx + i] || rnd() > 0.5) continue;
      if (treeFree(x, z)) plant(x, z);
    }
  }
  const nLawn = trees.length / 2 - nOsm;
  let nParkOsm = 0;
  // parcs et bois : leurs arbres d'OSM, et un semis là où il n'y en a pas (un arbre par case de 11 m au plus, en
  // bosquets et clairières) ; au-delà du budget, les deux sont éclaircis uniformément
  {
    const roomy = (x, z) => { for (const t of parkOsmGrid.near(x, z, 6)) if (Math.hypot(t[0] - x, t[1] - z) < 6) return false; return true; };
    const G = 11, cands = parkOsm.slice();
    for (let gj = Math.floor(B.minZ / G); gj * G < B.maxZ; gj++) for (let gi = Math.floor(B.minX / G); gi * G < B.maxX; gi++) {
      const x = (gi + 0.15 + 0.7 * hash2(gi, gj + 7919)) * G, z = (gj + 0.15 + 0.7 * hash2(gi + 104729, gj)) * G;
      const i = Math.floor((x - mx0) / MASK_CELL), j = Math.floor((z - mz0) / MASK_CELL), k = j * mnx + i;
      if (i < 0 || j < 0 || i >= mnx || j >= mnz || !parkCell[k] || mask[k] !== 2 || !inside(x, z, -4) || !inRegion(x, z, 60)) continue;
      if (hash2(gi + 31337, gj + 4242) < Math.min(0.95, Math.max(0.08, noise(x, z) * 1.4 - 0.15)) && roomy(x, z)) cands.push([x, z, hash2(gi + 999, gj + 555), 0]);
    }
    const keep = Math.min(1, (A.parkTrees || 0) / Math.max(1, cands.length));
    for (const [x, z, r, osm] of cands) if (r < keep && treeFree(x, z)) { plant(x, z); nParkOsm += osm; }
  }
  await log(`  ${trees.length / 2} arbres (${nOsm} de rue, ${nLawn} sur les pelouses, ${trees.length / 2 - nOsm - nLawn} dans les parcs dont ${nParkOsm} d'OSM)`);

  // ---------- Pièces : lieux célèbres, puis on complète le long des rues ----------
  const coins = [];
  const drivable = s => s.k !== 3, onGround = s => drivable(s) && !s.el;   // pas de pièce sur un pont (elle flotterait dessous)
  const farFromCoins = (x, z, d) => coins.every(c => Math.hypot(c.x - x, c.z - z) >= d);
  const score = e => { const t = e.tags || {}; return (e.type !== 'node' ? 1 : 0) + (t.railway === 'station' || t.station === 'subway' || t.public_transport === 'station' ? 4 : 0) + (t.tourism || t.historic || t.leisure || t.amenity || t.building ? 2 : 0) - (t.highway ? 1 : 0); };
  const landmarks = [];
  for (const [label, re] of Array.isArray(A.landmarks) ? A.landmarks : autoLandmarks()) {
    const cands = lmRaw.elements.filter(e => re.test((e.tags || {}).name || '')).map(e => ({ e, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon })).filter(c => c.lat != null && inside(...proj(c.lat, c.lon), -10) && inRegion(...proj(c.lat, c.lon), 5));
    cands.sort((a, b) => score(b.e) - score(a.e));
    if (!cands.length) continue;
    const [x, z] = proj(cands[0].lat, cands[0].lon);
    landmarks.push({ n: label, x: round1(x), z: round1(z) });
    const nr = nearestRoad(x, z, onGround, 400);
    const reach = (cands[0].e.tags || {}).leisure ? 350 : 150;
    if (!nr || nr.d > reach || !inRegion(nr.x, nr.z, -15) || !farFromCoins(nr.x, nr.z, 45) || coins.length >= COIN_COUNT - 4) continue;
    coins.push({ x: round1(nr.x), z: round1(nr.z), n: label });
  }
  // carte générée : les lieux les plus connus du territoire (Wikidata, attraits, gares…), assez loin les uns des autres
  function autoLandmarks() {
    const fame = t => (t.wikidata ? 3 : 0) + (t.wikipedia ? 1 : 0) + (/^(attraction|museum|zoo|theme_park|aquarium)$/.test(t.tourism || '') ? 3 : t.tourism ? 2 : 0) +
      (t.railway === 'station' || t.station === 'subway' ? 3 : 0) + (t.amenity === 'townhall' ? 2 : 0) + (t.historic ? 1 : 0);
    const picked = [], names = new Set();
    const cands = lmRaw.elements.map(e => ({ e, t: e.tags || {}, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon })).filter(c => c.lat != null && c.t.name);
    cands.sort((a, b) => fame(b.t) - fame(a.t) || a.e.id - b.e.id);
    for (const c of cands) {
      const [x, z] = proj(c.lat, c.lon), n = c.t.name.trim();
      if (picked.length >= 40 || names.has(n) || n.length > 40 || !inside(x, z, -10) || !inRegion(x, z, -10)) continue;
      if (picked.some(p => Math.hypot(p.x - x, p.z - z) < 80)) continue;
      names.add(n);
      const station = (c.t.railway === 'station' || c.t.station === 'subway') && !/^(Station|Gare)\b/i.test(n);
      picked.push({ x, z, label: station ? `Station ${n}` : n, re: new RegExp(`^${escapeRe(n)}$`) });
    }
    return picked.map(p => [p.label, p.re]);
  }
  const landmarkCoins = coins.length;
  {
    const cands = [];
    for (const s of segs) {
      if (!onGround(s)) continue;
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
  await log(`  ${coins.length} pièces (${landmarkCoins} près de lieux célèbres : ${coins.slice(0, landmarkCoins).map(c => c.n).join(', ')})`);
  if (!coins.length) throw new Error('aucune rue où placer les pièces');

  // ---------- Commerces : les plus connus d'abord, accrochés au bâtiment qui les abrite ----------
  const shops = [];
  if (A.shops) {
    const shopsRaw = raw.shops;
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
      if (bi < 0 || /^[pfch]$/.test(buildings[bi].t || '')) continue;   // pas d'enseigne sur une maison de banlieue
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
    await log(`  ${shops.length} commerces nommés sur ${cands.length} (${Object.entries(byCat).map(([k, v]) => `${k}:${v}`).join(' ')}) — ${shops.slice(0, 12).map(s => s.n).join(', ')}…`);
  }

  // ---------- Terrains de sport, piscines, patinoires, jeux pour enfants ----------
  const sports = [];
  {
    const SPORT = { tennis: 'tennis', soccer: 'soccer', american_football: 'soccer', rugby: 'soccer', baseball: 'baseball', softball: 'baseball',
      basketball: 'basket', volleyball: 'volley', beachvolleyball: 'volley', boules: 'boules', petanque: 'boules', bocce: 'boules',
      ice_hockey: 'rink', hockey: 'rink', ice_skating: 'rink', skateboard: 'skate', running: 'track', athletics: 'track', multi: 'multi', futsal: 'multi', handball: 'multi' };
    for (const el of sportsRaw.elements) {
      const t = el.tags || {}, lz = t.leisure, sp = String(t.sport || '').split(';')[0];
      const name = String(t.name || '').trim();
      for (let ring of polygonsOf(el)) {
        ring = simplify(ring.concat([ring[0]]), 0.4).slice(0, -1);
        const a = Math.abs(area(ring));
        if (ring.length < 3 || a < 25) continue;
        const [cx, cz] = centroid(ring);
        if (!inside(cx, cz) || !inRegion(cx, cz, 0)) continue;
        const indoor = t.indoor === 'yes' || t.covered === 'yes' || t.location === 'indoor' || t.building || nearBuilding(cx, cz, -0.1);
        if (lz === 'sports_centre' || lz === 'stadium' || (indoor && /ice_rink|swimming_pool/.test(lz))) {   // aréna : le bâtiment dessus
          for (const i of bGrid.near(cx, cz, 60)) {
            const b = buildings[i];
            if (/^[cfp]$/.test(b.t || '')) continue;
            const [bx, bz] = centroid(bRings[i]);
            if (pointInRing(bx, bz, ring) || pointInRing(cx, cz, bRings[i])) { b.t = 'a'; if (!b.n && name) b.n = name; }
          }
          continue;
        }
        if (indoor || /roof/.test(t.location || '') || +(t.level || 0) > 0) continue;   // piscines sur les toits : non
        let k = lz === 'swimming_pool' || lz === 'water_park' ? (/private|customers/.test(t.access || '') ? null : 'pool') : lz === 'ice_rink' ? 'rink' : lz === 'track' ? 'track' :
          lz === 'playground' ? 'play' : lz === 'skatepark' ? 'skate' : lz === 'pitch' ? SPORT[sp] || 'multi' : null;
        if (!k || (k === 'play' && a < 60)) continue;
        sports.push({ k, n: name, p: flat(ring) });
      }
    }
    const byK = {};
    for (const q of sports) byK[q.k] = (byK[q.k] || 0) + 1;
    await log(`  ${sports.length} terrains de sport (${Object.entries(byK).map(([k, v]) => `${k}:${v}`).join(' ')}), ${buildings.filter(b => b.t === 'a').length} arénas et centres sportifs`);
  }

  // ---------- Adresses civiques (pour « Aller à… ») ----------
  const addr = {};
  {
    for (const el of raw.addresses.elements) {
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
    await log(`  ${n} adresses sur ${Object.keys(addr).length} rues`);
  }
  // ---------- Statues et monuments ----------
  const statues = [];
  {
    for (const el of raw.statues.elements) {
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
    await log(`  ${statues.length} statues et monuments (${statues.filter(q => q.n).slice(0, 8).map(q => q.n).join(', ')}…)`);
  }

  // ---------- Départ (carte générée : la grande rue la plus proche du centre) ----------
  let spawn = { x: coins[0].x, z: coins[0].z, yaw: 0 };
  {
    const S = A.spawn;
    const near = S ? landmarks.find(l => l.n === S.near) || coins[0] : { x: 0, z: 0 };
    const toward = S && landmarks.find(l => l.n === S.toward);
    const nr = nearestRoad(near.x, near.z, S ? s => S.road.test(s.n) : s => s.k === 0 && !!s.n && !s.el && !s.low && !s.x, 800) || nearestRoad(near.x, near.z, onGround);
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
    origin: { lat: F.lat0, lon: F.lon0 },
    bounds: { minX: round1(B.minX), maxX: round1(B.maxX), minZ: round1(B.minZ), maxZ: round1(B.maxZ) },
    dem: { x0: round1(dem.x0), z0: round1(dem.z0), nx: dem.nx, nz: dem.nz, step: dem.step, h: dem.h },
    mask: { x0: round1(mx0), z0: round1(mz0), nx: mnx, nz: mnz, cell: MASK_CELL, rle },
    waterLevel,
    roads: roads.map(r => ({ n: r.n, w: r.w, k: r.k, p: flat(r.p), ...(r.e ? { e: r.e.map(round1), ...(r.b ? { b: 1 } : {}) } : {}), ...(r.g ? { g: 1 } : {}), ...(r.x ? { x: 1 } : {}) })),   // e : hauteur par point (< 0 : creusé) ; b : pont (vide dessous) ; g : pont au ras du sol au-dessus d'un passage inférieur ; x : autoroute
    buildings, walls, gates, trees, landmarks, coins, spawn,
    areas: areas.map(({ n, p }) => ({ n, p })),
    bikes,
    ...(rails.length ? { rails: rails.map(r => ({ p: flat(r.p), ...(r.e ? { e: r.e.map(round1), ...(r.b ? { b: 1 } : {}) } : {}), ...(r.g ? { g: 1 } : {}) })) } : {}),
    shops: shops.map(s => ({ n: s.n, c: s.c, b: s.b, x: round1(s.x), z: round1(s.z) })),
    addr, statues, sports,
    limit: limit ? flat(limit) : null,
    district: F.lines ? F.district : null,
  };
  return data;
}

// ===========================================================================
// Navigateur : la carte de n'importe quelle ville, à la demande
//   nom de lieu → Nominatim (ou Photon) → un cercle de « radius » m autour → une seule requête Overpass
//   (les catégories séparées par des marqueurs « make ») → relief des tuiles Terrarium (AWS) → compute.
//   CityGen.generateAsync fait tout ça dans un Worker : le jeu reste fluide (zone suivante préparée en roulant).
// ===========================================================================
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
// overpass-api.de refuse (406) une requête sans Referer : c'est le cas d'une page ouverte en fichier local (file://)
const LOCAL_FILE = typeof location !== 'undefined' && location.protocol === 'file:';
const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const ABORT = () => new DOMException('Génération annulée', 'AbortError');
const wait = (ms, signal) => new Promise((ok, ko) => {
  const t = setTimeout(ok, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); ko(ABORT()); }, { once: true });
});
const withTimeout = (signal, ms) => (AbortSignal.any && AbortSignal.timeout ? AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(ms)]) : signal);
// net : { signal, referrer, localFile }. referrer : dans le Worker, l'adresse de la page (sinon aucun Referer ne part)
const get = (net, url, ms, init = {}) => fetch(url, { ...init, signal: withTimeout(net.signal, ms), ...(net.referrer ? { referrer: net.referrer } : {}) });

// Réglages d'une carte générée : un cercle de « radius » m autour du lieu, densités selon la superficie
function liveArea(place, radius) {
  const km2 = Math.PI * (radius / 1000) ** 2, { unproj } = projection(place.lat, place.lon);
  const ring = [];
  for (let k = 0; k <= 96; k++) {
    const a = (k % 96) / 96 * Math.PI * 2, [lat, lon] = unproj(-Math.cos(a) * radius, Math.sin(a) * radius);
    ring.push({ lat, lon });
  }
  return {
    boundary: { drive: 12, keep: 120 }, lines: [ring],
    river: 'auto',
    levels: [[2, 0.3], [3, 0.55], [4, 0.15]],   // étages quand OSM ne dit rien : comme le Plateau fourni (les maisons de banlieue ont les leurs)
    suburbs: true,
    overpasses: true,                                  // autoroutes, ponts, viaducs et échangeurs
    maxTrees: Math.round(Math.min(9000, 1000 * km2)),
    parkTrees: Math.round(Math.min(6000, 1500 * km2)),
    shops: Math.round(Math.min(1500, 220 * km2)),       // densité d'une rue commerçante du Plateau (~210 au km²)
    landmarks: 'auto',
  };
}

async function geocode(q, net) {
  const tries = [
    async () => {
      const res = await get(net, `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=fr&q=${encodeURIComponent(q)}`, 15000);
      if (!res.ok) throw new Error(`Nominatim : ${res.status}`);
      const r = (await res.json())[0];
      return r && { lat: +r.lat, lon: +r.lon, name: r.name || q, label: r.display_name || r.name || q };
    },
    async () => {
      const res = await get(net, `https://photon.komoot.io/api/?limit=1&lang=fr&q=${encodeURIComponent(q)}`, 15000);
      if (!res.ok) throw new Error(`Photon : ${res.status}`);
      const f = (await res.json()).features?.[0];
      if (!f) return null;
      const p = f.properties || {}, name = p.name || q;
      return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name, label: [name, p.city !== name ? p.city : '', p.state, p.country].filter(Boolean).join(', ') };
    },
  ];
  let err = null;
  for (const t of tries) {
    try { const r = await t(); if (r) return r; } catch (e) { if (net.signal && net.signal.aborted) throw ABORT(); err = e.name === 'TypeError' ? new Error('pas de connexion') : e; }
  }
  const e = new Error(err ? `la recherche de lieux ne répond pas (${err.message})` : `« ${q} » introuvable`);
  e.notFound = !err;
  throw e;
}

// Nom d'une zone voisine (le quartier, sinon la ville) ; sans réponse, le nom qu'on avait déjà
async function reverse({ lat, lon, name }, net) {
  try {
    const res = await get(net, `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=fr&lat=${lat}&lon=${lon}`, 15000);
    if (res.ok) {
      const r = await res.json(), a = r.address || {};
      const n = a.neighbourhood || a.quarter || a.suburb || a.city_district || a.village || a.town || a.city || r.name;
      if (n) return { lat, lon, name: n, label: r.display_name || n };
    }
  } catch (e) { if (net.signal && net.signal.aborted) throw ABORT(); }
  return { lat, lon, name: name || 'Zone voisine', label: name || 'Zone voisine' };
}

// lit la réponse morceau par morceau pour afficher les mégaoctets reçus
async function readText(res, onBytes) {
  if (!res.body || !res.body.getReader) return res.text();
  const reader = res.body.getReader(), dec = new TextDecoder(), parts = [];
  let n = 0, shown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    parts.push(dec.decode(value, { stream: true }));
    if (n - shown > 300000) { shown = n; onBytes(n); }
  }
  parts.push(dec.decode());
  return parts.join('');
}

async function overpassAll(BBOX, list, status, net) {
  const q = `[out:json][timeout:120][bbox:${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}];` + list.map(({ name, body }) => `make set n="${name}";out;${body}`).join('');
  const eps = net.localFile ? [...OVERPASS.slice(1), OVERPASS[0]] : OVERPASS, signal = net.signal;
  let err = null;
  for (let attempt = 0; attempt <= eps.length; attempt++) {          // chaque serveur, puis le premier une seconde fois
    const ep = eps[attempt % eps.length], host = new URL(ep).host;
    try {
      status(`Téléchargement d'OpenStreetMap (${host})…`);
      const res = await get(net, ep, 150000, { method: 'POST', body: new URLSearchParams({ data: q }) })
        .catch(e => { throw signal && signal.aborted ? e : new Error(e.name === 'TimeoutError' ? `${host} ne répond pas` : `${host} injoignable`); });
      if (!res.ok) throw new Error(res.status === 429 ? `${host} est débordé (429)` : `${host} a répondu ${res.status}`);
      const text = await readText(res, n => status(`Téléchargement d'OpenStreetMap : ${(n / 1e6).toFixed(1).replace('.', ',')} Mo…`));
      if (!text.trimStart().startsWith('{')) throw new Error(`${host} : réponse inattendue`);
      const j = JSON.parse(text);
      if (/runtime error/i.test(j.remark || '')) {
        const e = new Error(/timed out|out of memory/i.test(j.remark) ? 'trop de données pour ce rayon : essaie plus petit' : `${host} : ${j.remark}`);
        e.tooBig = /timed out|out of memory/i.test(j.remark);
        throw e;
      }
      const raw = {};
      let cur = null;
      for (const e of j.elements) {
        if (e.type === 'set') { cur = raw[e.tags.n] = { elements: [] }; continue; }
        if (cur) cur.elements.push(e);
      }
      for (const { name } of list) if (!raw[name]) throw new Error(`${host} : réponse incomplète`);
      return raw;
    } catch (e) {
      if (signal && signal.aborted) throw ABORT();
      err = e.name === 'TimeoutError' ? new Error(`${host} ne répond pas`) : e.name === 'TypeError' ? new Error(`${host} : connexion interrompue`) : e;
      if (e.tooBig && attempt >= 1) break;
      status(`${err.message} ; nouvel essai…`);
      await wait(1500 + attempt * 1500, signal);
    }
  }
  throw new Error(`OpenStreetMap ne répond pas (${err ? err.message : 'erreur inconnue'})` +
    (net.localFile ? ' ; le jeu est ouvert comme fichier local : lance-le plutôt par un petit serveur web (par ex. « npx serve »)' : ''));
}

// Altitudes : tuiles Terrarium (PNG, altitude = R × 256 + G + B / 256 − 32768 m), lues au zoom 13 (~13 m par pixel)
async function terrarium(F, net) {
  const pts = F.demPoints(), Z = 13, N = 2 ** Z, S = 256;
  const gx = lon => ((lon + 180) / 360) * N * S - 0.5;
  const gy = lat => { const r = lat * Math.PI / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N * S - 0.5; };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [la, lo] of pts) { const x = gx(lo), y = gy(la); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const tiles = new Map(), jobs = [];
  for (let ty = Math.floor(y0 / S); ty <= Math.floor((y1 + 1) / S); ty++) for (let tx = Math.floor(x0 / S); tx <= Math.floor((x1 + 1) / S); tx++) {
    jobs.push((async () => {
      try {
        const res = await get(net, TERRARIUM(Z, tx, ty), 30000);
        if (!res.ok) return;
        const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(S, S) : Object.assign(document.createElement('canvas'), { width: S, height: S });
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        const px = g.getImageData(0, 0, S, S).data, h = new Float32Array(S * S);
        for (let k = 0; k < S * S; k++) h[k] = px[k * 4] * 256 + px[k * 4 + 1] + px[k * 4 + 2] / 256 - 32768;
        tiles.set(`${tx},${ty}`, h);
      } catch (e) { if (net.signal && net.signal.aborted) throw ABORT(); }
    })());
  }
  await Promise.all(jobs);
  if (!tiles.size) throw new Error('relief indisponible');
  const at = (x, y) => { const t = tiles.get(`${Math.floor(x / S)},${Math.floor(y / S)}`); return t ? t[(y - Math.floor(y / S) * S) * S + (x - Math.floor(x / S) * S)] : NaN; };
  const h = pts.map(([la, lo]) => {
    const x = gx(lo), y = gy(la), i = Math.floor(x), j = Math.floor(y), tx = x - i, ty = y - j;
    const v = (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - ty) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * ty;
    return Number.isFinite(v) ? v : 0;
  });
  return { ...F.dem, h };
}

// La carte complète dans un rayon de « radius » m autour de « query » : un nom de lieu, ou { lat, lon, name }
// (zone voisine : son nom vient du quartier). status(texte) : où on en est.
async function generate(query, radius, { status = () => {}, signal, referrer, localFile = LOCAL_FILE } = {}) {
  const net = { signal, referrer, localFile };
  const step = async msg => {
    if (signal && signal.aborted) throw ABORT();
    status(msg);
    await wait(0, signal);                                             // laisse le navigateur se redessiner
  };
  const near = typeof query === 'object';
  await step(near ? 'Recherche du nom du quartier…' : `Recherche de « ${query} »…`);
  const place = near ? await reverse(query, net) : await geocode(query, net);
  const A = liveArea(place, radius);
  const F = frame(A, A.lines, place.name);
  await step(`${place.label} : téléchargement d'OpenStreetMap…`);
  const raw = await overpassAll(F.BBOX, queries(A), status, net);
  await step('Relief du terrain…');
  try { raw.dem = await terrarium(F, net); } catch (e) {
    if (signal && signal.aborted) throw e;
    raw.dem = { ...F.dem, h: new Array(F.dem.nx * F.dem.nz).fill(0) };   // sans relief : terrain plat
  }
  const data = await compute(A, F, raw, msg => step(`Calcul de la carte : ${msg.trim()}`));
  data.attribution = 'Données © les contributeurs d\'OpenStreetMap (ODbL) · Relief : Terrain Tiles (AWS, Mapzen)';
  data.place = { name: place.name, label: place.label, lat: place.lat, lon: place.lon, radius };
  data.version = VERSION;
  return data;
}

// ---------- Worker : la génération tourne à côté du jeu ----------
// Il est fabriqué avec le code de ce fichier même (cityGen), ce qui marche aussi quand le jeu est ouvert en fichier local.
if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
  const running = new Map();
  root.onmessage = async ({ data: m }) => {
    if (m.abort) { const ac = running.get(m.id); if (ac) ac.abort(); return; }
    const ac = new AbortController();
    running.set(m.id, ac);
    try {
      const data = await generate(m.query, m.radius, { status: s => root.postMessage({ id: m.id, status: s }), signal: ac.signal, referrer: m.referrer, localFile: m.localFile });
      root.postMessage({ id: m.id, data });
    } catch (e) {
      root.postMessage({ id: m.id, error: { name: e.name, message: e.message, notFound: !!e.notFound } });
    } finally { running.delete(m.id); }
  };
}
let worker = null;                                                    // null : pas encore créé ; false : impossible ici
const jobs = new Map();
let jobId = 0;
function spawnWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([`(${cityGen})(self);`], { type: 'text/javascript' })));
    worker.onmessage = ({ data: m }) => {
      const j = jobs.get(m.id);
      if (!j) return;
      if (m.status) { j.status(m.status); return; }
      jobs.delete(m.id);
      if (m.error) j.ko(m.error.name === 'AbortError' ? ABORT() : Object.assign(new Error(m.error.message), { notFound: m.error.notFound }));
      else j.ok(m.data);
    };
    worker.onerror = e => {                                          // le Worker n'a pas pu démarrer : on fait tout ici
      e.preventDefault();
      worker.terminate();
      worker = false;
      for (const j of jobs.values()) generate(j.query, j.radius, j.opts).then(j.ok, j.ko);
      jobs.clear();
    };
  } catch (e) { worker = false; }
  return worker;
}
// Comme generate, mais dans le Worker (ou ici même s'il n'a pas pu démarrer)
function generateAsync(query, radius, opts = {}) {
  const w = typeof Worker !== 'undefined' ? spawnWorker() : false;
  if (!w) return generate(query, radius, opts);
  return new Promise((ok, ko) => {
    const id = ++jobId, { status = () => {}, signal } = opts;
    jobs.set(id, { ok, ko, status, query, radius, opts });
    const referrer = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.href : undefined;
    w.postMessage({ id, query, radius, referrer, localFile: LOCAL_FILE });
    if (signal) signal.addEventListener('abort', () => { if (worker) worker.postMessage({ id, abort: true }); }, { once: true });
  });
}

const CityGen = { VERSION, DEM_STEP, queries, frame, compute, projection, liveArea, generate, generateAsync };
root.CityGen = CityGen;
if (typeof module === 'object' && module.exports) module.exports = CityGen;
})(typeof window !== 'undefined' ? window : globalThis);
