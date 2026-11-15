// Is the wearer standing in ground the scan has marked as an obstacle?
// Pure arithmetic on a `hazard:update` grid, no three.js and no WebXR: node --test src/field/zone.test.js
//
// The scan does not take an obstacle off the map because the wearer walks into it (it did until
// 2026-11-15, scan/index.js). The wearer is warned instead: field/index.js raises the alert
// 'hazard-zone' (docs/INTERFACES.md section 3) while this says they are inside, and clears it
// when they are out again. A marked cell is structure, something standing on the floor, or a
// drop (scan/grid.js): all of them are places not to stand in.

import { isOff, numberOr } from '../core/params.js';

export const ZONE = {
  on: !isOff('zone'), // ?zone=0: no warning
  // In: a marked cell within this distance of the point on the floor under the head. About
  // where the feet and the body are; someone walking past a chair or through a doorway keeps
  // more than this from it.
  bodyM: numberOr('zoneM', 0.2),
  // Out: no marked cell within this, wider, distance. Standing at the rim of a marked patch
  // does not make the warning come and go.
  leaveM: 0.4,
  enterMs: 250, // in for this long before the warning comes up: cutting a corner in passing is not standing in it
  leaveMs: 600, // out for this long before it goes
  speakGapMs: 6000, // spoken at most this often, however often the wearer steps in and out
};

/**
 * True when a cell with the value 1 (obstacle) lies within `radiusM` of the room position
 * (x, z): the cell under it, or one whose nearest edge is that close. Unknown cells (255) and
 * ground outside the grid are not obstacles.
 * @param grid a `hazard:update` payload: { originXZ, cellSizeM, cols, rows, cells }
 */
export function obstacleWithin(grid, x, z, radiusM) {
  if (!grid?.cells || !(grid.cellSizeM > 0) || !Number.isFinite(x) || !Number.isFinite(z)) return false;
  const { originXZ, cellSizeM: cell, cols, rows, cells } = grid;
  const r = Math.max(0, radiusM);
  const c0 = Math.max(0, Math.floor((x - r - originXZ[0]) / cell));
  const c1 = Math.min(cols - 1, Math.floor((x + r - originXZ[0]) / cell));
  const r0 = Math.max(0, Math.floor((z - r - originXZ[1]) / cell));
  const r1 = Math.min(rows - 1, Math.floor((z + r - originXZ[1]) / cell));
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (cells[row * cols + col] !== 1) continue;
      // The nearest point of the cell's square to (x, z).
      const x0 = originXZ[0] + col * cell;
      const z0 = originXZ[1] + row * cell;
      const dx = x - Math.max(x0, Math.min(x0 + cell, x));
      const dz = z - Math.max(z0, Math.min(z0 + cell, z));
      if (dx * dx + dz * dz <= r * r) return true;
    }
  }
  return false;
}

/**
 * Follows the wearer over the grid and says when they have walked into marked ground and when
 * they are out of it again.
 * @param K bodyM, leaveM, enterMs, leaveMs (ZONE)
 */
export function createZoneWatch(K = ZONE) {
  let inside = false; // the warning is up
  let since = null; // when what is seen began to differ from `inside` (ms), or null while it agrees

  return {
    /**
     * The wearer is at (x, z) on `grid` at time `now` (ms). Returns 'enter' when they have been
     * in marked ground for enterMs, 'leave' when they have been clear of it for leaveMs, null
     * otherwise. Call it every frame, or at least several times in enterMs.
     */
    step(grid, x, z, now) {
      const differs = inside ? !obstacleWithin(grid, x, z, K.leaveM) : obstacleWithin(grid, x, z, K.bodyM);
      if (!differs) {
        since = null;
        return null;
      }
      since ??= now;
      if (now - since < (inside ? K.leaveMs : K.enterMs)) return null;
      inside = !inside;
      since = null;
      return inside ? 'enter' : 'leave';
    },

    /** Nothing to go by any more (no tracking, another mode, new room coordinates). True when the warning was up: it has to come down. */
    reset() {
      const was = inside;
      inside = false;
      since = null;
      return was;
    },

    /** The warning is up. */
    get inside() {
      return inside;
    },
  };
}
