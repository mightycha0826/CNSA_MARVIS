// The readings on the status tiles: what they were over the last minute, and which of them are
// shown right now.
//
// The pinned ones (battery, oxygen, ambient temperature: what has to be watched all the time)
// are always there; under them come the readings that matter most at the moment, chosen by
// importance.js. dash.js moves the tiles, layout.js says where to.

import { HUD } from './config.js';
import { STRINGS } from './strings.js';
import { choose, importance, trend, whileVitalsOpen } from './importance.js';
import { sizeOf } from './layout.js';

const S = STRINGS[HUD.lang];

/**
 * @param state          the HUD's state (index.js): env, alerts, suit, nav are read
 * @param suit           the vitals (suit.js): readings() and states()
 * @param waypointLabel  (id) => the name of a route's target
 * @param vitalsOpen     () => true while the vitals hologram shows its readings itself
 */
export function createStatus({ state, suit, waypointLabel, vitalsOpen }) {
  // One value a second: the graphs on the tiles, and how fast each reading is moving
  // (importance.js: trend).
  const history = { heart: [], body: [], radiation: [], pressure: [], airTemp: [], airPressure: [] };
  let lastSample = 0;
  let rankedShown = []; // ids of the ranked readings on show, in the order of their places
  let routeFrom = 0; // the longest distance seen on the route in progress: where its bar starts

  return {
    /** Once a second the readings are sampled. Returns true when they were: the graphs moved on. */
    sample(now) {
      if (now - lastSample < 1000) return false;
      lastSample = now;
      const r = suit.readings();
      const e = state.env;
      const push = (key, value) => {
        history[key].push(Number.isFinite(value) ? value : null);
        if (history[key].length > HUD.readings.historyS) history[key].shift();
      };
      push('heart', r.heart);
      push('body', r.torsoC);
      push('pressure', r.pressureKpa);
      push('radiation', e?.radiationUGyPerDay);
      push('airTemp', e?.airTempK != null ? e.airTempK - 273.15 : null);
      push('airPressure', e?.pressurePa);
      return true;
    },

    /** What the tiles show: { readings (for dash.set), pinned, ranked, scores }. */
    vm() {
      const R = HUD.readings;
      const r = suit.readings();
      const z = suit.states();
      const e = state.env;
      const linkLost = state.alerts.has('link-lost');
      const fill = (v, lo, hi) => (v == null ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
      const num = (v, digits = 0) => (v == null ? '—' : v.toFixed(digits).replace('-', '−'));

      // ---- pinned: a bar each, with the limits marked on it ----
      const suitAlert = state.alerts.get('suit-temp');
      const t = state.suit.temp;
      const G = HUD.suitGauge;
      const pinned = [
        {
          id: 'battery', pinned: true, label: 'Battery', value: num(r.battery), unit: '%',
          tag: r.battery == null ? 'no reading' : r.charging ? 'charging' : null,
          state: z.battery, fill: fill(r.battery, 0, 100),
          marks: [{ at: HUD.suit.battery.crit / 100 }, { at: HUD.suit.battery.warn / 100 }], lowIsBad: true,
        },
        {
          id: 'o2', pinned: true, inVitals: true, label: 'Oxygen', value: num(r.o2), unit: '%', tag: 'sim',
          state: z.o2, fill: fill(r.o2, 0, 100),
          marks: [{ at: HUD.suit.o2.crit / 100 }, { at: HUD.suit.o2.warn / 100 }], lowIsBad: true,
        },
        {
          // The sensor on the suit: the air around the wearer. As soon as its alert sounds (warn or
          // critical) the tile comes to the middle (layout.js: focus), where it cannot be missed.
          id: 'ambient', pinned: true, inVitals: true, label: S.suit, value: num(t, 1), unit: '°C',
          tag: linkLost ? S.lastValue : state.suit.source === 'mock' ? 'mock' : null,
          state: linkLost || t === null ? 'stale' : suitAlert?.level === 'critical' ? 'crit' : suitAlert ? 'warn' : '',
          focus: !!suitAlert,
          fill: fill(t, G.min, G.max),
          marks: [{ at: fill(G.warn, G.min, G.max), label: String(G.warn) }, { at: fill(G.crit, G.min, G.max), label: String(G.crit) }],
        },
      ];

      // ---- the rest: a graph each; the most important ones are shown ----
      const nav = state.nav;
      const routeOn = nav.status === 'ok' || nav.status === 'blocked';
      if (nav.status === 'ok') routeFrom = Math.max(routeFrom, nav.distanceM);
      else if (!routeOn) routeFrom = 0;
      const radAlert = state.alerts.get('radiation');
      const graph = (key, bad, span) => {
        const h = history[key];
        const seen = h.filter(Number.isFinite);
        // Without a set range the graph covers what the reading has done, with a little room.
        const lo = span ? span[0] : seen.length ? Math.min(...seen) : 0;
        const hi = span ? span[1] : seen.length ? Math.max(...seen) : 1;
        const room = span ? 0 : Math.max((hi - lo) * 0.25, Math.abs(hi) * 0.02, 1e-6);
        return { history: h, min: lo - room, max: hi + room, trend: bad == null ? 0 : trend(h, bad, span ? span[1] - span[0] : Math.max(hi - lo, Math.abs(hi) * 0.2, 1e-6)) };
      };
      const others = [
        {
          id: 'route', base: R.route.base, active: routeOn, viz: 'progress',
          label: nav.targetId ? S.distanceTo(waypointLabel(nav.targetId)) : S.distance,
          value: nav.status === 'ok' ? num(nav.distanceM, 1) : '—', unit: nav.status === 'ok' ? 'm' : '',
          word: nav.status === 'blocked' ? S.blocked : '', state: nav.status === 'blocked' ? 'warn' : '',
          fill: nav.status === 'ok' && routeFrom > 0 ? 1 - nav.distanceM / routeFrom : 0,
        },
        { id: 'heart', inVitals: true, base: R.heart.base, viz: 'graph', label: 'Heart rate', value: num(r.heart), unit: 'bpm', tag: 'sim', state: z.heart, lines: [HUD.suit.heart.warnLow, HUD.suit.heart.warnHigh], ...graph('heart', R.heart.bad, R.heart.span) },
        { id: 'body', inVitals: true, base: R.body.base, viz: 'graph', label: 'Body temp', value: num(r.torsoC, 1), unit: '°C', tag: 'sim', state: z.temp, lines: [HUD.suit.bodyTemp.warnLow, HUD.suit.bodyTemp.warnHigh], ...graph('body', R.body.bad, R.body.span) },
        { id: 'radiation', base: R.radiation.base, viz: 'graph', label: S.radiation, value: num(e?.radiationUGyPerDay), unit: S.radUnit, tag: e?.radiationIsFixedValue ? S.published : null, state: radAlert ? (radAlert.level === 'critical' ? 'crit' : 'warn') : '', active: e?.radiationUGyPerDay != null, ...graph('radiation', R.radiation.bad) },
        { id: 'pressure', inVitals: true, base: R.pressure.base, viz: 'graph', label: 'Suit pressure', value: num(r.pressureKpa, 1), unit: 'kPa', tag: 'sim', state: z.pressure, lines: [HUD.suit.pressureKpa.warnLow, HUD.suit.pressureKpa.warnHigh], ...graph('pressure', R.pressure.bad, R.pressure.span) },
        { id: 'airTemp', base: R.airTemp.base, viz: 'graph', label: S.airTemp, value: num(e?.airTempK != null ? e.airTempK - 273.15 : null, 1), unit: '°C', state: '', active: e?.airTempK != null, ...graph('airTemp', R.airTemp.bad) },
        { id: 'airPressure', base: R.airPressure.base, viz: 'graph', label: S.pressure, value: num(e?.pressurePa), unit: 'Pa', state: '', active: e?.pressurePa != null, ...graph('airPressure', R.airPressure.bad) },
      ];
      // While the vitals hologram is open it shows its readings itself: they leave the tiles
      // (unless critical or in focus), and come back by the ranking when it closes (importance.js).
      const candidates = whileVitalsOpen([...pinned, ...others], vitalsOpen());
      const pinnedShown = candidates.filter((m) => m.pinned);
      const { ranked } = choose(candidates, rankedShown);
      rankedShown = ranked.map((m) => m.id);
      // The order on the dashboard: the pinned ones first, in their fixed order, then the others,
      // those out of range before the rest. Within that they keep the places they have, so tiles
      // do not trade places every time two numbers pass each other.
      const tier = (m) => (m.state === 'crit' ? 2 : m.state === 'warn' ? 1 : 0);
      const order = [...ranked].sort((a, b) => tier(b) - tier(a) || ranked.indexOf(a) - ranked.indexOf(b));
      const H = HUD.dash.hDeg;
      const readings = [...pinnedShown.map((m) => ({ ...m, viz: 'bar' })), ...order].map((m) => ({
        ...m,
        hDeg: H[m.viz],
        scale: sizeOf({ ...m, score: importance(m) }, HUD.dash.size), // what matters more is drawn larger
        // What the tile shows, as text: it is drawn again only when this changes.
        sig: [m.label, m.value, m.unit, m.tag, m.word, m.state, m.fill?.toFixed(3), m.history?.length, m.history?.at(-1), m.min, m.max].join('|'),
      }));
      return { readings, pinned: pinnedShown, ranked: order, scores: others.map((m) => [m.id, importance(m)]) };
    },
  };
}
