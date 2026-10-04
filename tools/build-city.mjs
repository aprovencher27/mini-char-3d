// Génère les cartes réelles fournies avec le jeu à partir d'OpenStreetMap (Overpass) et du relief SRTM 30 m (OpenTopoData) :
//   vieux-quebec.js        -> window.VIEUX_QUEBEC
//   plateau-mont-royal.js  -> window.PLATEAU_MONT_ROYAL
//
//   node tools/build-city.mjs                     (toutes les cartes, avec le cache tools/.cache)
//   node tools/build-city.mjs plateau-mont-royal  (une seule carte)
//   node tools/build-city.mjs --refresh           (retélécharge tout)
//
// Le calcul lui-même est dans city-gen.js, partagé avec le jeu (qui s'en sert pour générer n'importe quelle ville).
// Ici : les réglages faits à la main de ces deux cartes, et les téléchargements (mis en cache).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../city-gen.js';

const { CityGen } = globalThis;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFRESH = process.argv.includes('--refresh');
const UA = 'MiniChar3D-game/1.0 (hobby project)';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

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
  let lines = null, district = null;
  if (A.boundary) {
    const ids = [].concat(A.boundary.rel);
    const raw = await cached('boundary.json', () => fetchOverpass('boundary', `[out:json][timeout:120];relation(id:${ids.join(',')});out geom;`));
    const rels = raw.elements.filter(e => e.type === 'relation');
    // plusieurs quartiers : on garde leur contour commun (une frontière partagée par deux quartiers disparaît)
    const uses = new Map();
    for (const r of rels) for (const m of r.members) if (m.type === 'way' && m.role !== 'inner') uses.set(m.ref, (uses.get(m.ref) || 0) + 1);
    lines = rels.flatMap(r => r.members.filter(m => m.type === 'way' && m.role !== 'inner' && uses.get(m.ref) === 1)).map(m => m.geometry).filter(Boolean);
    district = A.boundary.name || (rels[0].tags || {}).name;
    console.log(`  limites : ${district}`);
  }
  const F = CityGen.frame(A, lines, district);
  const { BBOX } = F;

  console.log('Téléchargement…');
  const raw = {};
  for (const q of CityGen.queries(A)) {
    raw[q.name] = await cached(`${q.name}.json`, () =>
      fetchOverpass(q.name, `[out:json][timeout:170][bbox:${BBOX.s - q.pad},${BBOX.w - q.pad},${BBOX.n + q.pad},${BBOX.e + q.pad}];${q.body}`));
  }
  raw.dem = await cached(`dem-${CityGen.DEM_STEP}.json`, async () => {
    const pts = F.demPoints();
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
    return { ...F.dem, h };
  });

  const data = await CityGen.compute(A, F, raw, msg => console.log(msg));
  const js = `// Généré par tools/build-city.mjs le ${data.generated}. ${data.attribution}.\nwindow.${A.global} = ${JSON.stringify(data)};\n`;
  await fs.writeFile(path.join(ROOT, A.out), js);
  console.log(`Écrit ${A.out} (${(js.length / 1024).toFixed(0)} Ko)`);
}

const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
for (const id of wanted.length ? wanted : Object.keys(AREAS)) {
  if (!AREAS[id]) { console.error(`Carte inconnue : ${id} (choix : ${Object.keys(AREAS).join(', ')})`); process.exit(1); }
  await buildArea(id, AREAS[id]);
}
