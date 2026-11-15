// Event bus. Modules talk to each other only over this bus (README section 9, rule 2).
// Section 3 of docs/INTERFACES.md is the contract for the event names and payload formats.
//
//   import { bus } from '../core/bus.js';
//   bus.emit('layer:toggle', { id: 'thermal', visible: true });
//   const off = bus.on('layer:toggle', ({ id, visible }) => { ... });
//   off();                       // or bus.off('layer:toggle', handler)
//
// For debugging, bus.on('*', (name, payload) => ...) sees every event.

const handlers = new Map(); // name -> Set<fn>

function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
  return () => off(name, fn);
}

function off(name, fn) {
  handlers.get(name)?.delete(fn);
}

function emit(name, payload) {
  // If one listener throws, the others still get the event.
  for (const fn of [...(handlers.get(name) ?? [])]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[bus] error while handling '${name}'`, err);
    }
  }
  for (const fn of [...(handlers.get('*') ?? [])]) {
    try {
      fn(name, payload);
    } catch (err) {
      console.error(`[bus] error while handling '*'`, err);
    }
  }
}

export const bus = { on, off, emit };
