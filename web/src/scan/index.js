// scan — field obstacle map from the headset's view of the room (role A).
//
// Sends: hazard:update (docs/INTERFACES.md section 3): a floor grid in room coordinates,
//        0 = passable, 1 = obstacle, 255 = not seen yet. Only on change, in the frame after the
//        depth read that changed it: up to ten times a second.
//
// Two layers on the same cells, merged when the grid is sent (mergeLayers in grid.js).
//
// The room scan (room.js): the room geometry the Quest 3 already keeps (Space Setup), read
// through WebXR `mesh-detection` (the room mesh and furniture volumes) and `plane-detection`
// (walls, tables, the floor). Every surface between floorBandM and headM above the floor blocks
// the cell under it; surfaces near the floor mark the cell as passable. Its limits:
//   - It is the room as the headset last scanned it. A chair moved after the scan is not in it
//     until the headset updates its room model.
//   - If the headset has no room scan, nothing arrives from it and every cell stays "not seen".
//     The wearer has to run Space Setup once (Settings > Environment setup).
//   - Space Setup stores a wall as one rectangle, so an open doorway is closed in the grid,
//     and stays closed: nothing takes structure off the room layer.
//
// Live depth (when the session has `depth-sensing`: field mode, or ?depth=1): ten times a
// second (depthMs; less often by itself when a read turns out to be slow, depthBusy) the depth
// image of the left eye is laid over the same cells (depth.js, grid.js). It adds what stands
// within depthRangeM of the wearer now (5 m, as far as the headset's 320 x 320 depth image can
// still clear what it marks), so a chair put down after the scan appears. In a room the headset
// has no room scan of, it is the whole map: on the headset every session so far had none
// (stats.meshes and planes were 0), so how far this reaches and how often it reads is how far
// and how fast the map grows.
// What it has marked stays on the map when the wearer walks away or looks elsewhere: an
// obstacle is only taken off again once the sensor sees clear floor where it stood. It never
// clears structure that came from the room scan. Not yet checked on the headset.
//
// The map has no edge (tiles.js). The floor is cut into tiles of 6.4 m, and the grid that is
// worked on and sent is a window of 4 x 4 tiles (25.6 m) around the wearer. When the wearer has
// walked about a tile from its centre, the window is moved by whole tiles; the tiles that fall
// out of it are kept (the archive) and come back when the wearer returns. `hazard:update` is
// always the window, so its originXZ changes when the window moves. Not yet checked on the headset.
//
// Every read counts for every cell in view: something put down is on the map after setScans
// reads (0.2 s; 0.3 s beyond farM) and off it after clearScans reads of bare floor (0.3 s),
// wherever the head looks. Settling (grid.js), which leaves alone the cells that keep giving
// the same answer and looks at them again every refreshS, is off by default: it made known
// ground slower to follow the room and saved no reads on the headset (see settleScans).
// ?settle=1 turns it on.
//
// Standing on a marked cell does not clear it. An obstacle comes off the map only when live
// depth sees bare floor where it stood; a wearer who walks into one is warned instead
// (field/zone.js raises the 'hazard-zone' alert). Until 2026-11-15 the cells under the wearer
// were freed at once.
//
// The map is kept on the Jetson (memory.js): the tiles that changed go to the hub as
// `map:store` (at most every storeMs) and the hub writes them to disk. When a session starts
// the hub hands back the map it stored last (`map:stored`); once the new scan lines up with
// it, it fills in what this session has not seen yet. ?remember=0 turns the handing back off.
//
// The obstacles also glow red on the real floor in field mode (overlay.js).
//
// ctx and frame: see the comment in map/index.js.

import { mode } from '../core/mode.js';
import { isOff, numberOr } from '../core/params.js';
import { startMockHazard } from '../mock/hazard.js';
import { createRoom } from './room.js';
import { createGrid, mergeLayers, viewOf } from './grid.js';
import { readDepth, depthImage } from './depth.js';
import { initOverlay } from './overlay.js';
import { encodeRuns, decodeTiles, linesUp, fillUnknown } from './memory.js';
import { TILES, tileKey, parseKey, inTiles, follow, cutTile, assemble, moveWindow } from './tiles.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// How far live depth looks, along the floor (SCAN.depthRangeM; leaveM and glowFullM follow it).
const depthRangeM = clamp(numberOr('depthRange', 5), 1.5, 8);
// Ground is not one flat plane: a room's floor sits a little off where the headset puts it,
// a platform or a ramp lifts it, the next room lies a step lower. Ground that differs from the
// floor by up to this much is still ground to walk on, not a thing in the way and not a drop
// (0.2 m: a kerb, a stair's riser). The three heights below are this plus what depth error
// adds (a floor point 5 m away reads up to 7 cm off, and the floor itself a few cm).
// ?step=0.05&low=0.05 gives the stricter heights of before (things from 0.25 m, drops from 0.3 m).
const stepM = clamp(numberOr('step', 0.2), 0, 0.5);
// Downwards the ground may differ more: level ground up to this much lower than the floor (the
// next terrace, a sunken part of the room, a slope's foot) is walked down to and is no drop.
// 0.5 m. ?low=0.2 gives the same as upwards.
const lowM = clamp(numberOr('low', 0.5), 0, 1.5);

export const SCAN = {
  cellM: 0.1, // the window is TILES.window x TILES.cells of these per side (tiles.js): 25.6 m
  followMs: 250, // how often the window is checked against where the wearer stands
  floorBandM: 0.1 + stepM, // room model: surfaces below this height are floor (0.3 m)
  headM: 1.9, // surfaces above this height do not block walking
  sampleM: 0.07, // spacing of the points sampled on each triangle
  trianglesPerFrame: 1500, // budget, so a large room mesh does not stall a frame
  rescanMs: 10000, // a mesh or plane that says it changed is not rasterised again sooner than this
  // The grid goes out at most this often, and never in the frame of a depth read. Kept below
  // depthMs (grid.test.js), so what a read changed goes out with the next frame: with 250
  // against a read every 200 the two beat against each other, and a change waited 144 ms on
  // average for its turn while the map kept changing. An update costs its listeners about a
  // millisecond now (the glow's outline is worked out for the box around the obstacles only,
  // overlay.js; the palm map draws the grid only when it is up; a route is planned again at
  // most every FIELD.regridMs). ?emitMs=250 is the value before.
  emitMs: clamp(numberOr('emitMs', 80), 50, 5000),

  // Live depth. Range, rate and sample count can be set from the address while tuning on the
  // headset: ?depthRange=4&depthMs=200&depthSamples=288&settle=1&emitMs=250 are the values of
  // the build before this one.
  // Ten reads a second (it was five, and 2.9 before 2026-11-15). The headset's depth image is
  // new about 30 times a second, so every read sees a new one.
  // What a read costs the processor (measured on the Jetson's Cortex-A78AE, the class of core
  // the Quest 3 has): about 4 ms for the 102,400 points of 320 a side over a floor with a few
  // things on it, more with a drop in view (a stair down: one sample in four beyond the edge
  // walks the missing floor, grid.js). What the read-back from the GPU costs on the headset is
  // not known; both are timed (depth.js) and go to the hub's log with the heartbeat
  // (stats.readMs), next to the frame rate.
  depthMs: clamp(numberOr('depthMs', 100), 50, 2000), // read the depth image this often
  // The reads may take this share of the time, no more: a read that took t ms is not followed
  // by the next before t / depthBusy ms have passed. Up to 15 ms a read, that leaves depthMs as
  // it is; a headset on which a read takes 30 ms reads five times a second by itself, not ten,
  // and keeps its frame rate. ?depthBusy=1 takes the limit away.
  depthBusy: clamp(numberOr('depthBusy', 0.15), 0.02, 1),
  // Samples per side taken from the depth image (never more than it has, depth.js). The far
  // floor decides: a 10 cm cell 3.8 m away must still get the minPoints it needs to say
  // "floor", or a chair marked there could never be cleared again. 288 does that at every
  // distance and tilt of the head tried; 256 leaves a cell at the rim now and then, and the
  // 192 of before holds to 2.4 m only (grid.test.js). For ?depthRange=5 take
  // ?depthSamples=320 (102,400 points, 4.5 ms a read).
  depthSamples: clamp(Math.round(numberOr('depthSamples', 320)), 64, 512),
  // Cells farther than this from the headset, along the floor, are left alone. 4 m (it was
  // 2.5): things are marked, and cleared again by the floor under them, out to 3.8 m.
  depthRangeM,
  bodyM: 0.8, // cells this close to the headset, along the floor, are the wearer's own hands and body
  floorNoiseM: 0.1 + stepM, // a depth point within this height of y = 0 counts as ground (0.3 m: level ground a step up or down, and the floor a few cm off)
  floorLowM: 0.1 + Math.max(stepM, lowM), // and down to this far below it (0.6 m): lower level ground, with what depth error adds
  thingMinM: 0.2 + stepM, // a depth point counts as a thing from this height (0.4 m): above what a step up plus depth error can reach
  // Ground this far below the floor is a drop, and is marked like an obstacle: a stair well, a pit, a ledge.
  // 0.7 m: ground up to 0.5 m lower is walked down to, and depth error puts a point 7 cm low at most.
  // ?drops=0 turns it off (a mirror-like floor may read as deeper than it is).
  dropMinM: isOff('drops') ? 0 : 0.2 + Math.max(stepM, lowM),
  minPoints: 3, // samples needed in a cell before a read says anything about it
  // Far away the image lies thin on the floor: where a floor cell would get fewer than twice
  // this many samples, this many say "floor", and where it would not even get this many the
  // read ends (grid.js: addDepthView, floorReachM). 2: at 5 m, with 320 samples a side and the
  // eye at 1.45 m, a floor cell gets 2 or more in 83 to 89 reads of 100 and 3 or more in 73 to 83.
  farPoints: 2,
  // Beyond farM a thing has to be seen farSetScans reads in a row (0.3 s) before it counts.
  // 4 m is where Meta says the depth image gets much less exact; nearer, nothing changes.
  farM: 4,
  farSetScans: 3,
  setScans: 2, // reads in a row that must see an obstacle before it counts (2 = 0.2 s): not stray depth, nor something passing in one image
  clearScans: 3, // floor-only reads before a live obstacle is cleared (3 = 0.3 s)
  // Settling (grid.js): a cell that gave the same answer this many reads in a row is settled
  // and left alone until it is looked at again (refreshS). Off (0); ?settle=1 turns it on with
  // 6 reads (0.6 s).
  // Why off: a settled cell is blind for refreshS at a time, so on ground the scan knew a chair
  // put down showed after about a second where on new ground it took setScans reads; with
  // every cell read every time, known ground follows the room as fast as new ground does
  // (grid.test.js has the case). And what settling was for, skipping reads, did not happen on
  // the headset: at most one read was skipped in a session (jetson/maps), because a real depth
  // image always leaves some cell open.
  settleScans: numberOr('settle', 0) ? 6 : 0,
  // The next five only matter with ?settle=1.
  refreshS: 1, // settled ground in view is looked at again this long after it settled (0 = only after the wearer has been away)
  resettleScans: 2, // and settles again after this many reads that say what it already is: a chair put down or taken away shows in 1 to 2 s
  giveUpScans: 16, // in view this many reads without an answer (behind something, or too far for enough points): settled too
  leaveM: depthRangeM + 1.5, // a settled cell is read again when the wearer returns after being this far from it (well beyond depthRangeM, or cells at its rim would open at every step)
  vantageM: 1, // a cell that gave no answer is read again when the wearer has moved about this far (or turned, or tilted the head)
  viewHalfDeg: 40, // half the width of what the depth image sees, for deciding what was in view
  forgetScans: 0, // reads out of sight before a live obstacle is forgotten; 0 = never: the map keeps what it has seen

  // The map on the Jetson.
  storeMs: 2000, // a changed map goes to the hub at most this often
  remember: !isOff('remember'), // take the stored map back

  // Highlight on the floor (overlay.js), [r, g, b] 0-255.
  glowRGB: [255, 48, 48], // the fill
  glintRGB: [255, 214, 208], // where the travelling light and the sparks are brightest
  glowFullM: 0.8 * depthRangeM, // shown in full within this distance of the wearer
  glowFadeM: 1, // beyond it, fading to 1/e every this many metres (a tenth at 5.5 m, gone by 8 m)
};

let ctx;
let room; // the room scan, on the window: what the headset stored at Space Setup (room.js)
let cols; // cells per side of the window
let origin; // room coordinates of the window's cell [0, 0]
let originTile; // the same in tiles: the window's first tile
const archive = new Map(); // tiles outside the window: tileKey -> { room, live }, each Uint8Array(tile)
let lastFollow = 0; // time the window was last checked against the head
let dirty = false; // a layer changed since the grid was last sent
let lastEmit = 0;
let stats = { meshes: 0, planes: 0, obstacles: 0, floor: 0, depth: 0 };
let reads = 0; // depth reads made
let skips = 0; // depth reads not made because everything in view was settled
let refreshes = 0; // times settled ground in view was opened to be read again
let live; // what live depth sees, on the same cells
let depthOn = false; // this session has depth-sensing and reading it has not failed
let depthSeen = false; // the live layer holds what a recent read saw
let lastDepth = 0; // time of the last read that got an image
let readCostMs = 0; // what a read takes, smoothed over the last few (ms): sets how soon the next may follow (SCAN.depthBusy)
let sendMs = 0; // how long the listeners of the last hazard:update took (ms)
let waitFrom = 0; // time of the first read in a row that got none
let said = {}; // what has been reported once this session
let sent = null; // the cells of the last hazard:update
let started = 0; // time of the session's first frame
let space = null; // the reference space whose 'reset' is being listened to
// The map on the Jetson. A run is one stretch in one set of room coordinates: a page load, and
// a new one after every recentre, so a map in old coordinates is not overwritten by the next.
const page = Date.now().toString(36);
let runNo = 0;
let run = `${page}-0`;
let stored = null; // the hub's last map from another run, when it has these tiles: tileKey -> Uint8Array(tile)
let storedWin = null; // the part of it under the window, as one grid; null when none of it is
let trusted = false; // the stored map lines up with this session's scan and is being used
let storedRun = null; // the run the stored map is of
let toStore = false; // the map changed since it last went to the hub
let lastStore = 0;
// Only tiles that changed are sent, so this side keeps count of what the hub has of this run.
const hubHas = new Map(); // tileKey -> the tile's runs as text, as last sent (or as the hub said it has)
const outbox = new Map(); // tileKey -> runs: tiles the hub does not have like this yet; they go with the next map:store
let restDue = false; // every tile outside the window has to be compared with what the hub has

const tileM = () => SCAN.cellM * TILES.cells;
const originOf = (tile) => [tile[0] * tileM(), tile[1] * tileM()];
const storedUnder = (tile) => stored && assemble((key) => stored.get(key), tile);

function reset() {
  cols = TILES.cells * TILES.window;
  // Around the room origin, where a session starts. If the wearer is somewhere else (a space
  // that kept its origin from before), the first look at the head moves the window there.
  originTile = [follow(null, 0), follow(null, 0)];
  origin = originOf(originTile);
  archive.clear();
  lastFollow = 0;
  room = createRoom(cols, cols, origin, SCAN);
  dirty = true;
  live = createGrid(cols, cols, SCAN.cellM, origin, SCAN);
  depthOn = ctx.xr.has('depth-sensing') === true;
  depthSeen = false;
  waitFrom = started = 0;
  readCostMs = 0;
  said = {};
  sent = null;
  // New coordinates (a session start or a recentre): a new run, and the stored map has to
  // prove itself again. Ask the hub for its latest; the answer comes as map:stored.
  run = `${page}-${runNo++}`;
  trusted = false;
  ctx.bus.emit('map:run', { run, trusted: false, storedRun });
  toStore = false;
  hubHas.clear();
  outbox.clear();
  restDue = false;
  storedWin = storedUnder(originTile);
  if (SCAN.remember) ctx.bus.emit('map:request', {});
}

/**
 * Move the window when the wearer has walked out of its two middle tiles (tiles.js: follow).
 * Both layers move; the tiles that leave go to the archive and to the hub.
 */
function followHead(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const next = [follow(originTile[0], inTiles(x, SCAN.cellM)), follow(originTile[1], inTiles(z, SCAN.cellM))];
  if (next[0] === originTile[0] && next[1] === originTile[1]) return;
  const nextOrigin = originOf(next);
  const { left } = moveWindow({ room: room.cells, live: live.cells }, originTile, next, archive, {
    live: {
      shift: (dCols, dRows) => live.shift(dCols, dRows, nextOrigin),
      paste: (col, row, tile) => live.restore(col, row, TILES.cells, tile),
    },
  });
  originTile = next;
  origin = nextOrigin;
  storedWin = storedUnder(originTile);
  for (const key of left) offer(key, restTile(key));
  if (outbox.size) toStore = true;
  // The room layer drops what falls outside the window, so the room scan of the ground that
  // just came in was never rasterised (or only as far as the archive has it). room.moved()
  // forgets what has been rasterised, which queues every mesh and plane again. shortcut: that
  // is the whole room model on every move, trianglesPerFrame a frame, and no hazard:update goes
  // out until the queue is empty. If that shows as a pause when walking, queue only what
  // reaches into the new tiles.
  room.moved(nextOrigin);
  sent = null; // the next hazard:update is a window somewhere else: nothing to compare it with
  dirty = true;
  console.info('[scan] window moved to', origin, 'tiles kept outside it:', archive.size);
}

/** The hub's answer to map:request: the newest map it has stored (link.js forwards map.stored). */
function takeStored(m) {
  if (!m || m.tileCells !== TILES.cells || Math.abs(m.cellSizeM - SCAN.cellM) > 1e-6 || !Array.isArray(m.tiles)) return;
  if (m.run === run) {
    // This run's own map: the answer to the request the link makes when it comes back. It says
    // what really arrived, so tiles sent while the link was down are sent again.
    hubHas.clear();
    for (const t of m.tiles) if (Array.isArray(t?.runs)) hubHas.set(tileKey(t.x, t.z), t.runs.join());
    restDue = toStore = true;
    return;
  }
  if (hubHas.size) {
    // The hub's newest map is not this run, though tiles of it were sent: send them all again.
    // (When the hub has no map at all it does not answer, and tiles lost before the first
    // connection are then sent only when they next change.)
    hubHas.clear();
    restDue = toStore = true;
  }
  if (!SCAN.remember) return;
  const tiles = decodeTiles(m.tiles, TILES.cells);
  if (!tiles.size) return console.warn('[scan] the stored map from the hub has no tiles');
  stored = tiles;
  storedRun = m.run ?? null;
  storedWin = storedUnder(originTile);
  trusted = false;
  dirty = true;
  // Which run the stored map is of, before it is trusted: the waypoints kept with that run may
  // still come back in this session, the ones of older runs cannot (hud/marks.js).
  ctx.bus.emit('map:run', { run, trusted: false, storedRun });
  console.info('[scan] stored map from the hub:', m.run, m.savedAt ?? '', tiles.size, 'tiles');
}

/**
 * What the hub should have of a tile outside the window: this run's layers from the archive,
 * and under them the stored map once it is trusted. Null when nothing is known there.
 */
function restTile(key) {
  const entry = archive.get(key);
  const under = trusted ? stored?.get(key) : null;
  if (!entry) return under ?? null;
  const { cells: tile } = mergeLayers(entry.room, entry.live);
  if (under) fillUnknown(tile, under);
  return tile;
}

/**
 * The ground outside the window that anything is known about, tile by tile:
 * [{ x, z: room metres of the tile's corner, sizeM, cells: Uint8Array(tileCells x tileCells) }].
 * With `hazard:update` (the window) this is every place the map knows: for the field map when
 * it is unfolded to all of it (field/index.js).
 */
export function knownBeyondWindow() {
  const out = [];
  if (!originTile) return out;
  const keys = new Set([...archive.keys(), ...(trusted && stored ? stored.keys() : [])]);
  for (const key of keys) {
    const t = parseKey(key);
    if (!t) continue;
    if (t[0] >= originTile[0] && t[0] < originTile[0] + TILES.window && t[1] >= originTile[1] && t[1] < originTile[1] + TILES.window) continue; // in the window
    const cells = restTile(key);
    if (cells) out.push({ x: t[0] * tileM(), z: t[1] * tileM(), sizeM: tileM(), cells });
  }
  return out;
}

/** Put a tile in the outbox if the hub does not have it like this. */
function offer(key, tile) {
  const runs = tile ? encodeRuns(tile) : [255, TILES.cells * TILES.cells];
  // A tile the hub has never heard of is, to the hub, a tile nothing is known about.
  if (runs.join() === (hubHas.get(key) ?? `255,${TILES.cells * TILES.cells}`)) outbox.delete(key);
  else outbox.set(key, runs);
}

const inWindow = ([tx, tz]) => tx >= originTile[0] && tz >= originTile[1] && tx < originTile[0] + TILES.window && tz < originTile[1] + TILES.window;

/** Send the tiles that changed to the hub (link.js forwards map:store). */
function store(time) {
  toStore = false;
  lastStore = time;
  if (restDue) {
    restDue = false;
    for (const key of new Set([...archive.keys(), ...(trusted && stored ? stored.keys() : [])])) {
      if (!inWindow(parseKey(key))) offer(key, restTile(key));
    }
  }
  // The window as it was last sent to the app: it has the stored map under it where that is trusted.
  if (sent) {
    for (let j = 0; j < TILES.window; j++) {
      for (let i = 0; i < TILES.window; i++) offer(tileKey(originTile[0] + i, originTile[1] + j), cutTile(sent, cols, i, j));
    }
  }
  if (!outbox.size) return;
  const tiles = [];
  for (const [key, runs] of outbox) {
    const [x, z] = parseKey(key);
    tiles.push({ x, z, runs });
    hubHas.set(key, runs.join());
  }
  outbox.clear();
  ctx.bus.emit('map:store', {
    run,
    cellSizeM: SCAN.cellM,
    tileCells: TILES.cells,
    tiles,
    source: depthSeen ? 'room-scan+depth' : 'room-scan',
    stats,
  });
}

export function init(context) {
  ctx = context;
  reset();
  // Mock mode: the fake obstacle grid stands in for the scan.
  if (ctx.mock.hazard) startMockHazard(ctx.bus, { speed: ctx.mock.speed });
  ctx.xr.onSessionStart(() => reset());
  // The reference space was shifted onto the room's kept coordinates (core/room-frame.js):
  // what was scanned in the first moments of the session is in the old ones.
  ctx.xr.onRealign?.(() => reset());
  ctx.xr.onSessionEnd(() => { if (toStore) store(0); }); // the last changes, before the wearer takes the headset off
  ctx.bus.on('map:stored', takeStored);
  // With depth-sensing three.js would draw a mesh that hides every virtual object behind real
  // surfaces (the reason depth is off by default, core/xr.js), and would leave clearing the
  // frame to that mesh. The scan only wants the numbers: no mesh, and the usual clear.
  ctx.renderer.xr.getDepthSensingMesh = () => null;
  ctx.renderer.xr.hasDepthSensing = () => false;
  initOverlay(ctx, SCAN);
  window.__scan = {
    stats: () => ({ ...stats, queued: room.pending, run, stored: !!stored, trusted, reads, skips, refreshes, settled: live?.settledCount ?? 0, archived: archive.size, windowXZ: [...origin], readCostMs: Math.round(readCostMs * 10) / 10 }),
    config: SCAN, // the numbers in use, with what the address set (?depthMs, ?depthRange, ?depthSamples, ?emitMs, ?settle ...)
  };
}

export function update(frame) {
  const { xrFrame, refSpace, time } = frame;
  if (!xrFrame || !refSpace || ctx.mock.hazard) return;

  followSpace(refSpace);
  followWearer(xrFrame, refSpace, time);
  room.collect(xrFrame, refSpace, time);
  if (room.work()) dirty = true;
  warnIfNoRoom(time);
  const read = readLive(frame);
  // Not in the frame that read depth: the read and the consumers of the event each take time.
  if (dirty && !read && !room.pending && time - lastEmit >= SCAN.emitMs) {
    if (!send(time)) return; // nothing new to say: the frame ends here, and a store that is due waits for the next one
  }
  if (toStore && time - lastStore >= SCAN.storeMs) store(time);
}

// Keep the window around the wearer. Not every frame: a step is far less than the margin the
// window has on every side.
function followWearer(xrFrame, refSpace, time) {
  if (time - lastFollow < SCAN.followMs) return;
  const at = xrFrame.getViewerPose(refSpace)?.transform.position;
  if (!at) return;
  lastFollow = time;
  followHead(at.x, at.z);
}

// After a recentre every stored coordinate is in the old frame: start over. The space in use
// can be swapped during a session (?space=unbounded), so follow whichever one it is.
function followSpace(refSpace) {
  if (space !== refSpace) {
    space = refSpace;
    space.addEventListener('reset', reset);
  }
}

// Without a room scan the grid stays empty and a route runs straight through the furniture.
// Nothing else tells the wearer, so say it once, a few seconds in.
function warnIfNoRoom(time) {
  started ||= time;
  if (!said.noRoom && time - started > 3000) {
    said.noRoom = true;
    if (!room.counts.meshes && !room.counts.planes) {
      console.error('[scan] no room scan: run Space Setup in this room. Features:', ctx.xr.enabledFeatures);
      if (mode.current === 'field') ctx.bus.emit('voice:say', { text: 'No room scan. Run Space Setup first.', priority: 'normal' });
    }
  }
}

// Lay the depth image over the live layer when a read is due. True when this frame read one.
function readLive(frame) {
  const { xrFrame, refSpace, time } = frame;
  if (!(depthOn && time - lastDepth >= readEveryMs(SCAN.depthMs, readCostMs, SCAN.depthBusy))) return false;
  let read = false;
  try {
    // Where the wearer is and faces, on the floor: decides what is in view (grid.js).
    const head = xrFrame.getViewerPose(refSpace)?.transform.matrix;
    let view = null;
    if (head) {
      view = viewOf(head, SCAN.vantageM);
      view.now = time;
      live.reopen(view);
      // Settled ground in view is looked at again every refreshS, on a clock of its own: what
      // settled longer ago than that is opened, so something put down or taken away on known
      // ground is noticed (grid.js: refresh). This used to wait until nothing else in view was
      // open, and on the headset that moment hardly ever came, because a real depth image always
      // leaves a few cells unsettled: the hub's records show one refresh in a hundred reads, and
      // a chair put down on known floor could then wait a minute. Only when nothing was opened
      // and nothing is open is the read skipped and the frame free.
      if (SCAN.refreshS > 0 && live.refresh(view, time, SCAN.refreshS * 1000)) refreshes++;
      else if (!live.unsettledInView(view)) {
        skips++;
        lastDepth = time;
        waitFrom = 0;
        view = null;
      }
    }
    read = !!view && readDepth(ctx.renderer, frame, live, SCAN);
    if (read) {
      reads++;
      lastDepth = time;
      waitFrom = 0;
      depthSeen = true;
      if (live.commit(view)) dirty = true;
      // What this read took, smoothed over the last few: one slow read (a frame the browser
      // was busy in) does not slow the scan down, a headset on which every read is slow does.
      readCostMs += (depthImage.costMs - readCostMs) * (readCostMs ? 0.25 : 1);
    } else if (!view) {
      // nothing to read this time (all settled), or no head pose yet
    } else if (!waitFrom) {
      waitFrom = time; // no image on this frame (the sensor is slower than the display): try the next
    } else if (time - waitFrom > 5000) {
      lastDepth = time; // none for 5 s: keep trying, but every depthMs and not every frame
      if (!said.noDepth) console.error('[scan] depth-sensing is on but no depth image arrives');
      said.noDepth = true;
    }
  } catch (err) {
    depthOn = false; // the room scan carries on without it; what it had marked stays on the map
    console.error('[scan] live depth switched off:', err);
  }
  return read;
}

// Merge the layers and send the grid when it differs from the last one sent. True when it was sent.
function send(time) {
  dirty = false;
  const { cells: merged, ...counts } = mergeLayers(room.cells, live.cells);
  // The map the hub kept from before: used once this session's scan has found enough of the
  // same obstacles in the same places, and only where this session has seen nothing yet.
  // Both are judged on the window: the part of the stored map that lies under it (storedWin,
  // laid together again whenever the window moves, so ground that comes in later is filled too).
  let kept = 0;
  if (storedWin) {
    if (!trusted && linesUp(storedWin, merged, cols, cols)) {
      trusted = true;
      restDue = toStore = true; // its tiles outside the window belong to this run's map on the hub as well
      // This run is in the coordinates of the stored one: what else was kept in them (the waypoints, hud/) fits too.
      ctx.bus.emit('map:run', { run, trusted: true, storedRun });
      console.info('[scan] the stored map lines up with this room: using it for what is not seen yet');
    }
    if (trusted) {
      kept = fillUnknown(merged, storedWin);
      counts.obstacles = counts.floor = 0;
      for (const cell of merged) {
        if (cell === 1) counts.obstacles++;
        else if (cell === 0) counts.floor++;
      }
    }
  }
  // A live cell can change without changing what is sent (floor seen where the room scan
  // already has floor, flicker on a cell the room scan blocks): nothing to say then.
  if (sent && merged.every((cell, i) => cell === sent[i])) return false;
  sent = merged;
  lastEmit = time;
  toStore = true;
  // archived, windowXZ: how many tiles are kept outside the window and where the window is, for diagnosis.
  // depthPx: the depth image's width, height and the samples per side taken from it (0 until the first read).
  // readMs: the slowest depth read since the last update, [ms waiting for the GPU, ms placing the points] (depth.js).
  // sendMs: how long the update before this one took everything that listens to it (the glow, the palm map).
  const tenth = (ms) => Math.round(ms * 10) / 10;
  stats = { ...room.counts, ...counts, stored: kept, settled: live.settledCount, reads, skips, refreshes, archived: archive.size, windowXZ: [...origin], depthPx: [depthImage.width, depthImage.height, depthImage.samples], reachM: Math.round(depthImage.reachM * 100) / 100, readMs: [tenth(depthImage.gpuMs), tenth(depthImage.pointsMs)], sendMs: tenth(sendMs) };
  depthImage.gpuMs = depthImage.pointsMs = 0;
  const sendFrom = performance.now();
  ctx.bus.emit('hazard:update', {
    originXZ: [...origin],
    cellSizeM: SCAN.cellM,
    cols,
    rows: cols,
    cells: merged,
    ts: Date.now(),
    source: depthSeen ? 'room-scan+depth' : 'room-scan',
    stats,
  });
  sendMs = performance.now() - sendFrom;
  return true;
}

/**
 * How long to wait after a read before the next: `everyMs`, or longer when a read takes so long
 * (`costMs`) that reading that often would take more than the share `busy` of the time.
 */
export function readEveryMs(everyMs, costMs, busy) {
  return Math.max(everyMs, busy > 0 ? costMs / busy : 0);
}
