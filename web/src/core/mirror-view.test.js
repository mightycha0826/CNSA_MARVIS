// node --test src/core/mirror-view.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { viewOfProjection, viewOfLens, widest, fitView, viewAngles, shareOfView, pictureSize } from './mirror-view.js';

const RAD = Math.PI / 180;
const tan = (deg) => Math.tan(deg * RAD);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

/** A projection matrix as WebXR gives it for an eye that sees `l` degrees to the left, `r` to the right, `u` up and `d` down. */
function eyeProjection(l, r, u, d, n = 0.1, f = 100) {
  const [L, R, T, B] = [-tan(l) * n, tan(r) * n, tan(u) * n, -tan(d) * n];
  // column by column
  return [(2 * n) / (R - L), 0, 0, 0, 0, (2 * n) / (T - B), 0, 0, (R + L) / (R - L), (T + B) / (T - B), -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0];
}

// About what a Quest 3 reports for its eyes: wide to the outside and downwards.
const LEFT_EYE = eyeProjection(54, 40, 44, 55);
const RIGHT_EYE = eyeProjection(40, 54, 44, 55);

test('a lopsided eye projection gives back its four angles', () => {
  const v = viewOfProjection(LEFT_EYE);
  near(v.left, -tan(54));
  near(v.right, tan(40));
  near(v.up, tan(44));
  near(v.down, -tan(55));
});

test('a lens that looks straight ahead is the same to both sides', () => {
  const v = viewOfLens(58, 4 / 3);
  near(v.up, tan(29));
  near(v.down, -tan(29));
  near(v.right, tan(29) * (4 / 3));
  near(v.left, -v.right);
  const [across, tall] = viewAngles(v);
  near(tall, 58, 1e-9);
  near(across, 72.9, 0.1); // what the Quest 3's camera sees across at 4:3
});

test('the whole view is the widest of what each eye sees', () => {
  const v = widest([viewOfProjection(LEFT_EYE), viewOfProjection(RIGHT_EYE)]);
  near(v.left, -tan(54));
  near(v.right, tan(54));
  near(v.up, tan(44));
  near(v.down, -tan(55));
  const [across, tall] = viewAngles(v);
  near(across, 108, 1e-9);
  near(tall, 99, 1e-9);
});

test('views that are no views are left out, and none at all gives null', () => {
  const good = viewOfLens(60, 1);
  assert.deepEqual(widest([null, { left: NaN, right: 1, down: -1, up: 1 }, good, { left: 1, right: -1, down: -1, up: 1 }]), good);
  assert.equal(widest([]), null);
  assert.equal(widest([undefined, { left: 0, right: 0, down: 0, up: 0 }]), null);
});

test('fitting to the picture only ever adds: nothing the wearer sees is cut', () => {
  const eyes = widest([viewOfProjection(LEFT_EYE), viewOfProjection(RIGHT_EYE)]);
  for (const aspect of [4 / 3, 16 / 9, 1, 3 / 4]) {
    const v = fitView(eyes, aspect, 0.04);
    assert.ok(v.left <= eyes.left && v.right >= eyes.right && v.down <= eyes.down && v.up >= eyes.up, `aspect ${aspect}`);
    near((v.right - v.left) / (v.up - v.down), aspect, 1e-9);
  }
});

test('the side that is too short grows by the same on both ends, the other keeps its margin only', () => {
  const eyes = { left: -1.2, right: 1.4, down: -1.5, up: 0.9 }; // 2.6 across, 2.4 tall
  const wide = fitView(eyes, 2); // needs 4.8 across
  near(wide.left, -1.2 - 1.1);
  near(wide.right, 1.4 + 1.1);
  near(wide.down, -1.5);
  near(wide.up, 0.9);
  const tall = fitView(eyes, 1); // needs 2.6 tall
  near(tall.down, -1.6);
  near(tall.up, 1.0);
  near(tall.left, -1.2);
  near(tall.right, 1.4);
  // The margin is a share of each side's own length.
  const m = fitView({ left: -1, right: 1, down: -1, up: 1 }, 1, 0.1);
  near(m.left, -1.1);
  near(m.up, 1.1);
});

test('what looks straight ahead stays where it was in the picture', () => {
  // The point straight ahead (tangent 0, 0) sits at the same share of the way down before and
  // after widening to 16:9: only the sides were added.
  const eyes = widest([viewOfProjection(LEFT_EYE), viewOfProjection(RIGHT_EYE)]);
  const v = fitView(eyes, 16 / 9);
  near(v.up / (v.up - v.down), eyes.up / (eyes.up - eyes.down));
  near(-v.left / (v.right - v.left), 0.5); // and in the middle from left to right
});

test('the camera picture fills about half of the whole view each way', () => {
  const eyes = widest([viewOfProjection(LEFT_EYE), viewOfProjection(RIGHT_EYE)]);
  const view = fitView(eyes, 4 / 3, 0.04);
  const s = shareOfView(view, viewOfLens(58, 4 / 3));
  assert.ok(s.w > 0.4 && s.w < 0.5, `width share ${s.w}`);
  assert.ok(s.h > 0.4 && s.h < 0.5, `height share ${s.h}`);
  near(s.x + s.w / 2, 0.5); // centred from left to right
  assert.ok(s.y + s.h / 2 < 0.5, 'above the middle: the eyes see further down than up');
  // In the camera view it is the whole picture.
  assert.deepEqual(shareOfView(viewOfLens(58, 4 / 3), viewOfLens(58, 4 / 3)), { x: 0, y: 0, w: 1, h: 1 });
});

test('the picture size is read from the address and held to sane values', () => {
  assert.deepEqual(pictureSize('1280x960'), [1280, 960]);
  assert.deepEqual(pictureSize('961x721'), [962, 722]); // even numbers
  assert.deepEqual(pictureSize('9999x9999'), [1920, 1440]);
  assert.deepEqual(pictureSize('10x10'), [320, 240]);
  assert.deepEqual(pictureSize('big'), [1280, 960]);
  assert.deepEqual(pictureSize(null, [640, 480]), [640, 480]);
});
