// The room's coordinates, the same in every session.
//
// The headset puts the origin of 'local-floor' where it likes: where the wearer stood when the
// session started, or where they last recentred. A map of the room and the waypoints in it are
// kept as coordinates, so in a session with another origin they would lie somewhere else.
//
// A persistent anchor fixes that. In the first session an anchor is made at the origin and the
// headset is asked to keep it (it then knows the place by its own tracking of the room). In a
// later session the anchor is asked back: where it now is tells how this session's origin
// differs from the first one's, and the reference space is shifted by that difference
// (core/xr.js). From then on the app's coordinates are those of the first session, and what
// was stored fits. Only a turn about the upright axis and a shift along the floor are taken
// from the anchor: the floor stays the floor.
//
// Pure arithmetic: node --test src/core/room-frame.test.js
// A place on the floor with a facing: { x, z, yaw }. yaw is a turn about +y in radians (the
// right-handed way: it takes +x toward -z).

/** The turn about +y of an orientation { x, y, z, w }: where its x axis points, seen from above. */
export function yawOf(q) {
  return Math.atan2(-2 * (q.x * q.z - q.w * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
}

/** A pose on the floor from a WebXR transform ({ position, orientation }). */
export const floorPose = (t) => ({ x: t.position.x, z: t.position.z, yaw: yawOf(t.orientation) });

/**
 * Where the origin of the kept coordinates lies in this session's coordinates.
 * @param kept the anchor's pose in the kept coordinates (as it was when the anchor was made)
 * @param now  the anchor's pose in this session's coordinates
 * @returns { x, z, yaw }: the origin offset to give the reference space, so that the anchor is
 *          at `kept` again
 */
export function originOffset(kept, now) {
  const yaw = wrap(now.yaw - kept.yaw);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // now = offset * kept: the kept position, turned by the offset's yaw, then shifted.
  return { x: now.x - (kept.x * c + kept.z * s), z: now.z - (-kept.x * s + kept.z * c), yaw };
}

/** A point of the kept coordinates in this session's coordinates, by an offset from originOffset. */
export function fromKept(offset, x, z) {
  const c = Math.cos(offset.yaw);
  const s = Math.sin(offset.yaw);
  return [offset.x + x * c + z * s, offset.z - x * s + z * c];
}

/** The offset as the pieces of an XRRigidTransform: position and orientation. */
export const asTransform = (o) => [{ x: o.x, y: 0, z: o.z }, { x: 0, y: Math.sin(o.yaw / 2), z: 0, w: Math.cos(o.yaw / 2) }];

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
