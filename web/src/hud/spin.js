// How the figure over the right palm turns, and how the hand's movement spins it.
// Pure arithmetic, no three.js and no WebXR: node --test src/hud/spin.test.js
//
// The figure is a wheel on the palm. Left alone it turns at its usual slow rate (a motor that
// holds it there through a soft coupling). The hand moving sideways drags it along, like a hand
// stroking a globe: to the wearer's right and it turns faster to the right, to the left and it
// slows, stops and turns to the left. When the hand rests, the coupling brings it back to the
// usual turn, quickly at first and then ever more slowly.
//
//   rate' = (usual - rate) / returnS  +  perM * push
//
//   rate    how fast it turns (rad/s). Positive: the side nearest whoever looks at it moves to
//           their right, which is rotation.y growing in three.js, wherever they stand.
//   push    the hand's sideways speed (m/s, positive to the wearer's right), smoothed and with
//           the trembling of hand tracking taken out (below deadMps it is 0).
//   perM    what a metre of sideways movement adds to the rate (rad/s per metre): the gain.
//   returnS the time constant of the way back: after 3 x returnS it is within 5 % of the usual turn.
//
// A step works the equation out exactly for the time that passed (the push taken as steady over
// it), so the figure turns the same at 72, 90 or 120 frames a second and a long frame cannot
// make it overshoot.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const TURN = Math.PI * 2;

/**
 * @param K { turnS, perM, returnS, maxRadS, deadMps, smoothS, maxMps } (HUD.suit and HUD.suit.spin)
 *   turnS    seconds for one turn when left alone
 *   maxRadS  the rate never passes this, either way
 *   smoothS  the hand's speed is smoothed over about this long (tracking gives a new position
 *            every frame, a few millimetres off each time)
 *   maxMps   a hand does not move faster than this: more is the tracking jumping
 */
export function createSpin(K) {
  const usual = TURN / K.turnS;
  let angle = 0; // rad, 0 .. 2 pi
  let rate = usual; // rad/s
  let speed = 0; // the hand's sideways speed as it is taken to be now (m/s, smoothed)

  return {
    /**
     * Let `dt` seconds pass. `sidewaysMps`: the hand's speed to the wearer's right over that
     * time (negative: to the left), or null when there is no hand to say (not tracked, or the
     * first frame it is seen). Returns the angle to give the figure (rad).
     */
    step(dt, sidewaysMps = null) {
      if (!(dt > 0) || !Number.isFinite(dt)) return angle;
      const measured = Number.isFinite(sidewaysMps) ? clamp(sidewaysMps, -K.maxMps, K.maxMps) : 0;
      speed += (measured - speed) * (1 - Math.exp(-dt / K.smoothS));
      // Below deadMps the hand is being held still; above it, only what is over counts, so the
      // push grows from nothing and does not jump in.
      const push = Math.sign(speed) * Math.max(0, Math.abs(speed) - K.deadMps);
      // Where the rate would settle if the hand kept this speed, and the way there worked out
      // exactly over dt: the distance to `settle` shrinks by the factor `left`.
      const settle = usual + K.perM * K.returnS * push;
      const left = Math.exp(-dt / K.returnS);
      let turned = settle * dt + (rate - settle) * K.returnS * (1 - left); // the rate's integral over dt
      rate = settle + (rate - settle) * left;
      // Never faster than maxRadS: a hard pull holds it at that rate (and turns it no further than that rate does).
      if (Math.abs(rate) > K.maxRadS) {
        rate = Math.sign(rate) * K.maxRadS;
        turned = clamp(turned, -K.maxRadS * dt, K.maxRadS * dt);
      }
      angle += turned;
      angle = ((angle % TURN) + TURN) % TURN;
      return angle;
    },

    /** The figure comes up anew: at its usual turn, with no movement of the hand remembered. It keeps facing the way it faced. */
    rest() {
      rate = usual;
      speed = 0;
    },

    /** How it turns now: { angle (rad), rate (rad/s), usual (rad/s), push (m/s, the hand's speed as taken) }. */
    state: () => ({ angle, rate, usual, push: speed }),
  };
}
