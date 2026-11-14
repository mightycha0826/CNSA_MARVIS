// The right wrist: rings of light.
//
// Closing the right hand into a fist while the vitals are up folds them away (suit.js): the
// figure and its readings are squeezed down toward the wrist, and five rings close around the
// wrist in their place, like bangles. They stay while the fist is held, in the colour of the
// worst vital sign, so a glance at the wrist says whether all is well. Opening the hand palm up
// lets them fly open again as the vitals unfold.
//
// What they are after: the armbands of a wuxia film, worn stacked on the forearm, heavy and
// alive with energy. So each ring is a solid band, not a line of light: a dark body with a
// bright rim, streaks of energy racing around it (fast through part of the turn and all but
// still in the rest, neighbours running opposite ways), and a soft glow about it. They do not
// sit still either: every few seconds the stack draws apart along the forearm and snaps
// together again, with a flash as the bands meet.
// The part of a ring that is behind the wrist, seen from the eyes, fades out: a real band is
// hidden there by the arm.
//
// No hand tracking in here: the caller passes the wrist's pose every frame.

import * as THREE from 'three';

export const BRACELET = {
  rings: 5,
  radiusM: 0.056, // wide of the wrist (about 3 cm from its middle to its skin): they hover, they do not sit
  bandM: 0.0046, // half the band's thickness
  bandWide: 1.7, // the band is this many times wider along the forearm than it is thick
  firstM: 0.02, // the first ring this far up the forearm from the wrist joint
  everyM: 0.0165, // and the others this far apart, almost touching
  staggerS: 0.045, // each ring closes this long after the one before, from the wrist up the arm
  fromScale: 2.4, // a ring starts this many times too wide and closes onto the wrist
  turnS: 0.8, // one turn of a streak takes about this long (each ring a little different)
  surge: 0.86, // how unevenly it turns: 0 steady, 1 stops dead once a turn
  leanRad: 0.07, // how far a band leans out of square to the forearm
  cycleS: 2.8, // the stack draws apart and snaps together once in this long
  apartM: 0.011, // how much farther apart neighbours are when drawn apart
};

const RING_VERTEX = `
varying vec2 vUv;
varying float vBehind;
varying vec3 vNormal;
varying vec3 vToEye;
void main() {
  vUv = uv;
  vec4 at = modelViewMatrix * vec4(position, 1.0);
  vec4 centre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  // How far behind the ring's middle this point is, seen from the eye: -1 the near side, +1 the far side.
  vBehind = (length(at.xyz) - length(centre.xyz)) / max(length(at.xyz - centre.xyz), 0.0001);
  vNormal = normalize(normalMatrix * normal);
  vToEye = normalize(-at.xyz);
  gl_Position = projectionMatrix * at;
}`;
// The band: a dark body, bright where its surface turns away from the eye, with two streaks of
// energy running around it, each bright at its head and thinning out behind.
const BAND_FRAGMENT = `
uniform vec3 colour;
uniform float level;
uniform float head; // where a streak's head is, in turns
uniform float reach; // how long a streak is, in half turns
uniform float flash; // the moment the bands meet
varying vec2 vUv;
varying float vBehind;
varying vec3 vNormal;
varying vec3 vToEye;
void main() {
  float back = fract((head - vUv.x) * 2.0);
  float streak = (1.0 - smoothstep(0.0, reach, back)) * smoothstep(0.0, 0.02, back);
  float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vToEye))), 1.6);
  vec3 body = colour * 0.16 + vec3(0.02, 0.025, 0.035);
  vec3 lit = body + colour * (0.75 * rim + 1.5 * streak * streak + 0.9 * flash);
  float seen = 1.0 - smoothstep(-0.1, 0.5, vBehind); // behind the wrist it is hidden by the arm
  gl_FragColor = vec4(lit, (0.82 + 0.18 * streak) * level * seen);
  #include <colorspace_fragment>
}`;
// The glow about the band: light only, strongest where a streak passes and when the bands meet.
const GLOW_FRAGMENT = `
uniform vec3 colour;
uniform float level;
uniform float head;
uniform float reach;
uniform float flash;
varying vec2 vUv;
varying float vBehind;
varying vec3 vNormal;
varying vec3 vToEye;
void main() {
  float back = fract((head - vUv.x) * 2.0);
  float streak = (1.0 - smoothstep(0.0, reach * 1.3, back)) * smoothstep(0.0, 0.02, back);
  float soft = pow(abs(dot(normalize(vNormal), normalize(vToEye))), 2.0); // gone at the glow's own edge
  float seen = 1.0 - smoothstep(-0.1, 0.5, vBehind);
  gl_FragColor = vec4(colour, (0.07 + 0.3 * streak + 0.45 * flash) * soft * level * seen);
  #include <colorspace_fragment>
}`;

const smooth = (t) => t * t * (3 - 2 * t);
/** Together again: slow to start, then all at once (0 -> 1). */
const snap = (t) => Math.min(1, t) ** 3;

/** A spring let go at 0 toward 1: quick, with one small overshoot (about 6 %), settled in a third of a second. */
export const pop = (t) => (t <= 0 ? 0 : 1 - Math.exp(-16 * t) * Math.cos(18 * t));

export function createBracelet(scene) {
  const K = BRACELET;
  const root = new THREE.Group();
  root.name = 'wrist-rings';
  root.visible = false;
  scene.add(root);
  const colour = new THREE.Color('#7fd4ff');
  const flash = { value: 0 };
  const rings = [];
  for (let k = 0; k < K.rings; k++) {
    const uniforms = { colour: { value: colour }, level: { value: 0 }, head: { value: 0 }, reach: { value: 0.3 }, flash };
    // A torus lies in its own x-y plane, around z: the wrist joint's z runs along the forearm.
    // Stretched along z it is a band, wider than it is thick.
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(K.radiusM, K.bandM, 10, 96).scale(1, 1, K.bandWide),
      new THREE.ShaderMaterial({ uniforms, vertexShader: RING_VERTEX, fragmentShader: BAND_FRAGMENT, transparent: true, depthTest: false, depthWrite: false }),
    );
    const glow = new THREE.Mesh(
      new THREE.TorusGeometry(K.radiusM, K.bandM * 2.8, 10, 96).scale(1, 1, K.bandWide * 0.8),
      new THREE.ShaderMaterial({ uniforms, vertexShader: RING_VERTEX, fragmentShader: GLOW_FRAGMENT, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }),
    );
    const mesh = new THREE.Group();
    mesh.add(glow, band);
    glow.renderOrder = 12;
    band.renderOrder = 13;
    band.frustumCulled = glow.frustumCulled = false;
    root.add(mesh);
    // Each ring its own pace and lean, neighbours turning opposite ways, so they never fall into step.
    rings.push({ mesh, uniforms, turnS: K.turnS * (0.85 + 0.09 * k), way: k % 2 ? -1 : 1, offset: k * 0.37, leanAt: k * 1.9 });
  }

  const s = { on: false, since: 0, level: 0 };

  return {
    root,
    /** The colour of the rings: the state of the vitals. */
    status(state) {
      colour.set(state === 'crit' ? '#ff5a4f' : state === 'warn' ? '#f27a0a' : '#7fd4ff');
    },
    /**
     * Every frame.
     * @param wrist { position: Vector3, quaternion: Quaternion } the right wrist joint, or null when it is not tracked
     * @param on    the rings are worn (the fist is held after the vitals were folded away)
     * @param now   seconds
     */
    update(wrist, on, now, dt) {
      if (on !== s.on) {
        s.on = on;
        s.since = now;
      }
      // Going is quicker than coming, and without the spring.
      s.level = on ? 1 : Math.max(0, s.level - dt / 0.18);
      root.visible = !!wrist && (on || s.level > 0);
      if (!root.visible) return;
      root.position.copy(wrist.position);
      root.quaternion.copy(wrist.quaternion);
      // The stack draws apart and snaps together: at rest for the first half of the cycle,
      // slowly apart over the next third, then together again all at once, with a flash.
      const c = ((now - s.since) / K.cycleS) % 1;
      const apart = c < 0.5 ? 0 : c < 0.86 ? smooth((c - 0.5) / 0.36) : 1 - snap((c - 0.86) / 0.14);
      const sinceSnap = c >= 0.97 ? (c - 0.97) * K.cycleS : c < 0.5 ? (c + 0.03) * K.cycleS : 1;
      flash.value = on ? Math.exp(-sinceSnap * 9) : 0;
      for (let k = 0; k < rings.length; k++) {
        const ring = rings[k];
        const t = now - s.since - k * K.staggerS;
        // Coming: each ring closes from wide onto the wrist, one after the other up the arm,
        // and settles with a small bounce. Going: they fly open again as they fade.
        const closed = on ? pop(t) : s.level * s.level;
        ring.mesh.scale.setScalar(K.fromScale + (1 - K.fromScale) * closed);
        ring.mesh.position.z = K.firstM + k * (K.everyM + K.apartM * apart);
        const u = ring.uniforms;
        u.level.value = on ? Math.min(1, Math.max(0, t / 0.08)) : s.level;
        // The streaks: one turn every turnS, but unevenly: fast through one part of the turn
        // and nearly still in the other. They are longer the faster they go.
        const phase = (now / ring.turnS + ring.offset) * Math.PI * 2;
        u.head.value = (ring.way * (phase + K.surge * Math.sin(phase))) / (Math.PI * 2);
        u.reach.value = 0.22 + 0.5 * (1 + K.surge * Math.cos(phase)) * 0.5;
        // And the band itself rocks a little, more while the stack is drawn apart.
        const lean = K.leanRad * (0.4 + 1.2 * apart) * Math.sin(now * 2.3 + ring.leanAt);
        const around = now * 1.7 * ring.way + ring.leanAt;
        ring.mesh.rotation.set(lean * Math.cos(around), lean * Math.sin(around), 0);
      }
    },
    state: () => ({ on: s.on, level: s.level, shown: root.visible }),
  };
}
