// The mirror's worker: turns the pictures read from the GPU into JPEGs and sends them to the hub.
//
// Why a worker: in an AR session the page's main thread is busy drawing every frame, and the
// browser encodes canvas pictures (toBlob) only when that thread is idle. On the Quest that
// made one picture take two to five seconds. Here nothing competes with the encoding, and the
// socket to the hub lives here too, so a slow network never holds up a frame.
//
// It also decides how hard the pictures press on the link (mirror-rate.js): the hub answers
// every picture ("ack"), no more than two are on their way at once, and the JPEG quality
// follows how long a picture takes to arrive. The page is only told "done" (and so only makes
// the next picture) once there is room for one: a slow link costs the headset fewer drawings,
// not more waiting pictures. A hub from before the acks is served as it always was: a fixed
// quality, and a picture dropped when the socket's own queue is long.
//
// From the page:  { type: 'open', url, quality, fps }           connect (and keep reconnecting)
//                 { type: 'frame', width, height, pixels, info, costMs, wantJpeg }
//                                    pixels: RGBA as read from the GPU (rows bottom to top, sRGB)
// To the page:    { type: 'viewers', n }   how many monitor pages are open (0 when not connected)
//                 { type: 'tune', tune }   set on the monitor page: { fovDeg, tiltDeg, view }
//                 { type: 'done', pixels, jpeg? }   a frame was dealt with: the next one may come
//
// To the hub:     binary JPEG;  { info } when it changed;  { stats } once a second;  { ping: t }
// From the hub:   { viewers, acks, tune };  { ack: k } for the k-th picture;  { pong: t }

import { createRate } from './mirror-rate.js';

const RETRY_MS = 5000;
const MAX_QUEUED_BYTES = 200000; // for a hub without acks: pictures are dropped, not queued, when the link is slower than the camera
const PING_MS = 2000;
const STATS_MS = 1000;

let ws = null;
let url = null;
let canvas = null;
let g = null;
let image = null;
let sentInfo = '';
let quality = 0.8; // for a hub without acks
let fps = 15;
let rate = null; // how hard to press, for this connection (mirror-rate.js)
let acks = false; // the hub answers every picture
let greeted = false; // the hub's first message of this connection is in: only then is it known whether it answers pictures
let waiting = null; // resolve() of the frame that waits for room on the link
const tally = { since: 0, pictures: 0, bytes: 0, encodeMs: 0, costMs: 0 }; // for the stats, since they last went out

const now = () => performance.now();

/** Room on the link again (or no link at all): let the waiting frame go. */
function release() {
  if (waiting && (!acks || !rate || rate.open())) {
    waiting();
    waiting = null;
  }
}

function connect() {
  try {
    ws = new WebSocket(url);
  } catch {
    return; // a bad address: link.js has already said so
  }
  const mine = ws;
  ws.onopen = () => {
    rate = createRate(fps);
    acks = false;
    greeted = false;
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.acks === true) acks = true;
      if ('viewers' in msg) {
        greeted = true;
        postMessage({ type: 'viewers', n: Number(msg.viewers) || 0 });
      }
      if (msg.tune) postMessage({ type: 'tune', tune: msg.tune });
      if ('ack' in msg && rate) {
        rate.acked(msg.ack, now());
        release();
      }
      if ('pong' in msg && rate && typeof msg.pong === 'number') rate.pong(now() - msg.pong, now());
    } catch {
      /* not for us */
    }
  };
  ws.onclose = () => {
    if (ws === mine) {
      ws = null;
      rate = null;
      acks = false;
      greeted = false;
    }
    sentInfo = '';
    release();
    postMessage({ type: 'viewers', n: 0 });
    setTimeout(connect, RETRY_MS);
  };
  ws.onerror = () => {}; // onclose follows
}

// The clock of the link: an answer that never came must not shut the window for good, and a
// ping goes out when nothing else is on its way (behind a picture it would measure the picture).
setInterval(() => {
  if (!rate || !acks || ws?.readyState !== WebSocket.OPEN) return;
  if (rate.tick(now())) release();
}, 250);
setInterval(() => {
  if (rate && acks && ws?.readyState === WebSocket.OPEN && rate.idle()) ws.send(JSON.stringify({ ping: now() }));
}, PING_MS);

function sendStats() {
  const t = now();
  if (t - tally.since < STATS_MS || !tally.pictures) return;
  const seconds = (t - tally.since) / 1000;
  const r = rate && acks ? rate.stats() : null;
  const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
  const stats = {
    quality: round(r ? r.quality : quality, 2),
    kB: round(tally.bytes / tally.pictures / 1000),
    fps: round(tally.pictures / seconds),
    mbit: round((tally.bytes * 8) / seconds / 1e6, 2),
    delayMs: round(r?.delayMs, 0),
    baseMs: round(r?.baseMs, 0),
    encodeMs: round(tally.encodeMs / tally.pictures),
    costMs: round(tally.costMs / tally.pictures), // of the headset's own thread for one picture
    held: r?.held ?? null,
    lost: r?.lost ?? null,
  };
  Object.assign(tally, { since: t, pictures: 0, bytes: 0, encodeMs: 0, costMs: 0 });
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ stats }));
}

async function frame({ width, height, pixels, info, costMs = 0, wantJpeg = false }) {
  const t0 = now();
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    g = canvas.getContext('2d');
    image = g.createImageData(width, height);
  }
  // Four bytes at a time (red is the lowest byte on every machine this runs on, alpha the
  // highest): the rows turned top to bottom, and no see-through pixels, which a canvas would
  // darken on its way to the JPEG.
  const src = new Uint32Array(pixels);
  const out = new Uint32Array(image.data.buffer);
  for (let y = 0; y < height; y++) {
    let s = (height - 1 - y) * width;
    for (let d = y * width, end = d + width; d < end; d++, s++) out[d] = src[s] | 0xff000000;
  }
  g.putImageData(image, 0, 0);
  const paced = acks && rate;
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: paced ? rate.quality : quality });
  const encodeMs = now() - t0;
  // Nothing goes out before the hub's greeting: a picture sent before it would be counted by a
  // hub that answers and not by us, and every answer after it would be one off.
  if (ws?.readyState === WebSocket.OPEN && greeted) {
    // The connection may have changed while the picture was encoded: ask again.
    const room = acks && rate ? rate.open() : ws.bufferedAmount <= MAX_QUEUED_BYTES;
    if (room) {
      const text = JSON.stringify({ info });
      if (text !== sentInfo) ws.send((sentInfo = text));
      if (acks && rate) rate.sent(now());
      ws.send(blob);
      if (!tally.pictures && t0 - tally.since > STATS_MS) tally.since = t0; // the first after a pause: count from here
      tally.pictures++;
      tally.bytes += blob.size;
      tally.encodeMs += encodeMs;
      tally.costMs += costMs;
      sendStats();
    }
  }
  // Not "done" before there is room for the next picture: the page would draw one for nothing.
  if (acks && rate && !rate.open() && ws?.readyState === WebSocket.OPEN) {
    rate.hold();
    await new Promise((resolve) => {
      waiting = resolve;
    });
  }
  return wantJpeg ? blob : null;
}

onmessage = ({ data }) => {
  if (data.type === 'open') {
    url = data.url;
    quality = data.quality ?? quality;
    fps = data.fps ?? fps;
    connect();
  } else if (data.type === 'frame') {
    frame(data)
      .catch(() => null)
      .then((jpeg) => postMessage({ type: 'done', pixels: data.pixels, jpeg }, [data.pixels])); // the buffer goes back to be reused
  }
};
