// Remote diagnostics: what goes wrong inside the headset is invisible from outside, so errors
// and session events are sent to the hub, which writes them to its log (client.log).
//
//   - uncaught errors, unhandled promise rejections, console.error
//   - AR session start / end, visibility changes, reference space resets
//   - a heartbeat every 5 s while in AR: head position, tracked hands, session visibility,
//     the frame rate over those 5 s with the longest gap between two frames, and what the
//     obstacle scan last reported (reads so far, cells found, the depth image's size): how
//     the app runs on the headset can then be read from the hub's logs/headset.log

import * as THREE from 'three';
import { bus } from './bus.js';

const headPos = new THREE.Vector3();

let send = null;
const queue = [];

function log(kind, data) {
  const entry = { kind, ...data };
  if (send && send('client.log', entry)) return;
  queue.push(entry);
  if (queue.length > 40) queue.shift();
}

function brief(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** @param {(type: string, payload: object) => boolean} sendJson */
export function initDiag(sendJson, xr) {
  send = sendJson;
  window.addEventListener('error', (e) => log('error', { message: e.message, at: `${e.filename?.split('/').pop()}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => log('rejection', { message: brief(e.reason) }));
  const original = console.error.bind(console);
  console.error = (...args) => {
    original(...args);
    log('console.error', { message: args.map(brief).join(' ').slice(0, 400) });
  };

  xr.onSessionStart((session) => {
    log('xr', { event: 'start', features: xr.enabledFeatures, visibility: session.visibilityState });
    setTimeout(() => xr.session === session && log('xr', { event: 'space', space: xr.space }), 1500);
    // Whether the room's coordinates were kept from the last session (core/room-frame.js).
    setTimeout(() => xr.session === session && log('xr', { event: 'roomAnchor', state: xr.roomAnchor }), 6000);
    session.addEventListener('visibilitychange', () => log('xr', { event: 'visibility', visibility: session.visibilityState }));
    const space = xr.refSpace;
    space?.addEventListener?.('reset', () => log('xr', { event: 'reference-space-reset' }));
  });
  xr.onSessionEnd(() => log('xr', { event: 'end' }));
  bus.on('app:mode', ({ mode }) => log('mode', { mode }));
  bus.on('hazard:update', ({ stats, source }) => {
    scan = stats ? { source, reads: stats.reads, skips: stats.skips, obstacles: stats.obstacles, floor: stats.floor, depth: stats.depth, meshes: stats.meshes, planes: stats.planes, depthPx: stats.depthPx } : null;
  });
}

/** Called by link.js when the socket opens: send what was collected while offline. */
export function flushDiag() {
  while (queue.length && send?.('client.log', queue[0])) queue.shift();
}

let lastBeat = 0;
let lastFrame = 0; // time of the frame before this one, while in AR
let frames = 0; // frames since the last heartbeat
let slowestMs = 0; // the longest gap between two frames since then
let scan = null; // what the obstacle scan said with its last hazard:update
/** Called every frame by the render loop. */
export function diagFrame(frame, camera) {
  if (!frame.session) {
    // Not in AR: the time until the next session is neither a slow frame nor part of a frame rate.
    lastFrame = lastBeat = frames = slowestMs = 0;
    return;
  }
  if (lastFrame) slowestMs = Math.max(slowestMs, frame.time - lastFrame);
  lastFrame = frame.time;
  frames++;
  if (frame.time - lastBeat < 5000) return;
  const fps = lastBeat ? Math.round((frames * 1000) / (frame.time - lastBeat)) : null; // null: the first beat of a page has no 5 s behind it
  const slowest = Math.round(slowestMs);
  lastBeat = frame.time;
  frames = 0;
  slowestMs = 0;
  let hands = 0;
  for (const src of frame.session.inputSources) if (src.hand) hands++;
  const p = camera.getWorldPosition(headPos);
  log('beat', { head: [p.x, p.y, p.z].map((v) => Number(v.toFixed(2))), hands, visibility: frame.session.visibilityState, fps, slowestMs: slowest, scan });
}
