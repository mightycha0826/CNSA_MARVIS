// node --test src/field/zone.test.js
// The hazard-zone warning: when the wearer counts as standing in marked ground, and when as out of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZONE, obstacleWithin, createZoneWatch } from './zone.js';

// A grid like the scan's (hazard:update): 0.1 m cells, cell [0, 0] at (-2, -2), with a chair of
// 5 x 5 cells whose corner is at (0.3, -0.8): it covers x 0.3 .. 0.8 and z -0.8 .. -0.3.
function gridWithChair() {
  const cols = 40;
  const rows = 40;
  const cells = new Uint8Array(cols * rows);
  cells.fill(255, 0, cols * 2); // two rows not seen yet
  for (let r = 12; r < 17; r++) for (let c = 23; c < 28; c++) cells[r * cols + c] = 1;
  return { originXZ: [-2, -2], cellSizeM: 0.1, cols, rows, cells };
}
const K = { bodyM: 0.2, leaveM: 0.4, enterMs: 250, leaveMs: 600 };

test('obstacleWithin: the cell under the wearer, or a marked cell whose edge is within reach', () => {
  const g = gridWithChair();
  assert.equal(obstacleWithin(g, 0.55, -0.55, 0), true, 'standing on it');
  assert.equal(obstacleWithin(g, 0.2, -0.55, 0), false, '0.1 m beside it');
  assert.equal(obstacleWithin(g, 0.2, -0.55, 0.11), true, 'its edge is 0.1 m away');
  assert.equal(obstacleWithin(g, 0.2, -0.55, 0.09), false);
  assert.equal(obstacleWithin(g, 0.05, -0.55, 0.2), false, '0.25 m from its edge');
  // Off a corner the distance is the diagonal: 0.1 m each way is 0.141 m.
  assert.equal(obstacleWithin(g, 0.2, -0.9, 0.13), false);
  assert.equal(obstacleWithin(g, 0.2, -0.9, 0.15), true);
  assert.equal(obstacleWithin(g, 0.31, -0.55, 0), true, 'just inside its edge');
  assert.equal(obstacleWithin(g, 0.29, -0.55, 0), false, 'just outside it');
});

test('obstacleWithin: unknown ground, ground outside the grid and no grid at all are not obstacles', () => {
  const g = gridWithChair();
  assert.equal(obstacleWithin(g, 0, -1.95, 0.3), false, 'cells not seen yet (255)');
  assert.equal(obstacleWithin(g, 30, 30, 0.5), false, 'far outside the grid');
  assert.equal(obstacleWithin(g, -2.3, -2.3, 0.2), false, 'just outside its corner');
  assert.equal(obstacleWithin(null, 0, 0, 1), false);
  assert.equal(obstacleWithin({}, 0, 0, 1), false);
  assert.equal(obstacleWithin(g, NaN, 0, 1), false);
  assert.equal(obstacleWithin(g, 0.55, -0.55, -1), true, 'a negative reach is none: the cell under the wearer still counts');
  // A grid whose marked cell is in its last row and column: the search does not run off the end.
  const edge = { originXZ: [0, 0], cellSizeM: 0.1, cols: 3, rows: 3, cells: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1]) };
  assert.equal(obstacleWithin(edge, 0.25, 0.25, 0), true);
  assert.equal(obstacleWithin(edge, 0.45, 0.45, 0.1), false, '0.15 m off its far corner, outside the grid');
  assert.equal(obstacleWithin(edge, 0.35, 0.35, 0.1), true);
});

test('walking into marked ground raises the warning after enterMs, and it stays while the wearer stands there', () => {
  const g = gridWithChair();
  const zone = createZoneWatch(K);
  let now = 0;
  const at = (x, z, ms = 50) => zone.step(g, x, z, (now += ms));
  assert.equal(at(-1, -0.55), null, 'clear floor');
  assert.equal(at(0.05, -0.55), null, '0.25 m from it: not in it');
  assert.equal(at(0.15, -0.55), null, 'in reach, for the first time');
  for (let i = 0; i < 4; i++) assert.equal(at(0.2 + i * 0.05, -0.55), null, `${(i + 1) * 50} ms in`);
  assert.equal(at(0.45, -0.55), 'enter', '250 ms in');
  assert.equal(zone.inside, true);
  for (let i = 0; i < 100; i++) assert.equal(at(0.55, -0.55), null, 'said once, not again while it lasts');
  assert.equal(zone.inside, true);
});

test('cutting a corner in passing does not raise it', () => {
  const g = gridWithChair();
  const zone = createZoneWatch(K);
  let now = 0;
  // Diagonally past the chair's corner at (0.3, -0.8), 0.17 m from it at the nearest, at 1 m/s
  // with a position every 50 ms: within reach for about 0.2 m of the way.
  let inReach = 0;
  for (let s = -1; s <= 1; s += 0.05) {
    const [x, z] = [0.18 + s / Math.SQRT2, -0.92 - s / Math.SQRT2];
    if (obstacleWithin(g, x, z, K.bodyM)) inReach++;
    assert.equal(zone.step(g, x, z, (now += 50)), null, `${s.toFixed(2)} m along`);
  }
  assert.ok(inReach >= 3 && inReach <= 5, `${inReach} positions were within reach`);
  assert.equal(zone.inside, false);
  // In reach again: the time before does not count towards it.
  assert.equal(zone.step(g, 0.2, -0.55, (now += 50)), null);
  assert.equal(zone.step(g, 0.2, -0.55, (now += 200)), null);
  assert.equal(zone.step(g, 0.2, -0.55, (now += 50)), 'enter');
});

test('leaving: out by more than leaveM for leaveMs, so standing at the rim does not make it come and go', () => {
  const g = gridWithChair();
  const zone = createZoneWatch(K);
  let now = 0;
  const at = (x, ms = 50) => zone.step(g, x, -0.55, (now += ms));
  at(0.55);
  assert.equal(at(0.55, 250), 'enter');
  // A step back to 0.3 m from the chair's edge: no longer within bodyM, still within leaveM.
  for (let i = 0; i < 40; i++) assert.equal(at(0), null, 'at the rim the warning holds');
  // Out to 0.5 m, in again before leaveMs has passed, and out again: the clock starts over.
  for (let i = 0; i < 12; i++) assert.equal(at(-0.2), null, `clear for ${i * 50} ms`);
  assert.equal(at(0), null, 'back at the rim before 600 ms were up');
  for (let i = 0; i < 12; i++) assert.equal(at(-0.2), null);
  assert.equal(at(-0.2), 'leave', '600 ms clear');
  assert.equal(zone.inside, false);
  assert.equal(at(-0.2), null);
});

test('the obstacle goes from the map while the wearer stands in it (seen to be bare floor): the warning goes too', () => {
  const g = gridWithChair();
  const zone = createZoneWatch(K);
  zone.step(g, 0.55, -0.55, 0);
  assert.equal(zone.step(g, 0.55, -0.55, 300), 'enter');
  const bare = { ...g, cells: new Uint8Array(g.cells.length) };
  assert.equal(zone.step(bare, 0.55, -0.55, 400), null);
  assert.equal(zone.step(bare, 0.55, -0.55, 1000), 'leave');
});

test('reset brings the warning down at once and says whether it was up', () => {
  const g = gridWithChair();
  const zone = createZoneWatch(K);
  assert.equal(zone.reset(), false);
  zone.step(g, 0.55, -0.55, 0);
  assert.equal(zone.reset(), false, 'not yet up: nothing to clear');
  zone.step(g, 0.55, -0.55, 1000);
  assert.equal(zone.step(g, 0.55, -0.55, 1200), null, 'the time before the reset does not count');
  assert.equal(zone.step(g, 0.55, -0.55, 1250), 'enter');
  assert.equal(zone.reset(), true);
  assert.equal(zone.inside, false);
  assert.equal(zone.reset(), false);
});

test('the numbers the app uses: out is wider than in, and both waits are short', () => {
  assert.ok(ZONE.leaveM > ZONE.bodyM && ZONE.bodyM > 0);
  assert.ok(ZONE.enterMs > 0 && ZONE.enterMs <= 500 && ZONE.leaveMs >= ZONE.enterMs && ZONE.leaveMs <= 1500);
  assert.equal(ZONE.on, true);
});
