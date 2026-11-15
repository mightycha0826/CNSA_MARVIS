// What part of the world the mirror's picture shows. Pure arithmetic, no three.js and no WebXR:
// node --test src/core/mirror-view.test.js
//
// A view is given by four tangents, as seen from the eye looking down -z: how far it reaches to
// the left and right, down and up, at a distance of 1 ({ left, right, down, up }; left and down
// are negative). That is what a projection matrix holds, and it adds up across eyes: the
// wearer's whole view is the widest of what each eye sees.
//
// The headset shows far more than the camera the browser hands out: about 108 x 99 degrees on
// a Quest 3 against the camera's 73 x 58. A mirror drawn with the camera's lens shows the room
// large and loses what the wearer sees near the edge of their view (the hand-held map, the
// panels low in the view). So the mirror has two views:
//   'full'    the wearer's whole view, widened to the picture's shape, the camera picture lying
//             in the middle of it at its true size;
//   'camera'  the camera's own lens: the room fills the picture.

const RAD = Math.PI / 180;

/**
 * The view of a projection matrix (16 numbers, column by column, as WebXR and three.js give them).
 * Works for the lopsided projections of a headset's eyes.
 */
export function viewOfProjection(p) {
  return {
    left: (p[8] - 1) / p[0],
    right: (p[8] + 1) / p[0],
    down: (p[9] - 1) / p[5],
    up: (p[9] + 1) / p[5],
  };
}

/** The view of a lens that looks straight ahead: `fovDeg` from top to bottom, `aspect` = width / height. */
export function viewOfLens(fovDeg, aspect) {
  const up = Math.tan((fovDeg * RAD) / 2);
  return { left: -up * aspect, right: up * aspect, down: -up, up };
}

/** The widest of several views: everything any of them sees. Null when there is none. */
export function widest(views) {
  let out = null;
  for (const v of views) {
    if (!v || ![v.left, v.right, v.down, v.up].every(Number.isFinite) || !(v.right > v.left) || !(v.up > v.down)) continue;
    out = out
      ? { left: Math.min(out.left, v.left), right: Math.max(out.right, v.right), down: Math.min(out.down, v.down), up: Math.max(out.up, v.up) }
      : { ...v };
  }
  return out;
}

/**
 * `view` grown to the shape of the picture (`aspect` = width / height), never shrunk: the side
 * that is too short for the picture grows by the same amount on both of its ends, so what was
 * in the middle stays in the middle. `margin` first adds that share on every side (0.04: 4 %):
 * the eyes sit a little to the side of the point the mirror looks from, and something held
 * close to the face reaches a little further into view than it does from the middle.
 */
export function fitView(view, aspect, margin = 0) {
  let { left, right, down, up } = view;
  const mx = ((right - left) * margin) / 2;
  const my = ((up - down) * margin) / 2;
  left -= mx;
  right += mx;
  down -= my;
  up += my;
  const w = right - left;
  const h = up - down;
  if (w / h < aspect) {
    const more = (h * aspect - w) / 2;
    left -= more;
    right += more;
  } else {
    const more = (w / aspect - h) / 2;
    down -= more;
    up += more;
  }
  return { left, right, down, up };
}

/** How wide and how tall a view is, in degrees: [across, top to bottom]. For the status line. */
export function viewAngles(view) {
  return [(Math.atan(view.right) - Math.atan(view.left)) / RAD, (Math.atan(view.up) - Math.atan(view.down)) / RAD];
}

/**
 * The share of the picture a lens fills when it looks the same way as the view (no tilt):
 * { x, y, w, h } as fractions of the picture, x and y from the top left. Tells how large the
 * camera picture comes out in the whole view.
 */
export function shareOfView(view, lens) {
  const w = view.right - view.left;
  const h = view.up - view.down;
  return { x: (lens.left - view.left) / w, y: (view.up - lens.up) / h, w: (lens.right - lens.left) / w, h: (lens.up - lens.down) / h };
}

/** "1280x960" -> [1280, 960], held to what a headset can draw and send; the fallback when it says nothing usable. */
export function pictureSize(text, fallback = [1280, 960]) {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(text ?? '');
  if (!m) return fallback;
  const even = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) / 2) * 2));
  return [even(m[1], 320, 1920), even(m[2], 240, 1440)];
}
