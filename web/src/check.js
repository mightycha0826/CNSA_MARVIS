// Device check page (check.html). Open it in the headset's browser to see which WebXR features work.
// It opens a session with the app's own session options (sessionInit in core/xr.js) and measures for 10 seconds.
// HTML is not seen inside an AR session, so the results go on a panel in front of the eyes during the session and into the table after it.

import * as THREE from 'three';
import { optionalFeatures, sessionInit, readEnabledFeatures } from './core/xr.js';
import { isOff } from './core/params.js';

// The check asks for live depth as the field map does (it is what that mode starts with);
// ?depth=0 leaves it out, as it does in the app.
const WITH_DEPTH = !isOff('depth');
const OPTIONAL_FEATURES = optionalFeatures(WITH_DEPTH);

const MEASURE_MS = 10000;

// State: ok (works) / no (does not) / unk (not known yet)
const rows = [
  ['secure', 'Secure connection (HTTPS)'],
  ['xr', 'navigator.xr'],
  ['ar', 'immersive-ar support'],
  ['session', 'AR session start'],
  ...OPTIONAL_FEATURES.map((f) => [`f:${f}`, `Granted: ${f}`]),
  ['hands', 'Hand input detected'],
  ['depth', 'Depth data received'],
  ['meshes', 'Meshes detected'],
  ['planes', 'Planes detected'],
  ['mic', 'Microphone permission (getUserMedia)'],
];
const result = Object.fromEntries(rows.map(([k]) => [k, { s: 'unk', v: 'not checked', d: '' }]));
const set = (k, s, v, d = '') => {
  result[k] = { s, v, d };
  render();
};
const MARK = { ok: '✔', no: '✘', unk: '?' };

function render() {
  document.getElementById('rows').innerHTML = rows
    .map(([k, label]) => {
      const r = result[k];
      return `<tr><td>${label}</td><td class="v ${r.s}">${MARK[r.s]} ${r.v}</td><td class="d">${r.d}</td></tr>`;
    })
    .join('');
}

function asText() {
  const lines = rows.map(([k, label]) => `${MARK[result[k].s]} ${label}: ${result[k].v}${result[k].d ? ` (${result[k].d})` : ''}`);
  return [`[Device check] ${new Date().toLocaleString('en-GB')}`, navigator.userAgent, ...lines].join('\n');
}

// ---- what can be known outside a session ----
set('secure', window.isSecureContext ? 'ok' : 'no', window.isSecureContext ? 'yes' : 'no', location.origin);
const startBtn = document.getElementById('start');
if (!navigator.xr) {
  set('xr', 'no', 'missing', window.isSecureContext ? 'this browser does not support WebXR' : 'open the page over HTTPS or on localhost');
  set('ar', 'no', 'cannot check');
} else {
  set('xr', 'ok', 'present');
  navigator.xr.isSessionSupported('immersive-ar').then(
    (ok) => {
      set('ar', ok ? 'ok' : 'no', ok ? 'supported' : 'not supported');
      startBtn.disabled = !ok;
    },
    (err) => set('ar', 'no', 'error', err.message),
  );
}

// ---- microphone ----
document.getElementById('mic').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) return set('mic', 'no', 'no getUserMedia');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const st = stream.getAudioTracks()[0]?.getSettings?.() ?? {};
    set('mic', 'ok', 'granted', `sampleRate ${st.sampleRate ?? '?'}, channelCount ${st.channelCount ?? '?'}`);
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    set('mic', 'no', 'denied or failed', `${err.name}: ${err.message}`);
  }
});

document.getElementById('copy').addEventListener('click', async () => {
  const text = asText();
  document.getElementById('raw').textContent = text;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* if copying is blocked, select the text shown below by hand */
  }
});

// ---- AR session ----
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.getElementById('app').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 50);

// The results panel shown 1.2 m in front of the eyes during the session
const panelCanvas = document.createElement('canvas');
panelCanvas.width = 1024;
panelCanvas.height = 1024;
const panelTex = new THREE.CanvasTexture(panelCanvas);
panelTex.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: panelTex, transparent: true }));
panel.position.set(0, 1.4, -1.2);
scene.add(panel);

function drawPanel(lines) {
  const g = panelCanvas.getContext('2d');
  g.clearRect(0, 0, 1024, 1024);
  g.fillStyle = 'rgba(11,13,16,0.85)';
  g.fillRect(0, 0, 1024, 1024);
  g.font = 'bold 46px system-ui, sans-serif';
  g.textBaseline = 'top';
  lines.forEach(([text, s], i) => {
    g.fillStyle = { ok: '#5bd57a', no: '#ff6b5e', unk: '#f6b26b' }[s] ?? '#e8eaed';
    g.fillText(text, 36, 30 + i * 62);
  });
  panelTex.needsUpdate = true;
}

function readDepth(frame, refSpace, session) {
  const pose = frame.getViewerPose(refSpace);
  if (!pose) return null;
  for (const view of pose.views) {
    let info = null;
    // cpu-optimized comes from the XRFrame, gpu-optimized from the XRWebGLBinding.
    if (session.depthUsage !== 'gpu-optimized' && frame.getDepthInformation) {
      info = frame.getDepthInformation(view);
    } else {
      info = renderer.xr.getBinding?.()?.getDepthInformation?.(view) ?? null;
    }
    if (info) return info;
  }
  return null;
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', sessionInit(WITH_DEPTH));
    await renderer.xr.setSession(session);
  } catch (err) {
    set('session', 'no', 'failed', `${err.name}: ${err.message}`);
    startBtn.disabled = false;
    return;
  }
  set('session', 'ok', 'started');

  const enabled = readEnabledFeatures(session);
  for (const f of OPTIONAL_FEATURES) {
    if (!enabled) set(`f:${f}`, 'unk', 'unknown', 'no session.enabledFeatures');
    else set(`f:${f}`, enabled.includes(f) ? 'ok' : 'no', enabled.includes(f) ? 'granted' : 'refused');
  }

  const m = { hands: 0, handJoints: 0, depthFrames: 0, depthSize: '', depthErr: '', meshes: 0, planes: 0, meshApi: false, planeApi: false, frames: 0 };
  const t0 = performance.now();
  let lastPanel = 0;

  renderer.setAnimationLoop((time, frame) => {
    if (!frame) return;
    m.frames++;
    const refSpace = renderer.xr.getReferenceSpace();

    let hands = 0;
    for (const src of session.inputSources) {
      if (!src.hand) continue;
      hands++;
      const wrist = src.hand.get?.('wrist');
      if (wrist && frame.getJointPose?.(wrist, refSpace)) m.handJoints++;
    }
    m.hands = Math.max(m.hands, hands);

    try {
      const info = readDepth(frame, refSpace, session);
      if (info) {
        m.depthFrames++;
        m.depthSize = `${info.width ?? info.texture?.width ?? '?'}×${info.height ?? info.texture?.height ?? '?'}`;
        // The values the scan (scan/depth.js) uses to turn depth values into metres. They go in the table's notes column.
        m.depthInfo = `near ${info.depthNear}, far ${info.depthFar}, rawValueToMeters ${info.rawValueToMeters}, own view ${info.projectionMatrix ? 'yes' : 'no'}`;
      }
    } catch (err) {
      m.depthErr = `${err.name}: ${err.message}`;
    }

    if (frame.detectedMeshes) {
      m.meshApi = true;
      m.meshes = Math.max(m.meshes, frame.detectedMeshes.size);
    }
    if (frame.detectedPlanes) {
      m.planeApi = true;
      m.planes = Math.max(m.planes, frame.detectedPlanes.size);
    }

    const left = Math.max(0, MEASURE_MS - (performance.now() - t0));
    if (time - lastPanel > 300) {
      lastPanel = time;
      drawPanel([
        [`Checking the device… ${Math.ceil(left / 1000)} s`, null],
        ['Look around the room, raise both hands', null],
        [`Hands: ${m.hands} (joints ${m.handJoints ? 'received' : 'none'})`, m.handJoints ? 'ok' : 'unk'],
        [`Depth: ${m.depthFrames} frames ${m.depthSize}`, m.depthFrames ? 'ok' : 'unk'],
        [`Meshes: ${m.meshApi ? m.meshes : 'no API'}`, m.meshes ? 'ok' : 'unk'],
        [`Planes: ${m.planeApi ? m.planes : 'no API'}`, m.planes ? 'ok' : 'unk'],
        [`Granted: ${enabled ? enabled.filter((f) => OPTIONAL_FEATURES.includes(f)).join(', ') || 'none' : 'unknown'}`.slice(0, 44), null],
      ]);
    }
    renderer.render(scene, camera);
    if (left <= 0) session.end();
  });

  session.addEventListener('end', () => {
    renderer.setAnimationLoop(null);
    startBtn.disabled = false;
    if (m.handJoints) set('hands', 'ok', `${m.hands}, joints received`);
    else if (m.hands) set('hands', 'unk', `${m.hands}, no joint positions`, 'the hands were found but no joint poses came');
    else set('hands', 'no', 'not detected', 'if it is 0 with the hands raised, hand tracking is off or the controllers are held');

    // In a session without depth-sensing even reading depthUsage throws (?depth=0, or the device refused it).
    let usage = WITH_DEPTH ? 'depth-sensing was asked for and not granted' : 'depth-sensing not asked for (?depth=0)';
    try {
      usage = `usage ${session.depthUsage}, format ${session.depthDataFormat}, ${m.depthInfo ?? ''}`;
    } catch {
      /* the note set above is used as it is */
    }
    if (m.depthFrames) set('depth', 'ok', `${m.depthFrames} frames, ${m.depthSize}`, usage);
    else set('depth', 'no', 'not received', usage.startsWith('usage') ? m.depthErr || usage : usage);

    set('meshes', m.meshes ? 'ok' : 'no', m.meshApi ? `${m.meshes}` : 'no API', m.meshApi && !m.meshes ? '0 if room setup (the space scan) has not been done' : '');
    set('planes', m.planes ? 'ok' : 'no', m.planeApi ? `${m.planes}` : 'no API', m.planeApi && !m.planes ? '0 if room setup (the space scan) has not been done' : '');
    document.getElementById('raw').textContent = asText();
  });
});

render();
window.__check = { result, asText };
