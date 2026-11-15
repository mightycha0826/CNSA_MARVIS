// How hard the mirror may press on the link to the hub: when the next picture may be made, and
// how much each one is compressed. Pure arithmetic, no sockets and no clock of its own:
// node --test src/core/mirror-rate.test.js
//
// The link is the Jetson's own hotspot, shared with the microphone, the speech and the alerts,
// and how much it carries changes as the wearer walks and turns. Two things must hold:
//
//   No lag. A picture that waits in a queue is an old picture. The socket's own queue cannot be
//   trusted to show it (the phone-grade network stack below it holds megabytes before the page
//   sees anything), so the hub answers every picture it has received (an "ack"), and no more
//   than `window` pictures are ever on their way at once. A slow link then gives fewer pictures
//   a second, each of them fresh, instead of a smooth film of what happened seconds ago.
//
//   As sharp as the link allows. How long a picture takes from "sent" to "the hub has it",
//   beyond what the tiniest message takes (a ping, measured now and then), says how much of the
//   link a picture uses. While that is well under the time between two pictures, the JPEG
//   quality goes up a step at a time; when a picture takes about as long as the gap to the
//   next, it comes down at once, in larger steps (slow up, fast down, like TCP itself).
//
// The hub's ack counts the pictures of the connection (1, 2, 3 ...), so a new connection
// starts a new controller.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const RATE = {
  window: 2, // pictures on their way at once, at most
  startQ: 0.8, // JPEG quality to begin with
  minQ: 0.45, // below this a picture is blocks and smears: fewer pictures are better then
  maxQ: 0.92, // above this the bytes double for nothing an eye sees on a monitor
  upQ: 0.03, // one step up
  downQ: 0.08, // one step down
  lostQ: 0.16, // and when an answer never came
  goodShare: 0.4, // a picture that took less than this share of the gap between pictures: room to spare
  busyShare: 0.9, // more than this share: the link is full
  upAfterS: 1.5, // this long with room to spare before a step up
  downEveryMs: 400, // not two steps down for the same jam
  lostAfterMs: 1500, // an answer that takes longer than this is overdue: the quality comes down, the picture still counts as on its way
  giveUpMs: 6000, // and after this long it is given up: the window opens again (a connection that died without saying so)
  baseForMs: 20000, // the quickest ping of the last 20 s is what the link costs whatever the size
};

/**
 * @param fps  pictures a second the page aims at (the gap between two is the budget of one)
 * @param K    the numbers above (tests pass their own)
 */
export function createRate(fps, K = RATE) {
  const gapMs = 1000 / fps;
  let quality = clamp(K.startQ, K.minQ, K.maxQ);
  let sent = 0; // pictures handed to the socket on this connection
  let acked = 0; // of which the hub has said it has them
  const sentAt = new Map(); // picture number -> when it left (ms)
  const pings = []; // [when, ms] of the last baseForMs
  let delayMs = null; // send -> ack, smoothed
  let good = 0; // pictures in a row with room to spare
  let busy = 0; // pictures in a row that took about the whole gap
  let overdue = 0; // the highest picture number already counted as overdue
  let lastDown = -Infinity;
  let held = 0; // times a picture had to wait for the window
  let lost = 0;

  const baseMs = () => (pings.length ? Math.min(...pings.map((p) => p[1])) : 0);

  function down(by, now) {
    good = 0;
    if (now - lastDown < K.downEveryMs) return;
    lastDown = now;
    quality = clamp(quality - by, K.minQ, K.maxQ);
  }

  return {
    /** The JPEG quality for the next picture (0..1). */
    get quality() {
      return quality;
    },

    /** May another picture go out? False while `window` of them have not been answered. */
    open: () => sent - acked < K.window,

    /** Nothing is on its way: the moment for a ping (it would otherwise queue behind a picture). */
    idle: () => sent === acked,

    /** A picture was handed to the socket at `now` (ms). Returns its number, the one the hub's ack will carry. */
    sent(now) {
      sent++;
      sentAt.set(sent, now);
      return sent;
    },

    /** The page wanted to send but the window was shut. */
    hold() {
      held++;
    },

    /** The hub has picture `k` (and so every one before it). */
    acked(k, now) {
      if (!Number.isInteger(k) || k <= acked || k > sent) return;
      const at = sentAt.get(k);
      for (let n = acked + 1; n <= k; n++) sentAt.delete(n);
      acked = k;
      if (at === undefined) return;
      const took = Math.max(0, now - at);
      delayMs = delayMs === null ? took : delayMs + (took - delayMs) * 0.3;
      const over = Math.max(0, took - baseMs()); // what the picture's size cost
      if (over > K.busyShare * gapMs) {
        // One late answer is the radio, not the link's size: only the second in a row costs quality.
        good = 0;
        if (++busy >= 2) down(K.downQ, now);
      } else {
        busy = 0;
        if (over < K.goodShare * gapMs) {
          if (++good >= K.upAfterS * fps) {
            good = 0;
            quality = clamp(quality + K.upQ, K.minQ, K.maxQ);
          }
        } else good = 0;
      }
    },

    /** A tiny message went to the hub and back in `ms`. */
    pong(ms, now) {
      if (!(ms >= 0)) return;
      pings.push([now, ms]);
      while (pings.length && now - pings[0][0] > K.baseForMs) pings.shift();
    },

    /**
     * Call now and then. A picture whose answer is overdue brings the quality down once, and
     * stays in the window: it is still on its way (the link delivers in order, nothing is ever
     * dropped), and sending more behind it would only make the hub's picture older. Only after
     * giveUpMs is it given up, so a connection that died without saying so never shuts the
     * window for good. Returns true when it gave up on something (the window may have opened).
     */
    tick(now) {
      let late = false;
      let gaveUp = false;
      for (const [n, at] of sentAt) {
        const age = now - at;
        if (age <= K.lostAfterMs) break; // the oldest first: a Map keeps the order of sending
        if (n > overdue) {
          overdue = n;
          late = true;
        }
        if (age > K.giveUpMs) {
          sentAt.delete(n);
          acked = Math.max(acked, n);
          gaveUp = true;
        }
      }
      if (late) {
        lost++;
        lastDown = -Infinity; // this one always counts
        down(K.lostQ, now);
      }
      return gaveUp;
    },

    /** For the status line: { quality, delayMs, baseMs, held, lost (answers that were overdue), flying }. */
    stats: () => ({ quality, delayMs, baseMs: baseMs(), held, lost, flying: sent - acked }),
  };
}
