// Data loader.
// Reads layerset.json, *.bin, traverse.json and env.json from public/data/, then
//   - sends `layers:ready` once, and
//   - sends `env:update` with one sample every config.envIntervalMs (starting over at the end).
// Formats: INTERFACES sections 2 and 3. In mock mode (mock.data) mock/layers.js stands in for the files.
// It also adds one derived waypoint, `near`: a destination about 20 m from the base (?near=).

import { bus } from './bus.js';
import { config, mock, DATA_BASE } from './config.js';
import { nearbyWaypoint } from './waypoints.js';

const assetOverrides = new Map(); // file name → blob URL (the images of mock mode)

/**
 * Turns a layer's `file` into the URL to load it from. Used when reading an image layer.
 *   new THREE.TextureLoader().load(ctx.assetUrl(layer.file))
 * In mock mode it gives the URL of the fake image.
 */
export function assetUrl(file) {
  return assetOverrides.get(file) ?? DATA_BASE + file;
}

// The Vite dev server answers 200 with index.html for a file that is not there, so the content-type is checked too.
function isMissing(res) {
  return !res.ok || (res.headers.get('content-type') ?? '').includes('text/html');
}

async function fetchJson(file, { optional = false } = {}) {
  try {
    const res = await fetch(DATA_BASE + file);
    if (isMissing(res)) throw new Error(res.ok ? 'file not found' : `HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (optional) {
      console.warn(`[loader] ${file} is missing (${err.message}). Skipping it.`);
      return null;
    }
    throw new Error(`could not read ${file}: ${err.message}`);
  }
}

async function fetchGrid(layer, grid) {
  const res = await fetch(DATA_BASE + layer.file);
  if (isMissing(res)) throw new Error(`${layer.file}: ${res.ok ? 'file not found' : `HTTP ${res.status}`}`);
  const buf = await res.arrayBuffer();
  const expected = grid.cols * grid.rows;
  if (buf.byteLength !== expected * 4) {
    throw new Error(`${layer.file}: ${buf.byteLength} bytes long, expected ${expected * 4} bytes (cols*rows*4)`);
  }
  // Little-endian Float32 (INTERFACES 2.2). Every device in use is little-endian.
  return new Float32Array(buf);
}

async function loadReal() {
  const layerSet = await fetchJson('layerset.json');
  const grids = {};
  await Promise.all(
    layerSet.layers
      .filter((l) => l.format === 'float32')
      .map(async (l) => {
        try {
          grids[l.id] = await fetchGrid(l, layerSet.grid);
        } catch (err) {
          console.warn(`[loader] could not read the numeric grid '${l.id}':`, err.message);
        }
      }),
  );
  const traverse = (await fetchJson('traverse.json', { optional: true })) ?? { sourceUrl: '', points: [] };
  const env = await fetchJson('env.json', { optional: true });
  return { layerSet, grids, traverse, env };
}

function playEnv(env) {
  const samples = env?.samples ?? [];
  if (!samples.length) {
    console.warn('[loader] env.json has no samples: env:update is not sent.');
    return;
  }
  let i = 0;
  const next = () => {
    const s = samples[i % samples.length];
    i++;
    bus.emit('env:update', {
      sol: s.sol,
      localTime: s.localTime,
      radiationUGyPerDay: s.radiationUGyPerDay,
      radiationIsFixedValue: !!env.radiationIsFixedValue,
      pressurePa: s.pressurePa ?? null,
      airTempK: s.airTempK ?? null,
    });
  };
  next();
  setInterval(next, config.envIntervalMs / mock.speed);
}

/** Reads the data and sends the events. Call it after every module's init is done. */
export async function loadData() {
  let data;
  if (mock.data) {
    const { buildMockData } = await import('../mock/layers.js');
    data = await buildMockData();
    for (const [file, url] of Object.entries(data.assets)) assetOverrides.set(file, url);
  } else {
    data = await loadReal();
  }
  const { layerSet, grids, traverse, env } = data;
  // A destination close to the base, next to the two the data brings (core/waypoints.js).
  if (config.nearbyM > 0 && !layerSet.waypoints?.some((w) => w.id === 'near')) {
    const near = nearbyWaypoint(layerSet, config.nearbyM, grids.slope);
    if (near) layerSet.waypoints.push(near);
    else console.warn('[loader] no usable cell for the nearby destination at', config.nearbyM, 'm');
  }
  bus.emit('layers:ready', { layerSet, grids, traverse });
  playEnv(env);
  return data;
}
