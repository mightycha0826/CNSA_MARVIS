// node --test src/core/room-frame.test.js
// Checked against three.js's own quaternions and matrices (a separate implementation).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { yawOf, originOffset, fromKept, asTransform } from './room-frame.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const Y = new THREE.Vector3(0, 1, 0);

test('yawOf reads the turn about the upright axis, also from an orientation that is tipped a little', () => {
  for (const yaw of [0, 0.3, -1.2, 2.9, -3.0]) {
    const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw);
    close(yawOf(q), yaw);
    const tipped = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.02));
    close(yawOf(tipped), yaw, 1e-3);
  }
});

test('the offset puts the anchor back where it was kept, for any origin the new session has', () => {
  const kept = { x: 0.4, z: -1.1, yaw: 0.25 }; // the anchor in the kept coordinates
  for (const [turn, dx, dz] of [[0, 0, 0], [0.9, 2, -3], [-2.4, -1.5, 0.7], [Math.PI, 4, 4]]) {
    // This session's origin is turned and shifted against the kept one: kept -> session.
    const session = new THREE.Matrix4().makeRotationY(turn).setPosition(dx, 0, dz);
    const at = new THREE.Vector3(kept.x, 0, kept.z).applyMatrix4(session);
    const now = { x: at.x, z: at.z, yaw: kept.yaw + turn };
    const offset = originOffset(kept, now);
    // The offset is that same turn and shift: a point of the kept coordinates lands where the session has it.
    for (const [x, z] of [[0, 0], [1, 0], [0, 1], [-2.5, 3.2]]) {
      const want = new THREE.Vector3(x, 0, z).applyMatrix4(session);
      const got = fromKept(offset, x, z);
      close(got[0], want.x);
      close(got[1], want.z);
    }
    // As an XRRigidTransform it is the same matrix.
    const [position, q] = asTransform(offset);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(position.x, position.y, position.z), new THREE.Quaternion(q.x, q.y, q.z, q.w), new THREE.Vector3(1, 1, 1));
    const p = new THREE.Vector3(-2.5, 0, 3.2);
    const a = p.clone().applyMatrix4(m);
    const b = p.clone().applyMatrix4(session);
    close(a.x, b.x);
    close(a.z, b.z);
    close(a.y, 0);
  }
});

test('an anchor made at the origin: the offset is simply where the anchor is now', () => {
  const o = originOffset({ x: 0, z: 0, yaw: 0 }, { x: 1.5, z: -2, yaw: 0.7 });
  assert.deepEqual([o.x, o.z], [1.5, -2]);
  close(o.yaw, 0.7);
});
