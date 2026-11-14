// node --test src/core/pop.test.js
// The way everything a hand brings up comes up (core/hologram.js: pop, popIn).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pop, popIn, POP_S } from './hologram.js';

test('pop: from nothing, a little too large once, then at its size', () => {
  assert.equal(pop(0), 0);
  assert.equal(pop(-1), 0);
  let top = 0;
  for (let t = 0; t <= 1; t += 0.005) top = Math.max(top, pop(t));
  assert.ok(top > 1.03 && top < 1.1, `overshoot ${top}`);
  assert.ok(Math.abs(pop(POP_S) - 1) < 0.002, 'settled when it is taken as settled');
  assert.ok(pop(0.08) > 0.7, 'most of the way in under a tenth of a second');
});

test('popIn: next to nothing while hidden, the pop from the frame it shows, then 1; again each time it comes up', () => {
  const st = {};
  assert.equal(popIn(st, false, 0), 0.001);
  assert.equal(popIn(st, true, 1000), 0.001); // the first frame: just started
  const mid = popIn(st, true, 1080);
  assert.ok(mid > 0.7 && mid < 1.1);
  assert.equal(popIn(st, true, 1000 + POP_S * 1000 + 1), 1);
  assert.equal(popIn(st, true, 9000), 1);
  assert.equal(popIn(st, false, 9100), 0.001);
  assert.equal(popIn(st, true, 9200), 0.001); // it starts over
  assert.ok(popIn(st, true, 9300) > 0.7);
});
