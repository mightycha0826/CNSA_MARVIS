// Run-time settings. Change them with the query after the address.
//
//   ?mock=1                 everything fake (runs without headset, Jetson or real data)
//   ?mock=link,hazard       only some parts fake. Parts: data, link, hazard
//                           e.g. C's real data + a fake Jetson: ?mock=link,hazard
//   ?mockSpeed=10           the mock timetable 10 times faster (for tests)
//   ?jetson=192.168.0.7:8443  the Jetson's address (default: port 8443 on this page's host)
//   ?debug=0                hides the event window at the top left
//   ?near=20                a destination this many metres from the base (default 20, 0 = none)

import { params, isOff, numberOr } from './params.js';

const MOCK_PARTS = ['data', 'link', 'hazard'];
const mockParam = params.get('mock');
const mockList = mockParam ? mockParam.split(',') : [];
const mockAll = mockParam === '1' || mockParam === 'true' || mockList.includes('all');

/** Which parts run fake. E.g. with mock.link === true, mock/jetson.js stands in for the Jetson */
export const mock = Object.fromEntries(MOCK_PARTS.map((p) => [p, mockAll || mockList.includes(p)]));
mock.any = MOCK_PARTS.some((p) => mock[p]);
mock.speed = numberOr('mockSpeed', 1);

function jetsonUrl() {
  const j = params.get('jetson');
  if (!j) return `wss://${location.hostname}:8443/ws`; // the starting value of INTERFACES section 4
  if (j.startsWith('ws://') || j.startsWith('wss://')) return j;
  return `wss://${j}${j.includes('/') ? '' : '/ws'}`;
}

export const config = {
  jetsonUrl: jetsonUrl(),
  /** How long to wait before trying again after the link drops */
  linkRetryMs: 2000,
  /** Not connected within this time: the link-lost alert */
  linkLostAfterMs: 3000,
  /** Level of the link-lost alert. On critical D switches to the route back to base, so the starting value is warn */
  linkLostLevel: 'warn',
  /** Interval between one env.json sample and the next */
  envIntervalMs: 5000,
  debug: !isOff('debug'),
  /** A destination this far from the base is added to the waypoints (m). ?near=0 leaves it out */
  nearbyM: params.has('near') ? Math.max(0, numberOr('near', 0)) : 20,
};

/** The URL of the files under public/data/. */
export const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
