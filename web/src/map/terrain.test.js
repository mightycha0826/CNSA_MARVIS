// node --test src/map/terrain.test.js
//
// How steep the palm map draws the ground, against what the data says: the relief is a mesh
// that is coarser than the data (MAP.maxVerticesPerSide), so its faces can be tilted otherwise
// than the slope layer says. And how it is lit: with the terrain's own normals, which lean by the
// slope layer's value. Checked on the real files in web/public/data/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { terrainArrays, surfaceNormal } from './terrain.js';
import { MAP } from './config.js';

const DATA = new URL('../../public/data/', import.meta.url);
const f32 = (name) => {
  const b = readFileSync(new URL(name, DATA));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const layerSet = JSON.parse(readFileSync(new URL('layerset.json', DATA), 'utf8'));
const { grid } = layerSet;
const topo = f32('topo.bin');
const slope = f32('slope.bin');
const traverse = JSON.parse(readFileSync(new URL('traverse.json', DATA), 'utf8')).points;

/** The slope (degrees) of the mesh face over every data cell, for a mesh of `side` vertices per side. */
function drawnSlope(side) {
  const { positions } = terrainArrays(topo, grid, side);
  const at = (r, c, k) => positions[(r * side + c) * 3 + k];
  const faces = new Float32Array((side - 1) * (side - 1));
  for (let r = 0; r < side - 1; r++) {
    for (let c = 0; c < side - 1; c++) {
      // The map is to scale, heights included, so angles on it are the terrain's angles.
      const dx = at(r, c + 1, 0) - at(r, c, 0);
      const dz = at(r + 1, c, 2) - at(r, c, 2);
      const gx = (at(r, c + 1, 1) - at(r, c, 1) + at(r + 1, c + 1, 1) - at(r + 1, c, 1)) / (2 * dx);
      const gz = (at(r + 1, c, 1) - at(r, c, 1) + at(r + 1, c + 1, 1) - at(r, c + 1, 1)) / (2 * dz);
      faces[r * (side - 1) + c] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
    }
  }
  const face = (i, n) => Math.min(side - 2, Math.floor((i / (n - 1)) * (side - 1)));
  return (col, row) => faces[face(row, grid.rows) * (side - 1) + face(col, grid.cols)];
}

/** Mean difference (degrees) between the slope the mesh shows and the slope layer, over every cell. */
function offTheLayer(side) {
  const drawn = drawnSlope(side);
  let sum = 0;
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) sum += Math.abs(drawn(col, row) - slope[row * grid.cols + col]);
  return sum / (grid.cols * grid.rows);
}

/** Mean difference (degrees) between the slope the mesh shows and the tilt the rover measured at its stops. */
function offTheRover(side) {
  const drawn = drawnSlope(side);
  return traverse.reduce((sum, p) => sum + Math.abs(drawn(p.cell[0], p.cell[1]) - p.tiltDeg), 0) / traverse.length;
}

test('the relief is drawn as steep as the slope layer says, to within 1.8 degrees on average', () => {
  const now = offTheLayer(MAP.maxVerticesPerSide);
  assert.ok(now < 1.8, `the mesh is ${now.toFixed(2)} degrees off the slope layer`);
  // the mesh it replaced: a vertex every fourth cell
  const before = offTheLayer(129);
  assert.ok(before > 2.2 && now < before * 0.75, `was ${before.toFixed(2)}, is ${now.toFixed(2)}`);
});

test('and closer to the tilt the rover measured at its 178 stops than the coarser mesh was', () => {
  const now = offTheRover(MAP.maxVerticesPerSide);
  const before = offTheRover(129);
  assert.equal(traverse.length, 178);
  assert.ok(now < 2.3 && now < before, `was ${before.toFixed(2)}, is ${now.toFixed(2)} degrees off the rover's tilt`);
});

const lean = (n) => (Math.acos(Math.max(-1, Math.min(1, n[1]))) * 180) / Math.PI; // a unit normal's angle from the vertical

test('the normal of the terrain leans by the slope the slope layer gives, at every cell', () => {
  let worst = 0;
  for (let row = 0; row < grid.rows; row += 3) {
    for (let col = 0; col < grid.cols; col += 3) worst = Math.max(worst, Math.abs(lean(surfaceNormal(topo, grid, col, row)) - slope[row * grid.cols + col]));
  }
  assert.ok(worst < 1e-3, `off by up to ${worst} degrees`);
  // and it points uphill's opposite way: on ground that rises to the east it leans west (-x), to the north it leans south (+z)
  const ramp = { cols: 3, rows: 3, cellSizeM: 4 };
  const toEast = Float32Array.from([0, 4, 8, 0, 4, 8, 0, 4, 8]);
  const toNorth = Float32Array.from([0, 0, 0, 4, 4, 4, 8, 8, 8]);
  const e = surfaceNormal(toEast, ramp, 1, 1);
  const n = surfaceNormal(toNorth, ramp, 1, 1);
  assert.ok(e[0] < 0 && Math.abs(e[2]) < 1e-9 && Math.abs(lean(e) - 45) < 1e-6);
  assert.ok(n[2] > 0 && Math.abs(n[0]) < 1e-9 && Math.abs(lean(n) - 45) < 1e-6);
  assert.equal(surfaceNormal(Float32Array.from([0, NaN, 8, 0, 4, 8, 0, 4, 8]), ramp, 1, 0), null);
});

test('the relief is lit as steep as the slope layer says: its normals are the terrain\'s, not the mesh\'s', () => {
  const side = MAP.maxVerticesPerSide;
  const { normals, positions, indices } = terrainArrays(topo, grid);
  assert.equal(normals.length, positions.length);
  // Every vertex: unit length, pointing up, on the side the triangles face (so a two-sided material lights the top).
  let sum = 0;
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    assert.ok(Math.abs(len - 1) < 1e-5 && normals[i + 1] > 0);
    // the slope the light shows at this vertex against the slope layer at the cell it stands in
    const v = i / 3;
    const col = Math.round(((v % side) / (side - 1)) * (grid.cols - 1));
    const row = Math.round((Math.floor(v / side) / (side - 1)) * (grid.rows - 1));
    sum += Math.abs(lean([normals[i], normals[i + 1], normals[i + 2]]) - slope[row * grid.cols + col]);
  }
  const off = sum / (normals.length / 3);
  // 0.77 on 2026-11-15 (a vertex stands between cells); normals worked out from the mesh's faces were 1.6 off, 2.4 with the mesh of 129
  assert.ok(off < 1, `the light is ${off.toFixed(2)} degrees off the slope layer at the vertices`);
  // the first triangle's own normal points up as well: front faces are the top of the terrain
  const [a, b, c] = [indices[0], indices[1], indices[2]].map((k) => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]]);
  const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  assert.ok(up > 0, 'the triangles are wound with their front on top');
});

test('the slope layer itself is as close to the tilt the rover measured as when it was checked (docs/DATA.md)', () => {
  // The rover's tilt at its stops is the only ground truth for slope. 2026-11-15: mean
  // absolute error 1.90 degrees, correlation 0.82 (data-pipeline/validate.py has the study).
  const layer = traverse.map((p) => slope[p.cell[1] * grid.cols + p.cell[0]]);
  const tilt = traverse.map((p) => p.tiltDeg);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mae = mean(layer.map((v, i) => Math.abs(v - tilt[i])));
  const [ml, mt] = [mean(layer), mean(tilt)];
  const r = mean(layer.map((v, i) => (v - ml) * (tilt[i] - mt))) / Math.sqrt(mean(layer.map((v) => (v - ml) ** 2)) * mean(tilt.map((v) => (v - mt) ** 2)));
  assert.ok(mae < 2 && r > 0.8, `mean absolute error ${mae.toFixed(2)}, correlation ${r.toFixed(3)}`);
});

test('the mesh stays within what one draw call on the headset should hold', () => {
  const { indices } = terrainArrays(topo, grid);
  assert.ok(indices.length / 3 <= 140000, `${indices.length / 3} triangles`);
});

// ---- the light over every cell, and the way back to the mesh of before ----

/** The normals three.js works out from the mesh itself: what the map was lit with before. */
function meshNormals(side) {
  const { positions, indices } = terrainArrays(topo, grid, side);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry.attributes.normal.array;
}

/**
 * Mean difference (degrees) between the slope the lit surface shows and the slope layer, over
 * every cell. What it shows over a cell: the normals of the three vertices of the triangle the
 * cell's centre lies in, blended as the GPU blends them across a triangle.
 */
function litOffTheLayer(normals, side) {
  let sum = 0;
  const n = [0, 0, 0];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const u = (col / (grid.cols - 1)) * (side - 1), v = (row / (grid.rows - 1)) * (side - 1);
      const qc = Math.min(side - 2, Math.floor(u)), qr = Math.min(side - 2, Math.floor(v)), fu = u - qc, fv = v - qr;
      const a = (qr * side + qc) * 3, b = a + 3, d = a + side * 3, e = d + 3; // the quad's corners, as terrainArrays numbers them
      const parts = fu + fv <= 1 ? [[a, 1 - fu - fv], [b, fu], [d, fv]] : [[e, fu + fv - 1], [b, 1 - fv], [d, 1 - fu]]; // its triangles: a-b-d, b-e-d
      n.fill(0);
      for (const [i, w] of parts) for (let k = 0; k < 3; k++) n[k] += normals[i + k] * w;
      sum += Math.abs((Math.atan2(Math.hypot(n[0], n[2]), n[1]) * 180) / Math.PI - slope[row * grid.cols + col]);
    }
  }
  return sum / slope.length;
}

test('over every cell the light shows the slope layer to within 1.4 degrees: closer than with normals from the mesh', () => {
  const side = MAP.maxVerticesPerSide;
  const now = litOffTheLayer(terrainArrays(topo, grid).normals, side);
  const fromMesh = litOffTheLayer(meshNormals(side), side);
  // 1.18 against 1.63 on 2026-11-15 (2.44 with the mesh of 129 and its own normals)
  assert.ok(now < 1.4 && now < fromMesh * 0.8, `from the mesh ${fromMesh.toFixed(2)}, from the data ${now.toFixed(2)} degrees off the slope layer`);
});

test('the terrain\'s normals point along the mesh\'s own: no axis the wrong way round', () => {
  const { normals } = terrainArrays(topo, grid);
  const own = meshNormals(MAP.maxVerticesPerSide);
  let along = 0;
  for (let i = 0; i < normals.length; i += 3) along += normals[i] * own[i] + normals[i + 1] * own[i + 1] + normals[i + 2] * own[i + 2];
  along /= normals.length / 3;
  assert.ok(along > 0.998, `mean cosine between the data's normals and the mesh's: ${along}`); // 0.9991; with east or north the wrong way round, 0.92 or less
});

test('a mesh coarser than a vertex every two cells is lit from its own faces, as before (?mapMesh=129)', () => {
  assert.equal(terrainArrays(topo, grid, 129).normals, null);
  assert.equal(terrainArrays(topo, grid, 193).normals, null);
  assert.ok(terrainArrays(topo, grid, 257).normals instanceof Float32Array);
  assert.ok(terrainArrays(topo, grid, grid.cols).normals instanceof Float32Array);
});
