// HUD colours and fonts. The dark theme of the Point design system (design-system/point), used as it is.
// The background is the real room, so the theme stays dark (mockups/hud-mockup.html).

import { HUD } from './config.js';
import tokens from '../../../design-system/point/tokens.json';
import fontUrl from '../../../design-system/point/fonts/WantedSansVariable.woff2?url';
import atkinson400 from './fonts/AtkinsonHyperlegible-400.woff2?url';
import atkinson700 from './fonts/AtkinsonHyperlegible-700.woff2?url';

const dark = Object.fromEntries(tokens.color.tokens.map((t) => [t.name, t.value.dark]));

function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export const T = {
  surface: alpha(dark.surface, 0.92), // the mockup's --h-surface: rgba(38,38,38,.92)
  /** Background of the layer menu and legend, which sit next to the map (HUD.layers.faceOpacity) */
  menu: alpha(dark.surface, HUD.layers.faceOpacity),
  row: dark.row,
  track: dark.track,
  badge: dark['badge-bg'],
  toast: alpha(dark['toast-bg'], 0.94),
  ink: dark.ink,
  muted: dark['ink-muted'],
  primary: dark.primary,
  primaryIcon: dark['primary-text'],
  point: dark.point,
  danger: dark.danger,
  dangerLine: dark['danger-line'],
  hairline: 'rgba(255, 255, 255, 0.08)',
};

// Status card of the updated mockup (mockups/hud-mockup.html): a transparent face so the room
// stays visible, white-and-black double outlines, and bold white text with a dark halo.
export const O = {
  ink: '#ffffff',
  label: '#f4f7fa',
  stale: '#d0d7de',
  ok: '#8ce99a',
  warn: '#ffa94d',
  crit: '#ff8787',
  line: 'rgba(255, 255, 255, 0.85)',
  outer: 'rgba(0, 0, 0, 0.88)',
  inner: 'rgba(0, 0, 0, 0.78)',
  halo: 'rgba(0, 0, 0, 0.95)',
  track: 'rgba(255, 255, 255, 0.28)',
  fill: '#748ffc',
  tagBg: 'rgba(0, 0, 0, 0.48)',
  cut: '#101214',
};

// Atkinson Hyperlegible keeps 0/O and 1/I/l apart; the files are bundled because the headset
// has no internet on the Jetson hotspot. Wanted Sans covers Korean labels (?lang=ko).
export const FONT_FAMILY = '"Atkinson Hyperlegible", "Wanted Sans", "Apple SD Gothic Neo", system-ui, sans-serif';

/** Loads Wanted Sans. If that fails, the HUD is still drawn, in the system font. */
export async function loadFont() {
  try {
    const faces = [
      new FontFace('Atkinson Hyperlegible', `url(${atkinson400})`, { weight: '400' }),
      new FontFace('Atkinson Hyperlegible', `url(${atkinson700})`, { weight: '700' }),
      new FontFace('Wanted Sans', `url(${fontUrl})`, { weight: '400 1000' }),
    ];
    for (const face of await Promise.all(faces.map((f) => f.load()))) document.fonts.add(face);
    return true;
  } catch (err) {
    console.warn('[hud] could not load the fonts, using the system font:', err.message);
    return false;
  }
}

// The legend's colour ramp for each layer (the mockup's values). An unknown layer gets greyscale.
export const RAMPS = {
  topo: [[18, 42, 74], [32, 120, 128], [196, 170, 110], [250, 246, 232]],
  slope: [[236, 236, 244], [150, 130, 200], [60, 20, 110]],
  optical: [[30, 30, 30], [240, 240, 240]],
  thermal: [[10, 6, 40], [110, 30, 120], [230, 110, 40], [252, 240, 150]],
  default: [[30, 30, 30], [240, 240, 240]],
};
