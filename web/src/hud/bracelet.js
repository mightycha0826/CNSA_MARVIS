// The right wrist: rings of light, and a watch on the back of the fist.
//
// Closing the right hand into a fist while the vitals are up folds them away (suit.js): the
// figure and its readings are squeezed down toward the wrist, and five rings close around the
// wrist in their place, like bangles. They stay while the fist is held, in the colour of the
// worst vital sign, so a glance at the wrist says whether all is well.
// Turn the back of the fist toward the eyes, as when looking at a watch, and a dial opens over
// it: the time, the date, and one line on the vitals.
// Opening the hand palm up unfolds the vitals again; opening it any other way lets the rings go.
//
// No hand tracking in here: the caller passes the wrist's pose every frame.

import * as THREE from 'three';

export const BRACELET = {
  rings: 5,
  radiusM: 0.041, // a loose bangle: a wrist is about 3 cm from its middle to its skin
  tubeM: 0.0021,
  firstM: 0.018, // the first ring this far up the forearm from the wrist joint
  everyM: 0.0105, // and the others this far apart
  staggerS: 0.035, // each ring closes this long after the one before
  fromScale: 2.4, // a ring starts this many times too wide and closes onto the wrist
  watchM: 0.078, // the dial's width
  watchLiftM: 0.058, // its height over the back of the wrist
  watchOnDot: 0.5, // the back of the hand faces the eyes this squarely: the dial opens
  watchOffDot: 0.3, // and closes again below this
};

const RING_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
// A ring glows all round, with two brighter arcs chasing each other along it.
const RING_FRAGMENT = `
uniform vec3 colour;
uniform float time;
uniform float level;
uniform float phase;
varying vec2 vUv;
void main() {
  float arc = pow(0.5 + 0.5 * cos(6.2831853 * (vUv.x * 2.0 - time * 0.55 + phase)), 8.0);
  float alpha = (0.42 + 0.58 * arc) * level;
  gl_FragColor = vec4(colour * (0.75 + 0.9 * arc), alpha);
  #include <colorspace_fragment>
}`;

/** A spring let go at 0 toward 1: quick, with one small overshoot (about 6 %), settled in a third of a second. */
export const pop = (t) => (t <= 0 ? 0 : 1 - Math.exp(-16 * t) * Math.cos(18 * t));

export function createBracelet(scene) {
  const K = BRACELET;
  const root = new THREE.Group();
  root.name = 'wrist-rings';
  root.visible = false;
  scene.add(root);
  const colour = new THREE.Color('#7fd4ff');
  const time = { value: 0 };
  const rings = [];
  for (let k = 0; k < K.rings; k++) {
    const material = new THREE.ShaderMaterial({
      uniforms: { colour: { value: colour }, time, level: { value: 0 }, phase: { value: k * 0.21 } },
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // A torus lies in its own x-y plane, around z: the wrist joint's z runs along the forearm.
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(K.radiusM, K.tubeM, 8, 64), material);
    mesh.position.z = K.firstM + k * K.everyM;
    mesh.renderOrder = 12;
    mesh.frustumCulled = false;
    root.add(mesh);
    rings.push(mesh);
  }

  // ---- the watch ----
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 384;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const watch = new THREE.Mesh(new THREE.PlaneGeometry(K.watchM, K.watchM), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  watch.name = 'wrist-watch';
  watch.renderOrder = 13;
  watch.frustumCulled = false;
  watch.visible = false;
  scene.add(watch); // not under the wrist: it faces the eyes, upright, whatever way the wrist is turned
  let drawn = '';
  let note = { text: 'VITALS OK', colour: '#7fd4ff' };

  function drawWatch(date) {
    const hhmm = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    const day = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
    const sec = date.getSeconds();
    const sig = `${hhmm}|${day}|${sec}|${note.text}|${note.colour}`;
    if (sig === drawn) return;
    drawn = sig;
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const c = W / 2;
    g.clearRect(0, 0, W, W);
    g.fillStyle = 'rgba(8, 12, 20, 0.72)';
    g.beginPath();
    g.arc(c, c, c - 10, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(127, 212, 255, 0.35)';
    g.stroke();
    // The seconds: an arc that fills around the rim once a minute, and sixty ticks.
    g.strokeStyle = note.colour;
    g.lineWidth = 8;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(c, c, c - 10, -Math.PI / 2, -Math.PI / 2 + ((sec + 1) / 60) * Math.PI * 2);
    g.stroke();
    g.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    g.lineWidth = 2;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * (c - 30), c + Math.sin(a) * (c - 30));
      g.lineTo(c + Math.cos(a) * (c - 22), c + Math.sin(a) * (c - 22));
      g.stroke();
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.font = '700 118px "Atkinson Hyperlegible", system-ui, sans-serif';
    g.fillText(hhmm, c, c - 6);
    g.fillStyle = '#b9c6d8';
    g.font = '600 30px "Atkinson Hyperlegible", system-ui, sans-serif';
    g.fillText(day, c, c - 92);
    g.fillStyle = note.colour;
    g.font = '700 28px "Atkinson Hyperlegible", system-ui, sans-serif';
    g.fillText(note.text, c, c + 84);
    texture.needsUpdate = true;
  }

  const s = { on: false, since: 0, level: 0, watchOn: false, watchSince: 0, watchLevel: 0 };
  const yAxis = new THREE.Vector3();
  const toEye = new THREE.Vector3();
  const eye = new THREE.Vector3();

  return {
    root,
    watch,
    /** The colour of the rings, and the line under the time: the state of the vitals. */
    status(state) {
      colour.set(state === 'crit' ? '#ff5a4f' : state === 'warn' ? '#f27a0a' : '#7fd4ff');
      note = state === 'crit' ? { text: 'VITALS CRITICAL', colour: '#ff5a4f' } : state === 'warn' ? { text: 'CHECK VITALS', colour: '#f27a0a' } : { text: 'VITALS OK', colour: '#7fd4ff' };
    },
    /**
     * Every frame.
     * @param wrist { position: Vector3, quaternion: Quaternion } the right wrist joint, or null when it is not tracked
     * @param on    the rings are worn (the fist is held after the vitals were folded away)
     * @param now   seconds
     */
    update(wrist, on, camera, now, dt) {
      time.value = now % 1000;
      if (on !== s.on) {
        s.on = on;
        s.since = now;
      }
      // Going: faster than coming, and without the spring.
      s.level = on ? 1 : Math.max(0, s.level - dt / 0.16);
      root.visible = !!wrist && (on || s.level > 0);
      if (!root.visible) {
        watch.visible = false;
        s.watchOn = false;
        s.watchLevel = 0;
        return;
      }
      root.position.copy(wrist.position);
      root.quaternion.copy(wrist.quaternion);
      rings.forEach((ring, k) => {
        const t = now - s.since - k * K.staggerS;
        // Coming: each ring closes from wide onto the wrist, one after the other, and settles with a small bounce.
        const closed = on ? pop(t) : 1;
        ring.scale.setScalar(K.fromScale + (1 - K.fromScale) * closed);
        ring.material.uniforms.level.value = on ? Math.min(1, Math.max(0, t / 0.08)) : s.level;
        // They are not rigid: each turns a little about the forearm and sways.
        ring.rotation.set(0.07 * Math.sin(now * 1.7 + k * 1.3), 0.07 * Math.cos(now * 1.3 + k * 0.9), now * (0.5 + 0.12 * k) * (k % 2 ? -1 : 1));
      });

      // The watch: the back of the hand (the wrist joint's +y) turned toward the eyes.
      camera.getWorldPosition(eye);
      yAxis.set(0, 1, 0).applyQuaternion(wrist.quaternion);
      toEye.copy(eye).sub(wrist.position).normalize();
      const facing = yAxis.dot(toEye);
      const want = on && facing > (s.watchOn ? K.watchOffDot : K.watchOnDot);
      if (want !== s.watchOn) {
        s.watchOn = want;
        s.watchSince = now;
      }
      s.watchLevel = want ? pop(now - s.watchSince) : Math.max(0, s.watchLevel - dt / 0.12);
      watch.visible = s.watchLevel > 0.01;
      if (watch.visible) {
        drawWatch(new Date());
        watch.position.copy(wrist.position).addScaledVector(yAxis, K.watchLiftM).addScaledVector(yAxis.set(0, 0, 1).applyQuaternion(wrist.quaternion), K.firstM);
        watch.quaternion.copy(camera.getWorldQuaternion(watch.quaternion)); // square to the eyes, upright as the head is
        watch.scale.setScalar(Math.max(0.001, s.watchLevel));
        watch.material.opacity = Math.min(1, s.watchLevel * 1.4);
      }
    },
    state: () => ({ on: s.on, level: s.level, watch: s.watchOn, shown: root.visible }),
  };
}
