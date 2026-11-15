// Marked places: the place picked on a palm map, the waypoints, and naming a waypoint by voice.
//
// A place picked on the palm map with the pointer: a pin on the map and a small card over it.
// What the card offers depends on what was picked (pick.kind):
//   'place'     bare ground                 Navigate (it becomes the target) · Waypoint · Cancel
//   'waypoint'  a waypoint (pick.id)        Navigate · Record (say a new name) · Delete · Cancel
//   'target'    the target                  Navigate · Delete · Cancel
// and while a waypoint that was just set waits for its name (`naming`): Record · Confirm.
// Every button can be spoken: "Navigate", "Waypoint", "Record", "Confirm", "Delete", "Cancel".
//
// Receives: map:run, waypoints:stored, voice:dictation, nav:position, app:mode
//           (voice:command comes through index.js: voice())
// Sends:    map:pick, waypoint:set, waypoint:remove, waypoints:store, voice:dictate,
//           nav:waypoint, nav:request, field:target, voice:command (nav.stop, when the target is deleted)

import * as THREE from 'three';
import { HUD } from './config.js';
import { drawCommands } from './draw.js';
import { makePanel } from './panel.js';
import { clickSound } from './sound.js';
import { mode } from '../core/mode.js';
import { popIn } from '../core/hologram.js';
import { walkableNear, reachableFrom, nextWaypointNumber } from '../core/waypoints.js';
import { mapCellInRoom, showPick, cellOfMapPoint, mapTargetCell, mapZoom } from '../map/index.js';
import { MAP } from '../map/config.js';
import { FIELD, fieldPlaceOnMap, showFieldPick, fieldHere, fieldTarget, fieldSpan } from '../field/index.js';

const NAMING_ITEMS = ['Record', 'Confirm'];
const onField = () => mode.current === 'field';
const eye = new THREE.Vector3();

/**
 * @param ctx        the module context (bus, scene, camera, xr)
 * @param state      the HUD's state (index.js): layerSet and grids are read, `reachable` is kept on it
 * @param showToast  (message) => void
 * @param changed    called when the naming buttons on the command card have to be drawn again
 */
export function createMarks({ ctx, state, showToast, changed }) {
  let pick = null; // while the card is up: { cell: [col, row], note, kind, id } on the Mars map, { room: [x, z], kind, id } on the field map
  // The places the wearer marked: id -> { id, label, room: [x, z] } (field map) or { id, label, cell } (Mars map).
  // They are kept on the Jetson (waypoints:store) and come back in the next session
  // (waypoints:stored). A waypoint of the Mars map is a cell of the data and fits at once. One
  // of the field map is a place in room coordinates, and those are only the same as before when
  // the scan has found itself in the stored map (map:run, trusted): until then it waits in
  // `shelved`, unseen. `runs`: the scan runs whose coordinates it is known to fit.
  const waypoints = new Map();
  let shelved = []; // field waypoints that are not shown: [{ id, label, room, runs }]
  const scan = { run: null, trusted: false, storedRun: null }; // the scan's run and whether it trusts the stored map (scan/index.js)
  // A waypoint that was just set and may be given a name: { id, until, listening, listenUntil, token }.
  // Its two buttons are on the card over the map and, since "Mark waypoint" is pressed on the
  // command card (where the map is not in view), on the command card too.
  let naming = null;
  let dictations = 0;
  let lastMapPoint = null; // where the wearer is on the Mars map, in map metres (nav:position)

  // The card over the picked place.
  const card = makePanel(HUD.pick.wDeg, HUD.pick.hDeg);
  card.mesh.visible = false;
  ctx.scene.add(card.mesh);
  const cardPop = {}; // the pop the card comes up with (core/hologram.js)
  let cardHits = [];
  let cardDirty = true;
  const touch = { hoverId: null, pressedId: null, pressedUntil: 0 }; // pointer feedback on the card

  /** The naming changed: both cards that show its buttons are drawn again. */
  const namingChanged = () => {
    changed();
    cardDirty = true;
  };

  // ---- the stored list ----
  /** The runs a field waypoint fits: those it had, and the one it is shown in now. */
  const runsOf = (w) => [...new Set([...(w.runs ?? []), scan.run].filter(Boolean))].slice(-8);

  /** The whole list to the hub: what is shown, and what waits for a session in which it fits. */
  function saveWaypoints() {
    const items = [];
    for (const w of waypoints.values()) {
      if (w.cell) items.push({ id: w.id, label: w.label, cell: w.cell });
      else items.push({ id: w.id, label: w.label, room: w.room, runs: runsOf(w) });
    }
    ctx.bus.emit('waypoints:store', { items: [...items, ...shelved], count: items.length + shelved.length });
  }

  /** The room's coordinates changed (a new session, a recentre): the field waypoints are put aside, not deleted. */
  function shelveRoomWaypoints() {
    for (const w of [...waypoints.values()]) {
      if (!w.room) continue;
      shelved = shelved.filter((d) => d.id !== w.id).concat({ id: w.id, label: w.label, room: w.room, runs: runsOf(w) });
      waypoints.delete(w.id);
      ctx.bus.emit('waypoint:remove', { id: w.id });
    }
  }

  /** Show the shelved field waypoints that fit the coordinates in use: those of run `fits`. */
  function unshelve(fits) {
    if (!fits) return;
    const back = shelved.filter((d) => d.runs?.includes(fits));
    if (!back.length) return;
    shelved = shelved.filter((d) => !back.includes(d));
    for (const d of back) {
      const w = { id: d.id, label: d.label, room: d.room, runs: d.runs };
      waypoints.set(w.id, w);
      ctx.bus.emit('waypoint:set', w);
    }
    saveWaypoints(); // they now fit this run too
    showToast(`${back.length} waypoint${back.length > 1 ? 's' : ''} from last time`);
  }

  /** The scan says which run it is in, and whether the stored map (and so the stored waypoints) fits it. */
  function onScanRun({ run, trusted, storedRun }) {
    if (run !== scan.run) {
      shelveRoomWaypoints(); // new coordinates; tagged with the run they were in
      scan.run = run;
    }
    scan.trusted = !!trusted;
    scan.storedRun = storedRun ?? null;
    if (scan.trusted) unshelve(scan.storedRun);
  }

  /** The hub's list from earlier sessions. */
  function onStoredWaypoints({ items }) {
    if (!Array.isArray(items)) return;
    let added = 0;
    for (const it of items) {
      if (!it?.id || waypoints.has(it.id)) continue;
      if (Array.isArray(it.cell)) {
        const w = { id: it.id, label: it.label ?? '', cell: it.cell };
        waypoints.set(w.id, w);
        ctx.bus.emit('waypoint:set', w);
        added++;
      } else if (Array.isArray(it.room)) {
        shelved = shelved.filter((d) => d.id !== it.id).concat({ id: it.id, label: it.label ?? '', room: it.room, runs: Array.isArray(it.runs) ? it.runs : [] });
      }
    }
    if (added && !onField()) showToast(`${added} waypoint${added > 1 ? 's' : ''} from last time`);
    // The link came back within this run, or the scan already trusts the stored map.
    unshelve(scan.run);
    if (scan.trusted) unshelve(scan.storedRun);
    // What was marked or renamed while the link was down is not on the hub yet: now that its
    // list is merged in, send ours.
    const kept = new Map(items.map((it) => [it?.id, it?.label ?? '']));
    if ([...waypoints.values(), ...shelved].some((w) => kept.get(w.id) !== w.label)) saveWaypoints();
  }

  const wpOf = (id) => waypoints.get(id) ?? null;
  const here = (w) => (onField() ? w.room : w.cell); // a waypoint of the other map has no place on this one

  // ---- picking ----
  /** The waypoint or target at (or right beside) a picked place, as { kind, id?, room | cell }, or null. */
  function markNear(place) {
    let best = null;
    const take = (kind, id, at, d) => {
      if (d <= 1 && (!best || d < best.d)) best = { kind, id, d, ...(onField() ? { room: at } : { cell: at }) };
    };
    if (place.room) {
      const reach = (HUD.pick.snapM * fieldSpan()) / FIELD.mapM; // the snap distance on the map, in room metres
      const far = (at) => Math.hypot(at[0] - place.room[0], at[1] - place.room[1]) / reach;
      const t = fieldTarget();
      if (t) take('target', null, t, far(t) * 0.8); // the target is the larger marker: it wins a tie
      for (const w of waypoints.values()) if (w.room) take('waypoint', w.id, w.room, far(w.room));
    } else if (state.layerSet) {
      const reach = (HUD.pick.snapM / (MAP.widthM * mapZoom())) * state.layerSet.grid.cols; // in cells, on the map as large as it shows now
      const far = (at) => Math.hypot(at[0] - place.cell[0], at[1] - place.cell[1]) / reach;
      const t = mapTargetCell();
      if (t) take('target', null, t, far(t) * 0.8);
      for (const w of waypoints.values()) if (w.cell) take('waypoint', w.id, w.cell, far(w.cell));
    }
    // The target stands on a waypoint (it was navigated to): the waypoint is what is picked, so
    // it can still be renamed or deleted; "Stop" ends the way to it.
    if (best?.kind === 'target') {
      const at = best.room ?? best.cell;
      const tol = best.room ? 0.05 : 0.5;
      const same = [...waypoints.values()].find((w) => here(w) && Math.hypot(here(w)[0] - at[0], here(w)[1] - at[1]) <= tol);
      if (same) best = { ...best, kind: 'waypoint', id: same.id };
    }
    return best;
  }

  /** What the two cards say while a waypoint waits for its name. */
  function namingVM() {
    const w = wpOf(naming.id);
    return naming.listening
      ? { title: 'Listening…', hint: 'Say the name, then pause', items: ['Cancel'] }
      : { title: w?.label ?? 'Waypoint', hint: 'Name it by voice?', items: NAMING_ITEMS };
  }

  function cardVM() {
    const pressedId = performance.now() < touch.pressedUntil ? touch.pressedId : null;
    const ls = state.layerSet;
    let hint = '';
    if (pick?.room) {
      const from = fieldHere() ?? [ctx.camera.getWorldPosition(eye).x, eye.z];
      hint = `${Math.hypot(pick.room[0] - from[0], pick.room[1] - from[1]).toFixed(1)} m from you`;
    } else if (pick && ls) {
      const at = Math.round(pick.cell[1]) * ls.grid.cols + Math.round(pick.cell[0]);
      const h = state.grids.topo?.[at];
      const slope = state.grids.slope?.[at];
      hint = [pick.note || (Number.isFinite(h) ? `${h.toFixed(0)} m` : null), Number.isFinite(slope) ? `slope ${slope.toFixed(0)}°` : null].filter(Boolean).join(' · ');
    }
    let vm;
    if (naming && pick?.id === naming.id) vm = namingVM();
    else if (pick?.kind === 'waypoint') vm = { title: wpOf(pick.id)?.label ?? 'Waypoint', hint, items: ['Navigate', 'Record', 'Delete', 'Cancel'] };
    else if (pick?.kind === 'target') vm = { title: 'Target', hint, items: ['Navigate', 'Delete', 'Cancel'] };
    else vm = { title: 'Selected point', hint, items: ['Navigate', 'Waypoint', 'Cancel'] };
    return {
      cols: vm.items.length > 3 ? 2 : vm.items.length, // four buttons: two rows of two, so "Navigate" is not cut short
      title: vm.title,
      hint: vm.hint,
      items: vm.items.map((label) => ({ id: label, label, hover: label === touch.hoverId, pressed: label === pressedId })),
    };
  }

  function setPick(next) {
    pick = next;
    if (pick.cell) showPick(pick.cell);
    cardDirty = true;
    ctx.bus.emit('map:pick', pick.room ? { room: pick.room } : { cell: pick.cell });
  }

  /** A place picked on the Mars map: `cell` is [col, row] of the data. */
  function selectPoint(cell) {
    if (naming) endNaming(); // picking elsewhere settles the waypoint that was waiting for its name
    clickSound();
    const mark = markNear({ cell });
    if (mark) return setPick({ cell: mark.cell, note: '', kind: mark.kind, id: mark.id });
    // The planner closes ground steeper than 20 degrees, and much of this terrain is: the pick
    // goes to the nearest walkable cell, and the card says how far that was.
    const asked = [Math.round(cell[0]), Math.round(cell[1])];
    const ls = state.layerSet;
    // Reachable from the base over walkable slopes, worked out once per data set.
    if (ls && state.reachable?.for !== ls) {
      const base = ls.waypoints?.find((w) => w.id === 'base');
      state.reachable = { for: ls, cells: base ? reachableFrom(ls, state.grids.slope ?? null, base.cell) : null };
    }
    const walkable = ls ? walkableNear(ls, state.grids.slope ?? null, asked, { within: state.reachable?.cells ?? null, reachCells: 40 }) : asked;
    const to = walkable ?? asked;
    const movedM = ls ? Math.round(Math.hypot(to[0] - asked[0], to[1] - asked[1]) * ls.grid.cellSizeM) : 0;
    setPick({ cell: to, note: !walkable ? 'no walkable ground near' : movedM ? `moved ${movedM} m to reachable ground` : '', kind: 'place' });
  }

  /** A place picked on the field map: `room` is where it is in the room. */
  function selectPlace(room) {
    if (naming) endNaming();
    clickSound();
    const mark = markNear({ room });
    setPick(mark ? { room: mark.room, kind: mark.kind, id: mark.id } : { room: [room[0], room[1]], kind: 'place' });
  }

  function clearPick(keepPin = false) {
    if (!pick) return;
    const wasField = !!pick.room;
    pick = null;
    if (wasField) showFieldPick(null);
    else if (!keepPin) showPick(null);
    card.mesh.visible = false;
    ctx.bus.emit('map:pick', null);
  }

  /** Go to the picked place: it becomes the target, and the route is requested. */
  function navigatePick() {
    if (!pick) return;
    const w = pick.kind === 'waypoint' ? wpOf(pick.id) : null;
    if (naming) endNaming(false);
    if (pick.room) {
      ctx.bus.emit('field:target', { point: pick.room, label: w?.label ?? '' });
      clearPick();
      return;
    }
    const id = w ? w.id : 'pick';
    ctx.bus.emit('nav:waypoint', { id, cell: pick.cell, label: w?.label ?? 'Selected point' });
    ctx.bus.emit('nav:request', { targetId: id });
    clearPick(!w); // the card goes; the pin stays where the route leads (a waypoint has its own marker)
  }

  // ---- waypoints ----
  /** Mark a place: { room } on the field map, { cell } on the Mars map. The waypoint then waits for its name. */
  function addWaypoint(place) {
    // Its number: the lowest one free among all the waypoints there are, those put aside too
    // (they come back with their names), so the number of a deleted waypoint is used again.
    const n = nextWaypointNumber([...waypoints.keys(), ...shelved.map((d) => d.id)]);
    // The id must not meet one from an earlier session (the stored list may arrive later).
    const w = { id: `wp-${Date.now().toString(36)}-${n}`, label: `Waypoint ${n}`, ...(place.room ? { room: [place.room[0], place.room[1]] } : { cell: [place.cell[0], place.cell[1]] }) };
    waypoints.set(w.id, w);
    ctx.bus.emit('waypoint:set', w);
    saveWaypoints();
    naming = { id: w.id, until: performance.now() + HUD.pick.namingMs, listening: false, listenUntil: 0, token: 0 };
    setPick({ ...(w.room ? { room: w.room } : { cell: w.cell, note: '' }), kind: 'waypoint', id: w.id });
    changed();
    showToast(`${w.label} set`);
    return w;
  }

  /** "Mark waypoint": the place where the wearer stands. */
  function markHere() {
    // On the Mars map without tracking (the PC view) the wearer is where the map starts them: at the base.
    const place = onField() ? { room: fieldHere() } : { cell: cellOfMapPoint(lastMapPoint) ?? state.layerSet?.waypoints?.find((w) => w.id === 'base')?.cell };
    if (!(place.room ?? place.cell)) {
      showToast('Position not tracked yet');
      return;
    }
    if (naming) endNaming(false);
    addWaypoint(place);
  }

  /** The naming is over (named, confirmed, timed out, or something else was picked). */
  function endNaming(closeCard = true) {
    if (!naming) return;
    if (naming.listening) ctx.bus.emit('voice:dictate', { on: false, id: naming.token });
    const id = naming.id;
    naming = null;
    namingChanged();
    if (closeCard && pick?.id === id) clearPick();
  }

  /** "Record": what is said next, until the speaker pauses, becomes the waypoint's name. */
  function startRecording(id) {
    if (!wpOf(id)) return;
    if (naming?.id !== id) naming = { id, until: 0, listening: false, listenUntil: 0, token: 0 };
    const now = performance.now();
    naming.listening = true;
    naming.listenUntil = now + HUD.pick.listenMs;
    naming.until = naming.listenUntil;
    naming.token = ++dictations;
    ctx.bus.emit('voice:dictate', { on: true, id: naming.token, seconds: HUD.pick.listenMs / 1000 });
    namingChanged();
    showToast('Listening: say the name');
  }

  function stopRecording(note) {
    if (!naming?.listening) return;
    ctx.bus.emit('voice:dictate', { on: false, id: naming.token });
    naming.listening = false;
    naming.until = performance.now() + HUD.pick.namingMs;
    namingChanged();
    if (note) showToast(note);
  }

  /** What the hub heard after "Record". */
  function onDictation({ id, text, unavailable }) {
    if (!naming?.listening || id !== naming.token) return;
    if (unavailable) return stopRecording('Recording needs the Jetson: not connected');
    // As a name: one line, no full stop at the end, not longer than a label can show.
    const label = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[.!?。]+$/, '').slice(0, 40).trim();
    if (!label) return stopRecording('Nothing heard');
    const w = wpOf(naming.id);
    naming.listening = false;
    if (w) {
      w.label = label;
      ctx.bus.emit('waypoint:set', w);
      saveWaypoints();
      showToast(`Waypoint: “${label}”`);
    }
    endNaming();
  }

  /** Delete what is picked: a waypoint, or the target. */
  function deletePicked() {
    if (!pick) return;
    if (pick.kind === 'waypoint') {
      const w = wpOf(pick.id);
      if (naming?.id === pick.id) endNaming(false);
      waypoints.delete(pick.id);
      ctx.bus.emit('waypoint:remove', { id: pick.id });
      saveWaypoints();
      showToast(`${w?.label ?? 'Waypoint'} deleted`);
    } else if (pick.kind === 'target') {
      if (pick.room) ctx.bus.emit('field:target', { point: null });
      else ctx.bus.emit('voice:command', { intent: 'nav.stop', slots: {}, text: '' }); // the Mars route ends, and its target with it
      showToast('Target deleted');
    } else return;
    clearPick();
  }

  /** A button of the pick card, or of the naming buttons on the command card. */
  function pressMark(id) {
    if (id === 'Navigate') navigatePick();
    else if (id === 'Waypoint') pick?.kind === 'place' && addWaypoint(pick);
    else if (id === 'Record') startRecording(naming?.id ?? pick?.id);
    else if (id === 'Confirm') endNaming();
    else if (id === 'Delete') deletePicked();
    else if (naming?.listening) stopRecording(); // "Cancel" while listening: back to Record / Confirm
    else {
      if (naming) endNaming(false);
      clearPick();
    }
  }

  // ---- wiring ----
  ctx.bus.on('voice:dictation', onDictation);
  ctx.bus.on('nav:position', ({ point }) => {
    lastMapPoint = point;
  });
  // A new session, or the reference space shifted onto the room's kept coordinates
  // (core/room-frame.js): the places marked in the room are put aside until the scan has found
  // itself in the stored map. (Waypoints on the Mars map are cells of the data and stay.)
  const newRoomCoordinates = () => {
    endNaming(false);
    clearPick();
    shelveRoomWaypoints();
  };
  ctx.xr.onSessionStart(newRoomCoordinates);
  ctx.xr.onRealign?.(newRoomCoordinates);
  ctx.bus.on('map:run', onScanRun);
  ctx.bus.on('waypoints:stored', onStoredWaypoints);
  ctx.bus.on('app:mode', () => {
    endNaming(false);
    clearPick(); // a place picked on one map means nothing on the other
  });

  return {
    /** The card over the picked place, as a pointer target: its panel, its hit rectangles, a press on it. */
    card,
    hits: () => cardHits,
    press(id) {
      touch.pressedId = id;
      touch.pressedUntil = performance.now() + HUD.layers.pressFlashMs;
      clickSound();
      pressMark(id);
    },
    /** Which button of the card the pointer is on (null: none). */
    hover(id) {
      if (id === touch.hoverId) return;
      touch.hoverId = id;
      cardDirty = true;
    },

    selectPoint,
    selectPlace,
    markHere,
    pressMark,

    /** The name the wearer gave a waypoint, or undefined when `id` is not one of theirs. */
    labelOf: (id) => waypoints.get(id)?.label,
    /** What the command card shows in place of the commands while a waypoint waits for its name, or null. */
    asking: () => (naming ? namingVM() : null),

    /**
     * A spoken command (or a command button, which goes the same way), after index.js has dealt
     * with the alerts. Saying a button of the card presses it. (link.js leaves the route request
     * to us while a place is picked.) `rescueArmed()`: "Confirm" then belongs to the emergency button.
     */
    voice(intent, rescueArmed) {
      if (pick && intent === 'nav.start') navigatePick();
      else if (intent === 'nav.stop' && (pick || naming)) pressMark('Cancel');
      // "Mark waypoint": the picked place if bare ground is picked, else where the wearer stands.
      else if (intent === 'nav.mark') pick?.kind === 'place' ? addWaypoint(pick) : markHere();
      else if (intent === 'waypoint.record') {
        const id = naming?.id ?? (pick?.kind === 'waypoint' ? pick.id : null);
        if (id) startRecording(id);
        else showToast('Pick a waypoint on the map first');
      } else if (intent === 'alert.ack' && naming && !naming.listening && !rescueArmed()) endNaming();
      else if (intent === 'mark.delete') {
        if (pick?.kind === 'waypoint' || pick?.kind === 'target') deletePicked();
        else showToast('Pick a waypoint or the target on the map first');
      }
    },

    /** Every frame, after the pointer: the naming's time limits, and the card over the picked place. */
    place(now) {
      // A waypoint that waits for its name does not wait for ever, and neither does the listening.
      if (naming && now > naming.until) {
        if (naming.listening) stopRecording('Nothing heard');
        else endNaming();
      }
      // The card stands over the picked place and goes where the map goes; it hides with the map.
      // (The field map scrolls under the wearer, so its pin is put in place again every frame.)
      if (pick?.room) showFieldPick(pick.room);
      const over = pick && (pick.room ? fieldPlaceOnMap(pick.room) : mapCellInRoom(pick.cell));
      card.mesh.visible = !!over;
      if (!over) popIn(cardPop, false, now);
      if (over) {
        card.mesh.position.copy(over);
        card.mesh.position.y += HUD.pick.liftM * (ctx.xr.presenting ? 1 : 8);
        card.mesh.lookAt(ctx.camera.getWorldPosition(eye));
        const size = HUD.pick.scale * (ctx.xr.presenting ? 1 : 6);
        const k = popIn(cardPop, true, now);
        card.mesh.scale.set(size * k, size * k * k, size);
      }
    },

    /** Every frame, with the other cards: draw the card again if what it shows has changed. */
    draw(now) {
      if (touch.pressedId && now > touch.pressedUntil) {
        touch.pressedId = null;
        cardDirty = true;
      }
      if (cardDirty && card.mesh.visible) {
        cardHits = drawCommands(card.g, HUD.pxPerDeg, cardVM());
        card.tex.needsUpdate = true;
        cardDirty = false;
      }
    },

    /** As if the hub had heard `text` after "Record" (tests, console). */
    dictated: (text) => naming && onDictation({ id: naming.token, text }),
    /** Marked places and the pick card (tests, console). */
    debug: () => ({ pick, naming: naming && { ...naming }, waypoints: [...waypoints.values()], shelved: [...shelved], scan: { ...scan }, card: pick ? cardVM() : null }),
  };
}
