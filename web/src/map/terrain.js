import { MAP } from './config.js';

export function range(grid) {
  let min = Infinity, max = -Infinity;
  for (const v of grid ?? []) if (Number.isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
  return { min, max };
}
export function sampleHeight(topo, grid, c, r) {
  if (c < 0 || r < 0 || c > grid.cols - 1 || r > grid.rows - 1) return NaN;
  const c0 = Math.floor(c), r0 = Math.floor(r), c1 = Math.min(grid.cols - 1, c0 + 1), r1 = Math.min(grid.rows - 1, r0 + 1);
  const tx = c - c0, ty = r - r0;
  const values = [[topo[r0 * grid.cols + c0], (1 - tx) * (1 - ty)],
    [topo[r0 * grid.cols + c1], tx * (1 - ty)], [topo[r1 * grid.cols + c0], (1 - tx) * ty], [topo[r1 * grid.cols + c1], tx * ty]];
  let h = 0;
  for (const [v, w] of values) { if (!w) continue; if (!Number.isFinite(v)) return NaN; h += v * w; }
  return h;
}
/**
 * The upward normal of the terrain at cell coordinates (c, r), in the map's axes (x east, y up,
 * z south), from the heights one cell either side: the 8 m difference the slope layer is
 * computed with (data-pipeline/build_data.py), one-sided at the edge of the data. The angle
 * between it and the vertical is the slope there. Null where a height is missing.
 */
export function surfaceNormal(topo, grid, c, r, out = [0, 1, 0]) {
  const c0 = Math.max(0, c - 1), c1 = Math.min(grid.cols - 1, c + 1), r0 = Math.max(0, r - 1), r1 = Math.min(grid.rows - 1, r + 1);
  const east = (sampleHeight(topo, grid, c1, r) - sampleHeight(topo, grid, c0, r)) / ((c1 - c0) * grid.cellSizeM);
  const north = (sampleHeight(topo, grid, c, r1) - sampleHeight(topo, grid, c, r0)) / ((r1 - r0) * grid.cellSizeM);
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  const k = 1 / Math.hypot(east, north, 1);
  out[0] = -east * k; out[1] = k; out[2] = north * k; // north is -z on the map
  return out;
}
export function mapPoint(topo, grid, cell, min, width = MAP.widthM, lift = 0) {
  const h = sampleHeight(topo, grid, cell[0], cell[1]);
  if (!Number.isFinite(h)) return null;
  const scale = width / (grid.cols * grid.cellSizeM);
  return [((cell[0] + 0.5) / grid.cols - 0.5) * width, (h - min) * scale + lift,
    (0.5 - (cell[1] + 0.5) / grid.rows) * width * grid.rows / grid.cols];
}
export function terrainArrays(topo, grid, maxSide = MAP.maxVerticesPerSide) {
  if (!topo || topo.length !== grid.cols * grid.rows) throw new Error('missing-topo');
  const { min, max } = range(topo);
  if (!Number.isFinite(min)) throw new Error('empty-topo');
  const cols = Math.min(grid.cols, maxSide), rows = Math.min(grid.rows, maxSide);
  const positions = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2), cells = [];
  // Lit by the terrain's own normals, not by the mesh's: the mesh is coarser than the data, and
  // normals worked out from its faces would show every slope as it is over two faces' width
  // (terrain.test.js: over every cell the light is 1.2 degrees off the slope layer, not 1.6).
  // Only where the vertices are at most MAP.ownNormalsMaxCells apart (257 per side): on a coarser
  // mesh (?mapMesh=129) the terrain's normals skip the ground between two vertices and the light
  // turns patchy (tried at 129 and 193), so there `normals` is null and the map takes them from
  // the mesh's faces, as it did before (map/index.js).
  const ownNormals = Math.max((grid.cols - 1) / (cols - 1), (grid.rows - 1) / (rows - 1)) <= MAP.ownNormalsMaxCells;
  const normals = ownNormals ? new Float32Array(cols * rows * 3) : null, normal = [0, 1, 0];
  // Prefix sum keeps holes even when vertices are downsampled.
  const stride = grid.cols + 1, missing = new Uint32Array((grid.rows + 1) * stride);
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    const i = (r + 1) * stride + c + 1;
    missing[i] = Number(!Number.isFinite(topo[r * grid.cols + c])) + missing[i - 1] + missing[i - stride] - missing[i - stride - 1];
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cell = [c / (cols - 1) * (grid.cols - 1), r / (rows - 1) * (grid.rows - 1)]; cells.push(cell);
    const p = mapPoint(topo, grid, cell, min) ?? [0, 0, 0]; const i = r * cols + c;
    positions.set(p, i * 3); uv.set([(cell[0] + 0.5) / grid.cols, (cell[1] + 0.5) / grid.rows], i * 2);
    normals?.set(surfaceNormal(topo, grid, cell[0], cell[1], normal) ?? [0, 1, 0], i * 3);
  }
  const indices = [];
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    const c0 = Math.floor(cells[a][0]), r0 = Math.floor(cells[a][1]);
    const c1 = Math.ceil(cells[e][0]) + 1, r1 = Math.ceil(cells[e][1]) + 1;
    const absent = missing[r1 * stride + c1] - missing[r0 * stride + c1] - missing[r1 * stride + c0] + missing[r0 * stride + c0];
    if (!absent) indices.push(a, b, d, b, e, d);
  }
  return { positions, uv, normals, indices, min, max };
}
