// node --test src/scan/overlay.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { initOverlay, outlineField } from './overlay.js';
import { setMode } from '../core/mode.js';

const X = 1;
const U = 255;

test('the outline field is 128 between obstacle and floor, higher inside, lower outside', () => {
  // A block 4 wide and 3 deep against two borders of an 8 x 5 grid.
  const cells = Uint8Array.from([
    X, X, X, X, 0, 0, 0, 0,
    X, X, X, X, 0, U, 0, 0,
    X, X, X, X, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const f = outlineField(cells, 8, 5, 2.5);
  const at = (col, row) => f[row * 8 + col];
  // The cell just inside the edge and the one just outside sit equally far either side of 128.
  assert.equal(at(3, 1) + at(4, 1), 255);
  assert.ok(at(3, 1) > 128 && at(4, 1) < 128);
  assert.ok(at(2, 1) > at(3, 1), 'deeper inside is higher');
  assert.ok(at(5, 1) < at(4, 1) && at(6, 1) < at(5, 1), 'farther outside is lower');
  assert.equal(at(7, 4), 0, 'far from any obstacle: nothing is drawn');
  assert.equal(at(5, 1), at(5, 2), 'unknown floor is outside like any other floor');
  // The grid's border is not an outline: a block against it stays "inside" up to the border.
  assert.ok(at(0, 0) >= at(1, 1));
});

test('a wall one cell wide still reaches above 128, so it gets its outline', () => {
  const cells = new Uint8Array(7 * 7);
  for (let r = 0; r < 7; r++) cells[r * 7 + 3] = X;
  const f = outlineField(cells, 7, 7, 2.5);
  assert.ok(f[3 * 7 + 3] > 128);
  assert.ok(f[3 * 7 + 2] < 128 && f[3 * 7 + 4] < 128);
  assert.equal(f[3 * 7 + 2], f[3 * 7 + 4]);
});

// The field worked out over every cell of the grid, as outlineField did until 2026-11-15 (but
// for a grid of a single row, where its way back started at the wrong end): what the one that
// only looks at the box around the obstacles has to give, byte for byte.
function outlineFieldWhole(cells, cols, rows, reach) {
  const n = cols * rows;
  const FAR = 1e3;
  const out = new Float32Array(n);
  const inn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const obstacle = cells[i] === 1;
    out[i] = obstacle ? 0 : FAR;
    inn[i] = obstacle ? FAR : 0;
  }
  const relax = (d) => {
    const pass = (from, to, step) => {
      for (let r = from; r !== to; r += step) {
        for (let c = step > 0 ? 0 : cols - 1; c >= 0 && c < cols; c += step) {
          const i = r * cols + c;
          let best = d[i];
          const rr = r - step;
          const cc = c - step;
          if (cc >= 0 && cc < cols) best = Math.min(best, d[i - step] + 1);
          if (rr >= 0 && rr < rows) {
            best = Math.min(best, d[rr * cols + c] + 1);
            if (cc >= 0 && cc < cols) best = Math.min(best, d[rr * cols + cc] + Math.SQRT2);
            const co = c + step;
            if (co >= 0 && co < cols) best = Math.min(best, d[rr * cols + co] + Math.SQRT2);
          }
          d[i] = best;
        }
      }
    };
    pass(0, rows, 1);
    pass(rows - 1, -1, -1);
  };
  relax(out);
  relax(inn);
  const field = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const signed = cells[i] === 1 ? inn[i] - 0.5 : -(out[i] - 0.5);
    field[i] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + signed / (2 * reach))));
  }
  return field;
}

test('working on the box around the obstacles gives the field of the whole grid, byte for byte', () => {
  let seed = 2026;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const grids = [];
  // Rooms: a few blocks, walls and single cells somewhere on a grid, also against its borders.
  for (let k = 0; k < 60; k++) {
    const cols = 1 + Math.floor(rnd() * 70);
    const rows = 1 + Math.floor(rnd() * 70);
    const cells = new Uint8Array(cols * rows).fill(rnd() < 0.3 ? 255 : 0);
    const things = Math.floor(rnd() * 6);
    for (let t = 0; t < things; t++) {
      const w = 1 + Math.floor(rnd() * (rnd() < 0.3 ? cols : 6));
      const h = 1 + Math.floor(rnd() * (rnd() < 0.3 ? rows : 6));
      const c0 = Math.floor(rnd() * cols);
      const r0 = Math.floor(rnd() * rows);
      for (let r = r0; r < Math.min(rows, r0 + h); r++) for (let c = c0; c < Math.min(cols, c0 + w); c++) cells[r * cols + c] = 1;
    }
    grids.push([cells, cols, rows]);
  }
  // Noise: every cell by chance, thin and dense.
  for (const share of [0.02, 0.3, 0.7, 0.98]) {
    const cells = Uint8Array.from({ length: 48 * 37 }, () => (rnd() < share ? 1 : rnd() < 0.5 ? 0 : 255));
    grids.push([cells, 48, 37]);
  }
  // Nothing at all, everything, one cell in a corner, one in the middle of the scan's window.
  grids.push([new Uint8Array(30 * 20), 30, 20], [new Uint8Array(30 * 20).fill(1), 30, 20]);
  const corner = new Uint8Array(30 * 20);
  corner[30 * 20 - 1] = 1;
  const middle = new Uint8Array(256 * 256).fill(255);
  middle[128 * 256 + 128] = 1;
  grids.push([corner, 30, 20], [middle, 256, 256]);

  let compared = 0;
  for (const [cells, cols, rows] of grids) {
    for (const reach of [2.5, 1, 4.2]) {
      assert.deepEqual(outlineField(cells, cols, rows, reach), outlineFieldWhole(cells, cols, rows, reach), `${cols} x ${rows}, reach ${reach}, grid ${compared}`);
      compared++;
    }
  }
  assert.ok(compared > 200);
});

test('written into bytes the caller keeps: what was there before is gone', () => {
  const cols = 20;
  const rows = 12;
  const kept = new Uint8Array(cols * rows).fill(77);
  const cells = new Uint8Array(cols * rows);
  cells[5 * cols + 9] = 1;
  assert.equal(outlineField(cells, cols, rows, 2.5, kept), kept, 'the same array comes back');
  assert.deepEqual(kept, outlineFieldWhole(cells, cols, rows, 2.5));
  // The obstacle is taken away: the next picture is empty, with nothing left of the last one.
  outlineField(new Uint8Array(cols * rows), cols, rows, 2.5, kept);
  assert.ok(kept.every((v) => v === 0));
});

test('the highlight lies on the floor where the grid is and shows in field mode only', () => {
  const on = {};
  let mesh;
  initOverlay({ bus: { on: (name, fn) => (on[name] = fn) }, scene: { add: (m) => (mesh = m) } }, { glowRGB: [255, 48, 48], glintRGB: [255, 214, 208] });
  const emit = (cols, rows, cells) => on['hazard:update']({ originXZ: [-1, -2], cellSizeM: 0.5, cols, rows, cells: Uint8Array.from(cells) });
  emit(8, 5, new Array(40).fill(0).map((_, i) => (i < 4 ? X : 0)));
  const field = () => mesh.material.uniforms.field.value.image;
  assert.deepEqual([field().width, field().height, field().data.length], [8, 5, 40]);
  assert.ok(field().data[0] > 128 && field().data[39] === 0);
  // Cell [0, 0] lies at originXZ and the picture covers the grid.
  assert.deepEqual([mesh.scale.x, mesh.scale.z, mesh.position.x, mesh.position.z], [4, 2.5, 1, -0.75]);

  assert.equal(mesh.visible, false);
  setMode('field');
  on['app:mode']();
  assert.equal(mesh.visible, true);

  // Another grid size (web/src/nav/browser.test.cjs feeds several): a new picture, no error.
  emit(3, 2, [X, X, X, X, X, X]);
  assert.deepEqual([field().width, field().height, field().data.length], [3, 2, 6]);
  assert.ok(field().data.every((v) => v > 128));
});
