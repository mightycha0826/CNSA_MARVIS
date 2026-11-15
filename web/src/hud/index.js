// hud — status tiles, emergency mode, layer switching UI (F)
//
// Receives: layers:ready, layer:toggle, env:update, telemetry:update, alert:raise, alert:clear,
//           nav:route, voice:command (alert.ack, and the words of the marks' buttons), voice:commands, app:mode
// The frame: a critical alert flashes red, a warn alert flashes the same frame in orange.
// The same pulse also lights the whole view softly in that colour (HUD.wash).
// Sends:    layer:toggle (when a tab is pressed, and once for the default layer right after layers:ready),
//           mode:change (emergency when a critical alert comes up; the mode before it when all are cleared)
// Formats: docs/INTERFACES.md section 3. Design: mockups/hud-mockup.html, design-system/point
//
// Files:
//   config.js      sizes, positions, periods (tune here)
//   strings.js     on-screen text (en / ko)
//   tokens.js      colours and fonts (the Point design system's dark theme)
//   draw.js        the functions that draw on a canvas
//   panel.js       a canvas on a mesh, and where it sits in front of the eyes
//   sound.js       alarm beep, click, arrival chime
//   pointer.js     point and pinch: the ray from the hand, its cursor, the press
//   marks.js       the picked place, the waypoints and their names, the card over a pick
//   status.js      the readings: their history, and which tiles are shown
//   dash.js        the tiles that move (layout.js: where to; importance.js: which matter most)
//   suit.js        the vitals hologram over the right palm (suit-limits.js: what is out of range)
//   rescue.js      the emergency (SOS) button
//   index.js       takes the events, keeps the state, places the panels, runs the frame
//
// HTML is not visible inside an AR session, so pictures drawn on canvases are put on a plane 1 m
// in front of the eyes. Only one layer is on at a time (decided in the mockup): pressing a tab
// turns the layer before it off and the new one on.
//
// Not checked on the headset: text size and legibility, translucent cards, the palm direction
// test, pressing tabs with the pointer (pointer.js).

import * as THREE from 'three';
import { HUD } from './config.js';
import { STRINGS } from './strings.js';
import { T, loadFont } from './tokens.js';
import { drawBanner, drawAlert, drawAlertGlow, drawLayers, drawCommands, drawSosBig } from './draw.js';
import { UNIT, makePanel, makeWash, placeOnStage, hitAt } from './panel.js';
import { alarmBeep, clickSound, successSound } from './sound.js';
import { createPointer, tipDown } from './pointer.js';
import { createSuit } from './suit.js';
import { createRescue } from './rescue.js';
import { createMarks } from './marks.js';
import { createStatus } from './status.js';
import { createDash } from './dash.js';
import { leftPalm, makePalmState, handOpen } from '../core/palm.js';
import { mode } from '../core/mode.js';
import { popIn } from '../core/hologram.js';
import { pickOnMap } from '../map/index.js';
import { pickOnFieldMap } from '../field/index.js';

const S = STRINGS[HUD.lang];
const SOS_ID = '__sos';
const NAMING_PREFIX = '__name:'; // the naming buttons on the command card ("Confirm" is also a command's name)
const VITALS_TILES = new Set(['o2', 'ambient', 'heart', 'body', 'pressure']); // the readings the vitals hologram shows itself
const UP = new THREE.Vector3(0, 1, 0);

let ctx;
const state = {
  suit: { temp: null, source: null },
  env: null,
  nav: { status: null, targetId: null, distanceM: 0 },
  alerts: new Map(), // id -> { level, message, ts }
  acked: false,
  layerSet: null,
  grids: {},
  activeLayer: null,
  toast: null, // { msg, until }
  baseMode: 'normal',
  mode: 'normal',
};
const dirty = { status: true, banner: true, layers: true, commands: true };

// ---- panels ----
let rigid; // the group fixed to the camera (the alert light, and the cards too when followRate is 0)
let cards; // the group of the status tiles and the alert card
let pBanner, pAlert, pLayers, pEdge, pCommands;
let dash = null; // the readings as moving tiles (dash.js)
let wash; // the soft light over the whole view while an alert rings
let layerHits = [];
let layersOnPalm = false;
const palmState = makePalmState();
// Pointer feedback on the layer menu: which tab the cursor is on and which was just pressed.
const touch = { hoverId: null, pressedId: null, pressedUntil: 0 };
// The same for the command menu over the back of the hand.
const cmdTouch = { hoverId: null, pressedId: null, pressedUntil: 0 };
let commandHits = [];
// What the hub can be told. The hub sends its own list (jetson/commands.json) when it connects;
// until then, and in mock mode, this list is shown. `mode` limits a command to the Mars map or
// the field map; the layer names are voice only, because the tabs beside the map do the same.
let commands = [
  { say: 'Status', intent: 'status.report', slots: {} },
  { say: 'Navigate', intent: 'nav.start', slots: { targetId: 'near' } },
  { say: 'Base', intent: 'nav.home', slots: {}, mode: 'mars' },
  { say: 'Mark waypoint', intent: 'nav.mark', slots: {} },
  { say: 'Stop', intent: 'nav.stop', slots: {} },
  { say: 'Confirm', intent: 'alert.ack', slots: {} },
];
/** The commands that apply to the mode the wearer is in. */
const menuCommands = () => commands.filter((c) => !c.mode || c.mode === mode.current);
// Point and pinch (pointer.js): the ray from the pointing hand, its cursor and the press.
let pointer;
let pointerTargets = [];
// Which menus a pointer was on in the last frame: a menu that is being pointed at holds still.
const engaged = { layers: false, commands: false };
let rescue = null; // the emergency button on the command card (rescue.js)
let leftOpen = false; // the left hand is held open: only then does it bring a menu up
let sosFistSince = null; // since when the left hand has been a fist over the command card
let sosBig = false; // the command card shows the SOS button alone, large (a fist is held over it)
let marks = null; // the picked place, the waypoints, the card over a pick (marks.js)
let status = null; // the readings on the tiles (status.js)
const tipped = new THREE.Vector3(); // the pointer's ray as it is used on the map (pointer.js: tipDown)
let lastSosDraw = 0;
let mapPointed = false; // the right hand's pointer is on the map this frame
let suit = null; // the right hand: the vitals hologram over the palm (suit.js)
let vitalsOpen = false; // it is up: its readings are not on the status tiles
let vitalsFlipAt = -Infinity; // when it last opened or closed
let vitalsAt = null; // where it is on the HUD's stage, [x, y] in degrees (as the tiles are placed)
// Test hook: keep the command menu up without a hand (PC).
let commandsPinned = false;
// The running alarm: which level it is for, when it started, and how many beeps have sounded.
const alarm = { level: null, t0: 0, beeps: 0 };

/** The command card as the SOS button alone (a fist over it), or as the commands again (the hand opened). */
function setSosBig(on) {
  if (on && sosBig) rescue.hold(); // armed for as long as the fist is held
  if (on === sosBig) return;
  sosBig = on;
  if (on) {
    if (rescue.state().phase === 'idle') rescue.press(); // arm
    clickSound();
  } else if (rescue.state().phase === 'armed') rescue.disarm(); // the hand opened without a "Confirm"
  // Either way the card comes up anew, the way everything over a hand comes up.
  if (steady.commands.pop) steady.commands.pop.was = false;
  dirty.commands = true;
}

/** A place in the room as a place on the HUD's stage, [x, y] in degrees as the tiles use them, or null when it is not in front of the wearer. */
function onStage(world) {
  const p = cards.worldToLocal(v2.copy(world));
  if (!(p.z < -0.05)) return null;
  const k = -HUD.distanceM / p.z; // onto the plane the tiles are on
  const half = HUD.stage.wDeg / 2;
  return [Math.max(-half, Math.min(half, (p.x * k) / UNIT)), Math.max(0, Math.min(HUD.stage.hDeg, HUD.stage.hDeg / 2 - (p.y * k) / UNIT))];
}

function commandsVM() {
  const pressedId = performance.now() < cmdTouch.pressedUntil ? cmdTouch.pressedId : null;
  // A waypoint was just marked from this card: until it is named or confirmed the card asks for that.
  const ask = marks.asking();
  return {
    cols: ask ? ask.items.length : HUD.commands.cols,
    title: ask?.title ?? S.voiceTitle ?? 'Commands',
    hint: ask?.hint ?? S.voiceHint ?? 'Say it, or point and pinch',
    items: ask
      ? ask.items.map((label) => ({ id: NAMING_PREFIX + label, label, hover: NAMING_PREFIX + label === cmdTouch.hoverId, pressed: NAMING_PREFIX + label === pressedId }))
      : menuCommands().map((c) => ({ id: c.say, label: c.say, hover: c.say === cmdTouch.hoverId, pressed: c.say === pressedId })),
    sos: { id: SOS_ID, ...rescue.vm(performance.now()), hover: cmdTouch.hoverId === SOS_ID, pressed: pressedId === SOS_ID },
  };
}

/** The button alone, large: what it says while a fist holds it armed, and once the signal is out. */
function sosBigVM() {
  const z = rescue.vm(performance.now());
  const pressedId = performance.now() < cmdTouch.pressedUntil ? cmdTouch.pressedId : null;
  const sub = z.state === 'sent' ? z.sub : z.state === 'armed' ? 'Say "Confirm", or point and pinch · open your hand to cancel' : 'Rescue signal';
  return { id: SOS_ID, state: z.state, label: z.state === 'sent' ? 'SOS SENT' : 'SEND SOS', sub, pulse: z.pulse, hover: cmdTouch.hoverId === SOS_ID, pressed: pressedId === SOS_ID };
}

/** Run a command from the menu exactly as if it had been spoken. `id` is what the button says. */
function runCommand(id) {
  const c = menuCommands().find((m) => m.say === id);
  if (c) ctx.bus.emit('voice:text', { text: c.say, intent: c.intent, slots: c.slots ?? {} });
}

function placeLayersFixed() {
  const L = HUD.layers;
  cards.add(pLayers.mesh);
  placeOnStage(pLayers, L.fixedLeftDeg, HUD.stage.hDeg - L.fixedBottomDeg - 15.5, L.wDeg, L.hDeg);
  pLayers.mesh.quaternion.identity(); // it may come back turned from the palm
  layersOnPalm = false;
}

// ---- names ----
const layerLabel = (id) => {
  const layer = state.layerSet?.layers.find((l) => l.id === id);
  return S.layers[id] ?? layer?.label ?? id ?? '—';
};
const waypointLabel = (id) => {
  const wp = state.layerSet?.waypoints?.find((w) => w.id === id);
  return marks.labelOf(id) ?? S.waypoints[id] ?? wp?.label ?? id ?? '';
};

function sortedAlerts() {
  return [...state.alerts.entries()]
    .map(([id, a]) => ({ id, ...a }))
    .sort((a, b) => (b.level === 'critical') - (a.level === 'critical') || b.ts - a.ts);
}

function bannerVM() {
  const list = sortedAlerts();
  const top = list[0];
  let alert = null;
  if (top) {
    const crit = top.level === 'critical';
    alert = {
      level: top.level,
      title: S.alerts[top.id]?.[top.level] ?? top.message ?? top.id,
      sub: crit ? (state.acked ? S.acked : S.returning) : top.id === 'link-lost' ? S.showingLast : '',
      more: list.length > 1 ? `+${list.length - 1}` : null,
    };
  }
  return { alert, toast: state.toast?.msg ?? null };
}

function layersVM() {
  const layers = state.layerSet?.layers ?? [];
  const pressedId = performance.now() < touch.pressedUntil ? touch.pressedId : null;
  const tabs = layers.map((l) => ({
    id: l.id,
    label: layerLabel(l.id),
    active: l.id === state.activeLayer,
    hover: l.id === touch.hoverId,
    pressed: l.id === pressedId,
  }));
  const layer = layers.find((l) => l.id === state.activeLayer);
  let legend = null;
  if (layer) {
    const numeric = layer.format === 'float32' && layer.min != null && layer.max != null;
    const fmt = (v) => `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)} ${layer.unit ?? ''}`.trim();
    legend = {
      rampId: layer.id,
      min: numeric ? fmt(layer.min) : S.low,
      max: numeric ? fmt(layer.max) : S.high,
      note: layer.kind === 'thermal' ? S.relative : null,
      src: [layer.mission, layer.instrument].filter(Boolean),
      keys: S.keys,
    };
  }
  return { tabs, legend };
}

// ---- state changes ----
function hasCritical() {
  for (const a of state.alerts.values()) if (a.level === 'critical') return true;
  return false;
}

/** The level of the alert light: critical if any alert is critical, else warn if there is any alert, else null. */
function frameLevel() {
  if (hasCritical()) return 'critical';
  return state.alerts.size ? 'warn' : null;
}

function updateMode() {
  const mode = hasCritical() ? 'emergency' : state.baseMode;
  if (mode === state.mode) return;
  state.mode = mode;
  ctx.bus.emit('mode:change', { mode });
}

function showToast(msg) {
  state.toast = { msg, until: performance.now() + HUD.toastMs };
  dirty.banner = true;
}

function selectLayer(id) {
  if (id === state.activeLayer) return;
  if (state.activeLayer) ctx.bus.emit('layer:toggle', { id: state.activeLayer, visible: false });
  ctx.bus.emit('layer:toggle', { id, visible: true });
}

function wire(bus) {
  bus.on('layers:ready', ({ layerSet, grids }) => {
    state.layerSet = layerSet;
    state.grids = grids ?? {};
    dirty.status = dirty.layers = true;
    // Announce the default layer once, one beat later: after the other modules have handled layers:ready.
    queueMicrotask(() => {
      if (state.activeLayer) return;
      const first = layerSet.layers.find((l) => l.id === 'optical') ?? layerSet.layers[0];
      if (first) selectLayer(first.id);
    });
  });
  bus.on('layer:toggle', ({ id, visible }) => {
    if (visible) state.activeLayer = id;
    else if (state.activeLayer === id) state.activeLayer = null;
    dirty.status = dirty.layers = true;
  });
  bus.on('env:update', (e) => {
    state.env = e;
    dirty.status = true;
  });
  bus.on('telemetry:update', ({ suitTempC, source }) => {
    if (typeof suitTempC === 'number') state.suit.temp = suitTempC;
    state.suit.source = source ?? null;
    dirty.status = true;
  });
  bus.on('alert:raise', ({ id, level, message, ts }) => {
    const before = state.alerts.get(id);
    // A new alert, or one that got worse, rings again. One that eases (critical back to warn)
    // keeps the wearer's "Confirm": it must not start beeping again on its way down.
    if (!before || (level === 'critical' && before.level !== 'critical')) state.acked = false;
    state.alerts.set(id, { level, message, ts: ts ?? Date.now() });
    dirty.status = dirty.banner = true;
    updateMode();
  });
  bus.on('alert:clear', ({ id }) => {
    if (!state.alerts.delete(id)) return;
    if (!state.alerts.size) state.acked = false;
    dirty.status = dirty.banner = true;
    updateMode();
  });
  bus.on('nav:route', ({ status, targetId, distanceM, frame }) => {
    const prev = state.nav;
    if (status === 'arrived' && prev.status !== 'arrived') {
      showToast(S.arrivedAt(waypointLabel(targetId ?? prev.targetId)));
      successSound();
    }
    else if (status === 'cancelled' && prev.status !== 'cancelled') showToast(S.guidanceEnded);
    // The way to the same destination became clearly longer: the route now goes around something.
    // (Not for the field map: there the distance grows simply because the wearer walks away.)
    else if (frame !== 'room' && status === 'ok' && prev.status === 'ok' && prev.targetId === targetId && distanceM > prev.distanceM + 0.3) showToast(S.recalculated);
    state.nav = { status, targetId: targetId ?? prev.targetId, distanceM: distanceM ?? 0 };
    dirty.status = true;
  });
  // The hub's own command list (jetson/commands.json), for the menu over the back of the hand.
  bus.on('voice:commands', ({ commands: list }) => {
    if (Array.isArray(list) && list.length) {
      commands = list.filter((c) => c?.say && c?.intent).slice(0, 12);
      dirty.commands = true;
    }
  });
  bus.on('voice:command', ({ intent, slots, text }) => {
    // Show what the voice assistant heard, so the wearer knows the command was taken.
    if (text) showToast(`\u201C${String(text).trim().replace(/[.!?]+$/, '')}\u201D`);
    if (intent === 'alert.ack' && state.alerts.size) {
      state.acked = true; // the flashing stops; the light and the alert card stay until alert:clear
      dirty.banner = true;
    }
    // The card over a picked place and the naming of a waypoint: saying a button presses it.
    marks.voice(intent, () => rescue.state().phase === 'armed');
  });
  // "Base" is a Mars-map command: the menu follows the mode.
  bus.on('app:mode', () => {
    dirty.commands = true;
  });
}

// ---- pressing ----
const raycaster = new THREE.Raycaster();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const q1 = new THREE.Quaternion();

function pressLayer(id) {
  touch.pressedId = id;
  touch.pressedUntil = performance.now() + HUD.layers.pressFlashMs;
  dirty.layers = true;
  clickSound();
  selectLayer(id);
}

function pressCommand(id) {
  cmdTouch.pressedId = id;
  cmdTouch.pressedUntil = performance.now() + HUD.layers.pressFlashMs;
  dirty.commands = true;
  clickSound();
  if (id === SOS_ID) rescue.press();
  else if (id.startsWith(NAMING_PREFIX)) marks.pressMark(id.slice(NAMING_PREFIX.length));
  else runCommand(id);
}

function initInput() {
  // In the headset every press comes from the pointer (pointer.js): hands and controllers alike.
  pointer = createPointer(ctx, HUD.pointer);
  pointerTargets = [
    // The layer tabs stand beside the map and the pick card over it: both are met by the ray
    // the map is met by, so the cursor passes between map and menu without a jump.
    { id: 'layers', panel: pLayers, hits: () => layerHits, press: pressLayer, pitchDeg: HUD.pointer.mapPitchDeg },
    { id: 'commands', panel: pCommands, hits: () => commandHits, press: pressCommand },
    { id: 'pick', panel: marks.card, hits: marks.hits, press: marks.press, pitchDeg: HUD.pointer.mapPitchDeg },
  ];
  // PC: mouse click
  const el = ctx.renderer.domElement;
  // A click that ends a drag of the view is not a click on the map.
  let downAt = null;
  el.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY]));
  el.addEventListener('click', (ev) => {
    if (ctx.xr.presenting) return;
    const r = el.getBoundingClientRect();
    v1.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1, 0);
    raycaster.setFromCamera(v1, ctx.camera);
    for (const t of pointerTargets) {
      if (!t.panel.mesh.visible) continue;
      const hit = raycaster.intersectObject(t.panel.mesh, false)[0];
      const id = hit?.uv && hitAt(t.hits(), hit.uv.x * t.panel.canvas.width, (1 - hit.uv.y) * t.panel.canvas.height)?.id;
      if (id != null) {
        t.press(id);
        return;
      }
    }
    // Not on a menu: a place on the map, if the click was not the end of a drag.
    if (downAt && Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
    const { origin, direction } = raycaster.ray;
    if (mode.current === 'mars') {
      const hit = pickOnMap(origin, direction, 40);
      if (hit) marks.selectPoint(hit.cell);
    } else {
      const hit = pickOnFieldMap(origin, direction, 40);
      if (hit) marks.selectPlace(hit.room);
    }
  });
}

// Where a hand-attached menu should be this frame (filled before followMenu is called).
const aim = new THREE.Object3D();
// A menu that came up with a hand gesture is not glued to that hand. It appears beside the hand
// and then holds its place in the room; it only moves again when the hand has moved clearly away
// from it. So a left hand that jitters, or that the headset mis-tracks, does not move the buttons.
const steady = {
  layers: { shown: false, lastSeen: 0, moving: false },
  commands: { shown: false, lastSeen: 0, moving: false },
};

/**
 * Place a menu that a hand gesture brought up.
 *  - `held` (a pointer is on it, or the two hands are so close that the left one cannot be
 *    trusted): it does not move at all, and it does not close.
 *  - Otherwise it stays where it is until the hand is more than a dead zone away, then glides
 *    after it and stops again.
 *  - When the hand turns out of the gesture the menu goes almost at once (turnedMs), and at
 *    once when the hand turns into the other menu's gesture (`other`). When the hand is lost
 *    from view instead, it stays for lingerMs: tracking drops out for moments all the time.
 */
function followMenu(panel, st, wanted, held, scale, now, dt, { handSeen = false, other = false } = {}) {
  const F = HUD.follow;
  if (other && !wanted) st.shown = false; // the hand now shows the other menu: this one goes at once
  else if (held && st.shown) st.lastSeen = now;
  else if (wanted) {
    if (!st.shown) {
      panel.mesh.position.copy(aim.position);
      panel.mesh.quaternion.copy(aim.quaternion);
      st.moving = false;
    } else {
      const d = panel.mesh.position.distanceTo(aim.position);
      const turn = panel.mesh.quaternion.angleTo(aim.quaternion);
      if (d > F.deadZoneM || turn > THREE.MathUtils.degToRad(F.deadZoneDeg)) st.moving = true;
      if (st.moving) {
        const k = 1 - Math.exp(-F.rate * dt);
        panel.mesh.position.lerp(aim.position, k);
        panel.mesh.quaternion.slerp(aim.quaternion, k);
        if (d < F.settleM && turn < 0.05) st.moving = false;
      }
    }
    st.shown = true;
    st.lastSeen = now;
  } else if (st.shown && now - st.lastSeen > (handSeen ? F.turnedMs : F.lingerMs)) {
    st.shown = false; // quickly when the hand has turned away, slowly when it was only lost from view
  }
  panel.mesh.visible = st.shown;
  // A menu springs up over the hand, as everything a hand brings up does (core/hologram.js: popIn).
  const k = popIn((st.pop ??= {}), st.shown, now);
  panel.mesh.scale.set(scale * k, scale * k * k, scale);
}

const wristPos = new THREE.Vector3();

// Hand tracking. Left palm up: the layer menu floats beside the map. Left back-of-hand up: the
// command menu floats above the hand, facing the wearer. The left hand only brings the menus up;
// the right hand points at them from where it is and pinches (pointer.js).
function updateHands(frame) {
  const { xrFrame, refSpace, session } = frame;
  const now = performance.now();
  let left = null;
  let right = null;
  if (xrFrame && refSpace && session) {
    for (const src of session.inputSources) {
      if (!src.hand) continue;
      if (src.handedness === 'left') left = src.hand;
      else if (src.handedness === 'right') right = src.hand;
    }
  }
  if (!left && !right) {
    // No hand tracking (PC, controllers): the layer menu sits at its fixed place.
    if (layersOnPalm) placeLayersFixed();
    pLayers.mesh.visible = mode.current !== 'field';
    pLayers.mesh.scale.setScalar(1);
    if (!commandsPinned) pCommands.mesh.visible = false;
    steady.layers.shown = steady.commands.shown = false;
    if (!commandsPinned) setSosBig(false);
    suit.hide();
    return;
  }

  const L = HUD.layers;
  const C = HUD.commands;
  const F = HUD.follow;
  const wrist = left && xrFrame.getJointPose?.(left.get('wrist'), refSpace);
  const rightWrist = right && xrFrame.getJointPose?.(right.get('wrist'), refSpace);
  // With the two hands close together the cameras see one in front of the other and the left
  // hand's pose cannot be trusted: nothing is read from it then, and the menus hold still.
  let crowded = false;
  if (wrist && rightWrist) {
    const a = wrist.transform.position;
    const b = rightWrist.transform.position;
    crowded = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < F.crowdM;
  }
  // Gestures with hysteresis: once a menu is up, the hand may tip a good way before it goes.
  let palmUp = false;
  let backUp = false;
  if (crowded) {
    palmUp = steady.layers.shown;
    backUp = steady.commands.shown;
  } else if (wrist) {
    const o = wrist.transform.orientation;
    v1.set(0, 1, 0).applyQuaternion(q1.set(o.x, o.y, o.z, o.w)); // back-of-hand direction
    // A menu comes up only over an open hand: one that points, pinches or makes a fist has
    // turned for another reason. (A hand that relaxes a little stays "open": handOpen is sticky.)
    leftOpen = handOpen(left, xrFrame, refSpace, leftOpen);
    palmUp = leftOpen && v1.y < (steady.layers.shown ? L.palmUpDot + F.gestureSlack : L.palmUpDot);
    const backRaw = v1.y > (steady.commands.shown ? C.backUpDot - F.gestureSlack : C.backUpDot);
    // A fist made while the command card is up turns the card into the SOS button alone,
    // large, and arms it (as pressing the red bar once does: "Confirm" or a press then sends
    // it). It stays so while the fist is held; opening the hand disarms it and brings the
    // commands back. Held for a moment first: one frame in which the tracking loses the
    // fingers is not a fist.
    const fistOnCard = !leftOpen && backRaw && steady.commands.shown;
    if (!fistOnCard) sosFistSince = null;
    else sosFistSince ??= now;
    setSosBig(fistOnCard && now - sosFistSince >= HUD.sos.fistMs);
    backUp = (leftOpen || fistOnCard) && backRaw;
  } else setSosBig(false); // the left hand is not tracked: no fist is being held
  // The right hand's own two views (suit.js). While its emergency button is up, the left hand
  // is the one that points: its command card stays away so it does not pop up over the ray.
  // The right hand has one thing of its own, the vitals over its palm, and it is also the hand
  // that points. Where the two hands could get in each other's way the left one has the say:
  // the vitals stay away while the hands are too close for the tracking to be trusted, and
  // while the right hand's pointer is on a menu or on the map.
  suit.place(frame, !crowded && !pointer.busy().right && !mapPointed);
  // Palm up shows the map in both modes, so in both it sends the command card away at once.
  const mapUp = palmUp;
  // The layer menu belongs to the Mars map; in field mode the palm shows the field map alone.
  palmUp = palmUp && mode.current !== 'field';
  const seen = !!wrist && !crowded;

  ctx.camera.getWorldPosition(v2);
  if (palmUp && !crowded) {
    if (!layersOnPalm) {
      ctx.scene.add(pLayers.mesh);
      layersOnPalm = true;
    }
    // To the right of the floating map (core/palm.js), with a gap, facing the wearer.
    if (leftPalm(frame, ctx.camera, palmState)) {
      aim.position.copy(palmState.anchor).addScaledVector(palmState.right, L.palmOffsetRightM);
      aim.position.y += L.palmOffsetUpM;
    } else {
      const p = wrist.transform.position;
      aim.position.set(p.x, p.y + 0.1, p.z);
    }
    aim.lookAt(v2);
  }
  followMenu(pLayers, steady.layers, palmUp, engaged.layers || (crowded && steady.layers.shown), L.palmScale, now, frame.dt, { handSeen: seen, other: seen && backUp });

  if (backUp && !crowded) {
    // Above the back of the hand, facing the eyes: a card standing over the hand, clear of it, so
    // the pointing hand never has to come near.
    const p = wrist.transform.position;
    wristPos.set(p.x, p.y, p.z);
    const knuckle = xrFrame.getJointPose?.(left.get('middle-finger-phalanx-proximal'), refSpace);
    if (knuckle) {
      const k = knuckle.transform.position;
      wristPos.lerp(v3.set(k.x, k.y, k.z), 0.5); // the middle of the back of the hand
    }
    aim.position.copy(wristPos);
    aim.position.y += C.liftM;
    // A little beyond the hand, away from the wearer: the pointing hand is then on the near
    // side of the card even when it is held as far out as the left one.
    v3.subVectors(wristPos, v2).setY(0);
    if (v3.lengthSq() > 1e-6) aim.position.addScaledVector(v3.normalize(), C.awayM);
    aim.lookAt(v2);
  }
  followMenu(pCommands, steady.commands, backUp, engaged.commands || (crowded && steady.commands.shown), C.scale, now, frame.dt, { handSeen: seen, other: seen && mapUp });
}

/** Pointing and pinching, after the menus have been placed for this frame. */
function updatePointer(frame, now) {
  const res = pointer.update(frame, pointerTargets, now, frame.dt);
  for (const [id, st, flag] of [['layers', touch, 'layers'], ['commands', cmdTouch, 'commands']]) {
    const r = res.get(id);
    engaged[id] = r.engaged;
    if (r.hoverId !== st.hoverId) {
      st.hoverId = r.hoverId;
      dirty[flag] = true;
    }
  }
  marks.hover(res.get('pick').hoverId);

  // A pointer that is on no menu may be on the map: a cursor on the terrain, and a pinch picks
  // the place under it. The same hands that press the left hand's menus (and controllers).
  mapPointed = false;
  const onMars = mode.current === 'mars';
  for (const ray of pointer.free()) {
    if (ray.hand && !HUD.pointer.hands.includes(ray.hand)) continue;
    // The map lies flat, and a hand's pointer runs nearly level: it would meet the map at a
    // shallow angle, where a small turn of the wrist sends the cursor far across it. For the
    // map the ray is tipped downward, so it comes down on the map steeply.
    const dir = tipDown(ray.dir, HUD.pointer.mapPitchDeg, tipped);
    const hit = onMars ? pickOnMap(ray.origin, dir, HUD.pointer.maxM) : pickOnFieldMap(ray.origin, dir, HUD.pointer.maxM);
    if (!hit) continue;
    ray.show(hit.point, UP);
    if (ray.hand === 'right') mapPointed = true;
    if (ray.pressed) {
      if (onMars) marks.selectPoint(hit.cell);
      else marks.selectPlace(hit.room);
    }
    break;
  }
  // The naming's time limits, and the card over the picked place (it goes where the map goes).
  marks.place(now);
}

/** Where the middle of a tab is on the screen (CSS pixels). Tests use it to find the place to click. */
function tabScreenXY(id) {
  const hit = layerHits.find((h) => h.id === id);
  if (!hit) return null;
  const u = (hit.x + hit.w / 2) / pLayers.canvas.width;
  const v = 1 - (hit.y + hit.h / 2) / pLayers.canvas.height;
  pLayers.mesh.updateWorldMatrix(true, false);
  v1.set((u - 0.5) * pLayers.wM, (v - 0.5) * pLayers.hM, 0).applyMatrix4(pLayers.mesh.matrixWorld).project(ctx.camera);
  const r = ctx.renderer.domElement.getBoundingClientRect();
  return { x: r.left + ((v1.x + 1) / 2) * r.width, y: r.top + ((1 - v1.y) / 2) * r.height };
}

// ---- module interface ----
export function init(context) {
  ctx = context;
  const { scene, camera } = ctx;
  scene.add(camera); // the camera's children are only drawn when the camera itself is in the scene

  rigid = new THREE.Group();
  rigid.name = 'hud';
  camera.add(rigid);
  cards = new THREE.Group();
  if (HUD.followRate > 0) scene.add(cards);
  else rigid.add(cards);

  // What looks centred when laid out sits a little high in the headset: the cards hang lower.
  if (HUD.followRate === 0) cards.position.y = -HUD.viewDropDeg * UNIT;
  dash = createDash({ parent: cards });
  pBanner = makePanel(HUD.banner.wDeg, HUD.banner.hDeg);
  placeOnStage(pBanner, (HUD.stage.wDeg - HUD.banner.wDeg) / 2 + HUD.centreShiftDeg, HUD.banner.topDeg, HUD.banner.wDeg, HUD.banner.hDeg);
  pLayers = makePanel(HUD.layers.wDeg, HUD.layers.hDeg);
  // Voice command menu: lives in the room (over the back of the left hand), hidden until then.
  pCommands = makePanel(HUD.commands.wDeg, HUD.commands.hDeg);
  pCommands.mesh.visible = false;
  ctx.scene.add(pCommands.mesh);
  // Alert card: bottom centre, clear of the line of sight (mockup). Its flashing light is a
  // second panel of the same size behind it, so the pulse is a change of opacity, not a redraw.
  const A = HUD.alert;
  const alertTop = HUD.stage.hDeg - A.bottomDeg + A.glowDeg - A.hDeg;
  pEdge = makePanel(A.wDeg, A.hDeg);
  placeOnStage(pEdge, (HUD.stage.wDeg - A.wDeg) / 2 + HUD.centreShiftDeg, alertTop, A.wDeg, A.hDeg);
  pEdge.mesh.renderOrder = 999;
  pEdge.mesh.visible = false;
  pAlert = makePanel(A.wDeg, A.hDeg);
  placeOnStage(pAlert, (HUD.stage.wDeg - A.wDeg) / 2 + HUD.centreShiftDeg, alertTop, A.wDeg, A.hDeg);
  cards.add(pBanner.mesh, pEdge.mesh, pAlert.mesh);
  wash = makeWash();
  camera.add(wash);
  placeLayersFixed();

  suit = createSuit(ctx);
  rescue = createRescue(ctx, { showToast, changed: () => (dirty.commands = true), battery: suit.battery });
  status = createStatus({ state, suit, waypointLabel, vitalsOpen: () => vitalsOpen });
  marks = createMarks({ ctx, state, showToast, changed: () => (dirty.commands = true) });
  wire(ctx.bus);
  initInput();
  loadFont().then(() => {
    dirty.status = dirty.banner = dirty.layers = true;
  });

  // Left open so that tests and the console can look at the state.
  window.__hud = {
    commandsVM,
    runCommand,
    /** PC: put the command menu in the scene without a hand, to look at it and click it. */
    showCommands: (on, at = [0.95, 1.45, 0.4]) => {
      commandsPinned = on;
      pCommands.mesh.visible = on;
      pCommands.mesh.position.fromArray(at);
      pCommands.mesh.lookAt(ctx.camera.getWorldPosition(v1));
      pCommands.mesh.scale.setScalar(HUD.commands.scale * 3);
      dirty.commands = true;
    },
    /** PC: the command card as the large SOS button, as a fist held over it makes it (after showCommands(true)). */
    sosBig: (on) => setSosBig(!!on),
    pointer,
    suit,
    rescue,
    /** Marked places and the pick card: for tests and the console. */
    marks: marks.debug,
    pressMark: marks.pressMark,
    selectPlace: marks.selectPlace,
    selectPoint: marks.selectPoint,
    markHere: marks.markHere,
    /** As if the hub had heard `text` after "Record". */
    dictated: marks.dictated,
    panels: () => ({ layers: pLayers, commands: pCommands, layerHits, commandHits }),
    state,
    statusVM: status.vm,
    bannerVM,
    layersVM,
    tabScreenXY,
    frameLevel,
    dash,
    wash: () => ({ visible: wash.visible, opacity: wash.material.opacity, color: `#${wash.material.color.getHexString()}` }),
  };
}

export function update(frame) {
  if (!ctx) return;
  const now = performance.now();

  // PC screen: in a narrow window the HUD is scaled down so that all of it shows. In AR it keeps its real size.
  let s = 1;
  if (!ctx.xr.presenting) {
    const halfH = Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov / 2)) * HUD.distanceM;
    s = Math.min(1, (halfH * ctx.camera.aspect) / ((HUD.stage.wDeg / 2) * UNIT), halfH / ((HUD.stage.hDeg / 2) * UNIT));
  }
  rigid.scale.set(s, s, 1);

  if (HUD.followRate > 0) {
    const k = 1 - Math.exp(-HUD.followRate * frame.dt);
    cards.position.lerp(ctx.camera.getWorldPosition(v1), k);
    cards.quaternion.slerp(ctx.camera.getWorldQuaternion(q1), k);
    cards.scale.set(s, s, 1);
  }

  updateHands(frame);
  updatePointer(frame, now);
  suit.tick(now, frame.dt);
  if (status.sample(now)) dirty.status = true; // the graphs moved on
  // The emergency button counts down while armed: the card is redrawn ten times a second then.
  if (rescue.tick(now) && now - lastSosDraw > 100) {
    lastSosDraw = now;
    dirty.commands = true;
  }
  if (touch.pressedId && now > touch.pressedUntil) {
    touch.pressedId = null;
    dirty.layers = true;
  }
  if (cmdTouch.pressedId && now > cmdTouch.pressedUntil) {
    cmdTouch.pressedId = null;
    dirty.commands = true;
  }

  if (state.toast && now > state.toast.until) {
    state.toast = null;
    dirty.banner = true;
  }

  // The alert light: red for critical, the same light in orange for warn, slowly brightening and
  // dimming. After "Confirm" it stays dim. mode:change (emergency) is sent only for critical.
  const level = frameLevel();
  // The light around the alert card (mockup): orange for warn, red for critical.
  pEdge.mesh.visible = !!level;
  // Alarm: a beep at the start of every period, the flash 0.1 s after it (mockup). "Confirm"
  // stops both; a change of level starts over.
  const ringing = level && !state.acked ? level : null;
  if (ringing !== alarm.level) {
    alarm.level = ringing;
    alarm.t0 = now;
    alarm.beeps = 0;
  }
  let pulse = 0; // 1 at the flash, 0 between flashes and after "Confirm"
  if (level) {
    const E = HUD.edge;
    pEdge.mat.color.set(level === 'critical' ? T.dangerLine : T.point);
    if (!ringing) pEdge.mat.opacity = E.ackedOpacity;
    else {
      const periodMs = E.periodS * 1000;
      if (now - alarm.t0 >= alarm.beeps * periodMs) {
        alarm.beeps++;
        alarmBeep(ringing);
      }
      // Pulse: bright at the start, eased down to lowOpacity by 48% of the period, held, then
      // back up over the last 8%.
      const since = now - alarm.t0 - E.flashDelayS * 1000;
      const p = since < 0 ? 0.6 : (since % periodMs) / periodMs;
      const ease = (x) => x * x * (3 - 2 * x);
      pulse = p < 0.48 ? 1 - ease(p / 0.48) : p < 0.92 ? 0 : ease((p - 0.92) / 0.08);
      pEdge.mat.opacity = E.lowOpacity + (1 - E.lowOpacity) * pulse;
    }
  }
  // The same pulse as a soft light over the whole view: orange for warn, red for critical.
  // It goes dark between flashes and stays dark after "Confirm".
  const washOpacity = HUD.wash.enabled && ringing ? pulse * (ringing === 'critical' ? HUD.wash.criticalPeak : HUD.wash.warnPeak) : 0;
  wash.visible = washOpacity > 0.002;
  if (wash.visible) {
    wash.material.color.set(ringing === 'critical' ? T.dangerLine : T.point);
    wash.material.opacity = washOpacity;
  }

  // The vitals hologram opening or closing changes what the tiles show: its readings go to
  // it and come back from it, flying (dash.flow), for a moment around the change.
  if (suit.isOpen() !== vitalsOpen) {
    vitalsOpen = !vitalsOpen;
    vitalsFlipAt = now;
    dirty.status = true;
  }
  if (vitalsOpen) vitalsAt = onStage(suit.position(v1)) ?? vitalsAt;
  dash.flow(now - vitalsFlipAt < HUD.dash.flowMs && vitalsAt ? { x: vitalsAt[0], y: vitalsAt[1], ids: VITALS_TILES } : null);
  if (dirty.status) {
    dash.set(status.vm().readings);
    dirty.status = false;
  }
  dash.tick(frame.dt);
  if (dirty.banner) {
    const vm = bannerVM();
    drawBanner(pBanner.g, HUD.pxPerDeg, vm);
    pBanner.tex.needsUpdate = true;
    const card = drawAlert(pAlert.g, HUD.pxPerDeg, vm, HUD.alert.maxCardDeg, HUD.alert.glowDeg);
    pAlert.tex.needsUpdate = true;
    drawAlertGlow(pEdge.g, HUD.pxPerDeg, card);
    pEdge.tex.needsUpdate = true;
    pAlert.mesh.visible = !!vm.alert; // an empty panel in the centre would still cost a draw
    dirty.banner = false;
  }
  if (dirty.layers) {
    layerHits = drawLayers(pLayers.g, HUD.pxPerDeg, layersVM());
    pLayers.tex.needsUpdate = true;
    dirty.layers = false;
  }
  marks.draw(now);
  if (dirty.commands && pCommands.mesh.visible) {
    commandHits = sosBig ? drawSosBig(pCommands.g, HUD.pxPerDeg, sosBigVM()) : drawCommands(pCommands.g, HUD.pxPerDeg, commandsVM());
    pCommands.tex.needsUpdate = true;
    dirty.commands = false;
  }
}
