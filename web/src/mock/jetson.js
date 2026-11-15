// Fake Jetson (?mock=1 or ?mock=link).
// Makes the same envelope messages the real Jetson sends ({ type, ts, payload }, INTERFACES section 4)
// by a timetable and hands them to link.js. link.js handles real and fake with the same code.
//
// 60 s timetable (then it starts over):
//    4 s  "Thermal"     layer.show
//    8 s  "Navigate"    nav.start
//   20 s  "Optical"     layer.show
//   30-42 s the ambient temperature climbs from 24.5 to 36.5 C (warn at 30, critical at 35)
//   42-55 s it cools (back to warn below 34 C, alert.clear below 29 C)
//   57 s  "Stop"        nav.stop
//
// PC keyboard: N navigate, H base, S stop, L thermal / optical, T temperature spike

const CYCLE_S = 60;

const SCRIPT = [
  { at: 4, intent: 'layer.show', slots: { id: 'thermal' }, text: 'Thermal' },
  { at: 8, intent: 'nav.start', slots: { targetId: 'near' }, text: 'Navigate' },
  { at: 20, intent: 'layer.show', slots: { id: 'optical' }, text: 'Optical' },
  { at: 57, intent: 'nav.stop', slots: {}, text: 'Stop' },
];

export const MOCK_KEYS_HELP = 'Keys: N navigate · H base · S stop · L thermal/optical · T temperature spike';

function scriptedTemp(t) {
  if (t < 30) return 24.5;
  if (t < 42) return 24.5 + ((t - 30) / 12) * 12; // up to 36.5
  if (t < 55) return 36.5 - ((t - 42) / 13) * 12.5; // down to 24.0
  return 24.5;
}

/**
 * @param {(msg: {type: string, ts: number, payload: object}) => void} deliver the function that takes the Jetson → headset messages
 * @param {{ speed?: number }} opts
 * @returns {() => void} a function that stops it
 */
export function startMockJetson(deliver, { speed = 1 } = {}) {
  const send = (type, payload) => deliver({ type, ts: Date.now(), payload });
  const say = (intent, slots, text) => send('voice.command', { intent, slots, text });

  const t0 = performance.now();
  let lastT = 0;
  let level = null; // level of the suit-temp alert that is up now
  let spikeUntil = -1; // until when the temperature raised with the T key holds (s)
  let thermalOn = false;

  function tick() {
    const elapsed = ((performance.now() - t0) / 1000) * speed;
    const t = elapsed % CYCLE_S;

    // Temperature: once a second (INTERFACES section 3)
    let temp = scriptedTemp(t) + (Math.random() - 0.5) * 0.2;
    if (elapsed < spikeUntil) temp = Math.max(temp, 36.5);
    temp = Math.round(temp * 10) / 10;
    send('telemetry', { suitTempC: temp, source: 'mock' });

    // Alert: the same rule as the hub (jetson/marswalk/alerts.py, INTERFACES section 4). The
    // level follows the temperature both ways, with a 1 degree margin on the way down.
    let next = null;
    if (temp >= 35) next = 'critical';
    else if (temp >= 30) next = level === 'critical' && temp >= 34 ? 'critical' : 'warn';
    else if (temp >= 29) next = level ? 'warn' : null;
    if (next !== level) {
      const easing = level === 'critical';
      level = next;
      if (!level) send('alert.clear', { id: 'suit-temp' });
      else {
        const message = easing ? 'Ambient temperature is high' : level === 'critical' ? 'Ambient temperature is critical' : 'Ambient temperature is rising';
        send('alert.raise', { id: 'suit-temp', level, message });
      }
    }

    // Voice commands: send those that fall between the last tick and this one
    for (const s of SCRIPT) {
      const crossed = lastT <= t ? s.at > lastT && s.at <= t : s.at > lastT || s.at <= t;
      if (crossed) say(s.intent, s.slots, s.text);
    }
    lastT = t;
  }

  const timer = setInterval(tick, 1000 / speed);

  function onKey(e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case 'n': say('nav.start', { targetId: 'near' }, 'Navigate'); break;
      case 'h': say('nav.home', {}, 'Base'); break;
      case 's': say('nav.stop', {}, 'Stop'); break;
      case 'l':
        thermalOn = !thermalOn;
        say('layer.show', { id: thermalOn ? 'thermal' : 'optical' }, thermalOn ? 'Thermal' : 'Optical');
        break;
      case 't': spikeUntil = ((performance.now() - t0) / 1000) * speed + 8; break;
    }
  }
  window.addEventListener('keydown', onKey);

  return () => {
    clearInterval(timer);
    window.removeEventListener('keydown', onKey);
  };
}
