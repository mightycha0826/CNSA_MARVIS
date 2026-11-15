// The event window at the top left (PC view only; it is not seen inside an AR session).
// Shows how often each event went over the bus and its last payload. ?debug=0 hides it.

import { bus } from './bus.js';

function brief(payload) {
  try {
    return JSON.stringify(payload, (k, v) => {
      if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.length})`;
      if (k === 'layerSet' || k === 'traverse') return '{…}';
      return v;
    });
  } catch {
    return String(payload);
  }
}

export function initDebug({ el, mock, keys }) {
  const counts = new Map();
  let dirty = true;
  // Left open so that the test (scripts/smoke.cjs) and the console can look at it.
  window.__marswalk = { bus, counts, last: {} };
  bus.on('*', (name, payload) => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    window.__marswalk.last[name] = payload;
    dirty = true;
  });
  if (!el) return;
  const mockOn = ['data', 'link', 'hazard'].filter((p) => mock[p]);
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    const rows = [...counts.keys()].sort().map((name) => {
      const p = brief(window.__marswalk.last[name]);
      return `<tr><td>${name}</td><td class="n">${counts.get(name)}</td><td class="p" title='${p.replaceAll("'", '&#39;')}'>${p}</td></tr>`;
    });
    el.innerHTML =
      `<h1>MARVIS <span class="tag">${mockOn.length ? `mock: ${mockOn.join(', ')}` : 'live link'}</span></h1>` +
      `<table>${rows.join('')}</table>` +
      (keys ? `<div style="margin-top:6px;color:#9aa0a6">${keys}</div>` : '') +
      `<div style="margin-top:6px"><a href="./check.html">Device check page</a></div>`;
  }, 250);
}
