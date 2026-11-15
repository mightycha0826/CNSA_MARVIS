// HUD panels: a canvas drawn by draw.js, shown on a flat mesh.
//
// HTML is not visible inside an AR session, so every card of the HUD is a picture on a canvas
// that is put on a plane 1 m in front of the eyes (or, for the hand menus, somewhere in the
// room). Sizes are given in degrees of the field of view, as in the mockup.

import * as THREE from 'three';
import { HUD } from './config.js';

/** The length of one degree at the HUD's distance (m). */
export const UNIT = HUD.distanceM * Math.tan(Math.PI / 180);

/**
 * A panel `wDeg` x `hDeg` large: { canvas, g (its 2D context), tex, mat, mesh, wM, hM }.
 * Draw on `g`, then set `tex.needsUpdate`.
 */
export function makePanel(wDeg, hDeg, pxW = Math.round(wDeg * HUD.pxPerDeg), pxH = Math.round(hDeg * HUD.pxPerDeg)) {
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wDeg * UNIT, hDeg * UNIT), mat);
  mesh.renderOrder = 1000;
  return { canvas, g: canvas.getContext('2d'), tex, mat, mesh, wM: wDeg * UNIT, hM: hDeg * UNIT };
}

/** Put a panel on the plane in front of the eyes, at a rectangle given in the mockup's screen coordinates (degrees from the top left). */
export function placeOnStage(panel, leftDeg, topDeg, wDeg, hDeg) {
  panel.mesh.position.set((leftDeg + wDeg / 2 - HUD.stage.wDeg / 2) * UNIT, (HUD.stage.hDeg / 2 - topDeg - hDeg / 2) * UNIT, -HUD.distanceM);
  panel.mesh.quaternion.identity();
  panel.mesh.scale.setScalar(1);
}

/** The hit rectangle (as draw.js returns them: { id, x, y, w, h } in canvas pixels) under a point, or null. */
export function hitAt(hits, x, y) {
  return hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) ?? null;
}

/**
 * The alert light over the whole view: a sheet of colour fixed in front of the eyes, larger than
 * the field of view. It is a little weaker in the middle than toward the edges, so what the
 * wearer is looking at stays clear. Drawn under the HUD cards, over everything else.
 */
export function makeWash() {
  const N = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const g = canvas.getContext('2d');
  // The sheet is 3 m wide half a metre away; the view ends about 0.7 m from its centre, which
  // is where the gradient reaches full strength.
  const grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, (N / 2) * 0.47);
  grad.addColorStop(0, `rgba(255, 255, 255, ${HUD.wash.centre})`);
  grad.addColorStop(1, 'rgba(255, 255, 255, 1)');
  g.fillStyle = grad;
  g.fillRect(0, 0, N, N);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 3),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  mesh.name = 'hud-alert-wash';
  mesh.position.z = -0.5;
  mesh.renderOrder = 900; // after the map and the room, before the HUD cards (999 and up)
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}
