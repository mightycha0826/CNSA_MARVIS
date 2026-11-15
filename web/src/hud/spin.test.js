// node --test src/hud/spin.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpin, createHandWatch } from './spin.js';

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

test('the angle stays within one turn', () => {
  const spin = createSpin(K);
  for (let k = 0; k < 2000; k++) {
    const angle = spin.step(1 / HZ, k % 300 < 100 ? -2 : 2);
    assert.ok(angle >= 0 && angle < Math.PI * 2);
  }
  assert.deepEqual(Object.keys(spin.state()), ['angle', 'rate', 'usual', 'handMps']);
});

// ---- the hand's own movement, told apart from the wearer's ----

/**
 * A wearer for `seconds` at 72 Hz. `at(t)` gives { head: [x, z], yaw (rad, 0 = facing -z, positive
 * to the right), hand: [right, ahead] of the head in the body's own frame, bodyYaw (rad, the way
 * the body and so the held-out hand is turned; the head's yaw when left out) }.
 * Returns the hand's own sideways speeds the watch reported (m/s).
 */
function watchWearer(seconds, at) {
  const watch = createHandWatch();
  const out = [];
  for (let k = 0; k <= seconds * HZ; k++) {
    const { head, yaw, hand, bodyYaw = yaw } = at(k / HZ);
    const right = [Math.cos(yaw), Math.sin(yaw)]; // facing (sin yaw, -cos yaw): its right
    const ahead = [Math.sin(bodyYaw), -Math.cos(bodyYaw)];
    const side = [Math.cos(bodyYaw), Math.sin(bodyYaw)];
    const palm = [head[0] + side[0] * hand[0] + ahead[0] * hand[1], head[1] + side[1] * hand[0] + ahead[1] * hand[1]];
    const mps = watch.measure(palm[0], palm[1], head[0], head[1], right[0], right[1], 1 / HZ);
    if (k === 0) assert.equal(mps, null, 'nothing to compare the first frame with');
    else out.push(mps);
  }
  return out;
}
const most = (a) => Math.max(...a.map(Math.abs));
const HELD = [0.15, 0.4]; // the right palm: 15 cm to the right of the head, 40 cm ahead

test('walking, stepping aside and turning the head do not count as the hand moving', () => {
  // Walking at 1.2 m/s, looking 10 and 20 degrees to the right of the way walked (the figure floats right of the middle).
  for (const look of [10, 20]) {
    const yaw = (look * Math.PI) / 180;
    assert.ok(most(watchWearer(3, (t) => ({ head: [0, -1.2 * t], yaw, bodyYaw: 0, hand: HELD }))) < 1e-9, `walking, head ${look} degrees aside`);
  }
  // A walk with the body swaying 2.5 cm from side to side, twice a second.
  assert.ok(most(watchWearer(3, (t) => ({ head: [0.025 * Math.sin(t * 4 * Math.PI), -1.2 * t], yaw: 0, hand: HELD }))) < 1e-9, 'body sway');
  // A step of 20 cm to the side.
  assert.ok(most(watchWearer(1, (t) => ({ head: [0.2 * Math.min(1, t / 0.5), 0], yaw: 0, hand: HELD }))) < 1e-9, 'a step aside');
  // Turning only the head (about the axis it turns on), the hand still: it slides across the view, and that is all.
  assert.ok(most(watchWearer(1.5, (t) => ({ head: [0, 0], yaw: 0.6 * Math.sin(t * 3), bodyYaw: 0, hand: HELD }))) < 1e-9, 'turning the head');
});

test('the eyes following the hand do not cancel its move; turning the whole body with the hand out counts as a sweep', () => {
  // The hand goes 15 cm to the right in 0.3 s while the head turns after it, keeping it in the same place of the view.
  const followed = watchWearer(0.3, (t) => {
    const hand = [HELD[0] + 0.5 * t, HELD[1]];
    return { head: [0, 0], yaw: Math.atan2(hand[0], hand[1]) - Math.atan2(HELD[0], HELD[1]), bodyYaw: 0, hand };
  });
  assert.ok(followed.slice(1).every((v) => v > 0.35), `followed by the eyes: ${Math.min(...followed.slice(1))} m/s at least for a hand moving at 0.5`);
  // Turning on the spot by 90 degrees in 1.5 s: the hand does sweep through the room, and it is taken as that.
  const turning = watchWearer(1.5, (t) => ({ head: [0, 0], yaw: (Math.PI / 2) * (t / 1.5), hand: HELD }));
  assert.ok(most(turning) > 0.3, 'a turn of the body is a sweep of the hand');
});

test('a move of the hand itself counts in full, standing or walking, and to the left as to the right', () => {
  // The hand goes 15 cm to the right in 0.3 s (0.5 m/s), then rests.
  const flick = (t) => [HELD[0] + 0.5 * Math.min(t, 0.3), HELD[1]];
  const standing = watchWearer(1, (t) => ({ head: [0, 0], yaw: 0, hand: flick(t) }));
  const walking = watchWearer(1, (t) => ({ head: [0, -1.2 * t], yaw: 0.17, bodyYaw: 0.17, hand: flick(t) }));
  for (const [name, seen] of [['standing', standing], ['walking', walking]]) {
    const during = seen.slice(1, Math.round(0.3 * HZ) - 1);
    assert.ok(during.every((v) => v > 0.4 && v < 0.51), `${name}: ${Math.min(...during)} to ${Math.max(...during)} m/s for a hand moving at 0.5`);
    assert.ok(most(seen.slice(Math.round(0.3 * HZ) + 1)) < 1e-9, `${name}: nothing once the hand rests`);
  }
  const left = watchWearer(1, (t) => ({ head: [0, 0], yaw: 0, hand: [HELD[0] - 0.5 * Math.min(t, 0.3), HELD[1]] }));
  assert.ok(left.slice(1, 20).every((v) => v < -0.4));
});

test('after the hand was out of sight the first frame back says nothing, however far it has moved', () => {
  const watch = createHandWatch();
  assert.equal(watch.measure(0.15, -0.4, 0, 0, 1, 0, 1 / HZ), null);
  assert.equal(watch.measure(0.15, -0.4, 0, 0, 1, 0, 1 / HZ), 0);
  watch.forget();
  assert.equal(watch.measure(0, -0.4, 0, 0, 1, 0, 1 / HZ), null, '15 cm to the left of where it was: no kick');
  assert.equal(watch.measure(0, -0.4, 0, 0, 1, 0, 0), null, 'no time passed: nothing to say');
});

// ---- what the wearer sees is the angle (tests from the review of 2026-11-15: before them a
// figure whose angle ignored the hand passed every test above) ----

const TURN = Math.PI * 2;

/** Step once and return how far the figure turned in that step (rad, the short way round). */
function turnedBy(spin, dt, mps) {
  const before = spin.state().angle;
  const d = spin.step(dt, mps) - before;
  return d - TURN * Math.round(d / TURN);
}

test('the figure itself turns as the rate says: the angle is the rate added up, either way', () => {
  for (const mps of [0.8, -0.8]) {
    const spin = createSpin(K);
    let turned = 0;
    let summed = 0;
    for (let k = 0; k < 3000; k++) { // 0.3 s of the hand moving, then 2.7 s of rest, in steps of 1 ms
      turned += turnedBy(spin, 0.001, k < 300 ? mps : 0);
      summed += spin.state().rate * 0.001;
    }
    assert.ok(Math.abs(turned - summed) < 0.01, `turned ${turned} rad, the rate added up ${summed} rad`);
    if (mps > 0) assert.ok(turned > 3 * USUAL + 3, `to the right it turned ${turned} rad in 3 s, far more than the usual ${3 * USUAL}`);
    else assert.ok(turned < -1, `to the left it turned ${turned} rad: backwards`);
  }
});

test('a step is the exact solution: one frame of 0.1 s lands where a hundred of 1 ms do', () => {
  for (const mps of [0.1, -0.3]) {
    const coarse = createSpin(K);
    const fine = createSpin(K);
    for (const spin of [coarse, fine]) for (let k = 0; k < 2000; k++) spin.step(0.001, mps); // the hand's smoothed speed has settled, the rate has not
    assert.ok(Math.abs(coarse.state().rate - (USUAL + K.perM * K.returnS * Math.sign(mps) * (Math.abs(mps) - K.deadMps))) > 0.3, 'the rate is still on its way');
    const one = turnedBy(coarse, 0.1, mps);
    let hundred = 0;
    for (let k = 0; k < 100; k++) hundred += turnedBy(fine, 0.001, mps);
    assert.ok(Math.abs(coarse.state().rate - fine.state().rate) < 1e-9, `rate ${coarse.state().rate} against ${fine.state().rate}`);
    assert.ok(Math.abs(one - hundred) < 1e-9, `turned ${one} against ${hundred}`);
  }
});

test('held at the limit on the side it was pulled to, and turning that way', () => {
  for (const wild of [50, -50]) {
    const spin = createSpin(K);
    let turned = 0;
    for (let k = 0; k < 72; k++) turned = turnedBy(spin, 1 / 72, wild);
    assert.equal(spin.state().rate, Math.sign(wild) * K.maxRadS);
    assert.ok(Math.abs(turned - (Math.sign(wild) * K.maxRadS) / 72) < 1e-9, `a frame at the limit turns ${turned} rad`);
  }
});

test('the push grows from nothing above deadMps, and a jump of the tracking counts as maxMps at most', () => {
  const spin = createSpin(K);
  for (let k = 0; k < 20 * 72; k++) spin.step(1 / 72, K.deadMps + 0.01); // 1 cm/s over: settles at perM x returnS x 0.01 more
  assert.ok(Math.abs(spin.state().rate - USUAL - K.perM * K.returnS * 0.01) < 1e-3, `rate ${spin.state().rate}`);
  const jump = createSpin(K);
  const most = createSpin(K);
  jump.step(1 / 72, 50);
  most.step(1 / 72, K.maxMps);
  assert.deepEqual(jump.state(), most.state());
});
