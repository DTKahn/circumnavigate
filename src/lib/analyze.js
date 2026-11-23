// The analysis engine: given a great circle, walk around it and report every
// geographic feature it crosses, in order. Works in the browser and in Node.

import {
  DEG,
  CIRCUMFERENCE_KM,
  EARTH_RADIUS_KM,
  greatCircle,
  pointAt,
  toLatLon,
  toVec,
  angleOn,
  offPlane,
  dot,
  norm,
  cross,
} from './geo.js';

export const SAMPLES = 3600; // one sample every 0.1° ≈ 11 km
export const STEP_KM = CIRCUMFERENCE_KM / SAMPLES;

export const CATEGORIES = [
  { id: 'continent', label: 'Continents', icon: '🌎' },
  { id: 'ocean', label: 'Oceans & seas', icon: '🌊' },
  { id: 'country', label: 'Countries', icon: '🏳️' },
  { id: 'city', label: 'Cities', icon: '🏙️' },
  { id: 'landform', label: 'Mountains & landforms', icon: '⛰️' },
  { id: 'water', label: 'Lakes & rivers', icon: '💧' },
  { id: 'landmark', label: 'Landmarks', icon: '📍' },
  { id: 'line', label: 'Lines of latitude & longitude', icon: '🧭' },
];

// ---------------------------------------------------------------------------
// Data decoding & spatial index
// ---------------------------------------------------------------------------

function decodeRing(enc) {
  const out = new Float64Array(enc.length);
  let x = 0,
    y = 0;
  for (let i = 0; i < enc.length; i += 2) {
    x += enc[i];
    y += enc[i + 1];
    out[i] = x / 100;
    out[i + 1] = y / 100;
  }
  return out;
}

const CELL = 10; // degrees
const COLS = 36;
const ROWS = 18;

function buildIndex(features) {
  const grid = Array.from({ length: COLS * ROWS }, () => []);
  features.forEach((f, idx) => {
    const [x0, y0, x1, y1] = f.b;
    const c0 = Math.max(0, Math.floor((x0 + 180) / CELL));
    const c1 = Math.min(COLS - 1, Math.floor((x1 + 180) / CELL));
    const r0 = Math.max(0, Math.floor((y0 + 90) / CELL));
    const r1 = Math.min(ROWS - 1, Math.floor((y1 + 90) / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r * COLS + c].push(idx);
  });
  return grid;
}

function cellOf(lon, lat) {
  const c = Math.min(COLS - 1, Math.max(0, Math.floor((lon + 180) / CELL)));
  const r = Math.min(ROWS - 1, Math.max(0, Math.floor((lat + 90) / CELL)));
  return r * COLS + c;
}

function pointInRings(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const yi = ring[i + 1];
      const yj = ring[j + 1];
      if (yi > y !== yj > y) {
        const xi = ring[i];
        const xj = ring[j];
        if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

function layer(raw) {
  const features = raw.map((f) => ({ ...f, rings: f.r.map(decodeRing) }));
  return { features, grid: buildIndex(features) };
}

/** All features in a polygon layer containing the point. */
function hits(L, lon, lat) {
  const out = [];
  for (const idx of L.grid[cellOf(lon, lat)]) {
    const f = L.features[idx];
    const b = f.b;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (pointInRings(f.rings, lon, lat)) out.push(idx);
  }
  return out;
}

function firstHit(L, lon, lat) {
  for (const idx of L.grid[cellOf(lon, lat)]) {
    const f = L.features[idx];
    const b = f.b;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    if (pointInRings(f.rings, lon, lat)) return idx;
  }
  return -1;
}

export function decodeWorld(raw) {
  const world = {
    countries: layer(raw.countries),
    marine: layer(raw.marine),
    regions: layer(raw.regions),
    lakes: layer(raw.lakes),
    rivers: raw.rivers.map((r) => ({
      n: r.n,
      lines: r.l.map((enc) => {
        const flat = decodeRing(enc);
        const vecs = [];
        for (let i = 0; i < flat.length; i += 2) vecs.push(toVec(flat[i + 1], flat[i]));
        return vecs;
      }),
    })),
    cities: raw.cities.map(([n, country, lat, lon, pop, cap]) => ({ n, country, lat, lon, pop, cap, v: toVec(lat, lon) })),
    peaks: raw.peaks.map(([n, lat, lon, elev]) => ({ n, lat, lon, elev, v: toVec(lat, lon) })),
    landmarks: raw.landmarks.map(([n, kind, lat, lon]) => ({ n, kind, lat, lon, v: toVec(lat, lon) })),
    attribution: raw.attribution,
  };
  return world;
}

export function isLand(world, lat, lon) {
  return firstHit(world.countries, lon, lat) >= 0 && firstHit(world.lakes, lon, lat) < 0;
}

// ---------------------------------------------------------------------------
// Helpers for runs (contiguous stretches of samples)
// ---------------------------------------------------------------------------

/**
 * Turn a sorted list of sample indices into runs [start, end] (inclusive),
 * joining gaps of up to `gap` samples and merging across the 0/N seam.
 * A run that wraps the seam gets a negative start.
 */
function toRuns(indices, gap = 1, N = SAMPLES) {
  if (!indices.length) return [];
  const runs = [];
  let s = indices[0];
  let e = s;
  for (let k = 1; k < indices.length; k++) {
    const i = indices[k];
    if (i - e <= gap + 1) e = i;
    else {
      runs.push([s, e]);
      s = e = i;
    }
  }
  runs.push([s, e]);
  if (runs.length > 1) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    if (first[0] + N - last[1] <= gap + 1) {
      runs.pop();
      first[0] = last[0] - N;
    }
  } else if (runs[0][0] === 0 && runs[0][1] === N - 1) {
    runs[0] = [0, N - 1];
  }
  return runs;
}

const continentOf = (c, lon) => (c.split ? (lon < c.split.lon ? c.split.west : c.split.east) : c.c);

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

const LINES = [
  { name: 'Arctic Circle', lat: 66.5634, note: 'Above this line the Sun can stay up all day in summer.' },
  { name: 'Tropic of Cancer', lat: 23.4366, note: 'The Sun is straight overhead here in late June.' },
  { name: 'Equator', lat: 0, note: 'Halfway between the North and South Poles. Latitude 0°.' },
  { name: 'Tropic of Capricorn', lat: -23.4366, note: 'The Sun is straight overhead here in late December.' },
  { name: 'Antarctic Circle', lat: -66.5634, note: 'Below this line the Sun can stay up all day in December.' },
  { name: 'Prime Meridian', lon: 0, note: 'Longitude 0°, through Greenwich, London.' },
  { name: '180th Meridian', lon: 180, note: 'Opposite the Prime Meridian; the International Date Line mostly follows it.' },
];

const CITY_KM = 25;
const PEAK_KM = 25;
const LANDMARK_KM = 60;

/**
 * Analyse the great circle starting at (lat, lon) heading `bearing`.
 * Returns ordered `items`, per-sample land mask and summary `stats`.
 */
export function analyze(world, lat, lon, bearing) {
  const N = SAMPLES;
  const circle = greatCircle(lat, lon, bearing);
  const lats = new Float64Array(N);
  const lons = new Float64Array(N);
  const country = new Int16Array(N).fill(-1);
  const lake = new Int16Array(N).fill(-1);
  const marine = new Int16Array(N).fill(-1);
  const land = new Uint8Array(N);
  const regionHits = new Map();

  for (let i = 0; i < N; i++) {
    const [la, lo] = toLatLon(pointAt(circle, (i / N) * 2 * Math.PI));
    lats[i] = la;
    lons[i] = lo;
    const c = firstHit(world.countries, lo, la);
    const lk = firstHit(world.lakes, lo, la);
    country[i] = c;
    lake[i] = lk;
    land[i] = c >= 0 && lk < 0 ? 1 : 0;
    if (!land[i] && lk < 0) marine[i] = firstHit(world.marine, lo, la);
    for (const r of hits(world.regions, lo, la)) {
      if (!regionHits.has(r)) regionHits.set(r, []);
      regionHits.get(r).push(i);
    }
  }

  // Fill water samples that fall between named marine polygons with the
  // nearest named body of water along the path.
  const filled = Int16Array.from(marine);
  for (let i = 0; i < N; i++) {
    if (land[i] || lake[i] >= 0 || filled[i] >= 0) continue;
    for (let d = 1; d < N / 2; d++) {
      const a = marine[(i + d) % N];
      const b = marine[(i - d + N) % N];
      if (b >= 0) {
        filled[i] = b;
        break;
      }
      if (a >= 0) {
        filled[i] = a;
        break;
      }
    }
  }

  const items = [];
  const midOf = (s, e) => {
    const m = (((Math.round((s + e) / 2) % N) + N) % N);
    return [lats[m], lons[m]];
  };
  const addArea = (cat, name, kind, s, e, extra = {}) => {
    const [mlat, mlon] = midOf(s, e);
    items.push({
      cat,
      name,
      kind,
      start: s,
      end: e,
      pos: Math.max(0, s),
      km: Math.max(0, s) * STEP_KM,
      lengthKm: (e - s + 1) * STEP_KM,
      lat: mlat,
      lon: mlon,
      ...extra,
    });
  };
  const addPoint = (cat, name, kind, t, extra = {}) => {
    const pos = (t / (2 * Math.PI)) * N;
    const v = pointAt(circle, t);
    const [la, lo] = toLatLon(v);
    items.push({ cat, name, kind, start: pos, end: pos, pos, km: pos * STEP_KM, lat: la, lon: lo, ...extra });
  };

  // Countries ------------------------------------------------------------------
  const byCountry = new Map();
  for (let i = 0; i < N; i++) {
    if (country[i] < 0) continue;
    if (!byCountry.has(country[i])) byCountry.set(country[i], []);
    byCountry.get(country[i]).push(i);
  }
  for (const [ci, idx] of byCountry) {
    const c = world.countries.features[ci];
    for (const [s, e] of toRuns(idx, 3)) {
      addArea('country', c.n, c.s ? `Territory of ${c.s}` : 'Country', s, e, { code: c.i, continent: c.c });
    }
  }

  // Continents --------------------------------------------------------------------
  const contAt = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (!land[i]) continue;
    contAt[i] = continentOf(world.countries.features[country[i]], lons[i]);
  }
  const byCont = new Map();
  contAt.forEach((c, i) => {
    if (!c) return;
    if (!byCont.has(c)) byCont.set(c, []);
    byCont.get(c).push(i);
  });
  for (const [name, idx] of byCont) {
    for (const [s, e] of toRuns(idx, 36)) {
      const landSamples = idx.filter((i) => (i >= s && i <= e) || i <= e - N || i >= s + N).length;
      addArea('continent', name, 'Continent', s, e, { landKm: landSamples * STEP_KM });
    }
  }

  // Oceans & seas -----------------------------------------------------------------
  // Group by name: e.g. the North and South Pacific are one "Pacific Ocean".
  const byMarine = new Map();
  for (let i = 0; i < N; i++) {
    if (filled[i] < 0 || land[i] || lake[i] >= 0) continue;
    const m = world.marine.features[filled[i]];
    if (!byMarine.has(m.n)) byMarine.set(m.n, { m, idx: [] });
    byMarine.get(m.n).idx.push(i);
  }
  for (const { m, idx } of byMarine.values()) {
    const kind = m.k[0].toUpperCase() + m.k.slice(1);
    for (const [s, e] of toRuns(idx, 6)) {
      if ((e - s + 1) * STEP_KM < 20 && m.k !== 'ocean') continue;
      addArea('ocean', m.n, kind, s, e, { ocean: m.k === 'ocean' });
    }
  }

  // Lakes ----------------------------------------------------------------------------
  const byLake = new Map();
  for (let i = 0; i < N; i++) {
    if (lake[i] < 0) continue;
    if (!byLake.has(lake[i])) byLake.set(lake[i], []);
    byLake.get(lake[i]).push(i);
  }
  for (const [li, idx] of byLake) {
    const l = world.lakes.features[li];
    if (!l.n) continue;
    for (const [s, e] of toRuns(idx, 2)) addArea('water', l.n, l.k, s, e);
  }

  // Landforms ---------------------------------------------------------------------
  const byRegion = new Map();
  for (const [ri, idx] of regionHits) {
    const r = world.regions.features[ri];
    const key = r.n + '|' + r.k;
    if (!byRegion.has(key)) byRegion.set(key, { r, idx: [] });
    byRegion.get(key).idx.push(...idx);
  }
  for (const { r, idx } of byRegion.values()) {
    idx.sort((a, b) => a - b);
    for (const [s, e] of toRuns(idx, 3)) addArea('landform', r.n, r.k, s, e);
  }

  // Rivers: look for river segments that cross the plane -------------------------
  for (const river of world.rivers) {
    const found = [];
    for (const line of river.lines) {
      for (let k = 0; k + 1 < line.length; k++) {
        const a = line[k];
        const b = line[k + 1];
        const da = dot(a, circle.n);
        const db = dot(b, circle.n);
        if ((da > 0) === (db > 0)) continue;
        const f = da / (da - db);
        const p = norm([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
        const t = angleOn(circle, p);
        if (found.some((x) => Math.abs(x - t) * EARTH_RADIUS_KM < 40)) continue;
        found.push(t);
      }
    }
    for (const t of found) addPoint('water', river.n, 'River', t);
  }

  // Points near the line ----------------------------------------------------------
  const nearby = (list, maxKm, cb) => {
    const lim = maxKm / EARTH_RADIUS_KM;
    for (const p of list) {
      const d = offPlane(circle, p.v);
      if (d <= lim) cb(p, angleOn(circle, p.v), d * EARTH_RADIUS_KM);
    }
  };
  nearby(world.cities, CITY_KM, (c, t, off) =>
    addPoint('city', c.n, c.cap ? 'Capital city' : 'City', t, {
      country: c.country,
      pop: c.pop,
      offKm: off,
      capital: !!c.cap,
      lat: c.lat,
      lon: c.lon,
    }),
  );
  nearby(world.peaks, PEAK_KM, (p, t, off) =>
    addPoint('landform', p.n, 'Mountain peak', t, { elev: p.elev, offKm: off, lat: p.lat, lon: p.lon }),
  );
  nearby(world.landmarks, LANDMARK_KM, (p, t, off) =>
    addPoint('landmark', p.n, p.kind, t, { offKm: off, lat: p.lat, lon: p.lon }),
  );

  // Lines of latitude & longitude --------------------------------------------------
  const maxLat = Math.acos(Math.min(1, Math.abs(circle.n[2]))) / DEG;
  for (const L of LINES) {
    const kind = L.lat !== undefined ? 'Line of latitude' : 'Line of longitude';
    if (L.lat !== undefined) {
      if (maxLat < 0.05 && L.lat === 0) {
        addPoint('line', L.name, kind, 0, { note: L.note, follows: true });
        continue;
      }
      // Sample-based crossing search (the path is not parallel to the line).
      for (let i = 0; i < N; i++) {
        const fi = lats[i] - L.lat;
        const fj = lats[(i + 1) % N] - L.lat;
        if (fi === 0 || (fi > 0) !== (fj > 0)) {
          const f = fi === 0 ? 0 : fi / (fi - fj);
          addPoint('line', L.name, kind, ((i + f) / N) * 2 * Math.PI, { note: L.note });
        }
      }
    } else {
      // A meridian is half of a great circle; intersect the two planes.
      const λ = L.lon * DEG;
      const m = [-Math.sin(λ), Math.cos(λ), 0];
      const out = [Math.cos(λ), Math.sin(λ), 0];
      const x = cross(circle.n, m);
      if (Math.hypot(...x) < 2e-3) {
        addPoint('line', L.name, kind, 0, { note: L.note, follows: true });
        continue;
      }
      for (const sign of [1, -1]) {
        const p = norm(x.map((v) => v * sign));
        if (dot(p, out) <= 0 || Math.abs(p[2]) > 0.99995) continue;
        addPoint('line', L.name, kind, angleOn(circle, p), { note: L.note });
      }
    }
  }
  // The poles
  const nz = Math.abs(circle.n[2]);
  if (nz < Math.sin(0.5 * DEG)) {
    // Circle runs (almost) through both poles.
    for (const [name, v] of [
      ['North Pole', [0, 0, 1]],
      ['South Pole', [0, 0, -1]],
    ]) {
      if (!items.some((it) => it.name === name)) addPoint('line', name, 'Pole', angleOn(circle, v), { note: 'Every line of longitude meets here.' });
    }
  }

  items.sort((a, b) => a.pos - b.pos || (b.lengthKm || 0) - (a.lengthKm || 0));

  // Stats ---------------------------------------------------------------------------
  let landN = 0,
    transitions = 0;
  for (let i = 0; i < N; i++) {
    landN += land[i];
    if (land[i] !== land[(i + 1) % N]) transitions++;
  }
  const longest = (val) => {
    let best = 0,
      bestStart = 0,
      run = 0;
    if (land.every((x) => x === val)) return { km: CIRCUMFERENCE_KM, start: 0 };
    let start0 = land.indexOf(val ? 0 : 1); // begin scan after a break
    for (let k = 1; k <= N; k++) {
      const i = (start0 + k) % N;
      if (land[i] === val) {
        run++;
        if (run > best) {
          best = run;
          bestStart = (i - run + 1 + N) % N;
        }
      } else run = 0;
    }
    return { km: best * STEP_KM, start: bestStart, end: (bestStart + best - 1) % N };
  };
  const uniq = (cat, filter = () => true) => new Set(items.filter((i) => i.cat === cat && filter(i)).map((i) => i.name));

  const stats = {
    landKm: landN * STEP_KM,
    waterKm: (N - landN) * STEP_KM,
    landPct: (landN / N) * 100,
    waterPct: 100 - (landN / N) * 100,
    transitions,
    countries: uniq('country').size,
    continents: uniq('continent').size,
    oceans: uniq('ocean', (i) => i.ocean).size,
    seas: uniq('ocean').size,
    cities: items.filter((i) => i.cat === 'city').length,
    longestLand: longest(1),
    longestWater: longest(0),
  };

  return { circle, items, land, lats, lons, stats };
}
