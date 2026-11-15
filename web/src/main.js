// Entry point. Builds the core, inits the modules, then starts the data and the Jetson link.
// Order matters: the first event goes out only after every module has set its bus.on in init.

import { bus } from './core/bus.js';
import { config, mock } from './core/config.js';
import { createXR } from './core/xr.js';
import { loadData, assetUrl } from './core/loader.js';
import { initLink } from './core/link.js';
import { initDebug } from './core/debug.js';
import { initRadiation } from './core/radiation.js';
import { setMode } from './core/mode.js';
import { params } from './core/params.js';
import { diagFrame } from './core/diag.js';
import { initMirror } from './core/mirror.js';
import { MOCK_KEYS_HELP } from './mock/jetson.js';

import * as scan from './scan/index.js';
import * as map from './map/index.js';
import * as nav from './nav/index.js';
import * as hud from './hud/index.js';
import * as field from './field/index.js';

// Order matters: field runs after map (it hides the whole-Mars map in field mode).
const MODULES = { scan, map, nav, hud, field };

async function main() {
  const debugEl = document.getElementById('debug');
  if (!config.debug) debugEl.remove();
  initDebug({ el: config.debug ? debugEl : null, mock, keys: mock.link ? MOCK_KEYS_HELP : '' });

  const core = createXR({
    container: document.getElementById('app'),
    button: document.getElementById('xr-button'),
  });
  // Two ways in: the Mars map (the main button) or the field map (scan the room, mark a target).
  // ?mode=field starts the PC view in field mode.
  if (params.get('mode') === 'field') setMode('field');
  const marsButton = document.getElementById('xr-button');
  const fieldButton = document.getElementById('xr-field-button');
  marsButton.addEventListener('click', () => { if (!core.xr.session) setMode('mars'); }, { capture: true });
  fieldButton?.addEventListener('click', () => {
    if (core.xr.session) return;
    setMode('field');
    core.xr.start().catch((err) => {
      console.error('[main] could not start the field map session', err);
      fieldButton.textContent = `Field map failed: ${err.name}`;
    });
  });
  const syncFieldButton = () => {
    if (!fieldButton) return;
    fieldButton.hidden = !!core.xr.session;
    fieldButton.disabled = marsButton.disabled && !core.xr.session;
  };
  core.xr.onSessionStart(syncFieldButton);
  core.xr.onSessionEnd(syncFieldButton);
  new MutationObserver(syncFieldButton).observe(marsButton, { attributes: true, childList: true });
  core.addModule('diag', { update: (frame) => diagFrame(frame, core.camera) });
  // For tests and for looking around from the console (window.__marswalk is made by initDebug).
  if (window.__marswalk) Object.assign(window.__marswalk, { scene: core.scene, camera: core.camera, controls: core.controls });

  const ctx = {
    bus,
    scene: core.scene,
    camera: core.camera,
    renderer: core.renderer,
    xr: core.xr,
    mock,
    config,
    assetUrl,
  };

  for (const [name, mod] of Object.entries(MODULES)) {
    try {
      await mod.init?.(ctx);
      core.addModule(name, mod);
    } catch (err) {
      // If one module breaks, the rest still start.
      console.error(`[main] ${name}.init failed. Carrying on without this module.`, err);
    }
  }

  // Last, so the picture it sends is of this frame: every module has placed its things by then.
  core.addModule('mirror', initMirror(core));

  initRadiation();
  core.run();
  await initLink(core.xr);
  try {
    await loadData();
  } catch (err) {
    console.error('[main] could not load the data:', err.message, '— if the real data is not there yet, add ?mock=1 to the address.');
  }
}

main();
