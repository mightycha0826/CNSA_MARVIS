// XR core: the renderer, the button that starts the AR session, the render loop.
//
// - Session: immersive-ar, reference space local-floor (room coordinates, INTERFACES section 1).
// - Of the optional features (optionalFeatures) only those the device grants are on.
//   Check what was granted with ctx.xr.enabledFeatures / ctx.xr.has('hand-tracking').
// - A PC browser without AR shows the same scene as a plain 3D view (turn it with the mouse).
// - Every frame it calls update(frame) of each registered module.

import * as THREE from 'three';
import { floorPose, originOffset, asTransform } from './room-frame.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mode } from './mode.js';
import { params } from './params.js';

// 'depth-sensing': live depth for the scan (scan/depth.js lays it over the room scan, so that
// something put down or taken away a moment ago changes the map).
//   - Field map: asked for by default, because a map that follows the surroundings is what that
//     mode is for. ?depth=0 leaves it out.
//   - Mars map: left out unless ?depth=1. Nothing there reads it.
// Asking is harmless where the headset refuses: it is an optional feature, and the room scan
// (mesh-detection and plane-detection) carries on alone. With it, three.js would hide virtual
// objects behind real surfaces; the scan switches that off (scan/index.js) and only reads the
// numbers. three.js also takes the cameras' near and far planes from the depth data then.
// Not yet checked on the headset: if the field map misbehaves there, try ?depth=0 first.
const DEPTH_PARAM = params.get('depth');
const wantDepth = () => DEPTH_PARAM === '1' || (DEPTH_PARAM !== '0' && mode.current === 'field');
// ?space=unbounded asks for the WebXR "unbounded" reference space, which the Quest Browser lists
// as experimental since 34.2: the session is then not limited to the Guardian boundary. That
// space has no floor level of its own, so it is shifted to the floor of 'local-floor' and the
// rest of the app keeps working in room coordinates. Untested on the headset: without the
// parameter, or if the headset refuses it, the session stays on 'local-floor'.
const WANT_UNBOUNDED = params.get('space') === 'unbounded';
// The room's coordinates are kept from session to session with a persistent anchor
// (room-frame.js), so the stored field map and the waypoints fit again. ?anchor=0 turns it off;
// ?anchor=new forgets the kept anchor and makes a new one where this session starts.
// Untested on the headset: if a session starts with the room turned or shifted, use ?anchor=0.
const ANCHOR_PARAM = params.get('anchor');
const ANCHOR_KEY = 'marswalk.roomAnchor'; // localStorage: { uuid, pose: { x, z, yaw } }
/** The optional features to ask for. Decided when the session starts: it depends on the mode. */
export const optionalFeatures = (depth = wantDepth()) => [
  'hand-tracking',
  ...(depth ? ['depth-sensing'] : []),
  ...(WANT_UNBOUNDED ? ['unbounded'] : []),
  'mesh-detection',
  'plane-detection',
  'anchors',
  'hit-test',
];

// Asking for depth-sensing needs the preferred formats with it. What the device chose is in
// session.depthUsage / session.depthDataFormat (see it in check.html).
export const DEPTH_SENSING_INIT = {
  // The Quest 3 only hands out gpu-optimized / unsigned-short, and that is what the scan reads.
  usagePreference: ['gpu-optimized', 'cpu-optimized'],
  dataFormatPreference: ['unsigned-short', 'float32', 'luminance-alpha'],
  // The depth image as it was captured, with its own pose and projection, instead of one warped
  // to the current view: the scan places each sample in the room itself (scan/depth.js).
  matchDepthView: false,
};

export function sessionInit(depth = wantDepth()) {
  return {
    requiredFeatures: ['local-floor'],
    optionalFeatures: optionalFeatures(depth),
    ...(depth ? { depthSensing: DEPTH_SENSING_INIT } : {}),
  };
}

/** The features the session was actually granted. null if the browser does not tell. */
export function readEnabledFeatures(session) {
  return Array.isArray(session?.enabledFeatures) ? [...session.enabledFeatures] : null;
}

export function createXR({ container, button }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(2.6, 2.4, 3.2); // start position for the PC view. In AR the headset's position takes over.

  scene.add(new THREE.HemisphereLight(0xffffff, 0x554433, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(2, 4, 1);
  scene.add(sun);

  // Seen in the PC view only: a dark background, a 4 m × 4 m floor grid (0.5 m a cell), the axes.
  // Axis colours: red +x, green +y (up), blue +z. The origin of the room coordinates is the middle of the floor.
  const desktopOnly = new THREE.Group();
  desktopOnly.name = 'desktop-only';
  const grid = new THREE.GridHelper(4, 8, 0x6b7280, 0x2f343c);
  desktopOnly.add(grid, new THREE.AxesHelper(0.5));
  scene.add(desktopOnly);
  const desktopBackground = new THREE.Color(0x0b0d10);
  scene.background = desktopBackground;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.6, 0);
  controls.enableDamping = true;

  window.addEventListener('resize', () => {
    if (renderer.xr.isPresenting) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const startCbs = new Set();
  const endCbs = new Set();
  const realignCbs = new Set();

  /** The XR state the other modules see (ctx.xr). */
  const xr = {
    /** Whether this browser supports immersive-ar. null until checked */
    supported: null,
    /** The current XRSession. null outside a session */
    session: null,
    /** Names of the granted features. null outside a session or if the browser does not tell */
    enabledFeatures: null,
    /** Whether an AR session is running */
    get presenting() {
      return renderer.xr.isPresenting;
    },
    /** The local-floor reference space. null outside a session */
    get refSpace() {
      return renderer.xr.isPresenting ? renderer.xr.getReferenceSpace() : null;
    },
    /** Whether a feature was granted. null if unknown (then try it and see) */
    has(feature) {
      if (!xr.session) return false;
      if (!xr.enabledFeatures) return null;
      return xr.enabledFeatures.includes(feature);
    },
    /** Called when a session starts, and at once if one is running. Returns a function that removes it */
    onSessionStart(fn) {
      startCbs.add(fn);
      if (xr.session) fn(xr.session);
      return () => startCbs.delete(fn);
    },
    onSessionEnd(fn) {
      endCbs.add(fn);
      return () => endCbs.delete(fn);
    },
    /**
     * Called when the app's coordinates change during a session: the reference space was
     * shifted onto the room's kept coordinates (room-frame.js). Whatever a module holds in
     * room coordinates from before is in the old ones.
     */
    onRealign(fn) {
      realignCbs.add(fn);
      return () => realignCbs.delete(fn);
    },
    /** How the room's kept coordinates stand: null (not tried), 'restored', 'created', or why not. */
    roomAnchor: null,
    start: startSession,
    end: () => xr.session?.end(),
  };

  function callAll(cbs, arg) {
    for (const fn of [...cbs]) {
      try {
        fn(arg);
      } catch (err) {
        console.error('[xr] error in a session callback', err);
      }
    }
  }

  // Swap the reference space for an unbounded one whose origin is the local-floor origin.
  // Resolves when the swap is done (or was not possible).
  async function useUnboundedSpace(session) {
    try {
      const [unbounded, floor] = await Promise.all([
        session.requestReferenceSpace('unbounded'),
        session.requestReferenceSpace('local-floor'),
      ]);
      await new Promise((resolve) => {
        session.requestAnimationFrame((_time, frame) => {
          const pose = frame.getPose(floor, unbounded); // where the floor origin is, in unbounded coordinates
          if (!pose || xr.session !== session) {
            console.warn('[xr] unbounded space: no pose for the floor origin, staying on local-floor');
          } else {
            renderer.xr.setReferenceSpace(unbounded.getOffsetReferenceSpace(pose.transform));
            xr.space = 'unbounded';
            console.info('[xr] reference space: unbounded, origin on the local floor');
          }
          resolve();
        });
      });
    } catch (err) {
      console.warn('[xr] unbounded reference space refused, staying on local-floor:', err.name);
    }
  }

  // ---- the room's coordinates, kept across sessions (room-frame.js) ----
  /** The next frame of the session in which fn(frame) returns something, or null after `tries` frames. */
  function frameWith(session, fn, tries = 180) {
    return new Promise((resolve) => {
      const step = (_time, frame) => {
        if (xr.session !== session) return resolve(null);
        let got = null;
        try {
          got = fn(frame);
        } catch {
          got = null;
        }
        if (got || --tries <= 0) resolve(got ?? null);
        else session.requestAnimationFrame(step);
      };
      session.requestAnimationFrame(step);
    });
  }

  /** Shift the reference space so that `anchor` lies where it was kept. `base`: the space the session gave. */
  async function alignTo(session, base, anchor, kept) {
    const pose = await frameWith(session, (frame) => frame.getPose(anchor.anchorSpace, base));
    if (!pose) throw new Error('the kept anchor has no pose in this room');
    const offset = originOffset(kept, floorPose(pose.transform));
    const [position, orientation] = asTransform(offset);
    renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(new XRRigidTransform(position, orientation)));
    console.info('[xr] room coordinates restored from the kept anchor: origin shifted by', offset.x.toFixed(2), offset.z.toFixed(2), 'm, turned', ((offset.yaw * 180) / Math.PI).toFixed(1), 'deg');
    callAll(realignCbs);
  }

  async function keepRoomCoordinates(session) {
    if (ANCHOR_PARAM === '0') return (xr.roomAnchor = 'off (?anchor=0)');
    try {
      if (typeof session.restorePersistentAnchor !== 'function') return (xr.roomAnchor = 'not offered by this browser');
      const base = renderer.xr.getReferenceSpace();
      const known = new Set(session.persistentAnchors ?? []);
      let saved = null;
      try {
        saved = ANCHOR_PARAM === 'new' ? null : JSON.parse(localStorage.getItem(ANCHOR_KEY));
      } catch {
        saved = null;
      }
      if (saved?.uuid && known.has(saved.uuid) && saved.pose) {
        const anchor = await session.restorePersistentAnchor(saved.uuid);
        await alignTo(session, base, anchor, saved.pose);
        // A recentre moves the origin again: put it back on the anchor.
        base.addEventListener('reset', () => alignTo(session, base, anchor, saved.pose).catch((err) => console.warn('[xr] room coordinates not restored after a recentre:', err.message)));
        return (xr.roomAnchor = 'restored');
      }
      // None kept (or the headset no longer has it): this session's origin becomes the kept one.
      // Anchors of this page that nothing points to any more are given back first (the headset keeps only a few).
      for (const uuid of known) await session.deletePersistentAnchor?.(uuid).catch(() => {});
      const anchor = await frameWith(session, (frame) => (frame.getViewerPose(base) ? frame.createAnchor?.(new XRRigidTransform(), base) : null));
      if (!anchor) throw new Error('no anchor could be made');
      const uuid = await (await anchor).requestPersistentHandle();
      localStorage.setItem(ANCHOR_KEY, JSON.stringify({ uuid, pose: { x: 0, z: 0, yaw: 0 }, madeAt: new Date().toISOString() }));
      console.info('[xr] room coordinates: an anchor is kept at this session\'s origin');
      return (xr.roomAnchor = 'created');
    } catch (err) {
      console.warn('[xr] room coordinates are not kept across sessions:', err?.name, err?.message);
      return (xr.roomAnchor = `failed: ${err?.message ?? err}`);
    }
  }

  async function startSession() {
    if (xr.session) return xr.session;
    const session = await navigator.xr.requestSession('immersive-ar', sessionInit());
    await renderer.xr.setSession(session);
    xr.session = session;
    xr.space = 'local-floor';
    xr.roomAnchor = null;
    // First the space the session is to run in, then that space onto the room's kept coordinates.
    (WANT_UNBOUNDED ? useUnboundedSpace(session) : Promise.resolve()).then(() => xr.session === session && keepRoomCoordinates(session));
    xr.enabledFeatures = readEnabledFeatures(session);
    console.info('[xr] session started. Granted features:', xr.enabledFeatures ?? '(the browser does not tell)');
    scene.background = null; // so that the passthrough shows
    desktopOnly.visible = false;
    controls.enabled = false;
    session.addEventListener('end', () => {
      xr.session = null;
      xr.enabledFeatures = null;
      scene.background = desktopBackground;
      desktopOnly.visible = true;
      controls.enabled = true;
      updateButton();
      callAll(endCbs);
    });
    updateButton();
    callAll(startCbs, session);
    return session;
  }

  function updateButton() {
    if (!button) return;
    if (xr.session) {
      button.textContent = 'Exit AR';
      button.disabled = false;
    } else if (xr.supported) {
      button.textContent = 'Mars map';
      button.disabled = false;
    } else if (xr.supported === false) {
      button.textContent = 'No AR here · PC 3D view';
      button.disabled = true;
    }
  }

  button?.addEventListener('click', () => {
    if (xr.session) xr.end();
    else startSession().catch((err) => {
      console.error('[xr] could not start the session', err);
      button.textContent = `Start failed: ${err.name}`;
    });
  });

  (async () => {
    try {
      xr.supported = !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'));
    } catch {
      xr.supported = false;
    }
    updateButton();
  })();

  // ---- the render loop ----
  const modules = [];
  const failed = new WeakSet();
  let last = 0;

  /** Registers a module whose update(frame) is called every frame. */
  function addModule(name, mod) {
    modules.push({ name, mod });
  }

  function run() {
    renderer.setAnimationLoop((time, xrFrame) => {
      const dt = last ? Math.min((time - last) / 1000, 0.1) : 0;
      last = time;
      // What a module's update(frame) is given
      const frame = {
        /** Time since the start (ms) */
        time,
        /** Time since the previous frame (s, at most 0.1) */
        dt,
        /** The XRFrame. null outside an AR session (PC view) */
        xrFrame: xrFrame ?? null,
        /** The local-floor reference space. null outside a session */
        refSpace: xr.refSpace,
        session: xr.session,
      };
      for (const m of modules) {
        if (!m.mod.update) continue;
        try {
          m.mod.update(frame);
        } catch (err) {
          // Logged once per module, so the same error does not pour out every frame.
          if (!failed.has(m.mod)) {
            failed.add(m.mod);
            console.error(`[xr] error in ${m.name}.update (later errors of this module are not logged)`, err);
          }
        }
      }
      if (controls.enabled) controls.update();
      renderer.render(scene, camera);
    });
  }

  return { renderer, scene, camera, xr, controls, addModule, run };
}
