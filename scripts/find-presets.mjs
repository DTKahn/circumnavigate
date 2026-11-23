// Searches every possible great circle for the "record-holders" shown in the
// app's Interesting paths list (most land, most countries, longest sea voyage…).
//
//   node scripts/find-presets.mjs
//
// 1. Rasterise the world at 0.1° (country id per pixel, lakes as water).
// 2. Score ~60,000 evenly spread great circles on the raster.
// 3. Hill-climb the best few for each goal.
// 4. Re-check the winners with the exact polygon analyser used by the app.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWorld, analyze, SAMPLES } from '../src/lib/analyze.js';
import { cross, norm, dot, toLatLon, bearingFromNormal, DEG } from '../src/lib/geo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/world.json'), 'utf8'));
const world = decodeWorld(raw);

// --- Rasterise -------------------------------------------------------------------
const RES = 10; // pixels per degree
const W = 360 * RES;
const H = 180 * RES;
const grid = new Int16Array(W * H).fill(-1);

function rasterise(features, value) {
  features.forEach((f, idx) => {
    const v = value(idx);
    const [, y0, , y1] = f.b;
    const r0 = Math.max(0, Math.floor((90 - y1) * RES));
    const r1 = Math.min(H - 1, Math.ceil((90 - y0) * RES));
    for (let r = r0; r <= r1; r++) {
      const y = 90 - (r + 0.5) / RES;
      const xs = [];
      for (const ring of f.rings) {
        const n = ring.length;
        for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
          const yi = ring[i + 1];
          const yj = ring[j + 1];
          if (yi > y !== yj > y) xs.push(((ring[j] - ring[i]) * (y - yi)) / (yj - yi) + ring[i]);
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] + 180) * RES - 0.5));
        const c1 = Math.min(W - 1, Math.floor((xs[k + 1] + 180) * RES - 0.5));
        for (let c = c0; c <= c1; c++) grid[r * W + c] = v;
      }
    }
  });
}
console.time('raster');
rasterise(world.countries.features, (i) => i);
rasterise(world.lakes.features, () => -1);
console.timeEnd('raster');

const countries = world.countries.features;
const CONTINENTS = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];
const contId = (ci, lon) => {
  const c = countries[ci];
  const name = c.split ? (lon < c.split.lon ? c.split.west : c.split.east) : c.c;
  return CONTINENTS.indexOf(name);
};

// --- Fast circle scoring ------------------------------------------------------------
const N = 3600;
const cosT = new Float64Array(N);
const sinT = new Float64Array(N);
for (let i = 0; i < N; i++) {
  cosT[i] = Math.cos((i / N) * 2 * Math.PI);
  sinT[i] = Math.sin((i / N) * 2 * Math.PI);
}
const seen = new Int32Array(countries.length);
let gen = 0;
const vals = new Int16Array(N);
const lonAt = new Float32Array(N);

function basis(n) {
  const ref = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const A = norm(cross(ref, n));
  const D = cross(n, A);
  return { A, D };
}

function score(n) {
  const { A, D } = basis(n);
  gen++;
  let land = 0;
  let countriesN = 0;
  let contMask = 0;
  for (let i = 0; i < N; i++) {
    const x = A[0] * cosT[i] + D[0] * sinT[i];
    const y = A[1] * cosT[i] + D[1] * sinT[i];
    const z = A[2] * cosT[i] + D[2] * sinT[i];
    const lat = Math.asin(Math.max(-1, Math.min(1, z))) / DEG;
    const lon = Math.atan2(y, x) / DEG;
    const r = Math.min(H - 1, Math.floor((90 - lat) * RES));
    const c = Math.min(W - 1, Math.floor((lon + 180) * RES));
    const v = grid[r * W + c];
    vals[i] = v;
    lonAt[i] = lon;
    if (v >= 0) {
      land++;
      if (seen[v] !== gen) {
        seen[v] = gen;
        countriesN++;
      }
      contMask |= 1 << contId(v, lon);
    }
  }
  let transitions = 0;
  for (let i = 0; i < N; i++) if (vals[i] >= 0 !== vals[(i + 1) % N] >= 0) transitions++;
  const longest = (wantLand) => {
    let best = 0;
    let run = 0;
    for (let k = 0; k < 2 * N; k++) {
      const isLand = vals[k % N] >= 0;
      if (isLand === wantLand) {
        run++;
        if (run > best) best = run;
      } else run = 0;
    }
    return Math.min(best, N);
  };
  let continents = 0;
  for (let m = contMask; m; m &= m - 1) continents++;
  return {
    land: land / N,
    transitions,
    countries: countriesN,
    continents,
    longestLand: longest(true),
    longestWater: longest(false),
  };
}

// --- Goals ---------------------------------------------------------------------------
const GOALS = {
  'most-land': (s) => s.land,
  'most-water': (s) => -s.land,
  'fewest-crossings': (s) => -s.transitions + s.land * 0.5,
  'most-crossings': (s) => s.transitions,
  'most-countries': (s) => s.countries + s.land * 0.5,
  'fewest-countries': (s) => -s.countries + s.land * 0.5,
  'longest-voyage': (s) => s.longestWater,
  'longest-walk': (s) => s.longestLand,
  'most-continents': (s) => s.continents + s.land * 0.5,
};

// Fibonacci points on the upper hemisphere = every circle once.
const CANDIDATES = 60000;
const normals = [];
const golden = Math.PI * (3 - Math.sqrt(5));
for (let i = 0; i < CANDIDATES; i++) {
  const z = 1 - i / CANDIDATES;
  const r = Math.sqrt(1 - z * z);
  normals.push([Math.cos(golden * i) * r, Math.sin(golden * i) * r, z]);
}

console.time('scan');
const scored = normals.map((n) => ({ n, s: score(n) }));
console.timeEnd('scan');

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function climb(n, f) {
  let best = n;
  let bestV = f(score(n));
  for (let step = 1.0; step > 0.02; step *= 0.7) {
    for (let k = 0; k < 40; k++) {
      const a = rand() * 2 * Math.PI;
      const { A, D } = basis(best);
      const d = step * DEG * Math.sqrt(rand());
      const cand = norm([
        best[0] + (A[0] * Math.cos(a) + D[0] * Math.sin(a)) * d,
        best[1] + (A[1] * Math.cos(a) + D[1] * Math.sin(a)) * d,
        best[2] + (A[2] * Math.cos(a) + D[2] * Math.sin(a)) * d,
      ]);
      const v = f(score(cand));
      if (v > bestV) {
        best = cand;
        bestV = v;
      }
    }
  }
  return { n: best, v: bestV };
}

const out = {};
for (const [goal, f] of Object.entries(GOALS)) {
  const top = [...scored].sort((a, b) => f(b.s) - f(a.s)).slice(0, 12);
  let winner = null;
  for (const t of top) {
    const r = climb(t.n, f);
    if (!winner || r.v > winner.v) winner = r;
  }
  const s = score(winner.n); // also leaves this circle's pixels in `vals`

  // Choose a starting point: the beginning of the stretch that makes this
  // path special (longest water for voyages, otherwise the longest land run).
  const { A, D } = basis(winner.n);
  const wantLand = goal !== 'longest-voyage' && goal !== 'most-water';
  let best = 0,
    bestStart = 0,
    run = 0;
  for (let k = 0; k < 2 * N; k++) {
    const i = k % N;
    if (vals[i] >= 0 === wantLand) {
      run++;
      if (run > best && run <= N) {
        best = run;
        bestStart = (i - run + 1 + N) % N;
      }
    } else run = 0;
  }
  const t = (bestStart / N) * 2 * Math.PI;
  const P = [0, 1, 2].map((j) => A[j] * Math.cos(t) + D[j] * Math.sin(t));
  const [lat, lon] = toLatLon(P);
  const dir = bearingFromNormal(lat, lon, winner.n);
  const exact = analyze(world, lat, lon, dir).stats;
  out[goal] = {
    lat: +lat.toFixed(3),
    lon: +lon.toFixed(3),
    dir: +dir.toFixed(2),
    landPct: +exact.landPct.toFixed(1),
    transitions: exact.transitions,
    countries: exact.countries,
    continents: exact.continents,
    longestLandKm: Math.round(exact.longestLand.km),
    longestWaterKm: Math.round(exact.longestWater.km),
  };
  console.log(goal.padEnd(18), JSON.stringify(s), '→', JSON.stringify(out[goal]));
}

fs.writeFileSync(path.join(ROOT, 'src/data/presets.json'), JSON.stringify(out, null, 2) + '\n');
console.log('wrote src/data/presets.json');
