// The sounds of the HUD: the alarm beep, the click of a press, the chime of an arrival.
//
// All of them are synthesized with Web Audio, so there are no sound files to load. Each one is
// best effort: without audio (no user gesture yet, no output device) the visual feedback has to
// be enough, so a failure is swallowed.

import { HUD } from './config.js';

let audio = null;

function audioCtx() {
  audio ??= new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state !== 'running') audio.resume();
  return audio;
}

// Alarm beep of the mockup: it sounds 0.1 s before each flash of the alert frame.
//   warn      one soft 880 Hz sine tone
//   critical  two sharp 2350 Hz square pulses through a low-pass filter (a piezo buzzer)
export function alarmBeep(level) {
  if (!HUD.alarm.enabled) return;
  try {
    const ac = audioCtx();
    const t = ac.currentTime + 0.004;
    const G = HUD.alarm.gain;
    if (level === 'critical') {
      for (const [at, dur] of [[0, 0.105], [0.165, 0.135]]) {
        const osc = ac.createOscillator();
        const filter = ac.createBiquadFilter();
        const gain = ac.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(HUD.alarm.criticalHz, t + at);
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(3400, t + at);
        gain.gain.setValueAtTime(0.0001, t + at);
        gain.gain.exponentialRampToValueAtTime(G * 1.1, t + at + 0.008);
        gain.gain.setValueAtTime(G * 1.1, t + at + dur - 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
        osc.connect(filter).connect(gain).connect(ac.destination);
        osc.start(t + at);
        osc.stop(t + at + dur + 0.015);
      }
    } else {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(HUD.alarm.warnHz, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(G, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    }
  } catch {
    /* no audio: the frame still flashes */
  }
}

/** Short click, so a press is heard as well as seen. */
export function clickSound() {
  try {
    const ac = audioCtx();
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    // A soft, low "tock": a calm tone that drops a little and fades quickly.
    osc.frequency.setValueAtTime(330, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  } catch {
    /* no audio: the visual feedback is enough */
  }
}

/** Arrived: four rising notes and a held last one, the sound of a mission accomplished. */
export function successSound() {
  if (!HUD.alarm.enabled) return; // ?sound=0 silences this with the alarms
  try {
    const ac = audioCtx();
    const t0 = ac.currentTime + 0.02;
    // C5, E5, G5, C6: a major chord climbing an octave; the last note rings out.
    [523.25, 659.25, 783.99, 1046.5].forEach((hz, k) => {
      const t = t0 + k * 0.11;
      const last = k === 3;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(HUD.alarm.gain * (last ? 1 : 0.8), t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0008, t + (last ? 0.75 : 0.22));
      gain.connect(ac.destination);
      // A soft tone with a quieter octave above it, so it sounds like a chime and not a beep.
      for (const [mult, share] of [[1, 1], [2, 0.28]]) {
        const osc = ac.createOscillator();
        const part = ac.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(hz * mult, t);
        part.gain.value = share;
        osc.connect(part).connect(gain);
        osc.start(t);
        osc.stop(t + (last ? 0.8 : 0.26));
      }
    });
  } catch {
    /* no audio: the toast and the spoken message say it */
  }
}
