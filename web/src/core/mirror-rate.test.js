// node --test src/core/mirror-rate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRate, RATE } from './mirror-rate.js';

/** About what a 1280 x 960 picture of a room with the HUD over it weighs at a JPEG quality (bytes). */
function bytesAt(q) {
  const table = [
    [0.45, 60e3],
    [0.6, 80e3],
    [0.75, 110e3],
    [0.85, 150e3],
    [0.92, 230e3],
  ];
  for (let i = 1; i < table.length; i++) {
    if (q <= table[i][0]) {
      const [q0, b0] = table[i - 1];
      const [q1, b1] = table[i];
      return b0 + ((b1 - b0) * Math.max(0, q - q0)) / (q1 - q0);
    }
  }
  return table.at(-1)[1];
}

/**
 * The page, the link and the hub for `seconds`, a millisecond at a time. The link carries
 * `bytesPerMs(t)` one picture after the other and every message takes `baseMs` on top (there
 * and back). Returns what happened.
 */
function run({ fps = 15, seconds = 30, bytesPerMs, baseMs = 4, ping = true, K = RATE }) {
  const rate = createRate(fps, K);
  const gap = 1000 / fps;
  const flying = []; // { n, left (bytes), sentAt }
  const acks = []; // { n, at }
  const out = { sent: 0, ages: [], maxFlying: 0, qualities: [], rate };
  let lastTry = -Infinity;
  let lastPing = -Infinity;
  for (let t = 0; t < seconds * 1000; t++) {
    // the link: the oldest picture first
    let budget = typeof bytesPerMs === 'function' ? bytesPerMs(t) : bytesPerMs;
    while (budget > 0 && flying.length) {
      const f = flying[0];
      const took = Math.min(budget, f.left);
      f.left -= took;
      budget -= took;
      if (f.left <= 0) {
        acks.push({ n: f.n, at: t + baseMs, sentAt: f.sentAt });
        flying.shift();
      } else break;
    }
    while (acks.length && acks[0].at <= t) {
      const a = acks.shift();
      out.ages.push(t - a.sentAt);
      rate.acked(a.n, t);
    }
    rate.tick(t);
    if (ping && rate.idle() && t - lastPing >= 2000) {
      lastPing = t;
      rate.pong(baseMs, t);
    }
    // the page: a picture every gap, if the window is open
    if (t - lastTry >= gap) {
      lastTry = t;
      if (rate.open()) {
        const n = rate.sent(t);
        flying.push({ n, left: bytesAt(rate.quality), sentAt: t });
        out.sent++;
      } else rate.hold();
    }
    out.maxFlying = Math.max(out.maxFlying, rate.stats().flying);
    if (t % 1000 === 999) out.qualities.push(rate.quality);
  }
  return out;
}

const MBIT = 1e6 / 8 / 1000; // bytes a millisecond per megabit a second
const FAST = 200 * MBIT; // the hotspot at arm's length: the largest picture takes a seventh of the gap

test('on a fast link the quality climbs to the top and every picture goes out', () => {
  const r = run({ bytesPerMs: FAST, seconds: 20 });
  assert.equal(r.rate.quality, RATE.maxQ);
  assert.ok(r.sent >= 20 * 15 - 3, `${r.sent} pictures in 20 s`);
  assert.equal(r.rate.stats().held, 0);
  assert.ok(Math.max(...r.ages) < 1000 / 15, 'no picture took as long as the gap to the next');
});

test('on a link that is too slow for the top it settles where a picture fits the gap', () => {
  // 12 Mbit/s: 1500 bytes a millisecond. At the top a picture would take 153 ms, twice the gap.
  const r = run({ bytesPerMs: 12 * MBIT, seconds: 40 });
  const tail = r.qualities.slice(-10);
  assert.ok(Math.max(...tail) <= 0.72, `settled at ${tail}`);
  assert.ok(Math.min(...tail) >= RATE.minQ);
  const late = r.ages.slice(-100);
  assert.ok(late.reduce((a, b) => a + b, 0) / late.length < 1000 / 15, 'a picture is at the hub before the next is due');
});

test('a link with room for most of it stops a step or two under the top, where a picture takes two fifths of the gap', () => {
  // 60 Mbit/s: the largest picture would take 31 ms of the 67 ms between two.
  const r = run({ bytesPerMs: 60 * MBIT, seconds: 30 });
  assert.ok(r.rate.quality >= 0.86 && r.rate.quality < RATE.maxQ, `settled at ${r.rate.quality}`);
  assert.equal(r.rate.stats().held, 0);
});

test('never more than the window on their way, however slow the link', () => {
  for (const mbit of [0.5, 1.2, 3, 8, 30]) {
    const r = run({ bytesPerMs: mbit * MBIT, seconds: 30 });
    assert.ok(r.maxFlying <= RATE.window, `${mbit} Mbit/s: ${r.maxFlying} flying`);
  }
});

test('a very slow link gives few pictures, each of them fresh, at the lowest quality', () => {
  // 1.2 Mbit/s: 150 bytes a millisecond, 400 ms for the smallest picture.
  const r = run({ bytesPerMs: 1.2 * MBIT, seconds: 40 });
  assert.equal(r.rate.quality, RATE.minQ);
  const perSecond = r.sent / 40;
  assert.ok(perSecond > 1.5 && perSecond < 3.5, `${perSecond} pictures a second`);
  // With the window at 2 a picture waits for one before it at most: about two transits, not a growing queue.
  const late = r.ages.slice(-30);
  assert.ok(Math.max(...late) < 1000, `oldest picture ${Math.max(...late)} ms`);
  // The same link with pictures simply queued would be 40 s * 15 * 60 kB = 36 MB behind 6 MB carried: half a minute late.
});

test('a link that only answers slowly, whatever the size, does not cost quality', () => {
  // 100 ms there and back for anything (a radio that sleeps between packets), but plenty of room.
  const withPings = run({ bytesPerMs: FAST, baseMs: 100, seconds: 40 });
  assert.equal(withPings.rate.quality, RATE.maxQ);
  assert.equal(Math.round(withPings.rate.stats().baseMs), 100);
  // Without a ping to tell the two apart the delay looks like a full link.
  const blind = run({ bytesPerMs: FAST, baseMs: 100, seconds: 40, ping: false });
  assert.equal(blind.rate.quality, RATE.minQ);
});

test('when the link stalls the window opens again after a moment and the quality has come down', () => {
  // Fast, nothing at all from 10 s to 14 s, then as before.
  const r = run({ bytesPerMs: (t) => (t >= 10000 && t < 14000 ? 0 : FAST), seconds: 40 });
  assert.ok(r.rate.stats().lost >= 1);
  assert.ok(r.qualities[14] < RATE.maxQ - 0.1, `quality after the stall ${r.qualities[14]}`);
  assert.equal(r.rate.quality, RATE.maxQ, 'and back at the top once it runs again');
  assert.ok(r.maxFlying <= RATE.window);
  const after = r.ages.slice(-50);
  assert.ok(Math.max(...after) < 1000 / 15);
});

test('a link that gets slower is followed down within seconds, and up again more slowly', () => {
  const r = run({ bytesPerMs: (t) => (t >= 15000 && t < 30000 ? 8 * MBIT : FAST), seconds: 60 });
  assert.equal(r.qualities[14], RATE.maxQ);
  assert.ok(r.qualities[18] <= 0.7, `three seconds into the slow stretch: ${r.qualities[18]}`);
  assert.ok(r.qualities[31] < RATE.maxQ, 'one second after it is over it has not jumped back');
  assert.equal(r.qualities[59], RATE.maxQ);
});

test('one step up needs a second and a half of pictures with room to spare', () => {
  const rate = createRate(10, { ...RATE, startQ: 0.6 });
  let t = 0;
  const one = (took) => {
    const n = rate.sent(t);
    t += took;
    rate.acked(n, t);
    t += 100 - took;
  };
  for (let i = 0; i < 14; i++) one(10);
  assert.equal(rate.quality, 0.6);
  one(10); // the fifteenth
  assert.ok(Math.abs(rate.quality - 0.63) < 1e-9);
  // A picture in the middle band (neither spare nor full) starts the count again.
  for (let i = 0; i < 10; i++) one(10);
  one(60);
  for (let i = 0; i < 14; i++) one(10);
  assert.ok(Math.abs(rate.quality - 0.63) < 1e-9);
  one(10);
  assert.ok(Math.abs(rate.quality - 0.66) < 1e-9);
});

test('one jam is one step down, not one for every picture caught in it', () => {
  const rate = createRate(10, { ...RATE, startQ: 0.8 });
  const a = rate.sent(0);
  const b = rate.sent(100);
  rate.acked(a, 300); // 300 ms: full
  rate.acked(b, 320); // 220 ms: full again, 20 ms later
  assert.ok(Math.abs(rate.quality - 0.72) < 1e-9);
  const c = rate.sent(400);
  rate.acked(c, 800); // 400 ms after the first step: a new one
  assert.ok(Math.abs(rate.quality - 0.64) < 1e-9);
});

test('answers that make no sense are ignored', () => {
  const rate = createRate(15);
  const n = rate.sent(0);
  rate.acked(n + 5, 10); // for a picture never sent
  rate.acked('1', 10);
  rate.acked(0, 10);
  rate.acked(NaN, 10);
  assert.equal(rate.stats().flying, 1);
  rate.acked(n, 20);
  assert.equal(rate.stats().flying, 0);
  rate.acked(n, 30); // twice
  assert.equal(rate.stats().flying, 0);
  assert.equal(rate.stats().delayMs, 20);
  rate.pong(-1, 40);
  rate.pong(NaN, 40);
  assert.equal(rate.stats().baseMs, 0);
});

test('an ack for a later picture answers the earlier ones too', () => {
  const rate = createRate(15);
  rate.sent(0);
  const second = rate.sent(10);
  assert.equal(rate.open(), false);
  rate.acked(second, 30);
  assert.equal(rate.open(), true);
  assert.equal(rate.idle(), true);
});

test('the quickest ping of the last twenty seconds is the base, older ones are forgotten', () => {
  const rate = createRate(15);
  rate.pong(5, 0);
  rate.pong(40, 10000);
  assert.equal(rate.stats().baseMs, 5);
  rate.pong(30, 21000);
  assert.equal(rate.stats().baseMs, 30); // the 5 is older than 20 s, the 40 still counts but is slower
});
