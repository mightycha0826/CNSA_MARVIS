# Developing Project Marvis

For whoever continues the code: how to build and test it, the rules the team worked by, what new code should follow, and what the reorganization of 2026-11-15 changed. What the app does is in the [README](../README.md) and in [USAGE.md](USAGE.md); the data formats are in [INTERFACES.md](INTERFACES.md).

The letters A to F are the six parts of the project and the people who built them ([README, Team](../README.md#team)). Names in the code keep the project's earlier name (`marswalk`, `window.__marswalk`, the `MARSWALK` hotspot).

## Contents

1. [Build and test](#1-build-and-test)
2. [Working rules](#2-working-rules)
3. [Writing the next code](#3-writing-the-next-code)
4. [The refactoring of 2026-11-15](#4-the-refactoring-of-2026-11-15)

---

## 1. Build and test

Node.js 20.19 or later is required (22.12 or later on the 22 line). In `web/`, after `npm install`:

```bash
npm run build      # static files in web/dist/ (served by the Jetson)
npm test           # unit tests: scan grid, field planner, hand pointer, route planner
npm run smoke      # with the dev server running, checks the mock-mode event flow (needs Playwright)
npx --yes eslint@9 src scripts   # lint (web/eslint.config.js); ESLint is fetched on first use, it is not a dependency
```

The hub's tests: `.venv/bin/python -m unittest discover tests` in `jetson/`.

Module owners start from `index.js` in their own folder (`web/src/scan/`, `map/`, `nav/`, `hud/`). What `init(ctx)` and `update(frame)` receive is described in the comment at the top of each file.

**`npm run build` writes `web/dist`, which a running hub serves to the headset at once.** To build without touching it: `npx vite build --outDir <somewhere else>`.

## 2. Working rules

The rules the six of us worked by during the hackathon. They still describe how the code is laid out.

1. **Edit only your own folder.** If someone else's folder needs a change, ask its owner.
2. **Modules talk only through events.** Do not call another module's functions directly.
3. **Tell B before changing an interface.** Edit [INTERFACES.md](INTERFACES.md) first, then the code.
4. **Branches**: `feat/<slot>-<topic>` (for example `feat/d-palm-map`). B merges into `main`.
5. **Push small and often.**
6. **Give the AI only what it needs.** `docs/INTERFACES.md` and your own folder are enough and cost fewer tokens.

## 3. Writing the next code

What the code base already does, written down so that new code fits in. Read this section and the header comment of the file you are about to change; that is usually enough.

**Where things go**

1. **One module, one folder, one `index.js`** with `init(ctx)` and `update(frame)`. Its header comment says what it does, which events it **receives** and **sends**, and what was not checked on the headset. Keep that comment true when the code changes.
2. **Split by responsibility before a file passes about 500 lines.** A part with state of its own becomes a file with a `create…({ ctx, … })` function that keeps the state inside and returns the few functions others need (`createPointer`, `createSuit`, `createRescue`, `createDash`, `createMarks`, `createStatus`). No new module-level `let` in an `index.js` for something that could live in such a part.
3. **What two modules share goes to `core/`**: how a hologram comes up and floats (`hologram.js`), the palm (`palm.js`), the shapes on the maps (`markers.js`), the query string (`params.js`). In the HUD: `panel.js` for a canvas on a mesh, `sound.js` for sounds. Use these; do not copy them.

**How modules talk**

4. **Events on the bus, nothing else** ([working rules](#2-working-rules), rule 2). Change [INTERFACES.md](INTERFACES.md) first, then the code. The exception that exists: a question about geometry that must be answered within the frame (`pickOnMap`, `fieldHere`). Never call another module to *change* its state.
5. **Handlers for one event run in the order the modules are listed in `main.js`** (`scan, map, nav, hud, field`). Code that depends on another module having handled the same event first waits a beat (`queueMicrotask`) and says so in a comment.
6. **On the hub, a new message type is a new method** `on_<type>(self, client, payload)` registered in `Hub.handlers`, plus a line in INTERFACES section 4. What belongs to one connection goes on `Client`. Writing a log line must never break the voice path: use `append_line`.

**Settings and numbers**

7. **Every number that can be tuned is in the module's config object** (`HUD`, `MAP`, `FIELD`, `SCAN`, `WALK`, `PALM`, …) with its unit in the name (`liftM`, `tiltDeg`, `holdMs`, `periodS`, `pxW`) and a comment on what it does. No bare numbers in the logic.
8. **The address's query string is read only through `core/params.js`.** A new `?switch=` is documented where it is read and in [USAGE.md](USAGE.md). `!isOff('x')` for a switch that is on by default, `numberOr` when zero should give the default, `finiteOr` when zero is a value.

**The frame**

9. **`update(frame)` allocates nothing.** Vectors, quaternions and matrices are module-level scratch objects; a canvas is drawn again only when its `dirty` flag (or a tile's `sig`) says its content changed.
10. **A change the wearer sees should come up the way everything else does:** `popIn` / `popScale` for what a hand brings up, the spring in `layout.js` for tiles. A new look is a decision for the team, not a side effect.
11. **Colours and fonts come from `hud/tokens.js`**; the words on the status tiles and the alerts from `hud/strings.js`.

**Tests and checking**

12. **Logic that can be tested goes in a file without three.js or the DOM**, with its test beside it (`grid.js` / `grid.test.js`), run by `npm test`. A file that tests import must load under node: nothing at its top level may touch `window` or `document`.
13. **Keep the console hooks working** (`window.__hud`, `__field`, `__map`, `__scan`, `__marswalk`): they are how the app is tested without a headset. A new flow gets a hook.
14. **Before pushing:** `npm test`, the hub's tests, the lint line of [section 1](#1-build-and-test), and a look in a PC browser with `?mock=1&mockSpeed=0.01` (and `&mode=field`). To compare with the version before, build both with `npx vite build --outDir <somewhere else>`: **`npm run build` writes `web/dist`, which the running hub serves to the headset at once.**
15. **Refactoring and new behaviour are separate commits.** A refactoring commit changes no behaviour and says how that was checked.

**Writing**

16. **English everywhere:** comments, log messages, text on screen, commit messages. Korean only in the `ko` string table and in the data's `label` fields.
17. **Comments say why**, in plain sentences: what the wearer experiences, what was tried and taken out again, what is not checked on the headset. Not what the next line does.
18. **Say what is real and what is simulated** wherever a value is shown (the `sim` tag, "simulated" in the documents): the principle that every value on screen can name the NASA data or the sensor it comes from applies to code as well.

## 4. The refactoring of 2026-11-15

Written on the day, and left as it was written: "now" and "not yet" mean that day.

The code was reorganized once the features were in. **Nothing the wearer sees or does changed**; the one visible difference is that the device check page and the mock data's names are now English (see "English only" below).

### What changed

| Area | Before | After |
|---|---|---|
| `web/src/hud/index.js` | 1,528 lines: events, state, sounds, panels, readings, waypoints, the pick card, hand menus and the frame loop in one file | 842 lines: events, state, hand menus, the frame loop. The rest moved out, each part with its own state behind a `create…()` function (below) |
| `web/src/hud/sound.js` (new) | In `index.js` | The alarm beep, the click, the arrival chime |
| `web/src/hud/panel.js` (new) | In `index.js`, handed on to `dash.js` as arguments | `makePanel`, `placeOnStage`, `hitAt`, `makeWash`, `UNIT`: a canvas on a mesh and where it sits. `dash.js` imports them |
| `web/src/hud/marks.js` (new) | About 350 lines and 12 module-level variables in `index.js` | `createMarks()`: the picked place, the waypoints and their storage, naming by voice, the card over a pick. It wires its own events |
| `web/src/hud/status.js` (new) | In `index.js` | `createStatus()`: the readings' history and which tiles are shown |
| `web/src/core/params.js` (new) | `new URLSearchParams(location.search)` in 13 places, three of them written around node having no `location` | One reader for the address's query string: `params`, `isOff()`, `numberOr()`, `finiteOr()`. Safe under node |
| `jetson/marswalk/hub.py` | `ws_handler`: 120 lines, most of them one `if / elif` chain over the message types, the connection's state in local variables | One method per message type (`on_hello`, `on_mic_begin`, …) in the table `Hub.handlers`; the connection's state in the `Client` dataclass. Three copies of the send loop are one (`_to_all`), two copies of the log append are one (`append_line`) |
| English only | Korean comments, console messages and the check page's text in 20 files | English. Left in Korean on purpose: the `ko` table in `hud/strings.js` (`?lang=ko`) and the `label` fields of the data (`label` is the short Korean name, `labelEn` the English one; the mock data now has `labelEn` too, so the PC planner shows "Base" in mock mode as it does with the real data) |
| Dead code | — | Removed: `mapInView`, `tabAt`, `engaged.pick` and a doubled import in `hud/index.js`; `frame()` in `hud/draw.js`; `dummy` and `stats` in `field/index.js`; unused `cells` (`field/planner.js`), `vp` (`nav/planner.js`), `mode` (`main.js`) |
| Lint | None | `web/eslint.config.js`: undefined names, unused code. 9 warnings before, none now |

### How it was checked

- **Unit tests:** 148 in `web/`, 28 in `jetson/`, all passing before and after. One hub test was adapted to the new `handle_utterance(samples, rate, client)` signature.
- **The web app, before against after:** both versions were built and opened side by side in a PC browser in mock mode. One script drove each through about 30 steps on the Mars map and 16 on the field map (pick a place, set, name, navigate to and delete waypoints, the same by voice, stored waypoints coming back, alerts raised, confirmed and cleared) and recorded the state and every event sent after each step. The two records are identical. The command card, the SOS button, the pick card and the check page were looked at as well.
- **The hub, before against after:** both versions were started on spare ports and sent every message type from two connections. What each connection received, and what the hub logged, is identical.
- **The translation:** on every changed line, the code outside comments and string literals is unchanged (compared by script).
- **Not checked on the headset.** And not yet in use: the running hub was not restarted and `web/dist` was not rebuilt. `npm run build` in `web/` puts the new web app on the headset; the Python changes take effect when the hub is restarted.

### Left as it is

Candidates for the next round, not touched now because they could only be checked on the headset:

- `hud/index.js`: `updateHands` and `followMenu` (the hand menus, about 170 lines) could become a `menus.js`.
- `field/index.js` (940 lines) mixes the walking position, the palm map's drawing and the guidance; `hud/suit.js` (650) and `hud/draw.js` (590) are long but each does one thing.
- `hud/` calls a few functions of `map/` and `field/` directly (`pickOnMap`, `mapCellInRoom`, `fieldHere`, …), which rule 2 of the [working rules](#2-working-rules) does not allow. They are questions about geometry that need an answer in the same frame; an event cannot return one.
