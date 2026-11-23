// Small spherical-geometry toolkit. Vectors are plain [x, y, z] arrays on the
// unit sphere with x → (0°N, 0°E), y → (0°N, 90°E), z → North Pole.

export const DEG = Math.PI / 180;
export const EARTH_RADIUS_KM = 6371;
export const CIRCUMFERENCE_KM = 2 * Math.PI * EARTH_RADIUS_KM; // ≈ 40,030 km

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function toVec(lat, lon) {
  const φ = lat * DEG;
  const λ = lon * DEG;
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}

export function toLatLon(v) {
  const [x, y, z] = norm(v);
  return [Math.asin(Math.max(-1, Math.min(1, z))) / DEG, Math.atan2(y, x) / DEG];
}

export const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
export const wrapBearing = (b) => ((b % 360) + 360) % 360;

/** Local east / north unit vectors at a point. */
export function frame(lat, lon) {
  const φ = lat * DEG;
  const λ = lon * DEG;
  const east = [-Math.sin(λ), Math.cos(λ), 0];
  const north = [-Math.sin(φ) * Math.cos(λ), -Math.sin(φ) * Math.sin(λ), Math.cos(φ)];
  return { east, north };
}

/**
 * The great circle that starts at (lat, lon) heading in `bearing` degrees
 * (0 = north, 90 = east). Returns start vector A, direction D and the plane normal n.
 */
export function greatCircle(lat, lon, bearing) {
  lat = Math.max(-89.999, Math.min(89.999, lat)); // directions are undefined exactly at a pole
  const A = toVec(lat, lon);
  const { east, north } = frame(lat, lon);
  const β = bearing * DEG;
  const D = norm([
    north[0] * Math.cos(β) + east[0] * Math.sin(β),
    north[1] * Math.cos(β) + east[1] * Math.sin(β),
    north[2] * Math.cos(β) + east[2] * Math.sin(β),
  ]);
  return { A, D, n: norm(cross(A, D)), lat, lon, bearing };
}

/** Point at angle t (radians) along the circle. */
export function pointAt(c, t) {
  const ct = Math.cos(t);
  const st = Math.sin(t);
  return [c.A[0] * ct + c.D[0] * st, c.A[1] * ct + c.D[1] * st, c.A[2] * ct + c.D[2] * st];
}

/** Position (radians, 0…2π) of the projection of v onto the circle. */
export function angleOn(c, v) {
  const t = Math.atan2(dot(v, c.D), dot(v, c.A));
  return t < 0 ? t + 2 * Math.PI : t;
}

/** Angular distance (radians) from v to the circle's plane. */
export const offPlane = (c, v) => Math.asin(Math.min(1, Math.abs(dot(v, c.n))));

/** Initial compass bearing from point 1 to point 2. */
export function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const Δλ = (lon2 - lon1) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return wrapBearing(Math.atan2(y, x) / DEG);
}

/** Bearing at point A for the circle with normal n (direction D = n × A). */
export function bearingFromNormal(lat, lon, n) {
  const A = toVec(lat, lon);
  const D = cross(n, A);
  const { east, north } = frame(lat, lon);
  return wrapBearing(Math.atan2(dot(D, east), dot(D, north)) / DEG);
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const a = toVec(lat1, lon1);
  const b = toVec(lat2, lon2);
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * EARTH_RADIUS_KM;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const COMPASS_WORDS = {
  N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east',
  ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south',
  SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west',
  WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest',
};
export const compass = (b) => COMPASS[Math.round(wrapBearing(b) / 22.5) % 16];
export const compassWords = (b) => COMPASS_WORDS[compass(b)];

export function formatLatLon(lat, lon) {
  const f = (v, p, n) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? p : n}`;
  return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'W')}`;
}
