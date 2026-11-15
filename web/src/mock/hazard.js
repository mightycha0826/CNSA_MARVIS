// Fake field obstacles (?mock=1 or ?mock=hazard).
// Sends `hazard:update` (INTERFACES section 3) once a second. 4 m × 4 m in room coordinates, 0.1 m cells.
// Every 20 seconds a chair-sized (0.5 m) obstacle stands on one side of the room (x≈0.5, z≈-0.6) for 12 seconds, then goes.
// The outermost two rows and columns of the grid are "not seen yet" (255).
//
// With mock.hazard (?mock=1 or ?mock=hazard), scan/index.js calls this function instead of the real scan.

const COLS = 40;
const ROWS = 40;
const CELL_M = 0.1;
const ORIGIN = [-2.0, -2.0];

/**
 * @param {{ emit: Function }} bus
 * @param {{ speed?: number }} opts
 * @returns {() => void} a function that stops it
 */
export function startMockHazard(bus, { speed = 1 } = {}) {
  const t0 = performance.now();
  function tick() {
    const t = (((performance.now() - t0) / 1000) * speed) % 20;
    const chair = t >= 6 && t < 18;
    const cells = new Uint8Array(COLS * ROWS);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col;
        if (row < 2 || col < 2 || row >= ROWS - 2 || col >= COLS - 2) {
          cells[i] = 255;
          continue;
        }
        const x = ORIGIN[0] + (col + 0.5) * CELL_M;
        const z = ORIGIN[1] + (row + 0.5) * CELL_M;
        if (chair && Math.abs(x - 0.5) < 0.25 && Math.abs(z + 0.6) < 0.25) cells[i] = 1;
      }
    }
    bus.emit('hazard:update', { originXZ: [...ORIGIN], cellSizeM: CELL_M, cols: COLS, rows: ROWS, cells, ts: Date.now() });
  }
  tick();
  const timer = setInterval(tick, Math.max(500, 1000 / speed)); // at most twice a second
  return () => clearInterval(timer);
}
