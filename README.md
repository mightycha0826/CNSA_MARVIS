# Marswalk Visor (working title)

**A three-layer map on a Mars explorer's helmet.**
An entry for the 2026 NASA Space Apps Challenge — *Interplanetary Survival Guide: Martian Map*.

> A helmet HUD that builds the map and the route from NASA data, fills in nearby obstacles with the helmet's sensors, and changes the route when the suit's condition becomes dangerous.

**Demo video:** [docs/demo/marswalk-visor-demo.mp4](docs/demo/marswalk-visor-demo.mp4), a screen recording of the app in use.

**This project is built on NASA data.** The map, the route, the status panel and the alerts all start from NASA mission data. The headset, the Jetson and the Arduino are the means of delivering that data to the explorer.

| Document | Who reads it | Contents |
|---|---|---|
| This README | Whole team | What we build and why, schedule, rules |
| [docs/ROLES.md](docs/ROLES.md) | Each owner | The six roles, done criteria, expected AI token use |
| [docs/INTERFACES.md](docs/INTERFACES.md) | Owners and their AIs | Data formats exchanged between modules |
| [docs/RESOURCES.md](docs/RESOURCES.md) | Whole team, especially C | Analysis of the published resources, data to use and addresses |
| [docs/CHALLENGE.md](docs/CHALLENGE.md) | Whole team | Full challenge text |
| Sections 12 and 13 of this README | Whoever writes code next | What the refactoring of 2026-11-15 changed, and the rules new code should follow |

---

## 1. What we build

A Meta Quest 3 stands in for the spacesuit helmet, and we build the map a Mars explorer sees while walking. The map has three layers.

| Layer | What it shows | Data | Hardware |
|---|---|---|---|
| 1. Orbital map | 3D map of the exploration site with terrain, optical and thermal data overlaid | **NASA orbiter data** (MRO, Mars Odyssey, MGS) | Quest 3 (palm map) |
| 2. Field map | Nearby obstacles that orbital data cannot see | Helmet depth sensor laid over the NASA map | Quest 3 (real-time environment analysis) |
| 3. Survival info | Radiation, ambient temperature, emergency alerts | **NASA Curiosity observations** + temperature sensor | Jetson + Arduino |

Control is by palm gesture and voice only. The premise is that pressing a screen is hard with spacesuit gloves.

### Principle: every feature starts from NASA data

For every feature we must be able to answer "which NASA data does this value on screen come from?" A feature that cannot answer is postponed.

| Feature | NASA data behind it |
|---|---|
| Palm 3D map | Terrain (MRO HiRISE and others), optical (MRO HiRISE), thermal (Mars Odyssey THEMIS) |
| Route guidance | Slope computed from terrain. Shown next to the path Curiosity actually drove, as validation |
| Status panel | Radiation observed by Curiosity RAD, elevation and geologic unit of the current position |
| Emergency mode | Alert based on observed radiation (together with the ambient temperature alert) |
| Voice guidance | Reads the values above aloud |
| Rover point-of-view photo | Real photos Curiosity took at that spot |
| Real-time environment analysis | Corrects the route built from NASA data to fit nearby obstacles |

Where each dataset comes from is in [docs/RESOURCES.md](docs/RESOURCES.md).

Only two inputs are not NASA data: the helmet depth sensor and the temperature sensor on the suit (it measures the air around the wearer). Both operate only on top of the map and route built from NASA data.

### Real-time environment analysis is the kick of the demo

A map of NASA data alone is just a picture on a screen. Real-time environment analysis shows that map **alive in real space**. The moment an obstacle is placed in the demo, the route computed from NASA data is redrawn before your eyes.

- NASA data is the protagonist; real-time environment analysis makes it stand out.
- It ties to the challenge text, which says existing tools are "built for regional and global views rather than the hyperlocalized areas astronauts will target". The helmet sensor fills the very short range where orbital data is weak.
- The real data backs this up. Across our map extent (2 km) the thermal image is only 25 pixels wide, and even the sharpest optical image is about 0.64 m per pixel ([docs/RESOURCES.md](docs/RESOURCES.md) section 4). A rock at your feet is invisible from orbit.

### Mission scenario

Survey sulfur-bearing rocks in the **Gediz Vallis channel** on Mount Sharp, Gale Crater, and return to base.

- **Survey site (sulfur stone field)**: 137.4089° E, 4.7857° S. Where Curiosity ended its drive on May 30, 2024 (sol 4200), the drive on which it cracked open a rock and found pure sulfur. It is about 102 m from the center of the map (the sol 4312 position, 137.4075° E, 4.7868° S). Evidence is in [docs/DATA.md](docs/DATA.md) section 2.
- **Base**: where Curiosity stood on sol 4098. 358 m from the survey site in a straight line and 45 m lower.
- **Science goal**: Curiosity found rocks of pure sulfur here, a first on Mars, and it is not yet known why they formed here ([JPL 2024-07-18](https://www.jpl.nasa.gov/news/nasas-curiosity-rover-discovers-a-surprise-in-a-martian-rock/), [JPL 2024-11-18](https://www.jpl.nasa.gov/news/nasas-curiosity-mars-rover-takes-a-last-look-at-mysterious-sulfur/), both read in full). The premise is that a human goes there to survey more widely.
- **Map extent**: 2,048 m × 2,048 m centered on 137.4075° E, 4.7868° S.
- **Reference path**: Curiosity drove 593 m and climbed 45 m from the base position to the survey site (sol 4098 → 4200).
- **Why this site**: it does not overlap the boxwork example in the challenge text, and being on the same Mount Sharp it lets us use terrain, optical, radiation and rover photos.

The evidence for coordinates and figures is in [docs/DATA.md](docs/DATA.md) and [docs/RESOURCES.md](docs/RESOURCES.md) sections 4 and 7.

### Demo flow (the one minute shown to the judges)

> **Check against the submission rules.** The official guide says the submitted demo is **a video of 30 seconds or less, or a deck of 7 slides or fewer**; anything longer is not eligible for Global Judging. No image, video or voice of anyone under 18 may appear. The flow below has to be cut to fit 30 seconds. All the rules are at the top of [docs/SUBMISSION.md](docs/SUBMISSION.md).

1. Raise the left palm and the Gediz Vallis 3D map appears. Switch layers.
2. Say "Take me to the survey site" and arrows are laid on the floor.
3. **(Kick)** While walking, meet a chair (playing a rock) and the route is recalculated.
4. Warm the temperature sensor by hand: the screen flashes red and the route changes to the return-to-base route.

The demo space (a room) stands in for a scaled-down part of the Martian surface. We state this first in the presentation.

---

## 2. What the challenge asks for

All quotations below are taken verbatim from [docs/CHALLENGE.md](docs/CHALLENGE.md).

| # | Challenge text | In our entry |
|---|---|---|
| Q1 | "create a layered, integrated view of a location or route on the Martian surface that pulls together data from multiple NASA science missions" | **Core task.** Layer 1, orbital map |
| Q2 | "create a map, tool, or interface a Mars astronaut could use during a surface exploration mission, using NASA data and tools" | **Core task.** The whole HUD |
| Q3 | "You might start by identifying some scientific goals for your mission and the location the astronaut will explore" | Mission scenario |
| Q4 | "You may consider including at least three kinds of data—optical, thermal, spectral, topographic, geophysical, atmospheric, radiation, and chemical are a few examples" | Three or more layer kinds |
| Q5 | "they are built for regional and global views rather than the hyperlocalized areas astronauts will target" | Layer 2, field map (our differentiator) |
| Q6 | "NASA’s first priority is always astronaut safety" | Layer 3, survival info, emergency mode |
| Q7 | "include a route map that shows where the astronaut will travel to accomplish their scientific objectives while avoiding significant obstacles such as large rock formations" | Route guidance |
| Q8 | "as a heads-up-display (HUD) projected on the spacesuit’s helmet visor" | HUD format (allowed by the text) |
| Q9 | "Consider how you might include these point-of-view images as part of your map" | Rover point-of-view photos (if time allows) |
| Q10 | "Astronauts will conduct Mars surface science wearing spacesuits and possibly carrying scientific equipment and other supplies. Consider how this might impact their mobility" | Palm and voice control (our interpretation) |

**Our approach**

- The core of the text is Q1 and Q2: **a map that layers data from several NASA missions**. This is the foundation of the entry, and a dedicated role (C) builds it first.
- Real-time environment analysis ties to Q5 and Q7. It is **a layer that puts nearby obstacles on top of the NASA data map**, and the kick that shows the map reacting to real space in the demo.

---

## 3. Features and priorities

The hackathon is 48 hours. We grade features and finish from the top.

- **P0**: cannot submit without it
- **P1**: makes the entry stand out
- **P2**: only if time remains

| Feature | Basis | Grade | Owner |
|---|---|---|---|
| NASA data layers (three or more kinds) | Q1, Q2, Q4 | P0 | C |
| Palm 3D map, layer switching | Q1, Q8 | P0 | D, F |
| Route guidance (obstacle-avoiding route, floor arrows) | Q7 | P0 | D |
| Curiosity's actual traverse shown (route validation) | Q1, Q7 | P0 | C, D |
| Status panel (radiation, ambient temperature, vitals) | Q6 | P0 | F, E |
| Emergency mode (red flashing screen) | Q6 | P0 | F, E |
| Real-time environment analysis (field obstacle layer, the demo kick) | Q5, Q7 | P1 | A |
| Voice commands (STT) and voice guidance (TTS) | Q10 | P1 | E |
| Rover point-of-view photos (real Curiosity photos) | Q9 | P1 | F, C |
| Night vision | No basis in the text | P2 | A, F |
| Video recording mode | No basis in the text | P2 | F |

Why night vision and recording are P2: users report that the Quest browser denies the feature that lets a WebXR session access passthrough camera frames (`camera-access`) ([Meta community forum](https://communityforums.atmeta.com/discussions/Questions_Discussions/request-webxr-raw-camera-access-camera-access-feature-in-quest-browser/1367463), confirmed by search summary, needs checking on the device). Filtering or recording the video directly may not be possible.

---

## 4. System architecture

```
[NASA data] --preprocessed on a PC--> layer files (height grid, images, JSON) --+
                                                                                v
[Arduino temperature sensor] --USB serial--> [Jetson Orin Nano Super] <--WebSocket--> [Quest 3 browser (WebXR app)]
                                              - sensor reading, hazard decision        - layered map, route, HUD
                                              - speech recognition -> intent -> speech  - field obstacle scan
                                              - web app serving (HTTPS)                 - microphone in, audio out
```

- **Web app**: Three.js + WebXR, built with Vite. Modules talk only through a shared event bus. Formats are in [docs/INTERFACES.md](docs/INTERFACES.md).
- **NASA data**: preprocessed on a PC during the hackathon and shipped as static files. The headset does not download source data in real time.
- **Mock mode**: every module must run alone on fake data. You can develop in a PC browser without the headset or the Jetson.

### Repository layout

```
web/                 web app (Vite + Three.js)
  src/core/          B  XR session, event bus, Jetson link, what the modules share (palm, hologram, markers, params)
  src/scan/          A  field obstacle scan
  src/map/           D  palm map, layer display
  src/nav/           D  path finding on the Mars map
  src/field/         B  field map on the palm, guidance on the real floor
  src/hud/           F  status tiles, emergency mode, hand menus, marks, vitals
  src/mock/          B  mock data (everyone adds their own)
  public/data/       C  processed layer files
data-pipeline/       C  NASA data processing scripts (Python)
jetson/              E  hub server, voice, sensor reading
arduino/             E  temperature sensor firmware
docs/                documents
```

---

## 5. Roles at a glance

Details are in [docs/ROLES.md](docs/ROLES.md), which also lists the owners.

| Slot | Owner | Role | One-line description |
|---|---|---|---|
| A | 이효제 | Real-time environment analysis | Builds a map of nearby obstacles from the headset depth sensor |
| B | 차유근 | XR core · integration lead | Builds the skeleton and merges everyone's code into one |
| C | 김건민 | NASA data layers · mission scenario | Gets NASA data and processes it into map layers |
| D | 안현상 | Map · route guidance | Shows the palm map, computes the route and lays the arrows |
| E | 김도훈 | Jetson hub · voice · sensor | Runs the voice assistant and the temperature sensor on the Jetson |
| F | 길윤석 | HUD UI · demo | Builds the status panel and the emergency screen, shoots the demo video |

---

## 6. 48-hour schedule

The hackathon is on November 14–15 ([spaceappschallenge.org/2026](https://www.spaceappschallenge.org/2026/), confirmed by search summary).

| Time | To do | Done when |
|---|---|---|
| 0–3 h | Start the terrain file (3.6 GB) download, fix the interfaces, put up the skeleton | An empty AR screen shows on the headset |
| 3–24 h | Each module developed (mock mode) | Each module runs alone on fake data |
| ~12 h | **C hands over one terrain layer first** | Real Martian terrain shows on D's map |
| 24–36 h | Integration | Demo flow steps 1–4 run end to end on the headset |
| 36–44 h | Rehearsal, demo video shoot | A video file exists |
| 44–48 h | Submission | Submitted |

If any P0 item is not done at the 24-hour mark, P1 and P2 work stops and helps P0.

---

## 7. Risks and mitigations

| Risk | Mitigation | Owner |
|---|---|---|
| If NASA data processing is late the map is empty | Optical tiles can be fetched right away, so hand those over first. Terrain within 12 hours | C |
| The terrain file and the traverse record may use different elevation references | **Resolved.** They agree: mean difference −0.17 m at 178 rover stops. No correction is used | C |
| Terrain elevation values exist only in the 3.6 GB file | **Resolved.** The server accepts partial requests; only the map window is read | C |
| Radiation data is close to raw and may take long to interpret | **Resolved.** Dose rates for sol 4200 are extracted from the RAD file (154 µGy/day on average) | C |
| Atmospheric (REMS) data could not be verified | **Resolved.** Pressure and air temperature for sol 4200 are in `env.json` | C, F |
| WebXR only works on HTTPS (or localhost) ([MDN](https://developer.mozilla.org/docs/Web/API/Navigator/xr)) | Confirm the headset can connect within the first 3 hours | B |
| Depth and mesh data may not come out as expected | Check on the device within the first 3 hours. If not, A falls back to plane detection | A |
| Hand tracking and microphone input in the browser are unverified | Check on the device within the first 3 hours | D, E |
| Submission requirements (video, description, deadline) are unknown | **Resolved.** Read from the official guide and summarized at the top of [docs/SUBMISSION.md](docs/SUBMISSION.md). Demo: 30 s video or 7 slides; deadline Nov 15, 11:59 p.m. local | C |
| Integration piles up at the end | Interface changes only after B approves | B |

---

## 8. NASA data

The Resources tab was published and we checked it directly. Detailed analysis and addresses are in [docs/RESOURCES.md](docs/RESOURCES.md).

| Rank | Layer | Kind (Q4) | Mission · instrument | Source |
|---|---|---|---|---|
| 1 | Terrain elevation | topographic | MRO HiRISE·CTX, Mars Express HRSC, MGS MOLA | [USGS Gale 1m DEM](https://astrogeology.usgs.gov/search/map/mars_msl_gale_merged_dem_1m) |
| 2 | Slope | (derived) | Same as above | Computed from terrain |
| 3 | Optical image | optical | MRO · HiRISE | [Mars Trek](https://trek.nasa.gov/mars/) |
| 4 | Thermal image (night) | thermal | Mars Odyssey · THEMIS | [Mars Trek](https://trek.nasa.gov/mars/) |
| 5 | Rover traverse record | (ground truth) | MSL Curiosity | [NASA traverse record](https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json) |
| 6 | Rover point-of-view photos | optical (ground) | MSL Curiosity | NASA raw images |
| 7 | Radiation | radiation | MSL Curiosity · RAD | [PDS](https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/) |
| 8 | Air pressure and temperature | atmospheric | MSL Curiosity · REMS | [PDS](https://atmos.nmsu.edu/PDS/data/mslrem_1001/) |
| 9 | Geologic unit | geologic | USGS SIM 3292 | [Mars Trek](https://trek.nasa.gov/mars/) |

- All of these are processed and in `web/public/data/`. What each file is, how it was made and how far it can be trusted is in [docs/DATA.md](docs/DATA.md).
- Four different NASA missions are involved (MRO, Mars Odyssey, MGS, MSL Curiosity).

**How the five resources are used**

| Resource | Use |
|---|---|
| Mars Trek | Main source of optical and thermal tiles |
| USGS-NASA Planetary Geologic Mapping Program | Shows the geologic unit of the site |
| Curiosity route map example | Design reference for the route map |
| NASA Worldview | Reference for the layer switching screen (an Earth observation tool, not a source of Mars data) |
| Mars Perseverance Raw Images Gallery | We use Curiosity photos served the same way (Perseverance is in a different crater) |

**Limits to keep in mind**

- Mars Trek terrain tiles are pictures, so no elevation values can be read from them. Elevation comes only from the USGS file.
- The thermal image is about 81 m per pixel, so 25 pixels across our map extent, and its brightness is relative brightness, not temperature.
- The optical image is 8-bit grayscale. If we colorize it, we state in the presentation that the source is grayscale.
- The terrain file and the traverse record share an elevation reference (mean difference −0.17 m at 178 rover stops), and terrain and optical overlap to within 4 m. How this was checked is in [docs/DATA.md](docs/DATA.md) section 6.
- The radiation and weather values are a recording of one Martian day (sol 4200), not a live feed.
- The global geologic map shows our whole site as a single unit (`Htu`).

### Missing data: comparison with the five resource sites

A teammate compared this README with the five resource sites and listed data we were not using (2026-11-14, branch `main`). C went through the list the same day. The "Status" column is what C found; items marked "checked" were checked against the live Mars Trek layer index (225 products, 39 covering our site) or against the files in `web/public/data/`.

| ID | Missing item | Source | Status (C, 2026-11-14) |
|---|---|---|---|
| M1 | Spectral and mineral data (CRISM, OMEGA) | Mars Trek, Curiosity route page | **Checked: nothing usable at our scale.** Trek's CRISM raster indicators cover other regions, not Gale. What covers our site is global: a map of hydrous mineral detections (OMEGA, CRISM) and TES mineral abundance maps at kilometers per pixel, less than one pixel across our 2 km map. `spectral` stays empty, and we say so |
| M2 | THEMIS daytime thermal image | Mars Trek | **Checked: available** (`THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018`), not added. Same 81 m per pixel as the night image we use |
| M3 | MOLA·HRSC global DEM (about 200 m) | Mars Trek, USGS | **Not needed.** It was the fallback if the 3.6 GB file failed; the 1 m terrain is read directly |
| M4 | CTX optical mosaic (about 5–6 m) | Mars Trek | **Checked: covers our site** (`curiosity_ctx_mosaic`, `Gale_CTX_BlockAdj_dd`), not needed. HiRISE at 0.64 m covers the whole map |
| M5 | Place names, landing sites, exploration zones, thematic layers | Mars Trek | Global overlays exist (dune fields, exploration zones and others). Not checked for our site |
| M6 | Curiosity planned route and science regions | Curiosity route page | A single GIF, not data. We use the rover's actual path instead (`traverse.json`) |
| M7 | Trek subsetting, elevation profile | Mars Trek | **Not needed.** The terrain file accepts partial requests, so only the map window is read |
| M8 | Trek rock detection | Mars Trek | Not checked. It is a tool, not a layer in the index |
| M9 | Trek sun angle | Mars Trek | Not checked |
| M10 | Trek WMTS tile addresses and structure | Mars Trek | **Done.** [docs/RESOURCES.md](docs/RESOURCES.md) section 2 |
| M11 | Source, metadata and position link of Curiosity photos | NASA raw images API | **Done.** `pov.json`: photos matched to map positions by site and drive number ([docs/DATA.md](docs/DATA.md) section 4) |
| M12 | Worldview screen features (compare, measure, time slider) | Worldview | UI ideas, not data. For F |

**What the five sites do not have**

- Atmospheric (REMS) and radiation (RAD) data: **done**, both from the Planetary Data System, in `env.json`.
- Chemical and geophysical data: still empty.
- A finer geologic map of Mount Sharp or Gale Crater: not found.
- Coordinates of Curiosity's planned route: not found.

The teammate's list also pointed to a `docs/MISSING_DATA.md` with evidence per item. That file was not in the branch, so it is not linked here.

---

## 9. Collaboration rules

1. **Edit only your own folder.** If someone else's folder needs a change, ask its owner.
2. **Modules talk only through events.** Do not call another module's functions directly.
3. **Tell B before changing an interface.** Edit [docs/INTERFACES.md](docs/INTERFACES.md) first, then the code.
4. **Branches**: `feat/<slot>-<topic>` (for example `feat/d-palm-map`). B merges into `main`.
5. **Push small and often.** At least once every 3 hours.
6. **Give the AI only what it needs.** `docs/INTERFACES.md` and your own folder are enough and cost fewer tokens.

---

## 10. Verification level of this document

- Challenge requirements: quoted from the text the team lead provided ([docs/CHALLENGE.md](docs/CHALLENGE.md)).
- Addresses, formats, resolutions and coordinates of NASA data: checked by connecting directly (2026-11-13). The level per item is marked in [docs/RESOURCES.md](docs/RESOURCES.md).
- Submission requirements: read from the official Project Submission Guide (2026-11-14).
- Radiation (RAD), atmospheric (REMS) data, terrain alignment and the sulfur discovery at Gediz Vallis: checked against the source files and the JPL articles (2026-11-14). Details in [docs/DATA.md](docs/DATA.md) and [docs/RESOURCES.md](docs/RESOURCES.md) section 7.
- Hackathon schedule and Quest browser capabilities: confirmed only from search result summaries.
- **Not checked on the headset:** the data files were loaded by the web app in a desktop browser only.
- Priorities, role split, schedule and expected token use: proposals, not facts. The team can change them.

---

## 11. How to run

Node.js 20.19 or later is required (22.12 or later on the 22 line). The web app is in `web/`.

```bash
cd web
npm install
npm run dev        # https://localhost:5173/ (self-signed certificate)
```

**Mock mode on a PC** — every event flows without the headset, the Jetson or real data.

- Open `https://localhost:5173/?mock=1`. Get past the certificate warning with "Advanced → Proceed".
- The top-left panel shows the events on the bus and their counts. Keyboard: `N` navigate, `H` base, `S` stop, `L` thermal / optical map, `T` temperature spike.
- HUD text is English by default (as in the mockup); add `?lang=ko` for Korean. HUD size, position and flash period are tuned with the numbers in `web/src/hud/config.js`.
- Parts can be mocked separately: `?mock=link,hazard` (parts: `data`, `link`, `hazard`). `?mockSpeed=10` runs the timeline ten times faster.
- `?mock=1&mode=field` opens the PC view in field mode, where the fake obstacle is outlined in red on the floor and stands on the field map.

**From the headset** — put the PC and the headset on the same Wi-Fi.

1. Enter the `Network: https://<PC address>:5173/` address printed by `npm run dev` in the headset browser.
2. Get past the certificate warning and press **Mars map** or **Field map** (the two start buttons, see below). Without a Jetson, append `?mock=link` to the address (`?mock=1` also swaps the room scan for a fake chair).
3. Give the Jetson address with `?jetson=<address>:8443`. The default is port 8443 on the same host as the page. If the Jetson also uses a self-signed certificate, open `https://<Jetson address>:8443/` once in the headset browser and accept the warning, or the WebSocket will not connect.

**Two ways in** — the start page has two buttons.

- **Mars map**: the NASA terrain on the left palm, layers, the route between base and survey site. The relief is to scale, heights included, on a mesh with a vertex every 8 m (257 per side; it was every 16 m), and it is lit with the terrain's own normals, so the ground looks as steep as the slope layer says it is: the mesh's faces are 1.5° off the slope layer on average (they were 2.4°) and the light 1.2° (`web/src/map/terrain.test.js`). The slope values themselves were left as they are: measured against the tilt the rover recorded at its 178 stops they are off by 1.9° on average, and no way of computing them from the 1 m terrain that we tried is more accurate by more than 0.1°, which is within the scatter of 178 stops; finer baselines are worse ([docs/DATA.md](docs/DATA.md) sections 4 and 6). **The finer mesh is not checked on the headset** (131,072 triangles where there were 32,768); `?mapMesh=129` gives the earlier mesh back, lit as it was. On a PC the **Mars route planner** panel (top right) picks start and destination; its destinations are the base, the survey site (390 m by route) and a **nearby point about 20 m from the base**, which is the one selected at first (22 m by route on the real terrain; `?near=<metres>` moves it, `?near=0` removes it). Walking moves your marker on the map (one real metre counts as 100 m by default, `?walkScale=`). **The route is also laid on the real floor**, with the same arrows and destination marker as on the field map. It is planned from the Mars data alone (slope and terrain): the furniture of the room plays no part in it. One real metre stands for up to 100 m on Mars, and the scale is set for each route so that it is about 3 m of real walking: the 22 m route to the nearby point and the 390 m route to the survey site are both a few steps across the room (`?walkScale=` fixes the scale instead).
- **Field map**: the premise is that you stand at the base on Mars. The palm map is the Mars map zoomed to the ground around you: 24 m across, 1 : 80, on a hologram 30 cm wide (it was 20 m on 25 cm).
  - **It follows the hand; a fist shows more ground.** The map goes where your left palm goes, with you in its middle. Close the hand into a fist while the map is up and it unfolds: it leaves its circle and reaches as far as the scan knows ground (the 25.6 m around you and every tile beyond that was mapped earlier), still over your hand. The point is range, not size: the ground is drawn only a little larger (30 %) and never smaller, so the map gets wider, up to 1.1 m across (68 m of ground); known ground that does not fit on that is left off, and the part around you is kept. While it is unfolded it is a plain map: the cone of light from the palm and the caption card under it are gone. Open the hand and it folds back, with both. The Mars map does the same: in the headset the circle shows the 1 km around you, and over a fist the whole 2 km map at that scale, 30 % larger, centred on itself; the markers keep their size on both. On a PC: `__field.unfold(true)`, `__map.zoom(2)` then `__map.unfold(true)`. (Two earlier ways of choosing what the map shows, by the angle to the line of sight and by sliding it with the palm, were both taken out again: neither felt right in the hand.) **Not checked on the headset.**
  - The scan starts from the room geometry the Quest 3 keeps (run Space Setup once; without it the app says "No room scan").
  - This mode also asks the headset for live depth and lays it on top, so the map follows the room: a chair put down after the room scan shows up in about half a second when it stands about 1 to 3.8 m from you (it was a second, and 2.3 m). The depth image is read five times a second (it was three), with 288 × 288 points taken from it (it was 192 × 192: the far floor needs them, or a chair marked 3.8 m away could never be cleared again; the loops that place the points were tightened so that a read costs the processor what it did before, 3.5 ms on the Jetson's CPU), and the map goes out up to four times a second. **Where the headset has no room scan this is the whole map** (every session on our headset so far: the map files in `jetson/maps/` say `meshes: 0, planes: 0`), so this range and rate are how far and how fast the map grows as you look around. If frames drop, `?depthMs=350` reads less often, `?depthRange=2.5` not as far and `?depthSamples=192` fewer points (the three values of before); to try farther, `?depthRange=5&depthSamples=320`. The heartbeat in the hub's `logs/headset.log` now carries the frame rate, the longest frame of the last 5 s and the scan's counts, so what a setting costs can be read there. What live depth has marked **stays on the map** when you walk away or look elsewhere; an obstacle is taken off only when the sensor sees clear floor where it stood. Whatever was in the room scan stays. **The new range and rate are not checked on the headset** (that live depth runs there is: 1,300 reads in a session of 7.7 minutes on 2026-11-15). If the field map misbehaves, add `?depth=0` to the address: the room scan then works alone.
  - **Settled areas cost little, but are still watched.** A cell read six times with the same answer is settled, so the reads go to what is new. Settled ground in view is looked at again every second, on a clock of its own (it was every 1.5 s, and only once nothing else in view was still open); two reads that agree settle it again. This is what makes a chair put down on known floor show within a second and a half and one taken away clear within two (`web/src/scan/grid.test.js`, with a sensor that has no noise and with one where a cell never settles). **It matters on the headset:** a real depth image always leaves a few cells open, so with the earlier rule the moment to look again hardly came (the hub's records: one refresh in a hundred reads, no read ever skipped) and a chair on known floor could wait a minute. The new rule is not checked on the headset (A called it the chair problem: before, known ground was only read again after you had been 4 m away). `?settle=0` turns settling off.
  - **The map has no edge and is kept on the Jetson.** The floor is divided into tiles of 6.4 m. The app works on a window of 4 × 4 tiles (25.6 m) that moves with you; tiles that leave it are kept aside and come back when you return, so the map grows as far as you walk (it used to end 8 m from where the session started). Every change goes to the hub tile by tile, which writes one file per run to `jetson/maps/` (the newest 200 kept). A new session gets the last stored map back and uses it for what it has not seen yet, but only once its own scan has found enough of the same obstacles in the same places, because the headset may have moved its origin (`?remember=0` turns the handing back off). **So that it does line up:** the headset puts its origin where a session starts, so the app keeps the room's coordinates itself. In the first session it makes an anchor at the origin and asks the headset to keep it (a WebXR persistent anchor); in later sessions it asks the anchor back and shifts its coordinates so that the anchor lies where it was, by a turn about the upright axis and a shift along the floor (`web/src/core/room-frame.js`). The stored map and the stored waypoints then fit, and the test above still guards against a wrong fit. **Not checked on the headset**: the hub's `logs/headset.log` says `roomAnchor: restored`, `created` or why not six seconds into a session; `?anchor=0` turns it off, `?anchor=new` starts over with a new anchor. Live depth still only sees about 4 m around you: ground farther away is mapped when you get near it.
  - **Where you have walked is clear floor.** The cells under you are freed at once, and the room scan cannot block them again: a doorway that was shut when the room was scanned stays open once you have walked through it. Something put there later is still found by live depth.
  - **Arriving.** When you reach the target (or, on the Mars map, the destination), a short chime of four rising notes plays with the "Arrived" message (`?sound=0` silences it with the alarms).
- **Guidance on the floor.** Chevrons every 42 cm over a faint band, with a light that runs along them toward the destination; they fade in just ahead of your feet and fade out a few metres on. The destination has rings spreading on the floor, a column of light that thins out upward, a diamond turning at chest height and a label with its name and distance.
  - **Known floor before unseen floor.** A step over floor the headset has not seen counts three times its length, the same factor the Mars route planner uses, so the route stays on scanned floor unless the way over unseen floor is less than a third as long. The shortcut that straightens the route obeys this too: it used to cut across unseen floor even where a scanned way existed.
  - **Drops.** Ground that lies more than 0.3 m below the floor you stand on (a stair going down, a kerb, a pit) is marked like an obstacle: red on the floor, structure on the map, closed to the route. It is marked from the edge of the floor on, including the strip the edge hides from the sensor. There is one floor level: other storeys are not mapped. Only live depth does this, so within about 3.8 m of you and where you look down at it. **Not checked on the headset**; a mirror-like floor may read as deeper than it is, and `?drops=0` turns it off.
  - **Narrow gaps.** A gap a person can get through sideways, about 30 cm, counts as walkable; a 10 cm gap does not. The route still keeps 30 cm from obstacles where there is room, and takes a squeeze only when the wide way is about 3 m longer.
  - `?mock=1` and `?mock=hazard` put a fake chair in place of the scan, so the real room is not outlined and live depth does nothing: on the headset without a Jetson use `?mock=link`.

**Everything a hand brings up comes up the same way.** The maps over the left palm, the layer menu beside the map, the command card over the back of the hand, the card over a picked place and the vitals over the right palm all appear the same way: out of nothing, a little too large (about 6 %), and back to their size within a third of a second, the height following just behind the width. So a hand that has just come into view does not have things switched on over it; they spring up (`web/src/core/hologram.js`: `popIn`). Going away is at once for the left hand's maps and menus. The vitals over the right palm go with an animation of their own: when the hand closes into a fist, is turned over, or is lost from view, they swell a little and collapse where they stood, in a fifth of a second. (Rings of light around the right wrist, which the vitals folded into when the hand closed, were tried and taken out again.)

**Menus: point and pinch.** The left hand brings a menu up, the right hand operates it from where it is, as with the Quest 3's own hand pointer. Nothing is touched, so the hands never cover each other from the headset's cameras.

- Open left palm turned up: the map, with the layer tabs beside it (Mars map). **A menu or hologram shows only over an open hand** (at least three fingers stretched out): a hand that points, pinches or makes a fist brings nothing up, however it is turned.
- Back of the open left hand up, as when looking at a watch: the command card above the hand (Status, Navigate, Base on the Mars map, Mark waypoint, Stop, Confirm) with the red **SOS** bar under them. On the Mars map "Navigate" goes to the nearby point about 20 m from the base; say "Take me to the survey site" for the 390 m route.
- Point the right hand at a menu: a thin beam and a ring cursor show where you aim, and the button under the cursor lights up. Pinch thumb and index finger to press it. The ring closes as the fingers do.
- A menu stays where it appeared instead of riding on the left hand; it follows only when the hand has moved about 5 cm away, and it does not move while you point at it.
- Controllers work the same way (point, pull the trigger). If the beam does not seem to come from where you point, add `?ray=own` to the address.
- A menu closes at once when the hand turns to the other gesture (map ↔ commands), and 0.12 s after the hand turns away; it only lingers (0.9 s) when the hand is lost from view.
- **Pick a place on the map.** Point the right hand at the map over the left palm: the cursor follows the terrain. For the map the pointer's ray is tipped 30° downward, so it comes down on the flat map steeply and the cursor is easier to steer; the layer tabs beside the map and the card over a picked place are met by the same tipped ray, so the cursor goes from the map onto them and back without a jump. Pinch, and a pin marks the place and a small card over it offers **Navigate**, **Waypoint** and **Cancel**; saying the word does the same as pressing the button. The pick moves to the nearest ground that can be walked (20° or less) and is connected to the base, and the card says how far it moved. On a PC, click the map. On the field map the same gesture picks a place in the room, and "Navigate" makes it the target.
- **Targets and waypoints.** The **target** is where the route leads: an orange diamond, the tallest and largest marker on the map, and in the room a column of light with a diamond above head height. A **waypoint** is a place you marked: blue, a ball on a short stem with its name, on the map and in the room. Both maps draw them, and you, with the same shapes (`web/src/core/markers.js`).
  - **Setting a waypoint:** pick a place and press **Waypoint**, or press **Mark waypoint** on the command card (or say it) to mark where you stand. (That button used to be "Mark target": a target at the place you already are made no sense.) The waypoint is there at once as "Waypoint 1", and for 15 s the card offers **Record** and **Confirm**. A new waypoint takes the lowest number that no waypoint holds: after "Waypoint 3" is deleted the next one is "Waypoint 3" again, not "Waypoint 4" (a waypoint keeps its number when it is given a name). After "Record", what you say until you pause becomes its name (the hub writes it down; it needs the Jetson). "Confirm" keeps the name it has.
  - **Picking one again:** point at a waypoint or at the target on the map and pinch. A waypoint's card offers **Navigate** (it becomes the target), **Record** (say a new name), **Delete** and **Cancel**; the target's card offers Navigate, **Delete** and Cancel.
  - **The route takes waypoints along.** The route to the target goes through every waypoint that lies nearly on the way: one that makes the route at most 10 % longer, several if all of them together stay within that, each at the place in the order where it costs least. A waypoint you have already been at is not led back to, and the route says which ones it passes. On the field map the measure is the route's length (10 %, or 0.5 m if that is more). On the Mars map it is the planner's own cost, metres weighted by slope and unknown ground (10 %, or 8 weighted metres), and it needs no extra search: the planner keeps the cost to every waypoint from every cell, so a leg is one lookup. A waypoint marked a moment ago is taken along a few seconds later, when its costs have been worked out (the route is then planned again by itself).
  - **Kept on the Jetson.** Every change of the list goes to the hub, which keeps it in `jetson/maps/waypoints.json` and hands it back when the app connects. A waypoint of the Mars map is a cell of the data and is there again at once. One of the field map is a place in room coordinates, and it is shown again once the scan has found itself in the stored map (the same test the stored map has to pass), with a note "2 waypoints from last time"; until then it is kept aside, not deleted.
- **Emergency.** Press the red SOS bar: it is armed for 8 s ("SEND SOS"). Or close the left hand into a fist while the command card is up (held a quarter of a second): the card springs up anew as the SOS button alone, as large as the card, armed for as long as the fist is held. Opening the hand disarms it and brings the commands back. Press it again, or say "Confirm", and the rescue signal goes out; "Cancel" disarms it. By voice alone: "SOS", "Rescue" or "Help" (also "Emergency", "Mayday") arms it, and one "Confirm" sends it. The hub then raises an alert on every other headset connected to it ("Rescue signal from a crew member"), shows a red banner on the monitor page and says so aloud. The crew is virtual: five seconds later the hub acknowledges in the crew's name and the bar says "Base crew (simulated) notified". "CANCEL SOS", or saying "Cancel rescue", withdraws the signal.

**The right hand: vitals.** The right hand points, and it shows one thing of its own.

- Open right palm turned up: a figure of the wearer turns slowly over the palm. **The hand spins it:** move the right hand to the right and the figure turns faster to the right; move it to the left and it slows, stops and turns the other way, as a globe does under a stroking hand. A longer or quicker move spins it more (a 15 cm flick: about half a turn a second more; never faster than 1.6 turns a second). When the hand rests, the figure comes back to its usual turn by itself, quickly at first and then ever more slowly (4.5 s after the hand stops about a twentieth of what the move added is left; after a 15 cm flick it is back within 5 % of its usual turn after about 7.5 s). Only a move of the hand itself counts: it is measured against the head, so walking, a step aside or turning the head does not spin the figure, and neither does the trembling of hand tracking (turning the whole body with the hand held out does: the hand sweeps through the room then; so does moving the head sideways past a hand held still). Bringing the hand back pushes the figure the other way just as much, so a move out and back does not leave it spinning: it ends a little under its usual turn (about stopped, or slowly the other way for a moment) and comes back from there. To spin it, move the hand and let it rest there. A frame or two without the hand in the middle of a move does not throw the spin away (`web/src/hud/spin.js`, with its numbers in `HUD.suit.spin`). **Not checked on the headset.** On a PC: `__hud.suit.show(true)`, then `__hud.suit.flick(0.75)` or `flick(-0.75)`, and `__hud.suit.spin()` says how it turns. It floats as the map does over the left palm: a little above the palm, a little away from you and a little toward the middle of the body, with a cone of light from the palm.
- **The readings stand around it.** An imaginary cylinder stands around the figure, wide enough to clear its arms. Each reading is a chip of its own, text only with a soft dark edge around the letters and no card behind it (the label, where the number comes from, and the number large): three to your left of the cylinder and two to your right, standing out from its side like wings, with a thin line toward the part of the figure they belong to that fades out on its way.  As you move around your hand the chips go around the cylinder, so you always see them straight on and they never cover the figure.
- The readings: oxygen, heart rate, suit pressure, the body temperature of head, torso, arms and legs, and the ambient temperature. A part of the figure turns orange or red when a reading that belongs to it is out of range (head: oxygen, head temperature; torso: body temperature, heart rate; arms and legs: their temperature, suit pressure), and the chip's name and number take the same colour. The battery is not here any more (it is the headset's, not the body's, and has its tile beside the line of sight), and the figure carries no pack.
- **What is real and what is not.** The battery is the headset's own, and the temperature sensor on the Jetson is real, but it measures the **air around the wearer** (its chip says "Ambient"), not the body. Oxygen, heart rate, suit pressure and every body temperature are simulated and marked "sim". The simulated body warms by 0.12 °C for each degree the ambient temperature is above 30 °C, so heating the sensor shows on the figure as well. `?simO2=12`, `?simPressure=24`, `?simHeart=160`, `?simBody=38.5` set them from the address.
- The figure is a scanned human body: `artifacts/hud-male/hud_male_blue.glb`, prepared by role D from Blender Studio's Human Base Meshes ("Body Male - Realistic", CC0, 86,856 triangles). It is one mesh, so the app tells head, torso, arms and legs apart by where a point of it lies, and colours them separately. The file is built into the app (the hub serves it, 3.2 MB); until it has loaded, a stand-in built from smooth solids is shown.
- **Two hands at once.** Where the hands could get in each other's way the left one has the say: the vitals stay away while the right hand's pointer is on a menu or on the map, and while the two wrists are closer than 16 cm (the cameras then see one hand in front of the other).

**Watching the headset from the Jetson.** Open `http://localhost:8080/monitor` on the Jetson (or `https://10.42.0.1:8443/monitor` from another device on the hotspot). It shows, live, what the app is drawing from the wearer's head: HUD, map, menus, pointer, arrows and the obstacle glow, plus a 1 m floor grid and dots on the hand joints. It needs no Meta account and no developer mode: the app itself sends the pictures to the hub, ten a second, and only while the page is open (they are encoded and sent by a worker, so the headset's frames do not wait for them). The room is behind it: on a headset the page asks the browser for a camera when it loads and draws its picture as the background (`?mirror=nocam` leaves it out; a desk computer is not asked for its webcam). Our Quest 3 offers three: "camera 0, facing front", which is a virtual camera showing the wearer's avatar, and two "facing back", the passthrough cameras; a back one is taken (`?mirrorCam=camera 1` picks by name if the other one is wanted). **Lining the picture up.** The virtual things are drawn over the camera picture, so they sit right only if they are drawn with the camera's lens. The mirror used to draw with a wider one (80° against the camera's roughly 58°), which made the floor grid look like a plane tipped against the real floor. The browser does not tell a page what the camera's lens is, so 58° is our estimate, and the monitor page has buttons at the top right to correct it while you watch: **field of view** until the 1 m squares fit the floor near and far, **tilt** until the grid lies on the floor. The hub keeps the values (`jetson/logs/mirror_tune.json`). The grid's lines follow the room's own axes (where you faced when the session started), not the walls. The picture is 640 × 480. `?mirror=0` turns the mirror off.

**The readings: tiles that move.** There is no status card in a corner any more. Each reading is a tile of its own, with its number and a bar or a graph of its last minute, and the tiles stand in two columns left and right of what you look at (they end 26° out; the 23° in the middle stay clear).

- **Always there:** battery (the headset's own), oxygen (simulated) and ambient temperature (the Jetson's sensor: the air around the wearer), each a bar with its limits marked. They come first, so they keep the top places.
- **The rest by importance** (`web/src/hud/importance.js`): a reading has a base (route 70 while one is active, heart rate 35, body temperature 33, radiation 32, suit pressure 30, air temperature 12, air pressure 10), plus 50 when it is out of range and 100 when critical, plus up to 20 for heading toward its limit. Those at 31 or more are shown, at most three; so tiles come and go. A reading on show keeps its place unless another beats it clearly. Elevation, geologic unit and the layer name are no longer shown.
- **While the vitals are open** (the hologram over the right palm) they show oxygen, ambient temperature, heart rate, body temperature and suit pressure themselves, larger and with the figure. So those leave the tiles: nothing is shown twice, and the places they free go to whatever ranks next. Their tiles do not just fade: they fly to the hologram, shrinking, as it opens. A reading that is critical, or has come to the middle with an alarm, stays on the tiles whatever the hand does. When the hologram closes, the readings are candidates again and the usual ranking decides which come back (the always-shown ones, and of the rest the most important, at most three); those fly back out of where the hologram was and spring to their places.
- **Level columns:** the tiles fill right, left, right, left in order, so the columns are level or the right one has one more.
- **To the middle:** a reading in a critical state, and the ambient temperature as soon as its alert sounds (30 °C), leaves its column and comes to the middle, under the line of sight and above the alert card, 30 % larger. The others close up. When it is back in range it returns.
- **Size follows importance:** a tile is between 84 % and 116 % of the normal size, by its importance score (30 gives the smallest, 90 the largest; a reading out of range is at least 112 %). The inner edges of each column stay on one line and the rows are spaced by each tile's own height, so the columns stay tidy while the sizes change. Tiles have no frame or background: a reading out of range is told by its colour and a warning sign before its name.
- **How they move:** on a spring, there in about a quarter of a second with a 5 % overshoot, stretching by up to 6 % along the way; a new tile fades in where it belongs, a dropped one fades out where it stood.
- **Lower than centred:** what is laid out as centred looks a little high in the Quest 3, so the whole HUD hangs 1.5° lower (`HUD.viewDropDeg`). The confirmation of a command ("Navigate") appears just below the line of sight.

**Voice.** The headset ends the microphone whenever it is taken off or the system menu opens; the app now opens it again by itself (it used to stay dead until the page was reloaded, which is why speech often seemed not to be recognised at all). The hub keeps the last 100 utterances as WAV files in `jetson/logs/utterances/`, named by time and by what was understood, for tuning.

**Alerts.** Warn and critical alerts bring up the alert card at the bottom, beep, and light the whole view softly in orange or red with each beep (`?wash=0` turns the light off, `?sound=0` the beep). "Confirm" stops both. The ambient temperature alert steps back down as the temperature falls: critical above 35 °C, back to warn below 34 °C, cleared below 29 °C.

**Device check page** — open `https://<PC address>:5173/check.html` in the headset browser. Press **Start AR check**, look around the room for 10 seconds and raise both hands: a table shows the granted session features and whether hands, depth, mesh and planes were received. The microphone is checked separately with the **Microphone check** button.

**Build and test**

```bash
npm run build      # static files in web/dist/ (served by the Jetson)
npm test           # unit tests: scan grid, field planner, hand pointer, route planner
npm run smoke      # with the dev server running, checks the mock-mode event flow (needs Playwright)
npx --yes eslint@9 src scripts   # lint (web/eslint.config.js); ESLint is fetched on first use, it is not a dependency
```

The hub's tests: `.venv/bin/python -m unittest discover tests` in `jetson/`.

Module owners start from `index.js` in their own folder (`web/src/scan/`, `map/`, `nav/`, `hud/`). What `init(ctx)` and `update(frame)` receive is described in the comment at the top of each file.

---

## 12. Refactoring (2026-11-15)

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
- `hud/` calls a few functions of `map/` and `field/` directly (`pickOnMap`, `mapCellInRoom`, `fieldHere`, …), which rule 2 of section 9 does not allow. They are questions about geometry that need an answer in the same frame; an event cannot return one.

---

## 13. Writing the next code

What the code base already does, written down so that new code fits in. Read this section and the header comment of the file you are about to change; that is usually enough.

**Where things go**

1. **One module, one folder, one `index.js`** with `init(ctx)` and `update(frame)`. Its header comment says what it does, which events it **receives** and **sends**, and what was not checked on the headset. Keep that comment true when the code changes.
2. **Split by responsibility before a file passes about 500 lines.** A part with state of its own becomes a file with a `create…({ ctx, … })` function that keeps the state inside and returns the few functions others need (`createPointer`, `createSuit`, `createRescue`, `createDash`, `createMarks`, `createStatus`). No new module-level `let` in an `index.js` for something that could live in such a part.
3. **What two modules share goes to `core/`**: how a hologram comes up and floats (`hologram.js`), the palm (`palm.js`), the shapes on the maps (`markers.js`), the query string (`params.js`). In the HUD: `panel.js` for a canvas on a mesh, `sound.js` for sounds. Use these; do not copy them.

**How modules talk**

4. **Events on the bus, nothing else** (section 9, rule 2). Change [docs/INTERFACES.md](docs/INTERFACES.md) first, then the code. The exception that exists: a question about geometry that must be answered within the frame (`pickOnMap`, `fieldHere`). Never call another module to *change* its state.
5. **Handlers for one event run in the order the modules are listed in `main.js`** (`scan, map, nav, hud, field`). Code that depends on another module having handled the same event first waits a beat (`queueMicrotask`) and says so in a comment.
6. **On the hub, a new message type is a new method** `on_<type>(self, client, payload)` registered in `Hub.handlers`, plus a line in INTERFACES section 4. What belongs to one connection goes on `Client`. Writing a log line must never break the voice path: use `append_line`.

**Settings and numbers**

7. **Every number that can be tuned is in the module's config object** (`HUD`, `MAP`, `FIELD`, `SCAN`, `WALK`, `PALM`, …) with its unit in the name (`liftM`, `tiltDeg`, `holdMs`, `periodS`, `pxW`) and a comment on what it does. No bare numbers in the logic.
8. **The address's query string is read only through `core/params.js`.** A new `?switch=` is documented where it is read and in section 11. `!isOff('x')` for a switch that is on by default, `numberOr` when zero should give the default, `finiteOr` when zero is a value.

**The frame**

9. **`update(frame)` allocates nothing.** Vectors, quaternions and matrices are module-level scratch objects; a canvas is drawn again only when its `dirty` flag (or a tile's `sig`) says its content changed.
10. **A change the wearer sees should come up the way everything else does:** `popIn` / `popScale` for what a hand brings up, the spring in `layout.js` for tiles. A new look is a decision for the team, not a side effect.
11. **Colours and fonts come from `hud/tokens.js`**; the words on the status tiles and the alerts from `hud/strings.js`.

**Tests and checking**

12. **Logic that can be tested goes in a file without three.js or the DOM**, with its test beside it (`grid.js` / `grid.test.js`), run by `npm test`. A file that tests import must load under node: nothing at its top level may touch `window` or `document`.
13. **Keep the console hooks working** (`window.__hud`, `__field`, `__map`, `__scan`, `__marswalk`): they are how the app is tested without a headset. A new flow gets a hook.
14. **Before pushing:** `npm test`, the hub's tests, the lint line of section 11, and a look in a PC browser with `?mock=1&mockSpeed=0.01` (and `&mode=field`). To compare with the version before, build both with `npx vite build --outDir <somewhere else>`: **`npm run build` writes `web/dist`, which the running hub serves to the headset at once.**
15. **Refactoring and new behaviour are separate commits.** A refactoring commit changes no behaviour and says how that was checked.

**Writing**

16. **English everywhere:** comments, log messages, text on screen, commit messages. Korean only in the `ko` string table and in the data's `label` fields.
17. **Comments say why**, in plain sentences: what the wearer experiences, what was tried and taken out again, what is not checked on the headset. Not what the next line does.
18. **Say what is real and what is simulated** wherever a value is shown (the `sim` tag, "simulated" in the README): the principle of section 1 applies to code as well.
