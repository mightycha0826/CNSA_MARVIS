# Design system

`point/` holds the source files of the **Point design system** (combo 1, cobalt and orange, is the default theme). Its own documents and previews are in Korean.

| File | Contents |
|---|---|
| `point/README.md` | Principles, tone of voice, rules for color, type, shape and motion |
| `point/tokens.json` | Tokens for color (light and dark), type, spacing, corners and motion |
| `point/components/` | A description (`README.md`) and a preview (`preview.html`) per component, and the shared `bundle.css` and `bundle.js` |
| `point/fonts/WantedSansVariable.woff2` | The Wanted Sans variable font (SIL OFL 1.1) |

Where Project Marvis uses it:

- `web/src/hud/`: the HUD reads the dark theme's tokens from `point/tokens.json` (`web/src/hud/tokens.js`) and uses the font from here.
- `mockups/hud-mockup.html`: the HUD design mockup. It sets out the rules by which sizes were carried over into angles of view (degrees).

The icons follow Material Symbols Rounded (Apache License 2.0), but the source SVG files are not in this folder. The HUD draws its icons on the canvas itself, so that it comes up without a network.
