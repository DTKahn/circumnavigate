import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { pointAt, toVec, toLatLon } from './lib/geo.js';

export const CONTINENT_COLORS = {
  Africa: '#f6e0b5',
  Asia: '#f7d4c6',
  Europe: '#dcd5f6',
  'North America': '#cdebcb',
  'South America': '#f8d4e4',
  Oceania: '#faeaa9',
  Antarctica: '#f8fafc',
};
const OCEAN = '#d7e9f9';
const OCEAN_DEEP = '#c5ddf3';
const PATH_COLOR = '#ff4f3a';
const HIGHLIGHT_COLOR = '#0071e3';
const PLANE_COLOR = '#0071e3';

// Geo vector [x, y, z] (z = north) → three.js space (y = up), matching the
// UV layout of THREE.SphereGeometry so an equirectangular texture lines up.
const toThree = (v, r = 1) => new THREE.Vector3(v[0] * r, v[2] * r, -v[1] * r);
const fromThree = (p) => [p.x, -p.z, p.y];

function decodeRing(enc) {
  const out = [];
  let x = 0,
    y = 0;
  for (let i = 0; i < enc.length; i += 2) {
    x += enc[i];
    y += enc[i + 1];
    out.push(x / 100, y / 100);
  }
  return out;
}

function drawTexture(raw, size) {
  const W = size;
  const H = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const X = (lon) => ((lon + 180) / 360) * W;
  const Y = (lat) => ((90 - lat) / 180) * H;

  // Ocean with a gentle latitude gradient.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, OCEAN);
  g.addColorStop(0.5, OCEAN_DEEP);
  g.addColorStop(1, OCEAN);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Graticule every 15°.
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = W / 4096;
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 15) {
    ctx.moveTo(X(lon), 0);
    ctx.lineTo(X(lon), H);
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    ctx.moveTo(0, Y(lat));
    ctx.lineTo(W, Y(lat));
  }
  ctx.stroke();

  const tracePath = (rings) => {
    ctx.beginPath();
    for (const enc of rings) {
      const r = decodeRing(enc);
      ctx.moveTo(X(r[0]), Y(r[1]));
      for (let i = 2; i < r.length; i += 2) ctx.lineTo(X(r[i]), Y(r[i + 1]));
      ctx.closePath();
    }
  };

  // Land, coloured by continent.
  for (const c of raw.countries) {
    tracePath(c.r);
    ctx.fillStyle = CONTINENT_COLORS[c.c] || '#eee';
    ctx.fill('evenodd');
    if (c.split) {
      // Countries spanning two continents: tint the eastern part.
      ctx.save();
      ctx.clip('evenodd');
      ctx.fillStyle = CONTINENT_COLORS[c.split.east];
      ctx.fillRect(X(c.split.lon), 0, W, H);
      ctx.fillStyle = CONTINENT_COLORS[c.split.west];
      ctx.fillRect(0, 0, X(c.split.lon), H);
      ctx.restore();
    }
  }
  // Lakes.
  ctx.fillStyle = OCEAN;
  for (const l of raw.lakes) {
    tracePath(l.r);
    ctx.fill('evenodd');
  }
  // Borders.
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = Math.max(1, W / 2600);
  ctx.lineJoin = 'round';
  for (const c of raw.countries) {
    tracePath(c.r);
    ctx.stroke();
  }
  // Rivers, very subtle.
  ctx.strokeStyle = 'rgba(120,170,220,0.55)';
  ctx.lineWidth = Math.max(0.6, W / 5000);
  ctx.beginPath();
  for (const r of raw.rivers) {
    for (const enc of r.l) {
      const p = decodeRing(enc);
      ctx.moveTo(X(p[0]), Y(p[1]));
      for (let i = 2; i < p.length; i += 2) {
        if (Math.abs(p[i] - p[i - 2]) > 180) ctx.moveTo(X(p[i]), Y(p[i + 1]));
        else ctx.lineTo(X(p[i]), Y(p[i + 1]));
      }
    }
  }
  ctx.stroke();
  return canvas;
}

function dotSprite(fill, ring, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = size * 0.08;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true });
}

export class Globe {
  constructor(container, { onPick } = {}) {
    this.container = container;
    this.onPick = onPick;
    this.showPlane = true;
    this.circle = null;
    this.anim = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(0, 0, 4.2);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.45;
    controls.zoomSpeed = 0.6;
    controls.minDistance = 1.6;
    controls.maxDistance = 7;
    controls.addEventListener('start', () => (this.anim = null));
    this.controls = controls;

    // Lights travel with the camera so the side facing you is always lit.
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-2, 2, 3);
    this.camera.add(key);
    this.scene.add(this.camera);

    // Earth
    this.earthMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 120), this.earthMat);
    this.scene.add(this.earth);

    // Soft atmosphere rim.
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(1.06, 96, 64),
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { c: { value: new THREE.Color('#7fb2ff') } },
        vertexShader: `varying vec3 vN; varying vec3 vP;
          void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform vec3 c; varying vec3 vN; varying vec3 vP;
          void main(){ float f = dot(normalize(-vP), vN); float a = pow(clamp(1.0 + f*1.0, 0.0, 1.0), 3.0) * 0.0 + pow(clamp(-f, 0.0, 1.0), 2.5) * 0.55; gl_FragColor = vec4(c, a); }`,
      }),
    );
    this.scene.add(atmo);

    // Cutting plane
    this.planeGroup = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 128),
      new THREE.MeshBasicMaterial({ color: PLANE_COLOR, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false }),
    );
    const rimPts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      rimPts.push(new THREE.Vector3(Math.cos(a) * 1.5, Math.sin(a) * 1.5, 0));
    }
    const rim = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(rimPts),
      new THREE.LineBasicMaterial({ color: PLANE_COLOR, transparent: true, opacity: 0.35 }),
    );
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 12), new THREE.MeshBasicMaterial({ color: PLANE_COLOR }));
    this.planeGroup.add(disc, rim, center);
    this.scene.add(this.planeGroup);

    // Paths
    this.pathMat = new LineMaterial({ color: PATH_COLOR, linewidth: 3.5, worldUnits: false, transparent: true });
    this.path = new Line2(new LineGeometry(), this.pathMat);
    this.path.renderOrder = 2;
    this.scene.add(this.path);
    this.hiMat = new LineMaterial({ color: HIGHLIGHT_COLOR, linewidth: 7, worldUnits: false });
    this.hi = new Line2(new LineGeometry(), this.hiMat);
    this.hi.visible = false;
    this.hi.renderOrder = 3;
    this.scene.add(this.hi);

    // Markers
    this.startDot = new THREE.Sprite(dotSprite(PATH_COLOR, '#ffffff'));
    this.startDot.scale.setScalar(0.075);
    this.startDot.renderOrder = 5;
    this.scene.add(this.startDot);
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.055, 24), new THREE.MeshBasicMaterial({ color: PATH_COLOR }));
    this.scene.add(this.arrow);
    this.pin = new THREE.Sprite(dotSprite(HIGHLIGHT_COLOR, '#ffffff'));
    this.pin.scale.setScalar(0.06);
    this.pin.visible = false;
    this.pin.renderOrder = 6;
    this.scene.add(this.pin);

    // Picking: a tap (not a drag) on the globe moves the starting point.
    const ray = new THREE.Raycaster();
    let down = null;
    renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved > 6 || !quick) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObject(this.earth)[0];
      if (hit && this.onPick) {
        const [lat, lon] = toLatLon(fromThree(hit.point));
        this.onPick(lat, lon);
      }
    });

    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
    this.dirty = true;
    controls.addEventListener('change', () => (this.dirty = true));
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  setWorld(raw) {
    const max = this.renderer.capabilities.maxTextureSize;
    const size = Math.min(max, 4096);
    const tex = new THREE.CanvasTexture(drawTexture(raw, size));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.earthMat.map = tex;
    this.earthMat.needsUpdate = true;
    this.dirty = true;
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole globe visible in tall, narrow viewports.
    const fit = w / h < 1 ? 1 / (w / h) : 1;
    this.camera.fov = Math.min(60, 32 * Math.pow(fit, 0.9));
    this.camera.updateProjectionMatrix();
    this.pathMat.resolution.set(w, h);
    this.hiMat.resolution.set(w, h);
    this.dirty = true;
  }

  circlePoints(circle, from = 0, to = Math.PI * 2, r = 1.003) {
    const steps = Math.max(2, Math.ceil(((to - from) / (Math.PI * 2)) * 720));
    const pos = [];
    for (let i = 0; i <= steps; i++) {
      const p = toThree(pointAt(circle, from + ((to - from) * i) / steps), r);
      pos.push(p.x, p.y, p.z);
    }
    return pos;
  }

  setCircle(circle) {
    this.circle = circle;
    const g = new LineGeometry();
    g.setPositions(this.circlePoints(circle));
    this.path.geometry.dispose();
    this.path.geometry = g;
    this.path.computeLineDistances();

    // Orient the plane disc: its normal is the circle's normal.
    const n = toThree(circle.n);
    this.planeGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    this.planeGroup.visible = this.showPlane;

    const A = toThree(circle.A, 1.012);
    this.startDot.position.copy(A);
    const D = toThree(circle.D);
    const tip = toThree(pointAt(circle, 0.045), 1.012);
    this.arrow.position.copy(tip);
    this.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), D.clone().normalize());
    this.dirty = true;
  }

  setPlaneVisible(v) {
    this.showPlane = v;
    this.planeGroup.visible = v;
    this.dirty = true;
  }

  /** Highlight a stretch of the path (sample positions as fractions of the loop). */
  highlight(item, samples) {
    if (!item || !this.circle) {
      this.hi.visible = false;
      this.pin.visible = false;
      this.dirty = true;
      return;
    }
    const TAU = Math.PI * 2;
    if (item.lengthKm) {
      const from = (item.start / samples) * TAU;
      const to = ((item.end + 1) / samples) * TAU;
      const g = new LineGeometry();
      g.setPositions(this.circlePoints(this.circle, from, to, 1.005));
      this.hi.geometry.dispose();
      this.hi.geometry = g;
      this.hi.computeLineDistances();
      this.hi.visible = true;
      this.pin.visible = false;
    } else {
      this.hi.visible = false;
      this.pin.visible = true;
      this.pin.position.copy(toThree(toVec(item.lat, item.lon), 1.014));
    }
    this.dirty = true;
  }

  /** Smoothly turn the globe so (lat, lon) faces the viewer. */
  flyTo(lat, lon, distance, duration = 900) {
    this.flyToVec(toVec(lat, lon), distance, duration);
  }

  /**
   * Look at the start point from slightly above the cutting plane, so the
   * circle shows as an ellipse and the plane is visible instead of edge-on.
   */
  flyToCircle(circle, distance, duration = 900) {
    const n = circle.n[2] < 0 ? circle.n.map((v) => -v) : circle.n;
    const a = 0.5; // ~29° above the plane
    const v = circle.A.map((x, i) => x * Math.cos(a) + n[i] * Math.sin(a));
    this.flyToVec(v, distance, duration);
  }

  flyToVec(v, distance, duration = 900) {
    const from = this.camera.position.clone();
    const dist = distance || from.length();
    const to = toThree(v).normalize().multiplyScalar(dist);
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
    this.anim = { t0: performance.now(), dur: duration, from, q0, q1, d0: from.length(), d1: dist };
  }

  tick() {
    if (this.anim) {
      const a = this.anim;
      let t = Math.min(1, (performance.now() - a.t0) / a.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const q = a.q0.clone().slerp(a.q1, e);
      const dir = a.from.clone().normalize().applyQuaternion(q);
      this.camera.position.copy(dir.multiplyScalar(a.d0 + (a.d1 - a.d0) * e));
      this.camera.lookAt(0, 0, 0);
      this.dirty = true;
      if (t >= 1) this.anim = null;
    }
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  }

  /** Lat/lon currently facing the viewer. */
  get view() {
    return toLatLon(fromThree(this.camera.position.clone().normalize()));
  }
}
