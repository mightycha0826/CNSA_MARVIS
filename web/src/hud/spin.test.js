// node --test src/hud/spin.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpin } from './spin.js';

// The numbers the app uses (HUD.suit.turnS and HUD.suit.spin in config.js).
const K = { turnS: 14, perM: 30, returnS: 1.5, maxRadS: 10, deadMps: 0.05, smoothS: 0.08, maxMps: 2.5 };
const USUAL = (Math.PI * 2) / K.turnS;
const HZ = 72;

/** Run `seconds` at `hz` frames a second with the hand moving sideways at speed(t) m/s (or null: no hand). Returns the highest and lowest rate seen. */
function run(spin, seconds, speed = () => 0, hz = HZ) {
  let max = -Infinity;
  let min = Infinity;
  const frames = Math.round(seconds * hz);
  for (let k = 0; k < frames; k++) {
    spin.step(1 / hz, speed(k / hz));
    const { rate } = spin.state();
    max = Math.max(max, rate);
    min = Math.min(min, rate);
  }
  return { max, min };
}

test('left alone it turns at its usual rate: once round in turnS seconds', () => {
  const spin = createSpin(K);
  let turned = 0;
  let before = 0;
  for (let k = 0; k < K.turnS * HZ; k++) {
    const angle = spin.step(1 / HZ, 0);
    turned += (angle - before + Math.PI * 2) % (Math.PI * 2);
    before = angle;
  }
  assert.ok(Math.abs(turned - Math.PI * 2) < 1e-6, `turned ${turned} rad in ${K.turnS} s`);
  assert.ok(Math.abs(spin.state().rate - USUAL) < 1e-12);
  // and with no hand to say anything (null) it is the same
  const other = createSpin(K);
  run(other, 3, () => null);
  assert.ok(Math.abs(other.state().rate - USUAL) < 1e-12);
});

test('the hand moving to the right turns it faster to the right; to the left it slows, stops and turns to the left', () => {
  const right = createSpin(K);
  const r = run(right, 0.3, () => 0.6); // 18 cm to the right in 0.3 s
  assert.ok(right.state().rate > USUAL + 3, `rate ${right.state().rate} after a move to the right`); // 18 cm: about half a turn a second more
  assert.ok(r.min >= USUAL - 1e-9, 'it never slowed on the way');

  const left = createSpin(K);
  const l = run(left, 0.3, () => -0.6);
  assert.ok(left.state().rate < -2, `rate ${left.state().rate} after a move to the left: it turns the other way`);
  assert.ok(l.max <= USUAL + 1e-9, 'it never sped up on the way');

  // The same move either way changes the rate by the same amount, opposite in sign.
  assert.ok(Math.abs(right.state().rate - USUAL + (left.state().rate - USUAL)) < 1e-9);
});

test('a longer or quicker move spins it more', () => {
  const after = (mps, seconds) => {
    const spin = createSpin(K);
    run(spin, seconds, () => mps);
    return spin.state().rate - USUAL;
  };
  assert.ok(after(0.6, 0.3) > after(0.3, 0.3) && after(0.3, 0.3) > 0);
  assert.ok(after(0.6, 0.3) > after(0.6, 0.15));
  // About perM for each metre moved: a little less, for the dead zone and for the way back that
  // has already begun. (The hand's speed is smoothed, so the last of the push comes just after the move.)
  const spin = createSpin(K);
  run(spin, 0.2, () => 1); // 20 cm
  const gained = run(spin, 0.3).max - USUAL;
  assert.ok(gained > 0.7 * K.perM * 0.2 && gained < K.perM * 0.2, `gained ${gained} rad/s over 20 cm`);
});

test('when the hand rests it comes back to its usual turn, fast at first, then ever more slowly, and never past it', () => {
  for (const mps of [0.8, -0.8]) {
    const spin = createSpin(K);
    run(spin, 0.3, () => mps);
    const off = spin.state().rate - USUAL;
    assert.ok(Math.abs(off) > 3);
    let last = Math.abs(off);
    let lastStep = Infinity;
    const at = {};
    for (let k = 1; k <= 12 * HZ; k++) {
      spin.step(1 / HZ, 0);
      const now = spin.state().rate - USUAL;
      assert.ok(Math.sign(now) === Math.sign(off) || Math.abs(now) < 1e-9, 'it does not swing past its usual turn');
      const gap = Math.abs(now);
      if (k > 0.5 * HZ) { // once the hand's own smoothed speed has died away
        assert.ok(gap <= last + 1e-12, 'always toward the usual turn');
        assert.ok(last - gap <= lastStep + 1e-12, 'in ever smaller steps');
        lastStep = last - gap;
      }
      last = gap;
      if (k === Math.round(K.returnS * HZ) || k === Math.round(4 * K.returnS * HZ)) at[k] = gap;
    }
    const [one, four] = Object.values(at);
    assert.ok(four < 0.06 * Math.abs(off), `after four time constants ${four} of ${Math.abs(off)} rad/s is left`);
    assert.ok(one > four * 10);
    assert.ok(last < 0.01, `back at the usual turn after 12 s: ${last} rad/s off`);
  }
});

test('the trembling of a hand held still does not turn it', () => {
  const spin = createSpin(K);
  // Hand tracking puts the palm a few millimetres off, anew in every frame (here up to 2 mm
  // either way, which between two frames looks like a speed of up to 0.29 m/s).
  let seed = 7;
  const jitterM = () => (((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5) * 0.004;
  let at = 0;
  const { max, min } = run(spin, 20, () => {
    const next = jitterM();
    const mps = (next - at) * HZ;
    at = next;
    return mps;
  });
  assert.ok(max - USUAL < 0.1 && USUAL - min < 0.1, `the rate stayed between ${min} and ${max} around ${USUAL}`);
  // A slow drift below the dead zone does nothing at all.
  const still = createSpin(K);
  run(still, 5, () => 0.04);
  assert.ok(Math.abs(still.state().rate - USUAL) < 1e-12);
});

test('it never turns faster than maxRadS, whatever the tracking says', () => {
  for (const wild of [50, -50, Infinity, -Infinity]) {
    const spin = createSpin(K);
    const { max, min } = run(spin, 3, () => wild);
    assert.ok(max <= K.maxRadS + 1e-9 && min >= -K.maxRadS - 1e-9, `between ${min} and ${max} for ${wild}`);
    assert.ok(Number.isFinite(spin.state().angle));
  }
  // What is not a number says nothing; time that did not pass, or is not a number, changes nothing.
  const spin = createSpin(K);
  spin.step(1 / HZ, NaN);
  spin.step(1 / HZ, undefined);
  assert.ok(Math.abs(spin.state().rate - USUAL) < 1e-12);
  const before = spin.state();
  for (const dt of [0, -1, NaN, Infinity]) spin.step(dt, 1);
  assert.deepEqual(spin.state(), before);
});

test('it turns the same whatever the frame rate, and a long frame does not throw it', () => {
  const flick = (t) => (t < 0.5 ? 0.4 : 0); // the same move of the hand: 20 cm in half a second (a whole number of frames at each rate)
  const rates = [30, 72, 90, 120].map((hz) => {
    const spin = createSpin(K);
    run(spin, 1, flick, hz);
    return spin.state().rate;
  });
  for (const rate of rates) assert.ok(Math.abs(rate - rates[1]) < 0.03 * Math.abs(rates[1] - USUAL), `rates at 30, 72, 90, 120 Hz: ${rates.map((r) => r.toFixed(3))}`);
  // A frame that took two seconds in the middle of a move: no jump beyond what the hand could give, and it settles.
  const spin = createSpin(K);
  run(spin, 0.2, () => 0.7);
  spin.step(2, 0.7);
  assert.ok(Math.abs(spin.state().rate) <= K.maxRadS + 1e-9);
  run(spin, 12);
  assert.ok(Math.abs(spin.state().rate - USUAL) < 0.01);
});

test('the angle stays within one turn, and rest() gives back the usual turn without turning the figure', () => {
  const spin = createSpin(K);
  for (let k = 0; k < 2000; k++) {
    const angle = spin.step(1 / HZ, k % 300 < 100 ? -2 : 2);
    assert.ok(angle >= 0 && angle < Math.PI * 2);
  }
  const { angle } = spin.state();
  spin.rest();
  assert.deepEqual(spin.state(), { angle, rate: USUAL, usual: USUAL, push: 0 });
});
