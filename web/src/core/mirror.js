// Mirror: what the app draws, sent to the Jetson hub so it can be watched on a monitor
// (http://<jetson>:8080/monitor, or https://<jetson>:8443/monitor) and recorded there.
//
// The headset's own casting needs a Meta account, and adb needs developer mode. This needs
// neither: several times a second the scene is drawn once more, from the wearer's head, into a
// picture that goes to the hub as a JPEG over its own WebSocket (/mirror). The hub keeps the
// newest picture and streams it to whoever has the monitor page open.
//
// The page only draws the picture and reads it back from the GPU without waiting for it: the
// pixels go into a buffer on the GPU and are fetched a frame or two later, when the GPU says
// they are there (checked from the frame loop, the one clock that is sure to tick in AR).
// Encoding and sending happen in a worker (mirror.worker.js):
// on the page's own thread an AR session leaves no idle time, and the first version, which
// encoded there, delivered one picture every few seconds.
//
// What it shows: everything the app draws (HUD, map, menus, pointer, arrows, the obstacle
// outline), plus two things only the mirror sees: a floor grid of 1 m squares and a dot on
// every tracked hand joint, so there is something to see the virtual things against.
// What it does not show by itself: the room. WebXR gives a page no picture of what the wearer
// sees, so the background is plain where the wearer sees the real world.
//
// The room behind it: on a headset the page asks the browser for a camera (getUserMedia) and
// draws its picture behind everything else. Our Quest 3 offers "camera 0, facing front" (a
// virtual camera that shows the wearer's avatar) and two cameras "facing back" (the
// passthrough cameras): a back one is taken; ?mirrorCam=camera 1 picks by name.
//
// How much of the world the picture shows (mirror-view.js): the wearer sees about 108 x 99
// degrees, the camera about 73 x 58. Drawn with the camera's lens, as it first was, the mirror
// lost whatever the wearer saw outside the camera's picture: the map on the palm, the panels
// low in the view. So the picture now shows the wearer's whole view (both eyes, as the headset
// reports them every frame, widened to the picture's shape), from the point midway between the
// eyes, and the camera picture lies in the middle of it at its true size. Around it the room
// is not seen: a dimmed blur of the picture's own edge fades out there, so the frame is not a
// hard black. The monitor page switches between this ("Whole view") and the old one
// ("Camera": the camera's lens, the room fills the picture, the edge of the wearer's view is
// lost); ?mirrorView=camera starts with the old one, ?mirrorFill=0 leaves the surround plain.
//
// Lining the two up: the virtual things only sit where the wearer sees them over the camera
// picture if that picture is drawn as large as the camera's lens makes it. With a lens taken
// too wide everything virtual is too small about the middle, and the floor grid then looks
// like a plane tipped against the real floor (it did: the mirror assumed 80 degrees, the
// camera sees about 58). The browser does not tell a page the camera's lens or where it
// points, so the values are our estimate for the Quest 3 (lens below) and can be corrected
// while watching: the monitor page has buttons for the field of view and the tilt, the hub
// keeps what was set and hands it to the app (a "tune" message). ?mirrorFov= and ?mirrorTilt=
// set them from the address instead.
// What the browser offered and gave is shown on the monitor page and in the hub's log.
// ?mirror=nocam leaves the camera out.
//
// Sharp and never late: the picture is 1280 x 960 (?mirrorSize=960x720 for less), stored the
// way a JPEG wants it (sRGB, so dark parts of the room keep their shades), and how hard it is
// compressed follows the link (mirror-rate.js, in the worker): the hub answers every picture,
// no more than two are ever on their way, and the JPEG quality goes up while the hotspot has
// room and down when it has not. A slow link gives fewer pictures, never old ones.
//
// What it costs the headset: one more drawing of the scene for every picture. So a picture is
// made at most 15 times a second (?mirrorFps=) and on at most one frame in five: when the
// headset itself is slow the mirror takes less, not the same. And nothing while nobody
// watches: the hub says how many viewers there are (a recording counts as one), and pictures
// are only made while there is at least one. ?mirror=0 turns it off, ?mirror=1 also mirrors
// the PC view (outside AR, without a camera).
//
// This is the one WebSocket besides link.js (INTERFACES section 4): pictures must not queue up
// in front of the microphone stream and the alerts.

import * as THREE from 'three';
import { config, mock } from './config.js';
import { mode } from './mode.js';
import { params, isOff, numberOr } from './params.js';
import { viewOfProjection, viewOfLens, widest, fitView, viewAngles, pictureSize } from './mirror-view.js';

const [WIDTH, HEIGHT] = pictureSize(params.get('mirrorSize'));

export const MIRROR = {
  enabled: !isOff('mirror') && !mock.link,
  outsideAR: params.get('mirror') === '1',
  camera: !['0', '1', 'nocam'].includes(params.get('mirror')), // the headset's camera picture behind the mirror; ?mirror=nocam leaves it out
  cameraName: params.get('mirrorCam'), // ?mirrorCam=camera 1 picks a camera by (part of) its name, when the default choice is the wrong one
  // 4:3 like the camera picture. In the whole view the wearer's 99 degrees from top to bottom
  // share these 960 lines on a flat picture: about 6.7 lines to a degree in the middle, against
  // 7.6 in the 640 x 480 picture of the camera's 58 degrees it replaces, so the whole view is
  // about a tenth coarser there; the camera view is twice as fine as it was.
  width: WIDTH,
  height: HEIGHT,
  fps: Math.min(30, Math.max(1, numberOr('mirrorFps', 15))), // pictures a second, at most
  everyFrames: 5, // and on one frame in five at most: a headset that runs slowly gives fewer
  quality: 0.8, // JPEG quality to begin with; the worker moves it with the link (mirror-rate.js)
  view: params.get('mirrorView') === 'camera' ? 'camera' : 'full', // what the picture shows (above); the monitor page switches it
  margin: 0.04, // the whole view is taken this much larger on every side (mirror-view.js: fitView)
  fill: isOff('mirrorFill') ? 0 : 0.42, // how bright the blur around the camera picture is, against the picture itself (0: plain)
  fovDeg: 80, // vertical, for the PC view (outside AR there are no eyes to ask)
  // With the camera picture behind: the lens the picture was taken with. Estimates for the
  // Quest 3's passthrough camera at 4:3 (not published for the browser); the monitor page tunes them.
  lens: {
    fovDeg: numberOr('mirrorFov', 58), // vertical
    tiltDeg: numberOr('mirrorTilt', 0), // how far the camera looks below the wearer's line of sight
    fovRange: [35, 110],
    tiltRange: [-25, 25],
  },
  backdrop: 0x0b0d12, // where the wearer sees the room
  layer: 31, // things only the mirror's camera sees
  // ?mirrorTest=1, on a PC with ?mirror=1: a headset's two eyes and a camera picture are made
  // up (a test card), so the whole view can be looked at without a headset.
  test: params.get('mirrorTest') === '1',
};

const JOINTS = 25;

/** ws(s)://host/ws -> ws(s)://host/mirror */
export const mirrorUrl = (jetsonUrl) => jetsonUrl.replace(/\/ws(\?.*)?$/, '/mirror');

// The room's picture: a sheet standing far in front of the camera that took it, as large as
// that camera's lens makes its picture, drawn before everything else and behind it. Larger
// than the picture by SPREAD each way: outside the picture it carries the blur (below).
const SHEET_M = 50; // how far away it stands; it is drawn without depth, so only its angle matters
const SPREAD = 4.4; // sheet size / picture size: room for the blur to fade out (1.6 pictures to every side)
const ROOM_FRAGMENT = `
  uniform sampler2D map;
  uniform float spread;
  uniform float fill;
  uniform vec3 backdrop;
  varying vec2 vUv;
  // A camera picture comes in sRGB; the scene is drawn in linear light.
  vec3 toLinear(vec3 c) {
    return mix(pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
  }
  void main() {
    vec2 uv = (vUv - 0.5) * spread + 0.5; // 0..1 across the camera picture
    vec2 beyond = max(max(-uv, uv - 1.0), 0.0); // how far outside it, in pictures
    float far = max(beyond.x, beyond.y);
    if (far <= 0.0) {
      gl_FragColor = vec4(toLinear(texture2D(map, uv).rgb), 1.0);
      return;
    }
    // Outside: the picture folded over at its edge and blurred beyond telling (a small copy of
    // it, from the texture's own chain of smaller copies), dimmed, and fading into the backdrop.
    // It says "the room goes on here, this camera does not see it", and no more than that.
    vec2 folded = 1.0 - abs(1.0 - mod(uv, 2.0));
    vec3 blur = toLinear(textureLod(map, folded, 6.5).rgb);
    float glow = fill * (1.0 - smoothstep(0.0, 1.6, far));
    float line = 0.5 + 0.5 * smoothstep(0.0, 0.008, far); // a thin dark line where the camera picture ends
    gl_FragColor = vec4(mix(backdrop, blur, glow) * line, 1.0);
  }`;

/** A picture to stand in for the camera's (?mirrorTest=1): squares of a tenth of the picture, a cross, the corners named. */
function testCard() {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 960;
  const g = c.getContext('2d');
  for (let j = 0; j < 10; j++) {
    for (let i = 0; i < 10; i++) {
      g.fillStyle = (i + j) % 2 ? '#3d6b8c' : '#8c6b3d';
      g.fillRect(i * 128, j * 96, 128, 96);
    }
  }
  g.strokeStyle = '#fff';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 1274, 954);
  g.beginPath();
  g.moveTo(640, 0);
  g.lineTo(640, 960);
  g.moveTo(0, 480);
  g.lineTo(1280, 480);
  g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 64px sans-serif';
  g.fillText('TOP LEFT', 24, 80);
  g.fillText('BOTTOM RIGHT', 760, 930);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; // handed to the shader as it is, like a camera picture
  return t;
}

export function initMirror({ renderer, scene, camera, xr }) {
  if (!MIRROR.enabled) return { update() {} };
  const { width, height } = MIRROR;
  const aspect = width / height;
  const cam = new THREE.PerspectiveCamera(MIRROR.fovDeg, aspect, 0.05, 200);
  const lens = { fovDeg: MIRROR.lens.fovDeg, tiltDeg: MIRROR.lens.tiltDeg }; // of the camera picture; the hub may correct it
  let wanted = MIRROR.view; // 'full' | 'camera'; the monitor page may switch it
  const tilt = new THREE.Quaternion();
  const RIGHT = new THREE.Vector3(1, 0, 0);
  const within = (v, [lo, hi], fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  cam.layers.enable(MIRROR.layer);
  // Stored as sRGB, the way the JPEG wants it: the GPU does the conversion as it writes, and
  // the dark shades of a room keep all their steps (as linear bytes they were a handful).
  const target = new THREE.WebGLRenderTarget(width, height);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  let pixels = new Uint8Array(width * height * 4); // handed to the worker with each picture and handed back
  const backdrop = new THREE.Color(MIRROR.backdrop);

  // Only for the mirror: the floor, the hands, and the room's picture.
  const floor = new THREE.GridHelper(16, 16, 0x39404f, 0x232833);
  floor.layers.set(MIRROR.layer);
  floor.visible = false; // on the PC view the scene has its own ground
  const hands = new THREE.InstancedMesh(new THREE.SphereGeometry(0.007, 8, 6), new THREE.MeshBasicMaterial({ color: 0xe8edf5 }), JOINTS * 2);
  hands.layers.set(MIRROR.layer);
  hands.frustumCulled = false;
  hands.count = 0;
  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, spread: { value: SPREAD }, fill: { value: MIRROR.fill }, backdrop: { value: backdrop } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: ROOM_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  sheet.layers.set(MIRROR.layer);
  sheet.frustumCulled = false;
  sheet.renderOrder = -1e6; // before everything else
  sheet.visible = false;
  scene.add(floor, hands, sheet);
  const poses = new Float32Array(JOINTS * 16);

  // The camera picture, if the browser gives one.
  let video = null;
  let videoTexture = null;
  let card = null; // ?mirrorTest=1: stands in for the camera
  let cameraNote = MIRROR.camera ? 'asking' : 'off'; // goes to the hub with the info
  async function openCamera() {
    try {
      const media = navigator.mediaDevices;
      if (!media?.getUserMedia) throw new Error('no getUserMedia here');
      const size = { width: { ideal: 1280 }, height: { ideal: 960 } };
      // The first request is what makes the browser name its cameras (labels are empty before a permission).
      let stream = await media.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false });
      const cameras = (await media.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const names = cameras.map((d) => d.label || '(unnamed)');
      // The room is seen by a camera "facing back". "Facing front" on a headset is the virtual
      // camera with the wearer's avatar, which the Quest hands out first whatever is asked for.
      const wantedCam = MIRROR.cameraName ? new RegExp(MIRROR.cameraName, 'i') : /back|environment|passthrough|world/i;
      const notTheRoom = /front|user|virtual|avatar/i;
      const have = stream.getVideoTracks()[0]?.label ?? '';
      if (!wantedCam.test(have)) {
        const other = cameras.find((d) => wantedCam.test(d.label)) ?? (MIRROR.cameraName ? null : cameras.find((d) => d.label && !notTheRoom.test(d.label)));
        stream.getTracks().forEach((t) => t.stop());
        if (!other) throw new Error(`no camera that sees the room is offered: ${names.join(', ')}`);
        stream = await media.getUserMedia({ video: { deviceId: { exact: other.deviceId }, ...size }, audio: false });
      }
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      videoTexture = new THREE.VideoTexture(video);
      videoTexture.colorSpace = THREE.SRGBColorSpace;
      if (MIRROR.fill) {
        // The chain of smaller copies the blur around the picture is taken from; it also makes
        // the picture itself calmer where it is drawn smaller than it came.
        videoTexture.generateMipmaps = true;
        videoTexture.minFilter = THREE.LinearMipmapLinearFilter;
      }
      const s = stream.getVideoTracks()[0].getSettings();
      cameraNote = `"${stream.getVideoTracks()[0].label}" ${s.width}x${s.height} (offered: ${names.join(', ')})`;
    } catch (err) {
      video = videoTexture = null;
      cameraNote = `none: ${err.name}: ${err.message}`;
    }
    console.info('[mirror] camera:', cameraNote);
  }
  // Asked for when the page loads, like the microphone (a prompt that comes up while an AR
  // session starts is lost behind it), and only on a device that has AR: a desk computer
  // should not be asked for its webcam.
  if (MIRROR.test) {
    card = testCard();
    cameraNote = 'test card';
  } else if (MIRROR.camera) {
    navigator.xr
      ?.isSessionSupported('immersive-ar')
      .then((ar) => {
        if (ar) openCamera();
        else cameraNote = 'off (no AR here)';
      })
      .catch(() => {});
  }

  let viewers = 0;
  let busy = false; // a picture is with the GPU or the worker, or the worker waits for the hub to answer
  let last = 0;
  let framesSince = MIRROR.everyFrames; // frames drawn since the last picture
  let costMs = 0; // what one picture takes of the page's own thread (ms, smoothed): drawing it and fetching it
  let spent = 0; // of which so far for the picture being made
  let lastInfo = null;
  let grab = null; // window.__mirror.grab(): resolve() for the next picture's JPEG
  const worker = new Worker(new URL('./mirror.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'viewers') viewers = data.n;
    else if (data.type === 'tune') {
      // Set on the monitor page while watching the grid against the real floor.
      lens.fovDeg = within(Number(data.tune?.fovDeg), MIRROR.lens.fovRange, lens.fovDeg);
      lens.tiltDeg = within(Number(data.tune?.tiltDeg), MIRROR.lens.tiltRange, lens.tiltDeg);
      if (data.tune?.view === 'full' || data.tune?.view === 'camera') wanted = data.tune.view;
    } else if (data.type === 'done') {
      pixels = new Uint8Array(data.pixels);
      busy = false;
      if (data.jpeg && grab) {
        grab(data.jpeg);
        grab = null;
      }
    }
  };
  worker.postMessage({ type: 'open', url: mirrorUrl(config.jetsonUrl), quality: MIRROR.quality, fps: MIRROR.fps });

  function placeHands(frame) {
    let n = 0;
    if (frame.xrFrame?.fillPoses && frame.session && frame.refSpace) {
      for (const src of frame.session.inputSources) {
        if (!src.hand || n + JOINTS > JOINTS * 2) continue;
        if (!frame.xrFrame.fillPoses(src.hand.values(), frame.refSpace, poses)) continue;
        hands.instanceMatrix.array.set(poses, n * 16);
        n += JOINTS;
      }
    }
    hands.count = n;
    hands.instanceMatrix.needsUpdate = true;
  }

  // Where the wearer's head is and what both eyes see. In AR three.js keeps a camera for each
  // eye (its own `camera` is the left eye alone): the mirror looks from midway between them,
  // and the whole view is the widest of what each sees.
  const headAt = new THREE.Vector3();
  const headTurn = new THREE.Quaternion();
  const eyeAt = new THREE.Vector3();
  const unused = new THREE.Vector3();
  // About a Quest 3's two eyes together, for ?mirrorTest=1 on a PC.
  const TEST_EYES = { left: -Math.tan(0.942), right: Math.tan(0.942), down: -Math.tan(0.96), up: Math.tan(0.768) };
  /** Sets headAt and headTurn; returns the wearer's whole view, or null when there are no eyes to ask. */
  function head(inAR) {
    const eyes = inAR ? (renderer.xr.getCamera()?.cameras ?? []) : [];
    const whole = widest(eyes.map((eye) => viewOfProjection(eye.projectionMatrix.elements)));
    if (!whole) {
      camera.matrixWorld.decompose(headAt, headTurn, unused);
      return MIRROR.test ? TEST_EYES : null;
    }
    eyes[0].matrixWorld.decompose(headAt, headTurn, unused);
    for (let i = 1; i < eyes.length; i++) headAt.add(eyeAt.setFromMatrixPosition(eyes[i].matrixWorld));
    headAt.divideScalar(eyes.length);
    return whole;
  }

  /** The mirror's camera shows `view` (mirror-view.js: four tangents). */
  function look(view) {
    const n = cam.near;
    cam.projectionMatrix.makePerspective(view.left * n, view.right * n, view.up * n, view.down * n, n, cam.far, cam.coordinateSystem);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  // Reading back without waiting: the picture is copied into a GPU buffer (a PBO) behind a
  // fence, and collected once the fence has been passed.
  const gl = renderer.getContext();
  const pbo = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  let pending = null; // { sync, info, since } while a picture is on its way out of the GPU

  function capture(frame) {
    const inAR = !!frame.session;
    const whole = head(inAR);
    placeHands(frame);
    floor.visible = inAR;
    const live = videoTexture && video.readyState >= 2 && !video.paused ? videoTexture : null;
    const room = live ?? card;
    // The whole view when there are eyes to ask and it is wanted, or when there is no camera
    // picture to fill the frame instead.
    const full = !!whole && (wanted === 'full' || !room);
    const view = full ? fitView(whole, aspect, MIRROR.margin) : viewOfLens(room ? lens.fovDeg : MIRROR.fovDeg, aspect);
    look(view);
    cam.position.copy(headAt);
    cam.quaternion.copy(headTurn);
    if (room) {
      // The camera looks where the head looks, tipped by the tilt; its picture stands square in front of it.
      tilt.setFromAxisAngle(RIGHT, THREE.MathUtils.degToRad(-lens.tiltDeg));
      sheet.quaternion.copy(headTurn).multiply(tilt);
      sheet.position.set(0, 0, -SHEET_M).applyQuaternion(sheet.quaternion).add(headAt);
      const tall = 2 * SHEET_M * Math.tan(THREE.MathUtils.degToRad(lens.fovDeg) / 2);
      const shape = live ? video.videoWidth / video.videoHeight || 4 / 3 : card.image.width / card.image.height;
      sheet.scale.set(tall * shape * SPREAD, tall * SPREAD, 1);
      sheet.material.uniforms.map.value = room;
      // In the camera view the mirror looks exactly as the camera does: its picture fills the frame.
      if (!full) cam.quaternion.copy(sheet.quaternion);
    }
    sheet.visible = !!room;
    const before = renderer.getRenderTarget();
    const xrOn = renderer.xr.enabled;
    const background = scene.background;
    try {
      renderer.xr.enabled = false; // draw into the picture, not into the headset's eyes
      if (inAR || room) scene.background = backdrop;
      renderer.setRenderTarget(target);
      renderer.render(scene, cam);
      // While target is still the current one (scan/depth.js): start the copy, do not wait for it.
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sees = viewAngles(view).map(Math.round);
      lastInfo = {
        width,
        height,
        fps: MIRROR.fps,
        ar: inAR,
        mode: mode.current,
        space: xr.space ?? null,
        camera: cameraNote,
        lens: room ? { ...lens } : null,
        view: full ? 'full' : room ? 'camera' : 'plain', // what this picture shows
        sees, // degrees across and from top to bottom
      };
      pending = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), info: lastInfo, since: frame.time };
      gl.flush();
      busy = true;
    } finally {
      sheet.visible = false; // the eyes never see it (it is on the mirror's layer), but nothing else should either
      scene.background = background;
      renderer.setRenderTarget(before);
      renderer.xr.enabled = xrOn;
    }
  }

  /** Fetch the picture if the GPU has finished it, and hand it to the worker. */
  function collect(frame) {
    const state = gl.clientWaitSync(pending.sync, 0, 0);
    if (state === gl.TIMEOUT_EXPIRED && frame.time - pending.since < 1000) return; // not yet: next frame
    const { sync, info } = pending;
    pending = null;
    gl.deleteSync(sync);
    if (state === gl.WAIT_FAILED || state === gl.TIMEOUT_EXPIRED) {
      busy = false; // the GPU never delivered: drop this picture
      return;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    worker.postMessage({ type: 'frame', width, height, pixels: pixels.buffer, info, costMs: Math.round(costMs * 10) / 10, wantJpeg: !!grab }, [pixels.buffer]);
  }

  /** Run `work` and count what it took of this thread towards the picture being made. */
  function clocked(work, frame) {
    const t0 = performance.now();
    work(frame);
    spent += performance.now() - t0;
  }

  // Left open for the console and for checking without a headset: what the mirror is doing,
  // and the next picture as it will be sent (a Blob of the JPEG).
  window.__mirror = {
    state: () => ({ viewers, busy, wanted, lens: { ...lens }, costMs, info: lastInfo }),
    grab: () =>
      new Promise((resolve) => {
        grab = resolve;
      }),
    watch: (n = 1) => {
      viewers = n; // as if a monitor page were open (until the hub says otherwise)
    },
  };

  return {
    update(frame) {
      framesSince++;
      if (pending) {
        clocked(collect, frame);
        if (!pending) {
          costMs += (spent - costMs) * (costMs ? 0.2 : 1);
          spent = 0;
        }
      }
      if (busy || !viewers) return;
      if (!frame.session && !MIRROR.outsideAR) return;
      if (framesSince < MIRROR.everyFrames || frame.time - last < 1000 / MIRROR.fps - 2) return;
      last = frame.time;
      framesSince = 0;
      clocked(capture, frame);
    },
  };
}
