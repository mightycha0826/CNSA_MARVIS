// Reads the headset's live depth image into the live grid (grid.js). Called by index.js five
// times a second (SCAN.depthMs), only when the session has `depth-sensing` (field mode, or ?depth=1).
//
// On the Quest 3 depth only exists as a texture (session.depthUsage 'gpu-optimized'): one layer
// per eye holding depth-buffer values (0..1) for a projection with the planes depthNear and
// depthFar. The left eye's layer is drawn into a small buffer, read back, and each sample is
// unprojected with the pose and projection the depth image was made with.
//
// The conventions follow three.js r187 (WebXRDepthSensing.js), Meta's Immersive Web SDK
// (depth-sensing-system.ts, depth-textures.ts) and the WebXR Depth Sensing spec.
// Not yet checked on the headset.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { addDepthView, depthTable } from './grid.js';

let reader = null; // { texture, target, bytes, quad, n, cfg, near, far, metres }, made on the first read

/** What the headset's depth image is, known from the first read on: for the scan's stats (and so the hub's log). */
export const depthImage = { width: 0, height: 0, samples: 0 };

/** @returns false when the browser had no depth image for this frame (nothing was added) */
export function readDepth(renderer, frame, grid, cfg) {
  const { session, xrFrame, refSpace } = frame;
  if (session.depthUsage !== 'gpu-optimized') throw new Error(`depth usage "${session.depthUsage}" is not supported, only gpu-optimized`);
  const views = xrFrame.getViewerPose(refSpace)?.views;
  const view = views?.find((v) => v.eye === 'left') ?? views?.[0];
  const depth = view && renderer.xr.getBinding().getDepthInformation(view);
  // No depth is normal on some frames: for a moment after the session starts, or between images.
  if (!depth?.texture || depth.isValid === false || !(depth.depthNear > 0)) return false;

  if (!reader) {
    // Never more samples per side than the image has pixels: two samples of one pixel are one
    // measurement counted twice, and minPoints is there to ask for several.
    const n = Math.max(1, Math.min(cfg.depthSamples, depth.width || cfg.depthSamples, depth.height || cfg.depthSamples));
    Object.assign(depthImage, { width: depth.width ?? 0, height: depth.height ?? 0, samples: n });
    console.info('[scan] live depth:', depth.width, 'x', depth.height, 'near', depth.depthNear, 'far', depth.depthFar, 'rawValueToMeters', depth.rawValueToMeters, 'samples per side', n);
    reader = {
      n,
      cfg: n === cfg.depthSamples ? cfg : { ...cfg, depthSamples: n },
      texture: new THREE.ExternalTexture(),
      target: new THREE.WebGLRenderTarget(n, n, { depthBuffer: false }),
      bytes: new Uint8Array(n * n * 4),
      quad: new FullScreenQuad(
        new THREE.ShaderMaterial({
          uniforms: { depthMap: { value: null }, layer: { value: 0 } },
          vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader: `
            uniform sampler2DArray depthMap;
            uniform int layer;
            varying vec2 vUv;
            void main() {
              // The one texel under the sample: a blend of a near and a far texel would be a point in mid-air.
              float b = texelFetch(depthMap, ivec3(vUv * vec2(textureSize(depthMap, 0).xy), layer), 0).r * 255.0;
              // 16 bits of depth in two bytes: one byte would blur everything beyond a metre into steps of tens of centimetres.
              gl_FragColor = vec4(floor(b) / 255.0, fract(b), 0.0, 1.0);
            }`,
          depthTest: false,
          depthWrite: false,
        }),
      ),
    };
  }
  const { texture, target, bytes, quad, n } = reader;
  texture.sourceTexture = depth.texture;
  quad.material.uniforms.depthMap.value = texture;
  quad.material.uniforms.layer.value = depth.imageIndex ?? 0;

  const gl = renderer.getContext();
  const before = renderer.getRenderTarget();
  try {
    renderer.xr.enabled = false; // draw into target, not into the headset's eyes
    renderer.setRenderTarget(target);
    // The browser hands out the same WebGLTexture every frame, pointed at a new image, and a
    // texture unit only follows when the texture is bound to it again. three.js skips a bind it
    // believes is still in place, so make it forget unit 0, the one this single-texture pass
    // uses. Without this some reads come back all zero or a frame old.
    renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, null, gl.TEXTURE0);
    quad.render(renderer);
    // Read while target is still the current one. After the restore three.js would re-bind the
    // wrong framebuffer of a multisampled headset target and that frame would come out empty.
    // shortcut: waits for the GPU at every read (five a second); if frames drop, switch to
    // readRenderTargetPixelsAsync, or read less often (?depthMs=350).
    renderer.readRenderTargetPixels(target, 0, 0, n, n, bytes);
  } finally {
    // index.js carries on after an error here, so the headset's target must be back either way.
    renderer.setRenderTarget(before);
    renderer.xr.enabled = true;
  }

  // Two bytes a sample -> metres, from a table made for this image's near and far planes (they
  // do not change from read to read; if they ever do, the table is made again).
  if (reader.near !== depth.depthNear || reader.far !== depth.depthFar) {
    reader.near = depth.depthNear;
    reader.far = depth.depthFar;
    reader.metres = depthTable(depth.depthNear, depth.depthFar);
  }
  const metres = reader.metres;
  addDepthView(
    grid,
    // sample (i, j) of n x n: readPixels rows run bottom to top, like v
    (u, v, i, j) => metres[(bytes[(j * n + i) * 4] << 8) | bytes[(j * n + i) * 4 + 1]],
    // The depth image's own camera (core/xr.js asks for it with matchDepthView: false); the eye's
    // on a browser that gives none.
    depth.projectionMatrix ?? view.projectionMatrix,
    (depth.transform ?? view.transform).matrix,
    reader.cfg,
  );
  return true;
}
