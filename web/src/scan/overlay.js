// Obstacle highlight on the real floor (field mode): each obstacle's footprint is filled with a
// soft translucent red, the way a phone shades what it has picked out of a photo before
// erasing it, with a light that travels across it and a few sparks. It is shown in full within
// 4 m of the wearer (SCAN.glowFullM: four fifths of the scan's range) and fades out exponentially beyond. There is no outline and no halo: on the headset a bright line around every obstacle was more than the room needed.
// Nothing blocky: the edge of the fill is drawn from a distance field, so it follows the shape
// and not the 10 cm cells, and fades out over a few centimetres.
//
// It draws whatever arrives on the bus, so the mock grid (?mock=hazard) shows the same way.

import * as THREE from 'three';
import { mode } from '../core/mode.js';

export const OVERLAY = {
  reachCells: 2.5, // the field runs from 0 to 1 over this many cells either side of an outline
};

// Scratch for outlineField, grown when a larger box comes and kept between calls: the scan can
// send ten grids a second, and two float arrays of the whole window each time is work for nothing.
let scratchOut = new Float32Array(0);
let scratchIn = new Float32Array(0);

// The two passes of a chamfer distance over a w x h block: afterwards d holds, for every cell,
// the shortest way to a cell that started at 0, in steps of 1 (along a row or column) and
// sqrt 2 (diagonally).
function relax(d, w, h) {
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      let best = d[i];
      if (c > 0) best = Math.min(best, d[i - 1] + 1);
      if (r > 0) {
        best = Math.min(best, d[i - w] + 1);
        if (c > 0) best = Math.min(best, d[i - w - 1] + Math.SQRT2);
        if (c < w - 1) best = Math.min(best, d[i - w + 1] + Math.SQRT2);
      }
      d[i] = best;
    }
  }
  for (let r = h - 1; r >= 0; r--) {
    for (let c = w - 1; c >= 0; c--) {
      const i = r * w + c;
      let best = d[i];
      if (c < w - 1) best = Math.min(best, d[i + 1] + 1);
      if (r < h - 1) {
        best = Math.min(best, d[i + w] + 1);
        if (c < w - 1) best = Math.min(best, d[i + w + 1] + Math.SQRT2);
        if (c > 0) best = Math.min(best, d[i + w - 1] + Math.SQRT2);
      }
      d[i] = best;
    }
  }
}

/**
 * How far each cell is from the outline of the obstacles, as bytes: 128 on the outline, rising
 * to 255 `reach` cells inside an obstacle and falling to 0 `reach` cells outside. Sampled with
 * smoothing on the GPU, the 128 line is a smooth outline. Floor and unknown cells are both
 * "outside". Distances are along rows, columns and diagonals (a chamfer), close enough for a glow.
 *
 * Only the box around the obstacles is worked on (with a margin wider than `reach`): everything
 * outside it is 0, and the distances inside it come out as they would over the whole grid
 * (overlay.test.js compares the two). In a room that is a few thousand cells of the window's 65,536.
 * @param into the bytes to write to (cols x rows), for a caller that keeps them; a new array without
 */
export function outlineField(cells, cols, rows, reach = OVERLAY.reachCells, into = null) {
  const n = cols * rows;
  const field = into ?? new Uint8Array(n);
  if (into) field.fill(0);
  // The box that holds every obstacle cell.
  let c0 = cols;
  let c1 = -1;
  let r0 = rows;
  let r1 = -1;
  for (let r = 0, i = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, i++) {
      if (cells[i] !== 1) continue;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      r1 = r;
    }
  }
  if (c1 < 0) return field; // no obstacle: nothing to outline
  // A cell beyond the margin is more than reach + 0.5 cells from every obstacle, which is where
  // the field reaches 0. And every obstacle cell has its nearest free cell inside the box: the
  // ring of the margin is free all the way round, where the grid goes that far.
  const margin = Math.ceil(reach) + 1;
  c0 = Math.max(0, c0 - margin);
  c1 = Math.min(cols - 1, c1 + margin);
  r0 = Math.max(0, r0 - margin);
  r1 = Math.min(rows - 1, r1 + margin);
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  if (scratchOut.length < w * h) {
    scratchOut = new Float32Array(w * h);
    scratchIn = new Float32Array(w * h);
  }
  const FAR = 1e3;
  // Distance to the nearest cell of the other kind, in cells, for both kinds at once.
  const out = scratchOut; // for cells outside: distance to the nearest obstacle
  const inn = scratchIn; // for cells inside: distance to the nearest free cell
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const obstacle = cells[(r0 + r) * cols + c0 + c] === 1;
      out[r * w + c] = obstacle ? 0 : FAR;
      inn[r * w + c] = obstacle ? FAR : 0;
    }
  }
  relax(out, w, h);
  relax(inn, w, h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = (r0 + r) * cols + c0 + c;
      const k = r * w + c;
      // A cell centre is half a cell from its own edge: the outline runs between the two kinds.
      const signed = cells[i] === 1 ? inn[k] - 0.5 : -(out[k] - 0.5);
      field[i] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + signed / (2 * reach))));
    }
  }
  return field;
}

const VERTEX = `
varying vec2 vUv;
varying vec2 vFloor;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vFloor = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAGMENT = `
uniform sampler2D field;
uniform float time;
uniform vec3 colour;
uniform vec3 glint;
uniform vec2 eye; // where the wearer is, on the floor
uniform vec2 reach; // shown in full within reach.x metres of the wearer, then fading by 1/e every reach.y metres
varying vec2 vUv;
varying vec2 vFloor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  float f = texture2D(field, vUv).r; // 0.5 on the edge of an obstacle, more inside, less outside
  float inside = smoothstep(0.42, 0.58, f); // the fill, fading out across the edge
  // Only what is near is shown in full: an obstacle across the room is not in the way yet,
  // and red patches all over the floor are more than the eye needs.
  float away = distance(vFloor, eye);
  float near = away <= reach.x ? 1.0 : exp(-(away - reach.x) / reach.y);
  if (inside * near < 0.01) discard;
  // A band of light that crosses the floor every few seconds.
  float sweep = pow(0.5 + 0.5 * sin(dot(vFloor, vec2(0.8, 0.6)) * 2.4 - time * 1.7), 6.0);
  // Sparks inside the shape: 2.5 cm squares, a few of them lit, each twinkling at its own pace.
  float seed = hash(floor(vFloor / 0.025));
  float spark = step(0.94, seed) * (0.5 + 0.5 * sin(time * 3.2 + seed * 50.0));
  float breathe = 0.9 + 0.1 * sin(time * 2.1);

  float alpha = inside * near * (0.34 * breathe + 0.14 * sweep + 0.36 * spark);
  vec3 rgb = mix(colour, glint, clamp(sweep * 0.35 + spark * 0.6, 0.0, 1.0));
  gl_FragColor = vec4(rgb, clamp(alpha, 0.0, 0.9));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** @param cfg { glowRGB, glintRGB } each [r, g, b] 0-255, glowFullM, glowFadeM (SCAN in index.js) */
export function initOverlay(ctx, { glowRGB, glintRGB, glowFullM = 4, glowFadeM = 1 }) {
  let floor = null;
  const rgb = (v) => new THREE.Color().setRGB(v[0] / 255, v[1] / 255, v[2] / 255, THREE.SRGBColorSpace);

  ctx.bus.on('app:mode', () => {
    if (floor) floor.visible = mode.current === 'field';
  });

  ctx.bus.on('hazard:update', ({ originXZ, cellSizeM, cols, rows, cells }) => {
    if (!floor) {
      // Laid down this way the texture runs along +x and +z, so cell [0, 0] sits at originXZ.
      floor = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2),
        new THREE.ShaderMaterial({
          uniforms: { field: { value: null }, time: { value: 0 }, colour: { value: rgb(glowRGB) }, glint: { value: rgb(glintRGB) }, eye: { value: new THREE.Vector2() }, reach: { value: new THREE.Vector2(glowFullM, glowFadeM) } },
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      floor.name = 'scan-obstacles';
      floor.visible = mode.current === 'field';
      floor.onBeforeRender = (_renderer, _scene, camera) => {
        floor.material.uniforms.time.value = (performance.now() / 1000) % 3600;
        // The camera that is drawing: in the headset one eye, close enough to where the wearer stands.
        const e = camera.matrixWorld.elements;
        floor.material.uniforms.eye.value.set(e[12], e[14]);
      };
      ctx.scene.add(floor);
    }
    const uniforms = floor.material.uniforms;
    // A new picture when the grid size is not the one before (the first event, or a test that feeds several sizes).
    if (uniforms.field.value?.image.width !== cols || uniforms.field.value.image.height !== rows) {
      uniforms.field.value?.dispose();
      const texture = new THREE.DataTexture(new Uint8Array(cols * rows), cols, rows, THREE.RedFormat);
      texture.magFilter = texture.minFilter = THREE.LinearFilter; // the smoothing that turns cells into an outline
      uniforms.field.value = texture;
    }
    const width = cols * cellSizeM;
    const depth = rows * cellSizeM;
    floor.scale.set(width, 1, depth);
    floor.position.set(originXZ[0] + width / 2, 0.01, originXZ[1] + depth / 2);
    outlineField(cells, cols, rows, OVERLAY.reachCells, uniforms.field.value.image.data);
    uniforms.field.value.needsUpdate = true;
  });
}
