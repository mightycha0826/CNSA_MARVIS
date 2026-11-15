// The address's query string, read in one place.
//
// Every switch and number that can be set from the address (?mock=1, ?sound=0, ?walkScale=50 ...)
// is read through this module, so `grep "params\.\|isOff(\|numberOr(\|finiteOr("` finds them all.
// What each one does is documented where it is used and in docs/USAGE.md.
//
//   import { params, isOff, numberOr, finiteOr } from '../core/params.js';
//   params.get('lang')         the raw value, or null when it is not in the address
//   params.has('walkScale')    whether it is in the address at all
//   !isOff('sound')            a switch that is on unless the address says ?sound=0
//   numberOr('radWarn', 300)   a number; absent, zero or junk gives the fallback
//   finiteOr('simO2', 98)      a number, zero included; absent or junk gives the fallback
//
// Safe to import under node (the unit tests): there is no address there, so nothing is set.

export const params = new URLSearchParams(globalThis.location?.search ?? '');

/** True only when the address says ?name=0: for switches that are on by default. */
export const isOff = (name) => params.get(name) === '0';

/** The number given for `name`; the fallback when it is absent, zero or not a number. */
export const numberOr = (name, fallback) => Number(params.get(name)) || fallback;

/** The number given for `name`, zero included; the fallback when it is absent or not a number. */
export const finiteOr = (name, fallback) => (params.has(name) && Number.isFinite(Number(params.get(name))) ? Number(params.get(name)) : fallback);
