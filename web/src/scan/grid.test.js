// node --test src/scan/grid.test.js
// The depth -> grid arithmetic, checked against three.js's own camera and ray maths (a separate
// implementation of the same projection), with the numbers the app really uses (SCAN).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SCAN, readEveryMs } from './index.js';
import { createGrid, viewOf, addDepthView, floorReachM, depthBufferToMeters, depthTable, mergeLayers, PASSABLE, OBSTACLE, UNKNOWN } from './grid.js';
import { TILES, moveWindow } from './tiles.js';

// A 16 m grid around the origin: the arithmetic is the same on the scan's larger window.
const SIZE_M = 16;
const COLS = Math.round(SIZE_M / SCAN.cellM);
const ORIGIN = [-SIZE_M / 2, -SIZE_M / 2];
const newGrid = () => createGrid(COLS, COLS, SCAN.cellM, ORIGIN, SCAN);
const cellOf = (x, z) => Math.floor((z - ORIGIN[1]) / SCAN.cellM) * COLS + Math.floor((x - ORIGIN[0]) / SCAN.cellM);

// A chair-sized box, where the mock obstacle stands (mock/hazard.js).
const CHAIR = new THREE.Box3(new THREE.Vector3(0.25, 0, -0.85), new THREE.Vector3(0.75, 0.5, -0.35));
const FLOOR = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// A camera with an off-centre frustum, like one eye of a headset.
function eye() {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
  camera.setViewOffset(1000, 1000, 120, 60, 800, 900);
  camera.position.set(-0.3, 1.6, 1.4);
  camera.lookAt(0.3, 0.2, -0.6);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

// Stands in for the depth sensor: cast a ray through (u, v) and return the distance from the camera plane.
function depthSensor(camera, thing) {
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  return (u, v) => {
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(2 * u - 1, 2 * v - 1, 0.5).unproject(camera).sub(ray.origin).normalize();
    const found = (thing && ray.intersectBox(thing, hit)) || ray.intersectPlane(FLOOR, hit);
    return found ? -hit.applyMatrix4(camera.matrixWorldInverse).z : 0;
  };
}

// One read of the floor with `thing` (a Box3) standing on it, or of the bare floor (null).
function read(grid, camera, thing) {
  addDepthView(grid, depthSensor(camera, thing), camera.projectionMatrix.elements, camera.matrixWorld.elements, SCAN);
  return grid.commit();
}

// The depth image of a Quest 3 eye (tangents left 1.376, right 0.839, up 0.966, down 1.428), at
// standing height, looking at the floor `ahead` metres in front.
function questEye(ahead, eyeM = 1.6) {
  const camera = new THREE.PerspectiveCamera();
  camera.projectionMatrix.makePerspective(-0.1376, 0.0839, 0.0966, -0.1428, 0.1, 100);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.position.set(0, eyeM, 0);
  camera.lookAt(0, 0.3, -ahead);
  camera.updateMatrixWorld();
  return camera;
}

// One read of a single cell with the given numbers of obstacle-height and floor-height points.
function readCell(grid, obstaclePoints, floorPoints) {
  for (let k = 0; k < obstaclePoints; k++) grid.add(0.05, 0.5, 0.05);
  for (let k = 0; k < floorPoints; k++) grid.add(0.05, 0, 0.05);
  grid.commit();
  return grid.cells[cellOf(0.05, 0.05)];
}

test('a chair becomes obstacle cells once it has been seen setScans times; the floor around it is passable', () => {
  const grid = newGrid();
  const camera = eye();
  for (let i = 1; i < SCAN.setScans; i++) {
    assert.equal(read(grid, camera, CHAIR), true); // the floor is already known
    assert.ok(!grid.cells.includes(OBSTACLE), `no obstacle yet after ${i} read(s)`);
  }
  assert.equal(read(grid, camera, CHAIR), true);
  assert.equal(grid.cells[cellOf(0.5, -0.6)], OBSTACLE); // middle of the chair
  assert.equal(grid.cells[cellOf(0.3, -0.4)], OBSTACLE); // just inside its corner
  assert.equal(grid.cells[cellOf(-0.4, -0.6)], PASSABLE); // floor beside it
  assert.equal(grid.cells[cellOf(0.5, 0.1)], PASSABLE); // floor in front of it
  assert.equal(grid.cells[cellOf(-1.9, 1.9)], UNKNOWN); // out of view
  // Obstacle cells do not spill beyond the chair (one cell of margin).
  for (let row = 0; row < COLS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (grid.cells[row * COLS + col] !== OBSTACLE) continue;
      const x = ORIGIN[0] + (col + 0.5) * SCAN.cellM;
      const z = ORIGIN[1] + (row + 0.5) * SCAN.cellM;
      assert.ok(x > 0.15 && x < 0.85 && z > -0.95 && z < -0.25, `obstacle outside the chair at ${x}, ${z}`);
    }
  }
});

test('taking the chair away clears it after clearScans floor-only reads, not before', () => {
  const grid = newGrid();
  const camera = eye();
  for (let i = 0; i < SCAN.setScans; i++) read(grid, camera, CHAIR);
  for (let i = 1; i < SCAN.clearScans; i++) {
    read(grid, camera, null);
    assert.equal(grid.cells[cellOf(0.5, -0.6)], OBSTACLE, `still held after ${i} clear read(s)`);
  }
  assert.equal(read(grid, camera, null), true);
  assert.ok(!grid.cells.includes(OBSTACLE));
  assert.equal(grid.cells[cellOf(0.5, -0.6)], PASSABLE);
  assert.equal(read(grid, camera, null), false); // nothing changed: no new hazard:update
});

test('an obstacle the wearer walks into stays on the map: the cells at their feet are not read, and nothing else clears them', () => {
  const grid = newGrid();
  const far = eye();
  for (let i = 0; i < SCAN.setScans; i++) read(grid, far, CHAIR);
  const marked = () => grid.cells.reduce((n, c) => n + (c === OBSTACLE), 0);
  const cells = marked();
  assert.ok(cells >= 9, `${cells} cells of chair`);
  // The wearer stands where it was marked (a false sighting, or something low they stepped
  // onto) and looks at the bare floor on every side. Until 2026-11-15 standing there freed it.
  for (const [lx, lz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    camera.position.set(0.5, 1.6, -0.6);
    camera.lookAt(0.5 + 2 * lx, 0, -0.6 + 2 * lz);
    camera.updateMatrixWorld();
    for (let i = 0; i < SCAN.clearScans * 2; i++) read(grid, camera, null);
    assert.equal(marked(), cells, `still marked, looking towards ${lx}, ${lz}`);
  }
  // Seen again from outside, with bare floor where it stood, it goes in the usual clearScans reads.
  for (let i = 0; i < SCAN.clearScans; i++) read(grid, far, null);
  assert.equal(marked(), 0);
});

test('a cell that is not seen keeps its state', () => {
  const grid = newGrid();
  for (let i = 0; i < SCAN.setScans; i++) read(grid, eye(), CHAIR);
  const away = eye();
  away.lookAt(-3, 0.2, 3); // turn the back on the chair
  away.updateMatrixWorld();
  for (let i = 0; i < SCAN.clearScans + 2; i++) read(grid, away, null);
  assert.equal(grid.cells[cellOf(0.5, -0.6)], OBSTACLE);
});

test('with a headset eye: a chair near the end of the range is marked and cleared, one beyond it is left alone', () => {
  const chairAt = (z) => new THREE.Box3(new THREE.Vector3(-0.25, 0, -z - 0.25), new THREE.Vector3(0.25, 0.9, -z + 0.25));
  const grid = newGrid();
  const camera = questEye(2.2);
  const within = SCAN.depthRangeM - 0.4;
  for (let i = 0; i < SCAN.setScans; i++) read(grid, camera, chairAt(within));
  assert.equal(grid.cells[cellOf(0.05, -within)], OBSTACLE);
  for (let i = 0; i < SCAN.clearScans; i++) read(grid, camera, null);
  assert.ok(!grid.cells.includes(OBSTACLE), 'cleared by the floor under it');
  // A chair the far limit cuts through is marked only where the floor under it can clear it again.
  for (let i = 0; i < SCAN.setScans; i++) read(grid, camera, chairAt(SCAN.depthRangeM - 0.2));
  const marked = [...grid.cells.keys()].filter((i) => grid.cells[i] === OBSTACLE);
  assert.ok(marked.length > 0);
  for (const i of marked) {
    const x = ORIGIN[0] + ((i % COLS) + 0.5) * SCAN.cellM;
    const z = ORIGIN[1] + (Math.floor(i / COLS) + 0.5) * SCAN.cellM;
    assert.ok(Math.hypot(x, z) <= SCAN.depthRangeM - SCAN.cellM, `marked on the limit at ${x}, ${z}`);
  }
  for (let i = 0; i < SCAN.clearScans; i++) read(grid, camera, null);
  assert.ok(!grid.cells.includes(OBSTACLE), 'and cleared like the rest');
  // Its top is nearer to the eye than the floor under it: marking it there could never be undone.
  for (let i = 0; i <= SCAN.setScans; i++) read(grid, camera, chairAt(SCAN.depthRangeM + 0.5));
  assert.ok(!grid.cells.includes(OBSTACLE), 'out of range for marking, as it is for clearing');
});

// A floor that ends at z = edgeZ: beyond it (toward -z) the ground lies `depth` metres lower.
function ledgeSensor(camera, edgeZ, depth) {
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  const lower = new THREE.Plane(new THREE.Vector3(0, 1, 0), depth);
  return (u, v) => {
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(2 * u - 1, 2 * v - 1, 0.5).unproject(camera).sub(ray.origin).normalize();
    let found = ray.intersectPlane(FLOOR, hit);
    if (found && hit.z < edgeZ) found = ray.intersectPlane(lower, hit); // through where the floor is missing, down to the lower ground
    return found ? -hit.applyMatrix4(camera.matrixWorldInverse).z : 0;
  };
}

test('a drop is marked like an obstacle: from the edge of the floor on, with no unknown strip behind the edge', () => {
  const grid = newGrid();
  const camera = questEye(1.6);
  const sensor = ledgeSensor(camera, -1.5, 1.0); // the floor ends 1.5 m ahead, 1 m down
  for (let k = 0; k < SCAN.setScans; k++) {
    addDepthView(grid, sensor, camera.projectionMatrix.elements, camera.matrixWorld.elements, SCAN);
    grid.commit();
  }
  for (const z of [-1.05, -1.25, -1.4]) assert.equal(grid.cells[cellOf(0.05, z)], PASSABLE, `floor before the edge, z ${z}`);
  // Every cell past the edge, as far as things are marked at all: the ground the sensor sees lies
  // farther out (hidden behind the edge up to there), and the cells between are marked with it.
  for (const z of [-1.65, -1.85, -2.05, -2.2]) assert.equal(grid.cells[cellOf(0.05, z)], OBSTACLE, `past the edge, z ${z}`);
});

test('a low step down is not a drop, and a drop that turns out to be floor is cleared', () => {
  const grid = newGrid();
  const camera = questEye(1.6);
  const step = ledgeSensor(camera, -1.5, 0.2); // 20 cm: under dropMinM
  for (let k = 0; k < SCAN.setScans + 1; k++) {
    addDepthView(grid, step, camera.projectionMatrix.elements, camera.matrixWorld.elements, SCAN);
    grid.commit();
  }
  assert.ok(!grid.cells.includes(OBSTACLE), 'a 20 cm step is not marked');
  // Nor is level ground half a metre lower: it is walked down to.
  const terrace = newGrid();
  const lower = ledgeSensor(camera, -1.5, 0.5);
  for (let k = 0; k < SCAN.setScans + 1; k++) {
    addDepthView(terrace, lower, camera.projectionMatrix.elements, camera.matrixWorld.elements, SCAN);
    terrace.commit();
  }
  assert.ok(!terrace.cells.includes(OBSTACLE), 'ground 0.5 m lower is not marked');

  const pit = ledgeSensor(camera, -1.5, 1.0);
  for (let k = 0; k < SCAN.setScans; k++) {
    addDepthView(grid, pit, camera.projectionMatrix.elements, camera.matrixWorld.elements, SCAN);
    grid.commit();
  }
  assert.equal(grid.cells[cellOf(0.05, -1.85)], OBSTACLE);
  for (let k = 0; k < SCAN.clearScans; k++) read(grid, camera, null); // the floor is there after all (a cover put over the pit, or a bad read)
  assert.equal(grid.cells[cellOf(0.05, -1.85)], PASSABLE);
});

test('a chair near the end of the range is marked and cleared however the head is tilted; with fewer samples the scan does not reach that far', () => {
  const chairAt = (z) => new THREE.Box3(new THREE.Vector3(-0.25, 0, -z - 0.25), new THREE.Vector3(0.25, 0.9, -z + 0.25));
  const far = SCAN.depthRangeM - 0.4;
  // Marked after setScans reads of the chair, then cleared by clearScans reads of the floor it stood on.
  const setAndCleared = (cfg, camera) => {
    const grid = createGrid(COLS, COLS, SCAN.cellM, ORIGIN, cfg);
    const look = (thing) => {
      addDepthView(grid, depthSensor(camera, thing), camera.projectionMatrix.elements, camera.matrixWorld.elements, cfg);
      grid.commit();
    };
    for (let i = 0; i < cfg.setScans; i++) look(chairAt(far));
    const marked = grid.cells.includes(OBSTACLE);
    for (let i = 0; i < cfg.clearScans; i++) look(null);
    return marked && !grid.cells.includes(OBSTACLE);
  };
  // Looking at the floor at one's feet, well ahead, and at the chair itself.
  for (const ahead of [1.5, 3, far]) assert.ok(setAndCleared(SCAN, questEye(ahead)), `looking ${ahead} m ahead`);
  // Why the sample count goes up with the range: at this distance too few of 192 x 192 points
  // land in a floor cell for it to say "floor", so a chair marked there would stay on the map
  // after it is gone. The read therefore ends where the floor still answers (floorReachM), and
  // with 192 samples that is well short of this chair: it is not marked at all.
  const coarse = { ...SCAN, depthSamples: 192 };
  const grid = createGrid(COLS, COLS, SCAN.cellM, ORIGIN, coarse);
  const camera = questEye(3);
  let reach = 0;
  const look = (thing) => {
    reach = addDepthView(grid, depthSensor(camera, thing), camera.projectionMatrix.elements, camera.matrixWorld.elements, coarse);
    grid.commit();
  };
  for (let i = 0; i < SCAN.farSetScans; i++) look(chairAt(far));
  assert.ok(reach < SCAN.depthRangeM - 1, `192 samples reach ${reach} m`);
  assert.ok(!grid.cells.includes(OBSTACLE), 'left alone: its floor could not clear it');
  for (let i = 0; i < SCAN.farSetScans; i++) look(chairAt(reach - 0.4));
  assert.ok(grid.cells.includes(OBSTACLE), 'a chair near the end of the shorter reach is marked');
  for (let i = 0; i < SCAN.clearScans; i++) look(null);
  assert.ok(!grid.cells.includes(OBSTACLE), 'and cleared');
});

test('commit looks only at the cells a read can change, and the map comes out as when it looked at all of them', () => {
  // Two grids fed the same: one commits the short way, the other every cell every time (as
  // before 2026-11-15). A wearer wanders, reads land around them and elsewhere, the window
  // shifts, tiles are laid back.
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (const extra of [{}, { settleScans: 6 }, { giveUpScans: 3, settleScans: 2, resettleScans: 1 }]) {
    const cfg = { ...SCAN, ...extra };
    const short = createGrid(COLS, COLS, SCAN.cellM, ORIGIN, cfg);
    const long = createGrid(COLS, COLS, SCAN.cellM, ORIGIN, { ...cfg, commitAll: true });
    const both = (f) => [f(short), f(long)];
    let origin = [...ORIGIN];
    let [hx, hz] = [0, 0];
    let now = 0;
    // Places where a thing comes and goes: the same cells are seen again and again, so it
    // matters whether two sightings came in a row or with a read between them.
    const spots = Array.from({ length: 12 }, () => [(rnd() - 0.5) * 9, (rnd() - 0.5) * 9]);
    for (let step = 0; step < 400; step++) {
      now += SCAN.depthMs;
      hx = Math.max(-6, Math.min(6, hx + (rnd() - 0.5) * 1.2));
      hz = Math.max(-6, Math.min(6, hz + (rnd() - 0.5) * 1.2));
      const view = step % 7 === 3 ? null : { ...headAt(hx, hz), now };
      if (view) {
        both((g) => g.reopen(view));
        if (step % 5 === 0) assert.deepEqual(...both((g) => g.refresh(view, now, 400)), `refresh, step ${step}`);
        assert.deepEqual(...both((g) => g.unsettledInView(view)), `unsettled in view, step ${step}`);
      }
      // A few clumps of points: things, floor, and stray single points, near the wearer and anywhere.
      const clumps = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < clumps; k++) {
        const near = rnd() < 0.8;
        const x = near ? hx + (rnd() - 0.5) * 6 : (rnd() - 0.5) * 15;
        const z = near ? hz + (rnd() - 0.5) * 6 : (rnd() - 0.5) * 15;
        const y = [0.5, 0.5, 0, 0, 0, 0.2, -0.6][Math.floor(rnd() * 7)];
        const points = Math.floor(rnd() * 8); // sometimes fewer than minPoints
        for (let q = 0; q < points; q++) {
          const px = x + (rnd() < 0.5 ? 0 : 0.11); // one point, the same for both grids
          both((g) => g.add(px, y, z));
        }
      }
      for (const [x, z] of spots) {
        const roll = rnd();
        if (roll < 0.35) for (let q = 0; q < 4; q++) both((g) => g.add(x, 0.5, z));
        else if (roll < 0.5) for (let q = 0; q < 4; q++) both((g) => g.add(x, 0, z));
      }
      assert.deepEqual(...both((g) => g.commit(view)), `what commit says changed, step ${step}`);
      if (step % 9 === 4) {
        // The window moves by a few cells (kept near where it started, so the wearer stays on it).
        const d = [0, 1].map((k) => (Math.abs(origin[k] - ORIGIN[k]) > 1.5 ? Math.sign(origin[k] - ORIGIN[k]) * -8 : Math.floor(rnd() * 3 - 1) * 8));
        origin = [origin[0] + d[0] * SCAN.cellM, origin[1] + d[1] * SCAN.cellM];
        both((g) => g.shift(d[0], d[1], origin));
      }
      if (step % 13 === 6) {
        const tile = Uint8Array.from({ length: 16 * 16 }, () => [PASSABLE, OBSTACLE, UNKNOWN][Math.floor(rnd() * 3)]);
        const at = [Math.floor(rnd() * (COLS - 16)), Math.floor(rnd() * (COLS - 16))];
        both((g) => g.restore(at[0], at[1], 16, tile));
      }
      assert.deepEqual(short.cells, long.cells, `cells, step ${step}`);
      assert.equal(short.settledCount, long.settledCount, `settled, step ${step}`);
    }
    assert.ok(short.cells.includes(OBSTACLE) && short.cells.includes(PASSABLE), 'the walk marked things and floor');
  }
});

test('with dropMinM 0 ground below the floor says nothing, as before', () => {
  const cfg = { ...SCAN, dropMinM: 0 };
  const grid = createGrid(COLS, COLS, SCAN.cellM, ORIGIN, cfg);
  const camera = questEye(1.6);
  const sensor = ledgeSensor(camera, -1.5, 0.6);
  for (let k = 0; k < SCAN.setScans + 1; k++) {
    addDepthView(grid, sensor, camera.projectionMatrix.elements, camera.matrixWorld.elements, cfg);
    grid.commit();
  }
  assert.ok(!grid.cells.includes(OBSTACLE));
});

test('something seen once and then gone (a passer-by, stray depth) never becomes an obstacle', () => {
  const grid = newGrid();
  const many = SCAN.minPoints * 3;
  for (let round = 0; round < 5; round++) {
    for (let i = 1; i < SCAN.setScans; i++) assert.notEqual(readCell(grid, many, 0), OBSTACLE);
    assert.equal(readCell(grid, 0, many), PASSABLE);
  }
});

test('sightings have to come in a row: two that are a read apart do not add up', () => {
  const grid = newGrid();
  const many = SCAN.minPoints * 3;
  for (let round = 0; round < 5; round++) {
    for (let i = 1; i < SCAN.setScans; i++) assert.notEqual(readCell(grid, many, 0), OBSTACLE);
    assert.notEqual(readCell(grid, 0, 0), OBSTACLE); // a read that does not see it: out of view, or nothing there
  }
  for (let i = 1; i < SCAN.setScans; i++) assert.notEqual(readCell(grid, many, 0), OBSTACLE);
  assert.equal(readCell(grid, many, 0), OBSTACLE);
});

test('a floor point lifted by depth error is not a thing: only points above thingMinM are', () => {
  const grid = newGrid();
  const many = SCAN.minPoints * 3;
  const cell = () => grid.cells[cellOf(0.05, 0.05)];
  const readAt = (y) => {
    for (let k = 0; k < many; k++) grid.add(0.05, y, 0.05);
    grid.commit();
  };
  // 4 % depth error at a 1.7 m eye lifts a floor point by 7 cm; with the floor 5 cm high that is 12 cm.
  for (let i = 0; i < SCAN.setScans + 2; i++) readAt(0.12);
  assert.equal(cell(), PASSABLE);
  for (let i = 0; i < SCAN.setScans + 2; i++) readAt(SCAN.thingMinM - 0.03); // neither floor nor thing
  assert.equal(cell(), PASSABLE);
  for (let i = 0; i < SCAN.setScans; i++) readAt(SCAN.thingMinM + 0.05);
  assert.equal(cell(), OBSTACLE);
});

test('level ground a step above or below the floor is ground, not a thing and not a drop', () => {
  // A platform, the next room a step lower, a floor the headset places 20 cm off: read with the
  // 7 cm a depth point can be out, in either direction.
  const many = SCAN.minPoints * 3;
  for (const level of [0.2, -0.2]) {
    for (const off of [-0.07, 0, 0.07]) {
      const grid = newGrid();
      for (let i = 0; i < SCAN.setScans + 2; i++) {
        for (let k = 0; k < many; k++) grid.add(0.05, level + off, 0.05);
        grid.commit();
      }
      assert.equal(grid.cells[cellOf(0.05, 0.05)], PASSABLE, `ground at ${level} m read as ${(level + off).toFixed(2)} m`);
    }
  }
  // Downwards further: level ground half a metre lower is walked down to.
  for (const y of [-0.3, -0.4, -0.5, -0.57]) {
    const grid = newGrid();
    for (let i = 0; i < SCAN.setScans + 2; i++) {
      for (let k = 0; k < many; k++) grid.add(0.05, y, 0.05);
      grid.commit();
    }
    assert.equal(grid.cells[cellOf(0.05, 0.05)], PASSABLE, `ground ${y} m`);
  }
  // What stands on such ground is still in the way: a seat 0.45 m above the floor, a pit 0.8 m deep.
  for (const y of [0.45, -0.8]) {
    const grid = newGrid();
    for (let i = 0; i < SCAN.setScans + 2; i++) {
      for (let k = 0; k < many; k++) grid.add(0.05, y, 0.05);
      grid.commit();
    }
    assert.equal(grid.cells[cellOf(0.05, 0.05)], OBSTACLE, `${y} m`);
  }
});

test('an unclear read changes nothing: too few points, or floor with a little of something else', () => {
  const grid = newGrid();
  const many = SCAN.minPoints * 3;
  for (let i = 0; i < SCAN.setScans; i++) readCell(grid, many, 0);
  // The edge of a chair or a thin leg: mostly floor, a point or two of obstacle. Not cleared.
  for (let i = 0; i < SCAN.clearScans + 2; i++) assert.equal(readCell(grid, 1, many), OBSTACLE);
  for (let i = 0; i < SCAN.clearScans + 2; i++) assert.equal(readCell(grid, 0, SCAN.minPoints - 1), OBSTACLE);
  // And it does not count against the clearing either: clearScans clean reads still clear it.
  for (let i = 1; i < SCAN.clearScans; i++) assert.equal(readCell(grid, 0, many), OBSTACLE);
  assert.equal(readCell(grid, 0, many), PASSABLE);
});

test('an obstacle out of sight stays on the map, until clear floor is seen where it stood', () => {
  assert.equal(SCAN.forgetScans, 0); // the default: nothing is forgotten
  const grid = newGrid();
  const many = SCAN.minPoints * 3;
  for (let i = 0; i < SCAN.setScans; i++) readCell(grid, many, 0);
  for (let i = 0; i < 600; i++) assert.equal(readCell(grid, 0, 0), OBSTACLE, `still there after ${i} reads out of sight`); // 5 minutes
  for (let i = 1; i < SCAN.clearScans; i++) assert.equal(readCell(grid, 0, many), OBSTACLE);
  assert.equal(readCell(grid, 0, many), PASSABLE);
});

test('with forgetScans set, an obstacle that stays out of sight that long is forgotten; one in sight is kept', () => {
  const cfg = { ...SCAN, forgetScans: 40 };
  const grid = createGrid(COLS, COLS, SCAN.cellM, ORIGIN, cfg);
  const many = SCAN.minPoints * 3;
  for (let i = 0; i < SCAN.setScans; i++) readCell(grid, many, 0);
  for (let i = 1; i < cfg.forgetScans; i++) assert.equal(readCell(grid, 0, 0), OBSTACLE, `still there after ${i} reads out of sight`);
  assert.equal(readCell(grid, 0, 0), UNKNOWN); // whoever stood there may have walked away
  // It has to be seen setScans times again before it counts.
  for (let i = 1; i < SCAN.setScans; i++) assert.equal(readCell(grid, many, 0), UNKNOWN);
  assert.equal(readCell(grid, many, 0), OBSTACLE);
  for (let i = 0; i < cfg.forgetScans * 2; i++) assert.equal(readCell(grid, many, 0), OBSTACLE); // in sight: kept
});

test('live depth adds to the room scan and never removes structure from it', () => {
  const [O, P, U] = [OBSTACLE, PASSABLE, UNKNOWN];
  // every pairing of what the room scan says with what live depth says
  const room = Uint8Array.from([O, O, O, P, P, P, U, U, U]);
  const live = Uint8Array.from([O, P, U, O, P, U, O, P, U]);
  const merged = mergeLayers(room, live);
  assert.deepEqual([...merged.cells], [O, O, O, O, P, P, O, P, U]);
  assert.deepEqual([merged.obstacles, merged.floor, merged.depth], [5, 3, 3]);
  assert.deepEqual([...room], [O, O, O, P, P, P, U, U, U]); // the room scan itself is left as it was
});

test("the wearer's own hands and invalid depth are ignored", () => {
  const grid = newGrid();
  const camera = eye();
  // 0.3 m: a hand held up in front of the face
  for (const d of [0.3, 0, -1, NaN, Infinity]) {
    for (let i = 0; i < SCAN.setScans; i++) {
      addDepthView(grid, () => d, camera.projectionMatrix.elements, camera.matrixWorld.elements, SCAN);
      assert.equal(grid.commit(), false, `depth ${d}`);
    }
  }
  assert.ok(grid.cells.every((c) => c === UNKNOWN));
});

test('the table of depths holds what the conversion gives for each of the 65,536 two-byte values', () => {
  for (const [near, far] of [[0.1, Infinity], [0.1, 50], [0.2, 0]]) {
    const table = depthTable(near, far);
    assert.equal(table.length, 65536);
    for (let code = 0; code < 65536; code += 7) {
      const exact = depthBufferToMeters(((code >> 8) + (code & 255) / 255) / 255, near, far);
      assert.equal(table[code], Math.fround(exact), `bytes ${code >> 8}, ${code & 255}`);
    }
    assert.equal(table[0], 0, 'no data');
    assert.equal(table[65535], 0, 'nothing there');
  }
  // as depth.js reads it: the two bytes of a sample, high first
  const table = depthTable(0.1, Infinity);
  const b = 1 - 0.1 / 3.2; // the depth-buffer value of a point 3.2 m away
  const high = Math.floor(b * 255);
  const low = Math.round((b * 255 - high) * 255);
  assert.ok(Math.abs(table[(high << 8) | low] - 3.2) < 0.01);
});

test('depth-buffer values convert to metres like the projection that wrote them', () => {
  const camera = new THREE.PerspectiveCamera(70, 1.2, 0.1, 50);
  for (const z of [0.3, 1, 2.5, 3.5]) {
    const b = (new THREE.Vector3(0, 0, -z).applyMatrix4(camera.projectionMatrix).z + 1) / 2;
    assert.ok(Math.abs(depthBufferToMeters(b, 0.1, 50) - z) < 1e-4, `finite far, ${z} m`);
    // Split into two bytes the way the shader in depth.js does, and back: within a centimetre.
    const hi = Math.floor(b * 255);
    const lo = Math.round((b * 255 - hi) * 255);
    assert.ok(Math.abs(depthBufferToMeters((hi + lo / 255) / 255, 0.1, 50) - z) < 0.01, `two bytes, ${z} m`);
    assert.ok(Math.abs(depthBufferToMeters(1 - 0.1 / z, 0.1, Infinity) - z) < 1e-9, `infinite far, ${z} m`);
  }
  // No far plane, however the browser says it: Infinity, 0, or nothing at all.
  for (const far of [Infinity, 0, undefined]) assert.ok(Math.abs(depthBufferToMeters(0.95, 0.1, far) - 2) < 1e-9, `far ${far}`);
  // No data (0, also what a texture that was not bound reads as), nothing there (1), nonsense.
  for (const b of [0, 1, 1.5, -0.2, NaN]) {
    assert.equal(depthBufferToMeters(b, 0.1, 50), 0);
    assert.equal(depthBufferToMeters(b, 0.1, Infinity), 0);
  }
});

// ---- settling: what has been read often enough is left alone ----
// Off by default (SCAN.settleScans 0; ?settle=1 turns it on with 6 reads): these tests run it
// as it is when on.
const SETTLE = { ...SCAN, settleScans: 6 };
const settlingGrid = () => createGrid(COLS, COLS, SCAN.cellM, ORIGIN, SETTLE);

// A head at (x, z), eyes level, facing -z (the default) or the direction given.
function headAt(x, z, lookX = 0, lookZ = -1, lookY = 0) {
  const o = new THREE.Object3D();
  o.position.set(x, 1.6, z);
  o.lookAt(x - lookX, 1.6 - lookY, z - lookZ); // an Object3D's -z points away from its lookAt target
  o.updateMatrixWorld();
  return viewOf(o.matrixWorld.elements, SCAN.vantageM);
}
// One read of the cell at (x, z) as seen from `view`.
function readAt(grid, view, x, z, obstaclePoints, floorPoints) {
  grid.reopen(view);
  for (let k = 0; k < obstaclePoints; k++) grid.add(x, 0.5, z);
  for (let k = 0; k < floorPoints; k++) grid.add(x, 0, z);
  grid.commit(view);
  return grid.cells[cellOf(x, z)];
}

test('viewOf: where the head is and faces; sig changes with a step, a turn or a tilt', () => {
  const v = headAt(1, 2);
  assert.deepEqual([v.x, v.z], [1, 2]);
  assert.ok(Math.abs(v.dirX) < 1e-6 && Math.abs(v.dirZ + 1) < 1e-6, 'faces -z');
  assert.equal(headAt(1.1, 2.1).sig, v.sig, 'a small step is the same view');
  assert.notEqual(headAt(2.2, 2).sig, v.sig);
  assert.notEqual(headAt(1, 2, 1, 0).sig, v.sig, 'turned 90 degrees');
  assert.notEqual(headAt(1, 2, 0, -1, -0.8).sig, v.sig, 'looking down');
  const down = headAt(0, 0, 0, -0.01, -1);
  assert.deepEqual([down.dirX, down.dirZ], [0, 0], 'straight down: no facing direction');
});

test('a cell read settleScans times with the same answer is settled: later points are ignored', () => {
  const grid = settlingGrid();
  const many = SCAN.minPoints * 3;
  const view = headAt(0, 0);
  const [x, z] = [0.05, -1.55];
  for (let i = 0; i < SCAN.setScans; i++) readAt(grid, view, x, z, many, 0);
  assert.equal(grid.settledCount, 0);
  for (let i = 0; i < SETTLE.settleScans; i++) assert.equal(readAt(grid, view, x, z, many, 0), OBSTACLE);
  assert.equal(grid.settledCount, 1);
  // The chair is carried off while the wearer stays near: the settled cell does not look again.
  for (let i = 0; i < SCAN.clearScans * 3; i++) assert.equal(readAt(grid, view, x, z, 0, many), OBSTACLE);
});

test('a settled cell is read again after the wearer has been leaveM away and come back', () => {
  const grid = settlingGrid();
  const many = SCAN.minPoints * 3;
  const near = headAt(0, 0);
  const [x, z] = [0.05, -1.55];
  for (let i = 0; i < SCAN.setScans + SETTLE.settleScans; i++) readAt(grid, near, x, z, many, 0);
  assert.equal(grid.settledCount, 1);
  grid.reopen(headAt(0, 2)); // 3.5 m from the cell: not far enough
  grid.reopen(near);
  assert.equal(grid.settledCount, 1);
  grid.reopen(headAt(0, SCAN.leaveM)); // more than leaveM from the cell
  assert.equal(grid.settledCount, 1, 'still settled while away');
  assert.equal(grid.reopen(near), 1);
  assert.equal(grid.settledCount, 0);
  // Now the missing chair is noticed.
  for (let i = 1; i < SCAN.clearScans; i++) assert.equal(readAt(grid, near, x, z, 0, many), OBSTACLE);
  assert.equal(readAt(grid, near, x, z, 0, many), PASSABLE);
});

test('a cell still changing does not settle', () => {
  const grid = settlingGrid();
  const many = SCAN.minPoints * 3;
  const view = headAt(0, 0);
  const [x, z] = [0.05, -1.55];
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < SETTLE.settleScans - 1; i++) readAt(grid, view, x, z, 0, many);
    for (let i = 0; i < SCAN.setScans; i++) readAt(grid, view, x, z, many, 0);
    assert.equal(grid.cells[cellOf(x, z)], OBSTACLE, `round ${round}: the cell still follows what is seen`);
  }
  // Still open: the floor is seen again and the obstacle clears.
  for (let i = 0; i < SCAN.clearScans; i++) readAt(grid, view, x, z, 0, many);
  assert.equal(grid.cells[cellOf(x, z)], PASSABLE);
});

test('nothing left to read in view: unsettledInView turns false, and true again for a new view', () => {
  const grid = settlingGrid();
  const view = headAt(0, 0);
  assert.equal(grid.unsettledInView(view), true); // nothing has been read yet
  // Reads that never give an answer anywhere (a blank wall beyond range, the ceiling).
  for (let i = 0; i < SCAN.giveUpScans; i++) {
    grid.reopen(view);
    grid.commit(view);
  }
  assert.equal(grid.unsettledInView(view), false, 'everything in view was given up on');
  assert.ok(grid.settledCount > 100);
  // Turn around: other cells, still open.
  const back = headAt(0, 0, 0, 1);
  assert.equal(grid.unsettledInView(back), true);
  // Same place, same heading, looking down now: the given-up cells are tried again.
  const down = headAt(0, 0, 0, -1, -0.9);
  assert.ok(grid.reopen(down) > 100);
  assert.equal(grid.unsettledInView(down), true);
});

test('with settleScans 0, the default, nothing ever settles', () => {
  assert.equal(SCAN.settleScans, 0);
  const grid = newGrid();
  const view = headAt(0, 0);
  for (let i = 0; i < 40; i++) readAt(grid, view, 0.05, -1.55, SCAN.minPoints * 3, 0);
  assert.equal(grid.settledCount, 0);
  assert.equal(grid.unsettledInView(view), true);
});

// ---- the window moves: shift and restore (tiles.js) ----

const T = TILES.cells;
const WIN = T * TILES.window;
const TILE_M = T * SCAN.cellM;
// The scan's window as it starts: two tiles either side of the room origin.
const windowGrid = (cfg = SCAN) => createGrid(WIN, WIN, SCAN.cellM, [-2 * TILE_M, -2 * TILE_M], cfg);
// The cell of a window grid that holds the room position (x, z), wherever the window is now.
const at = (grid, x, z) => grid.cells[Math.floor((z - grid.originXZ[1]) / SCAN.cellM) * WIN + Math.floor((x - grid.originXZ[0]) / SCAN.cellM)];
// One read of the cell at (x, z) with the wearer at `view`, on a window grid. The read is
// folded in without the view, so the cells around it are not given up on along the way: these
// tests count settled cells.
function look(grid, view, x, z, obstaclePoints, floorPoints) {
  grid.reopen(view);
  for (let k = 0; k < obstaclePoints; k++) grid.add(x, 0.5, z);
  for (let k = 0; k < floorPoints; k++) grid.add(x, 0, z);
  grid.commit();
  return at(grid, x, z);
}
// Move a window grid from tile `from` to tile `to` the way the scan does, with the archive.
function move(grid, from, to, archive) {
  return moveWindow({ live: grid.cells }, from, to, archive, {
    live: {
      shift: (dCols, dRows) => grid.shift(dCols, dRows, [to[0] * TILE_M, to[1] * TILE_M]),
      paste: (col, row, tile) => grid.restore(col, row, T, tile),
    },
  });
}

test('shift: a cell that stays in the window keeps its state and what was counted for it', () => {
  const grid = windowGrid(SETTLE);
  const many = SCAN.minPoints * 3;
  const view = headAt(0, 0);
  const [x, z] = [0.05, -1.55]; // a thing being confirmed: seen once less than it takes
  const [fx, fz] = [1.05, -1.55]; // floor, read once less than it takes to settle
  const [sx, sz] = [-1.05, -1.55]; // an obstacle that has settled
  for (let i = 0; i < SCAN.setScans + SETTLE.settleScans; i++) look(grid, view, sx, sz, many, 0);
  for (let i = 0; i < SETTLE.settleScans; i++) look(grid, view, fx, fz, 0, many); // the first read makes it floor, the others confirm it
  for (let i = 1; i < SCAN.setScans; i++) assert.notEqual(look(grid, view, x, z, many, 0), OBSTACLE); // last: sightings count in a row
  assert.equal(grid.settledCount, 1);

  grid.shift(T, 0, [-TILE_M, -2 * TILE_M]); // the window moves one tile in +x
  assert.deepEqual(grid.originXZ, [-TILE_M, -2 * TILE_M]);
  assert.equal(at(grid, sx, sz), OBSTACLE, 'the same room position still holds the obstacle');
  assert.equal(at(grid, fx, fz), PASSABLE);
  assert.equal(grid.settledCount, 1, 'what was settled is still settled');
  // The sighting from before the move still counts: one more makes it an obstacle.
  assert.equal(look(grid, view, x, z, many, 0), OBSTACLE);
  // So does the count towards settling: one more read of the floor settles it.
  look(grid, view, fx, fz, 0, many);
  assert.equal(grid.settledCount, 2);
  // And the settled obstacle does not look again, as before the move.
  for (let i = 0; i < SCAN.clearScans * 2; i++) assert.equal(look(grid, view, sx, sz, 0, many), OBSTACLE);
});

test('shift: ground that comes in is unknown and open; a settled cell that leaves is no longer counted', () => {
  const grid = windowGrid(SETTLE);
  const many = SCAN.minPoints * 3;
  const far = [-2 * TILE_M + 1.05, 0.05]; // in the column of tiles that leaves
  const view = headAt(far[0], far[1] + 1.5);
  for (let i = 0; i < SCAN.setScans + SETTLE.settleScans; i++) look(grid, view, far[0], far[1], many, 0);
  assert.equal(grid.settledCount, 1);
  grid.shift(T, 0, [-TILE_M, -2 * TILE_M]);
  assert.equal(grid.settledCount, 0);
  assert.ok(!grid.cells.includes(OBSTACLE), 'it left with its tile');
  // The same cell of the array now stands for ground a tile further on: nothing is known there,
  // and it takes the usual number of sightings to mark it.
  const fresh = [far[0] + WIN * SCAN.cellM, far[1]];
  assert.equal(at(grid, fresh[0], fresh[1]), UNKNOWN);
  const there = headAt(fresh[0], fresh[1] + 1.5);
  for (let i = 1; i < SCAN.setScans; i++) assert.notEqual(look(grid, there, fresh[0], fresh[1], many, 0), OBSTACLE);
  assert.equal(look(grid, there, fresh[0], fresh[1], many, 0), OBSTACLE);
});

test('a known cell that comes back into the window is settled and left alone until the wearer is back at it', () => {
  const grid = windowGrid();
  const archive = new Map();
  const many = SCAN.minPoints * 3;
  const chair = [-10.05, 0.05]; // in tile -2, the first column of the window
  const floor = [-10.55, 0.05];
  const beside = headAt(-10.05, 1.55); // 1.5 m from both
  for (let i = 0; i < SCAN.setScans; i++) look(grid, beside, chair[0], chair[1], many, 0);
  look(grid, beside, floor[0], floor[1], 0, many);
  assert.equal(at(grid, chair[0], chair[1]), OBSTACLE);
  assert.equal(grid.settledCount, 0, 'seen, but not often enough to be settled');

  // The wearer walks a tile on: the window follows and the chair's tile goes to the archive.
  move(grid, [-2, -2], [-1, -2], archive);
  assert.ok(!grid.cells.includes(OBSTACLE));
  assert.equal(archive.get('-2,0').live.filter((v) => v === OBSTACLE).length, 1);
  // And back by a tile: the window takes the tile in again, far from the wearer.
  move(grid, [-1, -2], [-2, -2], archive);
  assert.equal(at(grid, chair[0], chair[1]), OBSTACLE);
  assert.equal(at(grid, floor[0], floor[1]), PASSABLE);
  assert.equal(grid.settledCount, 2, 'both known cells came back settled; the unknown ones are open');

  // From 10 m away nothing is read into them, whatever the sensor says.
  const distant = headAt(0, 0);
  for (let i = 0; i < SCAN.clearScans * 2; i++) assert.equal(look(grid, distant, chair[0], chair[1], 0, many), OBSTACLE);
  assert.equal(grid.settledCount, 2);
  // Back within depth range they are opened, like any cell the wearer returns to.
  assert.equal(grid.reopen(beside), 2);
  assert.equal(grid.settledCount, 0);
  // The chair is gone by now: it takes the usual clearScans reads of bare floor to say so.
  for (let i = 1; i < SCAN.clearScans; i++) assert.equal(look(grid, beside, chair[0], chair[1], 0, many), OBSTACLE, `still held after ${i} clear read(s)`);
  assert.equal(look(grid, beside, chair[0], chair[1], 0, many), PASSABLE);
});

// ---- the chair problem: something put down on, or taken off, ground that was already settled ----

// Reads of one cell, as far apart as the app reads (SCAN.depthMs), until `until(state)` holds or
// `limit` reads have passed.
// The caller stands still; the app's read loop is played here: reopen, refresh when nothing is
// open in view, read, commit. Returns the seconds it took, or null.
function watch(grid, view, x, z, obstaclePoints, floorPoints, until, clock, limit = 40) {
  for (let k = 1; k <= limit; k++) {
    clock.ms += SCAN.depthMs;
    view.now = clock.ms;
    grid.reopen(view);
    if (!grid.refresh(view, clock.ms, SCAN.refreshS * 1000) && !grid.unsettledInView(view)) continue; // a skipped read (the app's loop: scan/index.js readLive)
    for (let p = 0; p < obstaclePoints; p++) grid.add(x, 0.5, z);
    for (let p = 0; p < floorPoints; p++) grid.add(x, 0, z);
    grid.commit(view);
    if (until(grid.cells[cellOf(x, z)])) return (k * SCAN.depthMs) / 1000;
  }
  return null;
}

test('with settling on: a chair put down on settled floor is marked within a second and a half, and cleared within two when it is taken away', () => {
  const grid = settlingGrid();
  const many = SCAN.minPoints * 3;
  const view = headAt(0, 0);
  const clock = { ms: 0 };
  const [x, z] = [0.05, -1.55];
  // Empty floor in view until everything in view has settled (the rest of the view gives no answer and is given up).
  watch(grid, view, x, z, 0, many, () => false, clock, 40);
  assert.equal(grid.cells[cellOf(x, z)], PASSABLE);
  assert.equal(grid.unsettledInView(view), false, 'all of the view is settled');
  // A chair is put down.
  const marked = watch(grid, view, x, z, many, 0, (cell) => cell === OBSTACLE, clock);
  assert.ok(marked !== null && marked <= 1.5, `marked after ${marked} s`); // it was up to 2.1 s with a read every 350 ms and a look every 1.5 s
  // It stands there until that has settled too, then it is taken away.
  watch(grid, view, x, z, many, 0, () => false, clock, 30);
  assert.equal(grid.cells[cellOf(x, z)], OBSTACLE);
  const cleared = watch(grid, view, x, z, 0, many, (cell) => cell === PASSABLE, clock);
  assert.ok(cleared !== null && cleared <= 2, `cleared after ${cleared} s`); // it was up to 2.45 s
});

test('with settling on: a chair on settled floor is marked as quickly when something else in view never settles (a real depth image)', () => {
  // On the headset a few cells always flicker, so "nothing in view is open" hardly ever holds.
  // Settled ground must be looked at again all the same, on its own clock.
  const grid = settlingGrid();
  const many = SCAN.minPoints * 3;
  const view = headAt(0, 0);
  const [x, z] = [0.05, -1.55];
  const flicker = [0.65, -2.05]; // a cell that says "thing" and "floor" in turn: it never settles
  let ms = 0;
  let k = 0; // reads made: the flickering cell is a thing in one whole read and floor in the next
  // The app's loop (scan/index.js readLive). Returns the seconds until `until` holds, or null.
  const watchNoisy = (obstaclePoints, floorPoints, until, limit) => {
    for (let n = 1; n <= limit; n++) {
      ms += SCAN.depthMs;
      view.now = ms;
      grid.reopen(view);
      if (!grid.refresh(view, ms, SCAN.refreshS * 1000) && !grid.unsettledInView(view)) continue;
      k++;
      for (let p = 0; p < many; p++) grid.add(flicker[0], k % 2 ? 0.5 : 0, flicker[1]);
      for (let p = 0; p < obstaclePoints; p++) grid.add(x, 0.5, z);
      for (let p = 0; p < floorPoints; p++) grid.add(x, 0, z);
      grid.commit(view);
      if (until(grid.cells[cellOf(x, z)])) return (n * SCAN.depthMs) / 1000;
    }
    return null;
  };
  let skipped = 0;
  for (let round = 0; round < 60; round++) {
    const before = k;
    watchNoisy(0, many, () => false, 1);
    if (k === before) skipped++;
  }
  assert.equal(grid.cells[cellOf(x, z)], PASSABLE);
  assert.equal(grid.cells[cellOf(flicker[0], flicker[1])], PASSABLE, 'the flickering cell never gets its two sightings in a row');
  assert.equal(grid.unsettledInView(view), true, 'it is still open');
  assert.equal(skipped, 0, 'so no read was skipped in 60');
  const marked = watchNoisy(many, 0, (cell) => cell === OBSTACLE, 60);
  assert.ok(marked !== null && marked <= 1.5, `marked after ${marked} s`);
  watchNoisy(many, 0, () => false, 40);
  const cleared = watchNoisy(0, many, (cell) => cell === PASSABLE, 60);
  assert.ok(cleared !== null && cleared <= 2, `cleared after ${cleared} s`);
});

test('ground that stays as it is costs only a few reads each time it is looked at again', () => {
  const grid = settlingGrid();
  const many = SCAN.minPoints * 3;
  const view = headAt(0, 0);
  const [x, z] = [0.05, -1.55];
  let reads = 0;
  let ms = 0;
  for (let k = 0; k < 120; k++) { // 24 s of standing still in front of bare floor
    ms += SCAN.depthMs;
    view.now = ms;
    grid.reopen(view);
    if (!grid.refresh(view, ms, SCAN.refreshS * 1000) && !grid.unsettledInView(view)) continue;
    for (let p = 0; p < many; p++) grid.add(x, 0, z);
    grid.commit(view);
    if (k >= 60) reads++; // the second half: everything has settled once by then
  }
  assert.ok(reads >= 15 && reads <= 45, `${reads} of 60 possible reads in the second half: looking again, at a lower rate`);
});

test('with refreshS 0 settled ground is not read again while the wearer stays (the old behaviour)', () => {
  const grid = settlingGrid();
  const view = headAt(0, 0);
  for (let k = 0; k < 40; k++) {
    grid.reopen(view);
    for (let p = 0; p < 9; p++) grid.add(0.05, 0, -1.55);
    grid.commit(view);
  }
  assert.equal(grid.unsettledInView(view), false);
  assert.equal(grid.refresh(view, 1e9, Infinity), 0, 'nothing is old enough');
});

// ---- settling off, the default: every read counts for every cell in view ----

test('a chair put down on floor that has been watched for a minute is marked after setScans reads and cleared after clearScans, while the head moves and a cell nearby never comes to rest', () => {
  // With settling on, the tests above allow 1.5 s and 2 s for this: a settled cell is blind until
  // it is looked at again. Off, known ground follows the room as fast as new ground does. The
  // app's read loop, as in index.js readLive: reopen, refresh, skip when nothing is open, read, commit.
  const many = SCAN.minPoints * 3;
  const [x, z] = [0.05, -1.55]; // where the chair will stand
  const [rx, rz] = [0.85, -1.95]; // the edge of something: a thing in one read, floor in the next
  const grid = newGrid();
  const clock = { ms: 0, k: 0 };
  // `seconds` of reads; the time until `until(cell)` holds for the chair's cell, or null.
  function play(seconds, chair, until) {
    for (let k = 1; k <= Math.round((seconds * 1000) / SCAN.depthMs); k++) {
      clock.ms += SCAN.depthMs;
      clock.k++;
      // The head sways and nods a little, as a head does.
      const view = { ...headAt(0, 0, Math.sin(clock.k / 3) * 0.05, -1, -0.5 + Math.sin(clock.k / 5) * 0.07), now: clock.ms };
      grid.reopen(view);
      if (!(SCAN.refreshS > 0 && grid.refresh(view, clock.ms, SCAN.refreshS * 1000)) && !grid.unsettledInView(view)) continue; // a skipped read
      for (let p = 0; p < many; p++) grid.add(x, chair ? 0.5 : 0, z);
      for (let p = 0; p < many; p++) grid.add(rx, clock.k % 2 ? 0.5 : 0, rz);
      grid.commit(view);
      if (until?.(grid.cells[cellOf(x, z)])) return (k * SCAN.depthMs) / 1000;
    }
    return null;
  }
  play(60, false);
  assert.equal(grid.cells[cellOf(x, z)], PASSABLE);
  assert.equal(grid.settledCount, 0, 'nothing settled in a minute');
  const marked = play(10, true, (cell) => cell === OBSTACLE);
  assert.equal(marked, (SCAN.setScans * SCAN.depthMs) / 1000, 'marked by the first setScans reads that see it');
  assert.ok(marked <= 0.2, `${marked} s`);
  play(60, true);
  const cleared = play(10, false, (cell) => cell === PASSABLE);
  assert.equal(cleared, (SCAN.clearScans * SCAN.depthMs) / 1000, 'cleared by the first clearScans reads of bare floor');
  assert.ok(cleared <= 0.3, `${cleared} s`);
});

test('the grid goes out in the frame after the read that changed it: emitMs stays more than a frame below depthMs', () => {
  // index.js sends when emitMs has passed since the last send, never in the frame of a read. With
  // emitMs above depthMs (250 against 200) a change waited up to 233 ms for its turn while the
  // map kept changing, as it does when the wearer walks: 144 ms on average.
  assert.ok(SCAN.emitMs <= SCAN.depthMs - 14, `emitMs ${SCAN.emitMs}, depthMs ${SCAN.depthMs}`); // 14 ms: a frame at 72 Hz
});

test('the reads are spaced by what a read takes: ten a second while it is quick, fewer by themselves when it is slow', () => {
  assert.equal(SCAN.depthMs, 100);
  const every = (costMs) => readEveryMs(SCAN.depthMs, costMs, SCAN.depthBusy);
  assert.equal(every(0), 100, 'nothing measured yet');
  assert.equal(every(5), 100, 'a read of 5 ms: every depthMs');
  assert.equal(every(SCAN.depthMs * SCAN.depthBusy), 100, 'the longest read that still leaves it at that');
  assert.ok(Math.abs(every(30) - 200) < 1e-9, 'a read of 30 ms: five a second');
  assert.ok(Math.abs(every(60) - 400) < 1e-9);
  // The share of the time spent reading never passes depthBusy, however slow a read is.
  for (const cost of [1, 10, 20, 50, 200]) assert.ok(cost / every(cost) <= SCAN.depthBusy + 1e-9, `${cost} ms`);
  assert.equal(readEveryMs(100, 500, 1), 500, 'with ?depthBusy=1 a read still does not start before the one before is over');
});


// ---- reach: what a cell needs follows how thin the image lies on the floor, and how far away it is ----

test('floorReachM: how far an image can clear what it marks, by its samples and the eye height', () => {
  const P = questEye(3).projectionMatrix.elements;
  const reach = (samples, eyeM) => floorReachM(P, samples, eyeM, SCAN.cellM, SCAN.farPoints);
  assert.ok(reach(320, 1.6) > 5.3 && reach(320, 1.6) < 5.45, `${reach(320, 1.6)}`);
  // The defaults fit together: at the eye height of our wearer (1.45 m on 2026-11-15) the image reaches depthRangeM.
  assert.ok(reach(SCAN.depthSamples, 1.45) >= SCAN.depthRangeM);
  // Fewer samples, or a lower eye, reach less far: the read then ends there by itself.
  assert.ok(reach(288, 1.45) > 4.75 && reach(288, 1.45) < 4.9);
  assert.ok(reach(192, 1.6) > 3.7 && reach(192, 1.6) < 3.9);
  assert.ok(reach(320, 0.8) < 4.4, 'sitting down');
  assert.ok(Math.abs(reach(320, 1.6) / reach(160, 1.6) - 2 ** (2 / 3)) < 1e-6, 'four times the samples: 1.59 times the reach');
  // What follows the range in SCAN.
  assert.ok(SCAN.leaveM >= SCAN.depthRangeM + 1 && SCAN.glowFullM < SCAN.depthRangeM && SCAN.farM < SCAN.depthRangeM);
});

test('where the image is thin, farPoints floor samples say "floor"; near the wearer it takes minPoints', () => {
  const weight = Math.ceil(SCAN.minPoints / SCAN.farPoints);
  const grid = newGrid();
  const [x, z] = [0.05, -4.55];
  grid.add(x, 0, z, weight); // one far sample: not enough
  grid.commit();
  assert.equal(grid.cells[cellOf(x, z)], UNKNOWN);
  for (let k = 0; k < SCAN.farPoints; k++) grid.add(x, 0, z, weight);
  grid.commit();
  assert.equal(grid.cells[cellOf(x, z)], PASSABLE);
  for (let k = 0; k < SCAN.farPoints; k++) grid.add(0.05, 0, -1.55); // the same number of samples near the wearer
  grid.commit();
  assert.equal(grid.cells[cellOf(0.05, -1.55)], UNKNOWN);
  // A thing point still outweighs them: floor with a little of something else is unclear, far away too.
  for (let i = 0; i < SCAN.farSetScans; i++) {
    for (let k = 0; k < SCAN.minPoints; k++) grid.add(x, 0.5, z);
    grid.commit();
  }
  assert.equal(grid.cells[cellOf(x, z)], OBSTACLE);
  for (let i = 0; i < SCAN.clearScans + 2; i++) {
    grid.add(x, 0.5, z);
    for (let k = 0; k < 4; k++) grid.add(x, 0, z, weight);
    grid.commit();
  }
  assert.equal(grid.cells[cellOf(x, z)], OBSTACLE);
});

test('one read of bare floor knows four fifths or more of the last metre of the range', () => {
  for (const ahead of [1.5, 3, SCAN.depthRangeM - 0.4]) {
    const camera = questEye(ahead, 1.45);
    const grid = newGrid();
    addDepthView(grid, depthSensor(camera, null), camera.projectionMatrix.elements, camera.matrixWorld.elements, SCAN);
    grid.commit();
    let cells = 0;
    let known = 0;
    for (let i = 0; i < grid.cells.length; i++) {
      const x = ORIGIN[0] + ((i % COLS) + 0.5) * SCAN.cellM;
      const z = ORIGIN[1] + (Math.floor(i / COLS) + 0.5) * SCAN.cellM;
      const d = Math.hypot(x, z);
      if (d < SCAN.depthRangeM - 1 || d > SCAN.depthRangeM - 0.1 || Math.abs(Math.atan2(x, -z)) > 0.5) continue;
      cells++;
      if (grid.cells[i] === PASSABLE) known++;
    }
    assert.ok(known / cells >= 0.8, `looking ${ahead} m ahead: ${known} of ${cells}`);
  }
});

test('beyond farM a thing has to be seen farSetScans times in a row; nearer, setScans as before', () => {
  assert.ok(SCAN.farSetScans > SCAN.setScans);
  const many = SCAN.minPoints * 3;
  const view = headAt(0, 0);
  const sight = (grid, at, from = view) => {
    for (let k = 0; k < many; k++) grid.add(at[0], 0.5, at[1]);
    grid.commit(from);
    return grid.cells[cellOf(at[0], at[1])];
  };
  const far = [0.05, -(SCAN.farM + 0.45)];
  const near = [0.05, -(SCAN.farM - 0.45)];
  const grid = newGrid();
  for (let i = 1; i < SCAN.setScans; i++) assert.notEqual(sight(grid, near), OBSTACLE);
  assert.equal(sight(grid, near), OBSTACLE);
  for (let i = 1; i < SCAN.farSetScans; i++) assert.notEqual(sight(grid, far), OBSTACLE, `far: not after ${i} sighting(s)`);
  assert.equal(sight(grid, far), OBSTACLE);
  // Sightings a read apart do not add up, far away either.
  const other = [1.05, -(SCAN.farM + 0.45)];
  for (let round = 0; round < 4; round++) {
    for (let i = 1; i < SCAN.farSetScans; i++) assert.notEqual(sight(grid, other), OBSTACLE);
    grid.commit(view); // a read that does not see it
  }
  // A far cell seen setScans times counts as soon as the wearer is within farM of it.
  for (let i = 0; i < SCAN.setScans - 1; i++) sight(grid, other);
  assert.notEqual(grid.cells[cellOf(other[0], other[1])], OBSTACLE);
  assert.equal(sight(grid, other, headAt(0, -1)), OBSTACLE);
  // An obstacle marked nearer stays one when it is seen again from beyond farM.
  for (let i = 0; i < SCAN.clearScans; i++) assert.equal(sight(grid, near, headAt(0, 2)), OBSTACLE);
});

test('at an eye height of 1.45 m, with a head that is never quite still: a chair 0.4 m inside the range is marked, and cleared within 2 s', () => {
  const far = SCAN.depthRangeM - 0.4;
  const chair = new THREE.Box3(new THREE.Vector3(-0.25, 0, -far - 0.25), new THREE.Vector3(0.25, 0.9, -far + 0.25));
  for (const ahead of [1.5, 3, far]) {
    const grid = newGrid();
    const look = (thing, k) => {
      const camera = questEye(ahead + 0.02 * Math.sin(k * 1.7), 1.45); // nodding by a fraction of a degree
      addDepthView(grid, depthSensor(camera, thing), camera.projectionMatrix.elements, camera.matrixWorld.elements, SCAN);
      grid.commit(headAt(0, 0));
    };
    for (let k = 0; k < SCAN.farSetScans; k++) look(chair, k);
    assert.ok(grid.cells.includes(OBSTACLE), `looking ${ahead} m ahead: marked`);
    let reads = 0;
    while (grid.cells.includes(OBSTACLE) && reads < 40) look(null, ++reads);
    assert.ok(reads * SCAN.depthMs <= 2000, `looking ${ahead} m ahead: cleared after ${reads} reads`);
  }
});
