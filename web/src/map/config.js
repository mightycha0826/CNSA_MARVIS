import { numberOr } from '../core/params.js';

export const MAP = Object.freeze({
  widthM: 0.3, // the hologram's width (it was 0.25): a wider view of either map
  desktopScale: 8,
  // The relief is a mesh of this many vertices per side over the 512 cells of the data. 257:
  // a vertex every other cell, 8 m apart, which is the baseline the slope layer is computed
  // over, so the ground is drawn as steep as the data says it is (terrain.test.js). It was
  // 129 (16 m): the relief then showed slopes 2.4 degrees off the slope layer on average,
  // now 1.5, and its light (the terrain's own normals, terrain.js) 1.2 over every cell. 131,072
  // triangles where there were 32,768, and the surface is see-through and two-sided, so each
  // eye draws it twice: 524,288 triangles a frame for both eyes, 131,072 with the mesh of
  // before. Not checked on the headset: ?mapMesh=129 gives the mesh of before back without a
  // build, lit as it was. The address can only make the mesh coarser (65 to 257).
  maxVerticesPerSide: Math.max(65, Math.min(257, Math.round(numberOr('mapMesh', 257)))),
  // The terrain's own normals light the relief only when its vertices are at most this many
  // cells apart; a coarser mesh is lit from its own faces (terrain.js: terrainArrays).
  ownNormalsMaxCells: 2,
  desktopTiltRad: 0.55, palmUpDot: -0.35, holdMs: 200, followRate: 18, textureMaxSize: 2048,
  // In the headset the circle shows the part of the map around the wearer: the map is `zoom`
  // times larger than fits the circle (1 km of its 2 km in view). A fist under it unfolds it:
  // the circle opens (unfoldFade: how far, 1 = none of it left) and the whole map shows at
  // that same scale, drawn only unfoldEnlarge times larger: more ground, not larger ground.
  // The PC view shows the whole map as it is.
  zoom: 2, unfoldEnlarge: 1.3, unfoldFade: 0.75 });
// Published HUD legend colours; no import of another module's runtime.
export const RAMPS = {
  topo: [[18, 42, 74], [32, 120, 128], [196, 170, 110], [250, 246, 232]],
  slope: [[236, 236, 244], [150, 130, 200], [60, 20, 110]],
  thermal: [[10, 6, 40], [110, 30, 120], [230, 110, 40], [252, 240, 150]],
};
export function rampColor(id, value) {
  const ramp = RAMPS[id] ?? [[30, 30, 30], [240, 240, 240]];
  const t = (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(t)), f = t - i;
  return ramp[i].map((v, k) => Math.round(v + (ramp[i + 1][k] - v) * f));
}
