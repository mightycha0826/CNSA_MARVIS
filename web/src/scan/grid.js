// Live layer of the floor grid: what the depth sensor sees right now, on the same cells as the
// room scan (room.js). Pure arithmetic, no three.js and no WebXR: node --test src/scan/grid.test.js
//
// The room scan only ever adds structure. This layer can also take it away again: a cell turns
// into an obstacle once something has been seen standing in it in setScans reads in a row, and
// back into floor once the sensor has seen nothing but floor there clearScans times.
//
// A drop is in the way like a thing is: where the ground lies more than dropMinM below the
// floor the wearer stands on (a stair going down, a kerb, a pit), the cells are marked as an
// obstacle, by the same counting. There is one floor level, y = 0: other storeys are not
// mapped, only where the floor ends.
//
// Matrices come as WebXR gives them: Float32Array(16), column-major.
//   P = projectionMatrix,  M = transform.matrix (eye -> room coordinates)

import { shiftCells } from './tiles.js';

export const PASSABLE = 0;
export const OBSTACLE = 1;
export const UNKNOWN = 255;

/**
 * cfg: thingMinM, headM, floorNoiseM, dropMinM (0 or absent: drops are not marked), minPoints, setScans, clearScans, forgetScans,
 * farM and farSetScans (absent: every cell takes setScans), and for
 * settling: settleScans, resettleScans, giveUpScans, leaveM, vantageM, depthRangeM, bodyM, viewHalfDeg (SCAN in index.js).
 * commitAll: commit() looks at every cell every time, as it did before 2026-11-15 (the test that compares the two).
 *
 * Settling (cfg.settleScans > 0; off by default, SCAN.settleScans says why): a cell that has been read settleScans times in a row with the
 * same answer is settled and is not read any more: points that fall into it are dropped. So is
 * a cell that stayed in view giveUpScans times without ever giving an answer (behind something,
 * under the lower edge of the image). The sensor's time then goes to cells that are still open,
 * and unsettledInView says when there are none in view, so the caller can skip the read.
 * A settled cell is opened again when the wearer comes back after having been more than leaveM
 * away from it, and, while it is in view, every so often by refresh(), which keeps the sensor
 * looking at ground it knows at a steady, lower rate. A given-up one is also opened as soon as the wearer looks from somewhere else
 * or in another direction (view.sig changes): it may be in the picture now.
 *
 * The grid is a window on a floor without an edge (tiles.js): `shift` moves it by whole cells
 * with everything it knows about the cells that stay, and `restore` lays back cells that were
 * in it before.
 */
export function createGrid(cols, rows, cellM, originXZ, cfg) {
  const n = cols * rows;
  let origin = [originXZ[0], originXZ[1]]; // room coordinates of cell [0, 0]; moves with shift
  const cells = new Uint8Array(n).fill(UNKNOWN);
  const sightings = new Uint8Array(n); // reads so far that saw an obstacle here, up to setScans
  const hold = new Uint8Array(n); // floor-only reads still needed before the obstacle is cleared
  const unseen = new Uint8Array(n); // reads since the cell last got a point, up to forgetScans (when that is on)
  const obstacle = new Uint16Array(n); // points that fell into the cell during this read
  const floor = new Uint16Array(n);
  const settled = new Uint8Array(n); // 1: read often enough, left alone until the wearer comes back
  const same = new Uint8Array(n); // reads in a row that gave the answer the cell already has
  const idle = new Uint8Array(n); // reads in a row in which the cell was in view and gave no answer
  const away = new Uint8Array(n); // the wearer has been more than leaveM from this settled cell
  const gaveUp = new Int32Array(n); // for a cell settled without an answer: the view.sig it was given up from, else 0
  const stamp = new Float64Array(n); // when the cell settled (ms, the caller's clock): refresh() opens the oldest again
  const settling = cfg.settleScans > 0;
  let settledCount = 0;
  const cosHalf = Math.cos(((cfg.viewHalfDeg ?? 40) * Math.PI) / 180);
  const dropBelow = cfg.dropMinM > 0 ? -cfg.dropMinM : -Infinity; // ground lower than this is a drop

  // What a commit has to look at. A cell that got no point in this read, has no sighting that
  // waits for its next one, and lies out of the view's reach is left exactly as it is by
  // commit(), so its loop runs over the box around the other cells only: a few thousand within
  // reach of the wearer, of the 65,536 in the scan's window, ten times a second.
  // A box is [col0, col1, row0, row1]; it is empty while col0 > col1.
  const touched = [cols, -1, rows, -1]; // cells that got a point since the last commit
  const waiting = [cols, -1, rows, -1]; // cells that hold a sighting the next read has to confirm or drop
  let whole = true; // the next commit looks at every cell: the first one, and after cells were moved or laid back

  // Whether cell i is where the depth image can see it from `view` { x, z, dirX, dirZ }: within
  // range along the floor and within viewHalfDeg of where the wearer faces. (dirX, dirZ) is the
  // facing direction on the floor, unit length, or 0, 0 when looking straight down or up.
  function inView(i, view) {
    const dx = origin[0] + ((i % cols) + 0.5) * cellM - view.x;
    const dz = origin[1] + (Math.floor(i / cols) + 0.5) * cellM - view.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < cfg.bodyM ** 2 || d2 > cfg.depthRangeM ** 2) return false;
    if (!view.dirX && !view.dirZ) return true;
    return dx * view.dirX + dz * view.dirZ >= cosHalf * Math.sqrt(d2);
  }

  // Rows and columns that hold every cell within depthRangeM of the wearer.
  function reach(view) {
    const k = Math.ceil(cfg.depthRangeM / cellM) + 1;
    const c = Math.floor((view.x - origin[0]) / cellM);
    const r = Math.floor((view.z - origin[1]) / cellM);
    return [Math.max(0, c - k), Math.min(cols - 1, c + k), Math.max(0, r - k), Math.min(rows - 1, r + k)];
  }

  function settle(i, sig = 0, now = 0) {
    settled[i] = 1;
    settledCount++;
    away[i] = 0;
    gaveUp[i] = sig;
    stamp[i] = now;
  }

  return {
    cells,

    /**
     * Add one point in room coordinates to the current read.
     * @param weight how many points a floor point counts for: 1, or more where the depth image
     *               lies thin on the floor (addDepthView). A thing point always counts once.
     */
    add(x, y, z, weight = 1) {
      const col = Math.floor((x - origin[0]) / cellM);
      const row = Math.floor((z - origin[1]) / cellM);
      if (!(col >= 0 && row >= 0 && col < cols && row < rows)) return; // also drops NaN
      const i = row * cols + col;
      if (settled[i]) return; // read often enough: nothing more to learn here for now
      // A thing standing here, or ground far enough below the floor that stepping here is a fall.
      if ((y > cfg.thingMinM && y < cfg.headM) || y < dropBelow) obstacle[i]++;
      // Between floorNoiseM and thingMinM (and as far below the floor) a noisy depth point could be either: it counts as neither.
      else if (Math.abs(y) <= cfg.floorNoiseM) floor[i] += weight;
      else return;
      if (col < touched[0]) touched[0] = col;
      if (col > touched[1]) touched[1] = col;
      if (row < touched[2]) touched[2] = row;
      if (row > touched[3]) touched[3] = row;
    },

    /**
     * Fold the current read into the cells. True when a cell changed.
     * A cell where the read is unclear (too few points, or floor with a little of something
     * else) keeps its state. So does a cell that was not seen: an obstacle stays on the map
     * until the sensor sees clear floor where it stood. Only with cfg.forgetScans > 0 is an
     * obstacle forgotten after that many reads out of sight.
     * @param view the wearer's view for this read (viewOf); needed for giving up on cells
     */
    commit(view = null) {
      let changed = false;
      // The box to look at: every cell, or the cells that got a point, those with a sighting
      // waiting, and those the view reaches (which may give up for want of an answer).
      let c0 = 0;
      let c1 = cols - 1;
      let r0 = 0;
      let r1 = rows - 1;
      if (!(whole || cfg.commitAll || cfg.forgetScans > 0)) { // forgetScans counts reads for every cell out of sight
        c0 = Math.min(touched[0], waiting[0]);
        c1 = Math.max(touched[1], waiting[1]);
        r0 = Math.min(touched[2], waiting[2]);
        r1 = Math.max(touched[3], waiting[3]);
        if (view && settling && cfg.giveUpScans > 0) {
          const seen = reach(view);
          if (seen[0] <= seen[1] && seen[2] <= seen[3]) {
            c0 = Math.min(c0, seen[0]);
            c1 = Math.max(c1, seen[1]);
            r0 = Math.min(r0, seen[2]);
            r1 = Math.max(r1, seen[3]);
          }
        }
      }
      whole = false;
      // Beyond farM a thing has to be seen farSetScans times in a row (the far rule, below).
      const far2 = view && cfg.farM > 0 && cfg.farSetScans > cfg.setScans ? cfg.farM ** 2 : Infinity;
      touched[0] = waiting[0] = cols;
      touched[2] = waiting[2] = rows;
      touched[1] = touched[3] = waiting[1] = waiting[3] = -1;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * cols + c;
          if (settled[i]) continue;
          let next = cells[i];
          const answered = obstacle[i] >= cfg.minPoints || (floor[i] >= cfg.minPoints && obstacle[i] === 0);
          if (obstacle[i] >= cfg.minPoints) {
            // Seen in setScans reads in a row before it counts: someone walking past and stray depth do not.
            // Farther than farM from the wearer it takes farSetScans: depth is less exact there,
            // nothing that far away is in the way yet, and a cell that comes and goes at that
            // distance is a new map, a new glow and a new route each time.
            let need = cfg.setScans;
            if (far2 < Infinity) {
              const dx = origin[0] + (c + 0.5) * cellM - view.x;
              const dz = origin[1] + (r + 0.5) * cellM - view.z;
              if (dx * dx + dz * dz > far2) need = cfg.farSetScans;
            }
            if (sightings[i] < need) sightings[i]++;
            if (sightings[i] >= need) {
              hold[i] = cfg.clearScans;
              next = OBSTACLE;
            }
          } else if (floor[i] >= cfg.minPoints && obstacle[i] === 0) {
            sightings[i] = 0;
            if (hold[i]) hold[i]--;
            next = hold[i] ? OBSTACLE : PASSABLE;
          } else if (next !== OBSTACLE) {
            sightings[i] = 0; // not seen as a thing in this read: the count starts over
          }
          if (obstacle[i] || floor[i]) unseen[i] = 0;
          else if (cfg.forgetScans > 0 && unseen[i] < cfg.forgetScans && ++unseen[i] === cfg.forgetScans) {
            sightings[i] = hold[i] = 0;
            if (next === OBSTACLE) next = UNKNOWN;
          }
          if (settling) {
            // The read says what the cell already is: a thing seen where an obstacle stands,
            // bare floor seen where the floor is clear. (A first sighting of something on clear
            // floor is an answer too, but the opposite one.)
            const thing = obstacle[i] >= cfg.minPoints;
            if (answered && next === cells[i] && next === (thing ? OBSTACLE : PASSABLE)) {
              idle[i] = 0;
              if (++same[i] >= cfg.settleScans) settle(i, 0, view?.now ?? 0);
            } else if (answered || next !== cells[i]) {
              same[i] = idle[i] = 0; // still changing, or an obstacle being confirmed
            } else if (view && cfg.giveUpScans > 0 && inView(i, view)) {
              if (++idle[i] >= cfg.giveUpScans) settle(i, view.sig || 1, view.now ?? 0); // in view all this time and nothing to see
            }
          }
          if (next !== cells[i]) {
            cells[i] = next;
            changed = true;
          }
          obstacle[i] = floor[i] = 0;
          // A sighting that has not made an obstacle yet: the next commit must come back here,
          // points or not, to count it on or to drop it.
          if (sightings[i] && next !== OBSTACLE) {
            if (c < waiting[0]) waiting[0] = c;
            if (c > waiting[1]) waiting[1] = c;
            if (r < waiting[2]) waiting[2] = r;
            if (r > waiting[3]) waiting[3] = r;
          }
        }
      }
      return changed;
    },

    /**
     * Open settled cells again where the wearer has come back: call before each read.
     * Returns how many were opened.
     */
    reopen(view) {
      if (!settledCount) return 0;
      let opened = 0;
      const leave2 = cfg.leaveM ** 2;
      const range2 = cfg.depthRangeM ** 2;
      for (let i = 0; i < n; i++) {
        if (!settled[i]) continue;
        const dx = origin[0] + ((i % cols) + 0.5) * cellM - view.x;
        const dz = origin[1] + (Math.floor(i / cols) + 0.5) * cellM - view.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > leave2) away[i] = 1;
        else if (d2 <= range2 && (away[i] || (gaveUp[i] && gaveUp[i] !== (view.sig || 1)))) {
          settled[i] = same[i] = idle[i] = away[i] = 0;
          settledCount--;
          opened++;
        }
      }
      return opened;
    },

    /**
     * Look again at what is settled: every settled cell in view that settled more than
     * `minAgeMs` ago is opened. It is not treated as new: if the next cfg.resettleScans reads
     * say what the cell already is, it settles again; a read that says otherwise starts the
     * usual counting, so a chair put down on floor that was settled is marked, and one taken
     * away is cleared. Without this, settled ground would only be read again after the wearer
     * had been away from it (the "chair problem"). Returns how many cells were opened.
     */
    refresh(view, now, minAgeMs) {
      if (!settling || !settledCount) return 0;
      const again = cfg.resettleScans ?? 2;
      const [c0, c1, r0, r1] = reach(view);
      let opened = 0;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * cols + c;
          if (!settled[i] || now - stamp[i] < minAgeMs || !inView(i, view)) continue;
          settled[i] = away[i] = 0;
          gaveUp[i] = 0;
          same[i] = Math.max(0, cfg.settleScans - again);
          idle[i] = Math.max(0, (cfg.giveUpScans ?? 0) - again);
          settledCount--;
          opened++;
        }
      }
      return opened;
    },

    /** True when a cell the depth image can see from `view` is still open: worth a read. */
    unsettledInView(view) {
      if (!settling) return true;
      const [c0, c1, r0, r1] = reach(view);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const i = r * cols + c;
          if (!settled[i] && inView(i, view)) return true;
        }
      }
      return false;
    },

    /**
     * Move the window: what was at column c + dCols, row r + dRows is at (c, r) afterwards, and
     * cell [0, 0] stands at `nextOriginXZ`. A cell that stays keeps its state and every counter.
     * A cell that comes in is unknown and open, with nothing counted.
     */
    shift(dCols, dRows, nextOriginXZ) {
      shiftCells(cells, cols, rows, dCols, dRows, UNKNOWN);
      for (const a of [sightings, hold, unseen, obstacle, floor, settled, same, idle, away, gaveUp, stamp]) shiftCells(a, cols, rows, dCols, dRows, 0);
      origin = [nextOriginXZ[0], nextOriginXZ[1]];
      settledCount = 0;
      for (let i = 0; i < n; i++) settledCount += settled[i];
      whole = true; // every cell has moved: the boxes commit() keeps are of the old places
    },

    /**
     * Lay back a square of cells that were in the window before (`values`, side x side, at
     * column col, row row). What is known comes back settled and marked as left behind: it
     * is not read from where the wearer stands now, and is opened like any cell the wearer
     * returns to once it is within depth range again (reopen). An obstacle comes back as one
     * that was confirmed, so it still takes clearScans reads of bare floor to remove it.
     */
    restore(col, row, side, values) {
      for (let r = 0; r < side; r++) {
        for (let c = 0; c < side; c++) {
          if (!(col + c >= 0 && row + r >= 0 && col + c < cols && row + r < rows)) continue;
          const i = (row + r) * cols + col + c;
          const value = values[r * side + c];
          if (settled[i]) settledCount--;
          cells[i] = value;
          sightings[i] = value === OBSTACLE ? cfg.setScans : 0;
          hold[i] = value === OBSTACLE ? cfg.clearScans : 0;
          unseen[i] = obstacle[i] = floor[i] = same[i] = idle[i] = gaveUp[i] = 0;
          settled[i] = away[i] = value === UNKNOWN ? 0 : 1;
          if (settled[i]) settledCount++;
        }
      }
      whole = true; // counts were laid back outside any read: let the next commit look at everything once
    },

    get settledCount() {
      return settledCount;
    },

    /** Room coordinates of cell [0, 0]. */
    get originXZ() {
      return [origin[0], origin[1]];
    },
  };
}

/**
 * Where the wearer is and looks, from the head's matrix (column-major, head -> room):
 * x, z on the floor; dirX, dirZ the facing direction along the floor (0, 0 when looking nearly
 * straight up or down); sig, a number that changes when the wearer has moved about vantageM,
 * turned about 30 degrees or tilted the head about 20 degrees: a different picture.
 */
export function viewOf(m, vantageM = 1) {
  const fx = -m[8];
  const fy = -m[9];
  const fz = -m[10];
  const flat = Math.hypot(fx, fz);
  const level = flat > 0.2;
  const turn = level ? Math.round(Math.atan2(fx, fz) / (Math.PI / 6)) + 6 : 13; // 0..12, 13 = straight up or down
  const tilt = Math.round(Math.asin(Math.max(-1, Math.min(1, fy))) / (Math.PI / 9)) + 5; // 0..10
  const px = Math.round(m[12] / vantageM) + 512;
  const pz = Math.round(m[14] / vantageM) + 512;
  return { x: m[12], z: m[14], dirX: level ? fx / flat : 0, dirZ: level ? fz / flat : 0, sig: 1 + turn + 16 * (tilt + 16 * (px + 1024 * pz)) };
}

/**
 * The cells to send: the room scan with the live layer on top. Live depth adds obstacles and
 * fills in floor the room scan knows nothing about; it never removes structure the room scan
 * put there (depth looks straight through glass, and misses thin things).
 * @returns cells, and counts: obstacles, floor, depth (cells live depth blocks right now)
 */
export function mergeLayers(room, live) {
  const cells = room.slice();
  let obstacles = 0;
  let floor = 0;
  let depth = 0;
  for (let i = 0; i < cells.length; i++) {
    if (live[i] === OBSTACLE) {
      cells[i] = OBSTACLE;
      depth++;
    } else if (live[i] === PASSABLE && cells[i] === UNKNOWN) cells[i] = PASSABLE;
    if (cells[i] === OBSTACLE) obstacles++;
    else if (cells[i] === PASSABLE) floor++;
  }
  return { cells, obstacles, floor, depth };
}

/**
 * How many samples of a depth image land in one floor cell 1 m from the camera (along its
 * axis), seen from eyeM above the floor: at depth d it is this number over d cubed. One sample
 * stands for d^3 * du * dv / eyeM square metres of floor, du and dv being the step from sample
 * to sample as tangents (2 / (P[0] * samples) and 2 / (P[5] * samples)); that holds however the
 * head is turned or tilted. 0 when the camera is not above the floor.
 */
export function floorSamplesAt1m(P, samples, eyeM, cellM) {
  return eyeM > 0 ? (cellM * cellM * eyeM * P[0] * P[5] * samples * samples) / 4 : 0;
}

/**
 * How far along the floor a depth image can clear what it marks: the distance at which a floor
 * cell still gets `points` of its samples. Farther out, a thing would be marked by the many
 * samples on its side and stay on the map after it is gone, for want of samples on the floor.
 * A Quest 3 eye at 1.6 m, 2 points: 5.4 m with 320 samples a side, 5.0 with 288, 3.8 with 192.
 */
export function floorReachM(P, samples, eyeM, cellM, points) {
  return Math.cbrt(floorSamplesAt1m(P, samples, eyeM, cellM) / points);
}

// Scratch for addDepthView, one entry per sample column: the part of each sample's direction
// that depends on the column alone. Grown when a larger sample count comes; never per read.
let colX = new Float64Array(0);
let colY = new Float64Array(0);
let colZ = new Float64Array(0);

/**
 * Add one eye's depth image to the grid.
 * @param depthAt (u, v, i, j) -> distance from the camera plane in metres; u, v in 0..1 with
 *                (0, 0) at the bottom left of the image, and i, j the same sample as column and
 *                row (0 .. depthSamples - 1), for a caller that holds exactly that many; 0 when unknown
 * @param cfg depthSamples, depthRangeM, bodyM, cellM, thingMinM, dropMinM, minPoints, farPoints
 * @returns how far this read reached along the floor, in metres: depthRangeM, or less (below)
 */
export function addDepthView(grid, depthAt, P, M, cfg) {
  const s = cfg.depthSamples;
  // The samples thin out on the floor with the cube of the distance, so what a floor cell needs
  // to say "floor" follows them: minPoints where it gets plenty, farPoints where it would get
  // fewer than twice that (a floor point then counts for more, grid.add), and where it would
  // not even get farPoints the read ends: nothing is marked there, because the floor could not
  // clear it again. So the scan reaches depthRangeM only if the image is fine enough for it: a
  // smaller depth image than asked for, ?depthSamples, or a wearer who sits down shorten it.
  const perCell = floorSamplesAt1m(P, s, M[13], cfg.cellM);
  const farPoints = cfg.farPoints > 0 ? Math.min(cfg.farPoints, cfg.minPoints) : cfg.minPoints;
  const reach = perCell > 0 ? Math.min(cfg.depthRangeM, Math.cbrt(perCell / farPoints)) : cfg.depthRangeM;
  const thin = perCell > 0 && farPoints < cfg.minPoints ? Math.cbrt(perCell / (2 * farPoints)) : Infinity; // depth beyond which farPoints will do
  const farWeight = Math.ceil(cfg.minPoints / farPoints);
  const nearest = cfg.bodyM ** 2;
  const farthest = reach ** 2;
  const nearestThing = (cfg.bodyM + 2 * cfg.cellM) ** 2;
  const farthestThing = (reach - 2 * cfg.cellM) ** 2;
  const thingMinM = cfg.thingMinM;
  const dropMinM = cfg.dropMinM > 0 ? cfg.dropMinM : 0;
  const cellM = cfg.cellM;
  // The eye's place and the three columns of its rotation, as plain numbers: this loop runs
  // for every sample of every read (depthSamples squared: 82,944 times at 288), and reading them out of the matrices
  // each time was most of what a read cost.
  const ox = M[12];
  const oy = M[13];
  const oz = M[14];
  const m0 = M[0], m1 = M[1], m2 = M[2];
  const m4 = M[4], m5 = M[5], m6 = M[6];
  const m8 = M[8], m9 = M[9], m10 = M[10];
  const p0 = P[0], p5 = P[5], p8 = P[8], p9 = P[9];
  // Undo the projection: the eye-space point at screen position (-1..1) and depth d is
  // d * ((2u - 1 + P[8]) / P[0], (2v - 1 + P[9]) / P[5], -1). Holds for the off-centre frustum
  // of a headset eye (P[8], P[9]). In room coordinates that is the eye plus d times a direction
  // which is a sum of a part for the sample's column and a part for its row.
  if (colX.length < s) {
    colX = new Float64Array(s);
    colY = new Float64Array(s);
    colZ = new Float64Array(s);
  }
  for (let i = 0; i < s; i++) {
    const ax = (2 * ((i + 0.5) / s) - 1 + p8) / p0;
    colX[i] = m0 * ax;
    colY[i] = m1 * ax;
    colZ[i] = m2 * ax;
  }
  for (let j = 0; j < s; j++) {
    const v = (j + 0.5) / s;
    const ay = (2 * v - 1 + p9) / p5;
    const rowX = m4 * ay - m8;
    const rowY = m5 * ay - m9;
    const rowZ = m6 * ay - m10;
    for (let i = 0; i < s; i++) {
      const d = depthAt((i + 0.5) / s, v, i, j);
      if (!(d > 0)) continue;
      // The point seen, measured from the eye (hx, hy, hz), in room axes.
      const hx = d * (colX[i] + rowX);
      const hz = d * (colZ[i] + rowZ);
      // Both limits are measured along the floor from the headset, so a cell is in or out for
      // the things standing in it and for the floor under them alike. Measured from the eye, a
      // chair would be marked farther out than the floor that later has to clear it.
      const along = hx * hx + hz * hz;
      const wy = oy + d * (colY[i] + rowY);
      if (dropMinM > 0 && wy < -dropMinM && Number.isFinite(wy) && oy > 0) {
        // The ray went through where the floor should be and met ground lower down: the floor
        // ends here. It is missing from where the ray crossed floor level to where it landed,
        // and that whole stretch is marked: the near part of the lower ground is hidden behind
        // the edge, and would otherwise stay unknown, which the route may cross.
        // Limits as for things, measured where the floor is missing, not where the ray landed:
        // the bottom of a deep drop is far away while its edge is at the wearer's feet.
        const t = oy / (oy - wy); // the part of the way from the eye to the point at which the ray is at floor level
        const ex = hx * t;
        const ez = hz * t;
        // One sample in four walks the stretch (every other column of every other row), a point
        // a cell. Every sample doing it laid far more than a cell needs (at 288 samples a side a
        // read with a drop in view cost nine times the work of before 2026-11-15), and two stray
        // too-far samples through one cell were enough to mark a drop on bare floor. The other
        // three lay only the point where their ray crossed floor level: that is where the edge
        // is, and it gives the first cells behind an edge as many points as a floor cell gets,
        // so a drop is marked from its edge on as far out as floor is told (grid.test.js).
        const steps = (i | j) & 1 ? 0 : Math.min(40, Math.ceil(Math.hypot(hx - ex, hz - ez) / cellM));
        for (let k = 0; k <= steps; k++) {
          const f = steps ? k / steps : 0;
          const px = ex + (hx - ex) * f;
          const pz = ez + (hz - ez) * f;
          const a = px * px + pz * pz;
          if (a > farthestThing) break;
          if (a >= nearestThing) grid.add(ox + px, wy, oz + pz);
        }
        continue;
      }
      if (!(along >= nearest && along <= farthest)) continue; // the wearer's own body, or too far to trust
      // Things count two cells inside those limits only. A cell the limit cuts through would be
      // marked from the strip that is in range, and that strip of floor is too thin to clear it.
      if (wy > thingMinM && !(along >= nearestThing && along <= farthestThing)) continue;
      grid.add(ox + hx, wy, oz + hz, d > thin ? farWeight : 1);
    }
  }
  return reach;
}

/**
 * Depth-buffer value (0..1) -> distance from the camera plane in metres, for a projection with
 * the planes near and far. A far plane that is infinite or not beyond near means there is none
 * (the Quest reports Infinity). 0 (no data) and 1 (nothing there) give 0.
 */
export function depthBufferToMeters(b, near, far) {
  if (!(b > 0 && b < 1)) return 0;
  return far > near && far !== Infinity ? (near * far) / (far - b * (far - near)) : near / (1 - b);
}

/**
 * The same conversion for every value a depth sample can have, worked out once: the depth image
 * is read as two bytes a sample (depth.js), so there are 65,536 of them, and a read asks for
 * more samples than that (82,944 at 288 a side). table[high * 256 + low] is the distance in
 * metres for the bytes (high, low).
 */
export function depthTable(near, far) {
  const table = new Float32Array(65536);
  for (let high = 0; high < 256; high++) {
    for (let low = 0; low < 256; low++) table[high * 256 + low] = depthBufferToMeters((high + low / 255) / 255, near, far);
  }
  return table;
}
