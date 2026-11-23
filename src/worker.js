// Runs the (CPU-heavy) path analysis off the main thread so the globe and
// dial stay smooth while you drag.
import { decodeWorld, analyze } from './lib/analyze.js';

let world = null;
let pending = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'world') {
    world = decodeWorld(msg.raw);
    if (pending) run(pending);
    pending = null;
  } else if (msg.type === 'analyze') {
    if (!world) pending = msg;
    else run(msg);
  }
};

function run({ id, lat, lon, dir }) {
  const r = analyze(world, lat, lon, dir);
  self.postMessage({ id, items: r.items, stats: r.stats, land: r.land });
}
