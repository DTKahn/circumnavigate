// Downloads Natural Earth data (public domain) and packs it into a compact
// JSON file used by both the web app and the preset finder.
//
//   node scripts/build-data.mjs
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import simplify from 'simplify-js';
import { LANDMARKS } from './landmarks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'ne');
const OUT = path.join(ROOT, 'public', 'data', 'world.json');
const BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';

const FILES = {
  countries: 'ne_50m_admin_0_countries',
  marine: 'ne_50m_geography_marine_polys',
  regions: 'ne_50m_geography_regions_polys',
  lakes: 'ne_50m_lakes',
  rivers: 'ne_50m_rivers_lake_centerlines',
  places: 'ne_10m_populated_places_simple',
  peaks: 'ne_10m_geography_regions_elevation_points',
};

async function load(name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, name + '.geojson');
  if (!fs.existsSync(file)) {
    console.log('downloading', name);
    const res = await fetch(BASE + name + '.geojson');
    if (!res.ok) throw new Error(`${name}: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).features;
}

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s\-(])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(Of|The|And|De|Du|La)\b/g, (w, _x, i) => (i === 0 ? w : w.toLowerCase()));

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Encode a ring as delta-encoded integers (1/100 degree).
function encodeRing(ring, tolerance) {
  let pts = ring.map(([x, y]) => ({ x, y }));
  if (tolerance) pts = simplify(pts, tolerance, true);
  if (pts.length < 4) return null;
  const out = [];
  let px = 0,
    py = 0;
  for (const p of pts) {
    const x = Math.round(p.x * 100);
    const y = Math.round(p.y * 100);
    if (out.length && x === px && y === py) continue;
    out.push(x - px, y - py);
    px = x;
    py = y;
  }
  return out.length >= 8 ? out : null;
}

function encodeGeometry(geom, tolerance) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const rings = [];
  let b = [180, 90, -180, -90];
  for (const poly of polys) {
    for (const ring of poly) {
      const enc = encodeRing(ring, tolerance);
      if (!enc) continue;
      rings.push(enc);
      for (const [x, y] of ring) {
        b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
      }
    }
  }
  return { r: rings, b: b.map((v) => Math.round(v * 100) / 100) };
}

function encodeLines(geom, tolerance) {
  const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
  const out = [];
  for (const line of lines) {
    let pts = line.map(([x, y]) => ({ x, y }));
    pts = simplify(pts, tolerance, true);
    if (pts.length < 2) continue;
    const enc = [];
    let px = 0,
      py = 0;
    for (const p of pts) {
      const x = Math.round(p.x * 100);
      const y = Math.round(p.y * 100);
      enc.push(x - px, y - py);
      px = x;
      py = y;
    }
    out.push(enc);
  }
  return out;
}

// Russia, Kazakhstan, Turkey etc. straddle continents. We store a split longitude
// so the app can attribute the right continent along the path.
const CONTINENT_SPLIT = {
  RUS: { west: 'Europe', east: 'Asia', lon: 60 }, // Ural Mountains (approx.)
  KAZ: { west: 'Europe', east: 'Asia', lon: 51.5 }, // Ural River (approx.)
  TUR: { west: 'Europe', east: 'Asia', lon: 29.0 }, // Bosphorus (approx.)
  EGY: { west: 'Africa', east: 'Asia', lon: 32.4 }, // Suez Canal (approx.)
};
const CONTINENT_FIX = {
  'Seven seas (open ocean)': null,
};
const SEVEN_SEAS_CONTINENT = {
  // Islands NE marks as "open ocean" – map them to the nearest continent.
  MDV: 'Asia', MUS: 'Africa', SYC: 'Africa', SHN: 'Africa', IOT: 'Asia', HMD: 'Antarctica',
  ATF: 'Antarctica', SGS: 'Antarctica',
};

// Friendlier names for students.
const SHORT_NAMES = {
  'Russian Federation': 'Russia',
  'Republic of Korea': 'South Korea',
  'Dem. Rep. Korea': 'North Korea',
  'Lao PDR': 'Laos',
  'Kingdom of eSwatini': 'Eswatini',
  'Republic of Cabo Verde': 'Cabo Verde',
  'Czech Republic': 'Czechia',
  'Federated States of Micronesia': 'Micronesia',
  'Heard I. and McDonald Islands': 'Heard Island and McDonald Islands',
};

async function main() {
  const out = {
    attribution: 'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.',
  };

  // Countries --------------------------------------------------------------
  const countries = await load(FILES.countries);
  out.countries = countries
    .map((f) => {
      const p = f.properties;
      const a3 = p.ADM0_A3;
      let continent = p.CONTINENT;
      if (continent in CONTINENT_FIX) continent = SEVEN_SEAS_CONTINENT[a3] || 'Oceania';
      const g = encodeGeometry(f.geometry, 0.02);
      const c = {
        n: SHORT_NAMES[p.NAME_LONG] || p.NAME_LONG || p.NAME,
        a: a3,
        i: p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : '',
        c: continent,
        pop: p.POP_EST,
        lx: Math.round(p.LABEL_X * 100) / 100,
        ly: Math.round(p.LABEL_Y * 100) / 100,
        ...g,
      };
      if (CONTINENT_SPLIT[a3]) c.split = CONTINENT_SPLIT[a3];
      if (p.SOVEREIGNT && p.SOVEREIGNT !== p.ADMIN) c.s = p.SOVEREIGNT;
      return c;
    })
    .filter((c) => c.r.length);

  // Marine areas -------------------------------------------------------------
  const marine = await load(FILES.marine);
  out.marine = marine
    .filter((f) => f.properties.featurecla !== 'river' && f.properties.featurecla !== 'reef')
    .map((f) => ({
      n: titleCase(f.properties.name_en || f.properties.name),
      k: f.properties.featurecla,
      ...encodeGeometry(f.geometry, 0.05),
    }))
    .filter((c) => c.r.length);

  // Landforms ----------------------------------------------------------------
  const KEEP = {
    'Range/mtn': 'Mountain range',
    Desert: 'Desert',
    Plateau: 'Plateau',
    Plain: 'Plain',
    Basin: 'Basin',
    Tundra: 'Tundra',
    'Pen/cape': 'Peninsula',
    Peninsula: 'Peninsula',
    Isthmus: 'Isthmus',
    Island: 'Island',
    'Island group': 'Islands',
    Delta: 'River delta',
    Valley: 'Valley',
    Wetlands: 'Wetlands',
    Lowland: 'Lowland',
    Foothills: 'Foothills',
    Gorge: 'Gorge',
    Geoarea: 'Region',
  };
  const regions = await load(FILES.regions);
  out.regions = regions
    .filter((f) => KEEP[f.properties.FEATURECLA] && f.properties.NAME)
    .map((f) => ({
      n: cap(f.properties.NAME_EN || titleCase(f.properties.NAME)),
      k: KEEP[f.properties.FEATURECLA],
      ...encodeGeometry(f.geometry, 0.05),
    }))
    .filter((c) => c.r.length);

  // Lakes ------------------------------------------------------------------------
  const lakes = await load(FILES.lakes);
  out.lakes = lakes
    .filter((f) => f.properties.featurecla !== 'Playa')
    .map((f) => ({
      n: f.properties.name || f.properties.name_en || '',
      k: f.properties.featurecla === 'Reservoir' ? 'Reservoir' : 'Lake',
      ...encodeGeometry(f.geometry, 0.02),
    }))
    .filter((c) => c.r.length);

  // Rivers -----------------------------------------------------------------------
  const rivers = await load(FILES.rivers);
  out.rivers = rivers
    .filter((f) => f.properties.featurecla === 'River' && f.properties.name)
    .map((f) => ({
      n: f.properties.name_en || f.properties.name,
      l: encodeLines(f.geometry, 0.03),
    }))
    .filter((r) => r.l.length);

  // Cities -----------------------------------------------------------------------
  const places = await load(FILES.places);
  out.cities = places
    .filter((f) => f.properties.pop_max >= 50000 || f.properties.adm0cap)
    .sort((a, b) => b.properties.pop_max - a.properties.pop_max)
    .map((f) => {
      const p = f.properties;
      return [
        p.name,
        p.adm0name,
        Math.round(p.latitude * 1000) / 1000,
        Math.round(p.longitude * 1000) / 1000,
        p.pop_max,
        p.adm0cap ? 1 : 0,
      ];
    });

  // Peaks ------------------------------------------------------------------------
  const peaks = await load(FILES.peaks);
  out.peaks = peaks
    .filter((f) => f.properties.featurecla === 'mountain' && f.properties.elevation >= 1500 && (f.properties.name_en || f.properties.name))
    .map((f) => {
      const p = f.properties;
      return [
        p.name_en || p.name,
        Math.round(p.lat_y * 1000) / 1000,
        Math.round(p.long_x * 1000) / 1000,
        p.elevation,
      ];
    });

  out.landmarks = LANDMARKS;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(out);
  fs.writeFileSync(OUT, json);
  for (const k of Object.keys(out)) {
    if (Array.isArray(out[k])) console.log(k.padEnd(10), out[k].length, (JSON.stringify(out[k]).length / 1024).toFixed(0) + 'kB');
  }
  console.log('wrote', OUT, (json.length / 1024).toFixed(0) + 'kB');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
