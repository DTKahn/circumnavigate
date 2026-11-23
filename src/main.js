import './style.css';
import { Globe, CONTINENT_COLORS } from './globe.js';
import { CATEGORIES, SAMPLES, STEP_KM } from './lib/analyze.js';
import {
  greatCircle,
  bearingTo,
  compass,
  compassWords,
  formatLatLon,
  wrapBearing,
  wrapLon,
  distanceKm,
  toVec,
  CIRCUMFERENCE_KM,
} from './lib/geo.js';
import PRESET_DATA from './data/presets.json';

const $ = (sel) => document.querySelector(sel);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('circumnavigate:' + k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('circumnavigate:' + k, JSON.stringify(v));
    } catch {
      /* private mode etc. */
    }
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  lat: 0,
  lon: 0,
  dir: 0,
  unit: store.get('unit', 'km'),
  cats: new Set(store.get('cats', CATEGORIES.map((c) => c.id))),
  result: null,
  selected: null,
  preset: null,
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const KM_PER_MI = 1.609344;
const nf = new Intl.NumberFormat();
const dist = (km, { short = false } = {}) => {
  const v = state.unit === 'mi' ? km / KM_PER_MI : km;
  const r = v >= 100 ? Math.round(v / 10) * 10 : v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return short ? nf.format(r) : `${nf.format(r)} ${state.unit}`;
};
const people = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} million people` : `${nf.format(Math.round(n / 1000) * 1000)} people`;
const elev = (m) => (state.unit === 'mi' ? `${nf.format(Math.round(m * 3.28084))} ft` : `${nf.format(m)} m`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const flag = (iso) =>
  iso && iso.length === 2 ? String.fromCodePoint(...[...iso.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🏳️';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const P = PRESET_DATA;
const PRESETS = [
  { id: 'most-land', emoji: '⛰️', title: 'Most land', metric: () => `${Math.round(P['most-land'].landPct)}% land`, desc: 'The circle that spends the most time on solid ground.' },
  { id: 'most-water', emoji: '🌊', title: 'Most water', metric: () => `${Math.round(100 - P['most-water'].landPct)}% water`, desc: 'Almost the whole way around is ocean.' },
  { id: 'fewest-crossings', emoji: '🏖️', title: 'Fewest land–water crossings', metric: () => `${P['fewest-crossings'].transitions} coastlines`, desc: 'One long stretch of land, then one long stretch of sea.' },
  { id: 'most-crossings', emoji: '🏝️', title: 'Most land–water crossings', metric: () => `${P['most-crossings'].transitions} coastlines`, desc: 'Island-hopping through archipelagos.' },
  { id: 'most-countries', emoji: '🗺️', title: 'Most countries', metric: () => `${P['most-countries'].countries} countries`, desc: 'A tour through the most nations in one loop.' },
  { id: 'fewest-countries', emoji: '🧊', title: 'Fewest countries', metric: () => `${P['fewest-countries'].countries} countries`, desc: 'Big oceans and very few borders.' },
  { id: 'longest-voyage', emoji: '⛵', title: 'Longest sea voyage', metric: () => `${dist(P['longest-voyage'].longestWaterKm)} of sea`, desc: 'Sail in a straight line without hitting land. Pakistan to Kamchatka!' },
  { id: 'longest-walk', emoji: '🥾', title: 'Longest walk', metric: () => `${dist(P['longest-walk'].longestLandKm)} on land`, desc: 'Walk in a straight line without getting your feet wet.' },
  { id: 'most-continents', emoji: '🌍', title: 'Most continents', metric: () => `${P['most-continents'].continents} continents`, desc: 'Touches more continents than any other circle.' },
  { id: 'equator', emoji: '☀️', title: 'The Equator', metric: () => '0° latitude', desc: 'The only line of latitude that is a great circle.', lat: 0, lon: -78.45, dir: 90 },
  { id: 'meridian', emoji: '🕰️', title: 'Pole to pole', metric: () => '0° & 180° longitude', desc: 'The Prime Meridian through Greenwich, then the Date Line.', lat: 51.4769, lon: -0.0005, dir: 180 },
  { id: 'flight', emoji: '✈️', title: 'New York → Tokyo flight', metric: () => dist(distanceKm(40.64, -73.78, 35.77, 140.39)), desc: 'Why planes fly over the Arctic: it’s the shortest way.', lat: 40.64, lon: -73.78, dir: bearingTo(40.64, -73.78, 35.77, 140.39) },
].map((p) => ({ ...p, ...(P[p.id] ? { lat: P[p.id].lat, lon: P[p.id].lon, dir: P[p.id].dir } : {}) }));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const globe = new Globe($('#globe'), {
  onPick: (lat, lon) => {
    hideHint();
    $('#qStart').value = '';
    setPath({ lat, lon }, { fly: false });
  },
});

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let reqId = 0;
let inflight = false;
let queued = null;
worker.onmessage = (e) => {
  inflight = false;
  if (queued) {
    const q = queued;
    queued = null;
    send(q);
  }
  if (e.data.id !== reqId) return;
  state.result = e.data;
  render();
};
function send(msg) {
  if (inflight) {
    queued = msg;
    return;
  }
  inflight = true;
  worker.postMessage(msg);
}
function requestAnalysis() {
  reqId++;
  send({ type: 'analyze', id: reqId, lat: state.lat, lon: state.lon, dir: state.dir });
}

let world = null;
let searchIndex = [];

async function boot() {
  initDial();
  initChips();
  initPresets();
  initSearch($('#qStart'), $('#sStart'), (p) => {
    setPath({ lat: p.lat, lon: p.lon }, { fly: true });
  });
  initSearch($('#qThrough'), $('#sThrough'), (p) => {
    const d = distanceKm(state.lat, state.lon, p.lat, p.lon);
    if (d < 1 || d > CIRCUMFERENCE_KM / 2 - 1) {
      toast(d < 1 ? 'That’s where you already start!' : 'That’s the exact opposite side: every direction works.');
      return;
    }
    setPath({ dir: bearingTo(state.lat, state.lon, p.lat, p.lon) }, { fly: false, keepThrough: true });
    const a = toVec(state.lat, state.lon);
    const b = toVec(p.lat, p.lon);
    globe.flyToVec([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
    toast(`Your line now passes through ${p.label}`);
  });

  // Units
  document.querySelectorAll('[data-unit]').forEach((b) =>
    b.addEventListener('click', () => {
      state.unit = b.dataset.unit;
      store.set('unit', state.unit);
      renderUnits();
      initPresets();
      render();
    }),
  );
  renderUnits();

  $('#share').addEventListener('click', share);
  $('#turn').addEventListener('click', () => setPath({ dir: wrapBearing(state.dir + 90) }));
  $('#flip').addEventListener('click', () => setPath({ dir: wrapBearing(state.dir + 180) }));
  $('#recenter').addEventListener('click', () => globe.flyToCircle(greatCircle(state.lat, state.lon, state.dir), 4.2));
  $('#togglePlane').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', on);
    globe.setPlaneVisible(on);
  });
  $('#locate').addEventListener('click', locate);
  $('#strip').addEventListener('click', (e) => {
    if (!state.result) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    const t = f * Math.PI * 2;
    const c = greatCircle(state.lat, state.lon, state.dir);
    const v = [0, 1, 2].map((i) => c.A[i] * Math.cos(t) + c.D[i] * Math.sin(t));
    globe.flyTo(Math.asin(v[2]) * (180 / Math.PI), Math.atan2(v[1], v[0]) * (180 / Math.PI));
  });
  window.addEventListener('resize', () => state.result && drawStrip());

  // Initial path: from the URL, otherwise a nice default.
  const q = new URLSearchParams(location.search);
  const fromUrl = ['lat', 'lon', 'dir'].every((k) => q.has(k) && isFinite(+q.get(k)));
  const preset = PRESETS.find((p) => p.id === q.get('path'));
  const start = fromUrl
    ? { lat: Math.max(-90, Math.min(90, +q.get('lat'))), lon: wrapLon(+q.get('lon')), dir: wrapBearing(+q.get('dir')) }
    : preset || PRESETS.find((p) => p.id === 'most-countries');
  state.preset = !fromUrl ? start.id : null;
  setPath({ lat: start.lat, lon: start.lon, dir: start.dir }, { fly: false, keepPreset: true });
  globe.flyToCircle(greatCircle(state.lat, state.lon, state.dir), 4.2, 1);

  let raw;
  try {
    const res = await fetch('./data/world.json');
    if (!res.ok) throw new Error(res.status);
    raw = await res.json();
  } catch {
    $('#loading').innerHTML = 'Couldn’t load the map. Check your connection and refresh.';
    return;
  }
  world = raw;
  worker.postMessage({ type: 'world', raw });
  globe.setWorld(raw);
  searchIndex = buildSearchIndex(raw);
  $('#loading').classList.add('done');
  renderStart();
  setTimeout(hideHint, 9000);
}

function hideHint() {
  $('#hint').classList.add('gone');
}

// ---------------------------------------------------------------------------
// Path updates
// ---------------------------------------------------------------------------

let urlTimer = 0;
function setPath(next, { fly = false, keepPreset = false, keepThrough = false } = {}) {
  if (!keepThrough) $('#qThrough').value = '';
  if (next.lat !== undefined) state.lat = Math.max(-90, Math.min(90, next.lat));
  if (next.lon !== undefined) state.lon = wrapLon(next.lon);
  if (next.dir !== undefined) state.dir = wrapBearing(next.dir);
  if (!keepPreset) state.preset = null;
  state.selected = null;
  globe.highlight(null);
  globe.setCircle(greatCircle(state.lat, state.lon, state.dir));
  if (fly) globe.flyToCircle(greatCircle(state.lat, state.lon, state.dir));
  renderDial();
  renderStart();
  markPreset();
  requestAnalysis();
  clearTimeout(urlTimer);
  urlTimer = setTimeout(syncUrl, 300);
}

function shareUrl() {
  const u = new URL(location.href);
  u.search = '';
  u.searchParams.set('lat', state.lat.toFixed(3));
  u.searchParams.set('lon', state.lon.toFixed(3));
  u.searchParams.set('dir', state.dir.toFixed(1));
  return u.toString();
}
function syncUrl() {
  history.replaceState(null, '', shareUrl());
}

async function share() {
  const url = shareUrl();
  const title = 'Circumnavigate';
  const text = `My great circle starts ${$('#startName').textContent} heading ${compassWords(state.dir)}.`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch {
      /* cancelled */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Paste it anywhere to share this path.');
  } catch {
    prompt('Copy this link:', url);
  }
}

function locate() {
  if (!navigator.geolocation) return toast('Location isn’t available in this browser.');
  toast('Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setPath({ lat: pos.coords.latitude, lon: pos.coords.longitude }, { fly: true });
      toast('Your line now starts where you are.');
    },
    () => toast('Couldn’t get your location. Try searching instead.'),
    { enableHighAccuracy: false, timeout: 10000 },
  );
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------------------
// Direction dial
// ---------------------------------------------------------------------------

function initDial() {
  const ticks = $('#ticks');
  let html = '';
  for (let a = 0; a < 360; a += 15) {
    const major = a % 45 === 0;
    const r1 = 54;
    const r2 = major ? 47 : 50;
    const s = Math.sin((a * Math.PI) / 180);
    const c = -Math.cos((a * Math.PI) / 180);
    if (a % 90 === 0) continue;
    html += `<line class="${major ? 'major' : ''}" x1="${60 + s * r1}" y1="${60 + c * r1}" x2="${60 + s * r2}" y2="${60 + c * r2}"/>`;
  }
  ticks.innerHTML = html;

  const dial = $('#dial');
  let dragging = false;
  const angleFrom = (e) => {
    const r = dial.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    return wrapBearing(Math.round((Math.atan2(x, -y) * 180) / Math.PI));
  };
  dial.addEventListener('pointerdown', (e) => {
    dragging = true;
    dial.setPointerCapture(e.pointerId);
    hideHint();
    setPath({ dir: angleFrom(e) });
  });
  dial.addEventListener('pointermove', (e) => dragging && setPath({ dir: angleFrom(e) }));
  dial.addEventListener('pointerup', () => (dragging = false));
  dial.addEventListener('pointercancel', () => (dragging = false));
  dial.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 1;
    const d = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 45, PageDown: -45 }[e.key];
    if (d) {
      e.preventDefault();
      setPath({ dir: Math.round(state.dir) + d });
    }
  });
}

function renderDial() {
  $('#needle').setAttribute('transform', `rotate(${state.dir} 60 60)`);
  $('#dial').setAttribute('aria-valuenow', Math.round(state.dir));
  $('#dial').setAttribute('aria-valuetext', `${Math.round(state.dir)} degrees, ${compassWords(state.dir)}`);
  $('#dirLabel').textContent = compassWords(state.dir);
  $('#dirDeg').textContent = `${Math.round(state.dir)}° · ${compass(state.dir)}`;
}

// ---------------------------------------------------------------------------
// Start label (reverse geocoding from our own data)
// ---------------------------------------------------------------------------

function renderStart() {
  $('#startCoords').textContent = formatLatLon(state.lat, state.lon);
  let label = formatLatLon(state.lat, state.lon);
  const r = state.result;
  if (world) {
    let best = null;
    let bestD = 80;
    for (const c of world.cities) {
      if (Math.abs(c[2] - state.lat) > 1) continue;
      const d = distanceKm(state.lat, state.lon, c[2], c[3]);
      if (d < bestD && (d < 15 || c[4] > 300000)) {
        bestD = d;
        best = c;
      }
    }
    if (best) label = `${bestD < 15 ? 'in' : 'near'} ${best[0]}, ${best[1]}`;
    else if (r) {
      const at = r.items.find((i) => (i.cat === 'country' || i.cat === 'ocean' || (i.cat === 'water' && i.lengthKm)) && i.start <= 0);
      if (at) label = at.cat === 'country' ? `in ${at.name}` : `in the ${at.name.replace(/^The /, '')}`;
    }
  }
  $('#startName').textContent = label;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const fold = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function buildSearchIndex(raw) {
  const idx = [];
  for (const c of raw.countries) idx.push({ label: c.n, sub: c.s ? `Territory of ${c.s}` : `Country in ${c.c}`, icon: flag(c.i), lat: c.ly, lon: c.lx, score: 2e9 + (c.pop || 0) });
  for (const l of raw.landmarks) idx.push({ label: l[0], sub: l[1], icon: '📍', lat: l[2], lon: l[3], score: 1.5e9 });
  for (const c of raw.cities) idx.push({ label: c[0], sub: `${c[5] ? 'Capital of ' : ''}${c[1]}`, icon: c[5] ? '⭐️' : '🏙️', lat: c[2], lon: c[3], score: c[4] + (c[5] ? 5e6 : 0) });
  for (const p of raw.peaks) idx.push({ label: p[0], sub: `Mountain · ${nf.format(p[3])} m`, icon: '⛰️', lat: p[1], lon: p[2], score: p[3] * 50 });
  for (const e of idx) e.key = fold(e.label);
  return idx;
}

function searchPlaces(q) {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i);
  if (m) {
    let lat = +m[1];
    let lon = +m[3];
    if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
    if (m[4] && m[4].toUpperCase() === 'W') lon = -Math.abs(lon);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 360) return [{ label: formatLatLon(lat, lon), sub: 'Coordinates', icon: '🧭', lat, lon }];
  }
  const f = fold(q.trim());
  if (f.length < 2) return [];
  const out = [];
  for (const e of searchIndex) {
    const i = e.key.indexOf(f);
    if (i < 0) continue;
    const rank = (i === 0 ? 3 : e.key[i - 1] === ' ' ? 2 : 1) + (e.key === f ? 2 : 0);
    out.push({ e, rank });
  }
  out.sort((a, b) => b.rank - a.rank || b.e.score - a.e.score);
  return out.slice(0, 8).map((o) => o.e);
}

function initSearch(input, list, onPick) {
  let results = [];
  let active = -1;
  const close = () => {
    list.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const draw = () => {
    if (!input.value.trim()) return close();
    list.innerHTML = results.length
      ? results
          .map(
            (r, i) =>
              `<li role="option" id="${list.id}-${i}" aria-selected="${i === active}" data-i="${i}"><span class="s-icon">${r.icon}</span><span><div class="s-name">${esc(r.label)}</div><div class="s-sub">${esc(r.sub)}</div></span></li>`,
          )
          .join('')
      : `<li class="s-empty">${world ? 'No matches. Try a city, country or “lat, lon”.' : 'Loading places…'}</li>`;
    list.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
  };
  const pick = (r) => {
    if (!r) return;
    input.value = r.label;
    close();
    input.blur();
    onPick(r);
  };
  input.addEventListener('input', () => {
    results = searchPlaces(input.value);
    active = results.length ? 0 : -1;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(results[active] || results[0]);
    } else if (e.key === 'Escape') close();
  });
  list.addEventListener('pointerdown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) {
      e.preventDefault();
      pick(results[+li.dataset.i]);
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('focus', () => input.value && input.select());
}

// ---------------------------------------------------------------------------
// Presets & chips
// ---------------------------------------------------------------------------

function initPresets() {
  $('#presets').innerHTML = PRESETS.map(
    (p) => `<button type="button" class="preset" data-id="${p.id}">
      <span class="p-emoji" aria-hidden="true">${p.emoji}</span>
      <span class="p-title">${p.title}</span>
      <span class="p-metric">${p.metric()}</span>
      <span class="p-desc">${p.desc}</span>
    </button>`,
  ).join('');
  $('#presets').onclick = (e) => {
    const b = e.target.closest('.preset');
    if (!b) return;
    const p = PRESETS.find((x) => x.id === b.dataset.id);
    state.preset = p.id;
    $('#qStart').value = '';
    $('#qThrough').value = '';
    setPath({ lat: p.lat, lon: p.lon, dir: p.dir }, { fly: true, keepPreset: true });
    if (matchMedia('(max-width: 860px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  markPreset();
}
function markPreset() {
  document.querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-current', b.dataset.id === state.preset));
}

function initChips() {
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const id = b.dataset.cat;
    if (state.cats.has(id)) state.cats.delete(id);
    else state.cats.add(id);
    store.set('cats', [...state.cats]);
    renderList();
  });
}

// ---------------------------------------------------------------------------
// Rendering results
// ---------------------------------------------------------------------------

function renderUnits() {
  document.querySelectorAll('[data-unit]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.unit === state.unit));
  document.querySelectorAll('[data-dist]').forEach((el) => (el.textContent = dist(+el.dataset.dist)));
}

function render() {
  const r = state.result;
  if (!r) return;
  const s = r.stats;
  $('#stLand').textContent = `${Math.round(s.landPct)}%`;
  $('#stWater').textContent = `${Math.round(s.waterPct)}%`;
  $('#stCountries').textContent = s.countries;
  $('#stCross').textContent = s.transitions;
  const parts = [
    `All the way around is <b>${dist(CIRCUMFERENCE_KM)}</b>.`,
    `You cross <b>${s.continents} continent${s.continents === 1 ? '' : 's'}</b> and <b>${s.oceans} ocean${s.oceans === 1 ? '' : 's'}</b>.`,
    `Longest stretch of open water: <b>${dist(s.longestWater.km)}</b>. Longest on land: <b>${dist(s.longestLand.km)}</b>.`,
  ];
  $('#facts').innerHTML = parts.join(' ');
  drawStrip();
  renderStart();
  renderList();
}

function drawStrip() {
  const r = state.result;
  const c = $('#strip');
  const w = c.clientWidth;
  if (!w) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * dpr);
  c.height = Math.round(28 * dpr);
  const ctx = c.getContext('2d');
  const styles = getComputedStyle(document.documentElement);
  ctx.fillStyle = styles.getPropertyValue('--water').trim();
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = styles.getPropertyValue('--land').trim();
  const N = r.land.length;
  for (let i = 0; i < N; ) {
    if (!r.land[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < N && r.land[j]) j++;
    const x0 = (i / N) * c.width;
    const x1 = (j / N) * c.width;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), c.height);
    i = j;
  }
  const sel = state.selected;
  if (sel) {
    ctx.fillStyle = styles.getPropertyValue('--accent').trim();
    const x0 = (Math.max(0, sel.start) / N) * c.width;
    const x1 = ((sel.end + 1) / N) * c.width;
    ctx.fillRect(x0, 0, Math.max(2 * dpr, x1 - x0), 4 * dpr);
    ctx.fillRect(x0, c.height - 4 * dpr, Math.max(2 * dpr, x1 - x0), 4 * dpr);
    if (sel.start < 0) {
      const xw = ((N + sel.start) / N) * c.width;
      ctx.fillRect(xw, 0, c.width - xw, 4 * dpr);
      ctx.fillRect(xw, c.height - 4 * dpr, c.width - xw, 4 * dpr);
    }
  }
  const total = state.unit === 'mi' ? CIRCUMFERENCE_KM / KM_PER_MI : CIRCUMFERENCE_KM;
  const step = state.unit === 'mi' ? 5000 : 10000;
  let ax = '';
  for (let v = 0; v < total - step * 0.4; v += step) ax += `<span style="left:${(v / total) * 100}%">${nf.format(v)}</span>`;
  ax += `<span style="left:100%">${nf.format(Math.round(total))} ${state.unit}</span>`;
  $('#stripAxis').innerHTML = ax;
}

function metaFor(it) {
  const off = it.offKm > 3 ? ` · ${dist(it.offKm)} from the line` : '';
  switch (it.cat) {
    case 'continent':
      return `Continent · ${dist(it.lengthKm)} across`;
    case 'country':
      return `${it.kind} · ${dist(it.lengthKm)} across`;
    case 'ocean':
      return `${it.kind} · ${dist(it.lengthKm)} of water`;
    case 'city':
      return `${it.capital ? 'Capital of ' : ''}${esc(it.country)} · ${people(it.pop)}${off}`;
    case 'landform':
      return it.elev ? `Mountain peak · ${elev(it.elev)} high${off}` : `${it.kind} · ${dist(it.lengthKm)} across`;
    case 'water':
      return it.lengthKm ? `${it.kind} · ${dist(it.lengthKm)} across` : 'River crossing';
    case 'landmark':
      return `${it.kind}${off}`;
    case 'line':
      return it.follows ? `Your line runs right along it! ${it.note}` : `${it.kind}. ${it.note || ''}`;
    default:
      return it.kind;
  }
}

function iconFor(it) {
  if (it.cat === 'country') return flag(it.code);
  if (it.cat === 'landform') return it.elev ? '🏔️' : { Desert: '🏜️', Island: '🏝️', Islands: '🏝️', Peninsula: '🗺️' }[it.kind] || '⛰️';
  if (it.cat === 'water') return it.lengthKm ? '💧' : '〰️';
  if (it.cat === 'city') return it.capital ? '⭐️' : '🏙️';
  if (it.cat === 'line' && /Pole/.test(it.name)) return '🧊';
  if (it.cat === 'ocean' && !it.ocean) return '🐚';
  return CATEGORIES.find((c) => c.id === it.cat).icon;
}

function renderList() {
  const r = state.result;
  if (!r) return;
  const counts = {};
  for (const it of r.items) counts[it.cat] = (counts[it.cat] || 0) + 1;
  $('#chips').innerHTML = CATEGORIES.map(
    (c) =>
      `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${state.cats.has(c.id)}"><span aria-hidden="true">${c.icon}</span>${c.label}<span class="c-count">${counts[c.id] || 0}</span></button>`,
  ).join('');

  const visible = r.items.filter((it) => state.cats.has(it.cat));
  const half = SAMPLES / 2;
  const rows = [];
  rows.push(`<li class="j-milestone"><span class="j-icon">A</span><div class="j-main"><div class="j-name">Start ${esc($('#startName').textContent)}</div><div class="j-meta">Heading ${compassWords(state.dir)} (${Math.round(state.dir)}°)</div></div><span class="j-km">0</span></li>`);
  let antipodeDone = false;
  visible.forEach((it) => {
    if (!antipodeDone && it.pos >= half) {
      rows.push(antipodeRow());
      antipodeDone = true;
    }
    const i = r.items.indexOf(it);
    const bg = it.cat === 'continent' ? `style="background:${CONTINENT_COLORS[it.name] || ''}"` : '';
    rows.push(
      `<li data-i="${i}" aria-selected="${state.selected === it}"><span class="j-icon" ${bg} aria-hidden="true">${iconFor(it)}</span><div class="j-main"><div class="j-name">${esc(it.name)}</div><div class="j-meta">${metaFor(it)}</div></div><span class="j-km">${it.start < 0 ? 'start' : dist(it.km, { short: true })}</span></li>`,
    );
  });
  if (!antipodeDone) rows.push(antipodeRow());
  rows.push(`<li class="j-milestone"><span class="j-icon">A</span><div class="j-main"><div class="j-name">Back where you started</div><div class="j-meta">A great circle always comes home.</div></div><span class="j-km">${dist(CIRCUMFERENCE_KM, { short: true })}</span></li>`);
  if (!visible.length) rows.splice(1, 0, `<li class="j-empty">Turn on a category above to see what your line crosses.</li>`);
  $('#journey').innerHTML = rows.join('');
}

function antipodeRow() {
  const lat = -state.lat;
  const lon = wrapLon(state.lon + 180);
  return `<li data-antipode="1"><span class="j-icon" aria-hidden="true">🔄</span><div class="j-main"><div class="j-name">Antipode: the exact opposite side</div><div class="j-meta">${formatLatLon(lat, lon)} · halfway around</div></div><span class="j-km">${dist(CIRCUMFERENCE_KM / 2, { short: true })}</span></li>`;
}

$('#journey').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li || !state.result) return;
  if (li.dataset.antipode) {
    globe.highlight({ lat: -state.lat, lon: wrapLon(state.lon + 180) }, SAMPLES);
    globe.flyTo(-state.lat, wrapLon(state.lon + 180));
    state.selected = null;
    return;
  }
  if (li.dataset.i === undefined) return;
  const it = state.result.items[+li.dataset.i];
  if (state.selected === it) {
    state.selected = null;
    globe.highlight(null);
  } else {
    state.selected = it;
    globe.highlight(it, SAMPLES);
    globe.flyTo(it.lat, it.lon);
  }
  document.querySelectorAll('#journey li[data-i]').forEach((x) => x.setAttribute('aria-selected', state.selected && +x.dataset.i === state.result.items.indexOf(state.selected)));
  drawStrip();
});

boot();

// Exposed for debugging in the console.
window.__circ = { state, globe, STEP_KM };
