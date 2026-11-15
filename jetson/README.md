# jetson/ — Jetson hub (role E)

Everything outside the headset: the temperature sensor on the suit (ambient temperature: the air around the wearer), alerts, voice assistant, web app serving.
The letters A to F are the team's six parts ([README, Team](../README.md#team)).
All formats follow [docs/INTERFACES.md](../docs/INTERFACES.md) sections 4–6. Headset connection: [QUEST_CONNECT.md](QUEST_CONNECT.md). Firmware: [../arduino/](../arduino/README.md).

## One-time setup

```bash
cd jetson
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
tools/get_models.sh                     # speech models into models/ (1.2 GB, not in git)
tools/make_cert.sh                      # certs/ (not in git)
tools/build_web.sh                      # web/dist, served by the hub (installs Node into .tools/ if needed)
sudo tools/setup_hotspot.sh '<password>'   # Jetson hotspot MARSWALK, 10.42.0.1
```

Without `uv`: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`.

## Run

```bash
.venv/bin/python -m marswalk.hub --dev --http-port 8080
```

| Option | Meaning |
|---|---|
| `--dev` | Accept `dev.text` and `dev.temp` from the fake client. Turn off for the demo |
| `--http-port 8080` | Also serve plain HTTP (for `adb reverse` / `localhost` only) |
| `--serial /dev/ttyACM0` | Arduino port. Default: auto-detect. `none`: mock temperature only |
| `--static ../web/dist` | B's build output. If missing, the connection test page is served |
| `--warn-c 30 --critical-c 35 --margin-c 1` | Temperature alert thresholds (tune with the real sensor). An alert steps down once the temperature is `margin` under its threshold |
| `--wake-word helmet` | Only obey speech that contains the word ("Helmet, status report"). For rooms where other people talk; off by default |
| `--stt auto --tts auto` | Speech backends. `auto` uses the models if present, otherwise `null` / `tone` |
| `--recordings-dir recordings` | Where the monitor page's recordings go (default `jetson/recordings/`, not in git) |
| `--record-max-min 30` | A recording ends by itself after this many minutes |
| `--no-convert` | Keep the recordings as `.mkv` only; make no `.mp4` after the stop |

The same command runs on a PC without a Jetson (no Arduino → `source: mock`; no models → no STT, beep TTS).

Open `https://<Jetson IP>:8443/` in a browser for the connection test page: secure context, WebSocket, temperature, alerts, microphone (hold to talk), TTS playback.

## Voice

Speech is **English**. Everything runs on the Jetson CPU through the `sherpa-onnx` wheel (no torch, no GPU).

```
headset mic --16 kHz PCM, continuous--> Silero VAD --utterance--> SenseVoice STT --text--> commands.json --> voice.command
                                         (muted while the hub speaks)                                    \-> Supertonic TTS --> headset
```

| Part | Model | Measured on this Jetson (4 threads) |
|---|---|---|
| Voice activity | Silero VAD | 0.09 s for 8 s of audio |
| STT | SenseVoice (int8) | ~0.15 s per command |
| Commands | `commands.json`, fuzzy phrase match | instant |
| TTS | Supertonic 3 (int8), 22.05 kHz output | ~1.0–1.3 s for a short sentence, ~2 s for the status report |

What makes it robust:

- **The headset only streams audio; the hub decides what is speech.** A neural detector copes with noise and the headset's automatic gain, where a loudness threshold in the browser did not.
- **The microphone is ignored while the hub is speaking**, so it never hears its own voice as a command.
- **Short commands** ("Status", "Base", "Thermal") and **fuzzy matching**: "thermo mat" still means "thermal map"; phrases under 5 letters must match exactly, so "shop" is not "stop".
- **The microphone permission is asked on the 2D page**, before the AR session starts, and the page shows `Voice: mic on · audio running` above the two start buttons (Mars map, Field map) when it is ready.
- **The headset reports its microphone state** (`voice.status`) and the hub logs it, with the input level every 10 s. Everything the recognizer hears, matched or not, goes to `logs/heard.log`.

### Adding or changing a command

Edit [`commands.json`](commands.json) and save. The hub reloads it by itself; a typo in the file keeps the previous commands working and logs an error.

```json
{ "intent": "camera.shot", "phrases": ["photo", "take a picture"], "reply": "Picture taken" }
```

- `intent` and `slots` are sent to the headset as `voice.command`; any module can listen for a new intent on the bus (`voice:command`).
- `reply` (optional) is spoken by the hub.
- `{layer}` in a phrase or slot stands for every entry of `vars.layer`, so one line covers all layers.
- `wake_word` (or `--wake-word helmet`) makes the hub obey only speech that contains the word.
- Try a sentence without a headset: `.venv/bin/python tools/voice_selftest.py --text "show me the thermal map"`.

Current commands (kept to what the demo needs; every extra phrase is one more thing ordinary talk can trigger): "Status", "Navigate" (to the nearby point about 20 m from the base; "Take me to the survey site" names the far one), "Base", "Mark waypoint" (then "Record" to say its name, or "Confirm"), "Delete" (the waypoint or target picked on the map), "Stop", "Confirm", "SOS" / "Rescue" / "Help" (arms the SOS; one "Confirm" then sends it, "Cancel rescue" withdraws it), "Thermal" / "Optical" / "Slope" / "Elevation", and the longer forms in [INTERFACES.md section 6](../docs/INTERFACES.md#6-voice-commands).

- The critical alert sentence is synthesized at startup, so it plays without the 1 s delay.
- `status.report` is answered by the hub itself: ambient temperature, alerts, route state.
- An `urgent` utterance drops normal ones still waiting; the browser cuts audio already playing.

### Headset menu and diagnostics

- The hub sends its command list (`voice.commands`) when a headset connects and whenever `commands.json` changes. The headset shows it as a card above the back of the left hand; pointing at an entry and pinching comes back as `voice.text` and runs like speech. `"say"` sets the label, `"menu": false` keeps a command out of the list, and `"mode": "mars"` or `"field"` shows it only on that map.
- The headset reports errors, AR session events (start, end, visibility, reference space reset) and its head position every 5 s as `client.log`. They are in `logs/headset.log`; errors also appear in the hub log.

## Testing without the headset

```bash
.venv/bin/python -m unittest discover tests        # alert thresholds, intents, spoken sentences
.venv/bin/python tools/voice_selftest.py --save samples   # sentence -> TTS -> STT -> intent, writes samples/*.wav

.venv/bin/python tools/fake_quest.py -q \
  --temp 31 --temp 36 --temp 25 \
  --text "take me to the survey site" \
  --say "Route recalculated" \
  --stream samples/00_status_report.wav --stream samples/02_nav_home.wav --for 8
```

Received TTS is saved as `tts_out_<n>.wav`. Use `--url wss://10.42.0.1:8443/ws` to reach the Jetson from another machine.

## One click start

After the Jetson was switched on, double-click **Start Project Marvis** on the desktop (or pick it in the app list). It brings up the hotspot if it is down, starts the hub (stopping one that runs), opens the monitor page, opens the app in the headset's browser when the headset is reachable over adb, and says in its window when the headset connects and when it is in AR. Run again at any time: it restarts the hub and leaves the rest alone.

```bash
tools/start_all.sh                     # the same from a terminal
tools/start_all.sh --status            # what is running; changes nothing
tools/start_all.sh --stop              # stop the hub
tools/start_all.sh --install-shortcut  # put the icon on the desktop and in the app list (once per machine)
```

The launcher also lies in the project folder (`Start Project Marvis.desktop`). GNOME Files opens such a file as text instead of running it, which is why the icon on the desktop exists. Nothing in it uses sudo. On the headset one press is still needed: **Field map** or **Mars map** (a browser may only start AR from the wearer's own press).

The hub started this way runs detached from the window and without `--dev` (`tools/start_all.sh --dev` adds it); its output is added to `logs/hub.log` and its pid is in `logs/hub.pid`. If the systemd service below is active, the hub is left to it. A missing `web/dist` or certificate is made, one that is there is never rebuilt. Whether the app is in AR is only known while a monitor page is open, because only then does the app send pictures. `tools/start_all.sh --help` lists the other options (`--no-browser`, `--no-wait`) and the environment variables for other ports, more hub options and another log folder.

## Start at boot

```bash
sudo cp marswalk-hub.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now marswalk-hub
journalctl -u marswalk-hub -f
```

### Monitor, stored maps, rescue signal

- **Monitor.** `http://localhost:8080/monitor` (or `https://<jetson>:8443/monitor`) shows what the headset app is drawing, live. The app sends JPEG pictures over `/mirror` only while the page is open. No Meta account or developer mode is involved.
- **Whole view or camera.** The picture shows the wearer's whole view (both eyes, about 118 x 101 degrees) with the camera picture in the middle at its true size; "Camera" on the page gives the old view, the room filling the picture and the edge of the wearer's view cut off. The line under the title shows what the stream is doing: JPEG quality, size of a picture, megabits, delay. The app raises the quality while the hotspot has room and lowers it when it has not; no more than two pictures are ever on their way, so the picture is never seconds old.
- **Recording.** "Record" on the monitor page writes the pictures with the wearer's microphone and the hub's speech to `recordings/marswalk-<date>-<time>.mkv` (`--recordings-dir`; not in git), and after "Stop" makes an `.mp4` (H.264 + AAC, 30 frames a second) beside it with GStreamer. A recording ends by itself after 30 minutes (`--record-max-min`) or when the disk has less than 1 GB left, and does not start with less than 2 GB; `--no-convert` keeps the `.mkv` only. While a recording runs, pictures are made even with no monitor page open, and it goes on when the headset drops out for a while. More under [Recording the demo video](#recording-the-demo-video).
- **Fullscreen.** The Fullscreen button or the F key shows the picture alone; F or Esc brings the page back. A rescue banner stays visible.
- **Field maps.** The headset sends the tiles of its obstacle map that changed (a tile is 6.4 m square); the hub keeps them in `maps/` (`--maps-dir`), one JSON file per run holding every tile of that run, the newest 200 runs. After a restart the newest run is still handed back to a headset that asks, and a run that carries on is merged into its own file. Files from before the tiles (one grid per file) are skipped.
- **Utterances.** The last 100 pieces of speech the hub cut out of the microphone stream are kept as WAV in `logs/utterances/`, named by time and by what the recogniser made of them (`--keep-audio 0` keeps none). This is audio of whoever spoke near the headset; it stays on the Jetson and `logs/` is not in git.
- **Rescue signal.** The headset's emergency button (the red bar on its command card, or "SOS" / "Rescue" / "Help" then "Confirm" by voice) arrives as `rescue.signal`. The hub logs it, raises the alert `crew-rescue` on every other headset, shows a banner on the monitor page, speaks, and after 5 s acknowledges in the name of a crew that does not exist ("Base crew (simulated)").

### Recording the demo video

1. Open the monitor page, wait for "Live", press **● Record**. Beside the button: the running time and the size of the file. "no pictures are coming" there means the headset is not in AR or not connected; the recording runs on, with the voices only until pictures come.
2. Press **■ Stop**. The page shows "making the MP4 …" (about half the recording's length on the Jetson, at low priority), then two links: the **MP4** to hand on, and the **master MKV**, the pictures exactly as the headset sent them (Motion JPEG, so it is large: a few hundred MB a minute at full size) with 48 kHz sound. VLC and mpv play the MKV.
3. "Last recordings" under the title lists the newest five with their links. The files stay in `recordings/` until deleted by hand.

What is in the file: every picture at the moment it arrived, the wearer's microphone (all of it, also what the hub does not listen to), and what the hub said, placed where the headset played it. While the hub speaks the microphone is turned down, because it hears the headset's own speaker.

If the hub is stopped while a recording runs (Ctrl-C, `kill`, the one click start starting it again), the file is finished first and stays as an MKV; no MP4 is made of it. A hub killed outright (`kill -9`, power loss) leaves an MKV without its length written, which still plays. Without GStreamer (`gst-launch-1.0`, `x264enc`, `voaacenc`) there is the MKV only, and without numpy the recording has no sound.

```bash
curl -X POST -d '{"on": true}' http://localhost:8080/monitor/record    # the same as the button; {"on": false} stops
curl -s http://localhost:8080/monitor.json                             # "recording": the one that runs or ran last, "recordings": the files
curl -O http://localhost:8080/recordings/marswalk-20261115-213045.mp4
```

## Layout

| File | Contents |
|---|---|
| `marswalk/hub.py` | HTTPS + WSS server, 1 Hz telemetry, message handling, voice flow |
| `marswalk/sensors.py` | Serial reader; falls back to `mock` after 5 s of silence |
| `marswalk/alerts.py` | Temperature alert state machine (the level follows the temperature up and down, 1 °C margin) |
| `commands.json` | The voice commands (edit this to add or change one) |
| `marswalk/intents.py` | Matches what was heard against `commands.json` |
| `marswalk/speech.py` | Sentences the hub speaks (numbers spelled out) |
| `marswalk/voice.py` | STT / TTS backends |
| `marswalk/maps.py` | The field map on disk (`maps/`) |
| `marswalk/mirror.py` | The headset's view for the monitor page (`/mirror`, `/monitor`) |
| `marswalk/record.py` | Recording of the monitor's pictures and the voices (`recordings/`) |
| `marswalk/static/monitor.html` | The monitor page |
| `marswalk/static/index.html` | Connection test page |
| `tools/fake_quest.py` | Fake Quest client |
| `tools/voice_selftest.py` | Voice round trip without a microphone |
| `tools/arduino.sh` | Build / flash the firmware from the Jetson |
| `tools/build_web.sh` | Build the web app into `web/dist` |
| `tools/start_all.sh` | One click start: hotspot, hub, monitor page, headset |

## Checked with the real web app

With `web/dist` built, the hub serves B's app and `link.js` connects to it (`http://localhost:8080/?jetson=ws://localhost:8080/ws&mock=data,hazard` on the Jetson itself): telemetry reaches the ambient temperature tile, a critical temperature puts the HUD in emergency mode, and spoken "Take me to the survey site" / "Show the thermal map" arrive as `nav:request` / `layer:toggle`.

The web app's voice link is `web/src/core/voice.js`: it streams the microphone continuously and plays the hub's speech (`urgent` cuts what is playing). `?voice=0` turns it off; `?mockMic=a.wav,b.wav` uses audio files as the microphone. Checked in a PC browser with `mockMic`: "Thermal" switched the map layer and "Navigate" made D's planner compute the route. Not yet confirmed with the headset's own microphone.

## Not verified yet

- **Real voices and a real microphone.** Accuracy was measured only with synthetic speech (18 of 18 test sentences through the streaming path, before the command list was shortened; not measured again since). After a session with the headset, read `logs/heard.log` and add what was misheard to `commands.json`.
- **Real sensor.** A sensor is wired and read by the hub (2026-11-14: warming it by hand raised the alerts). Alert thresholds are still the starting values.
- **Recordings in other players.** The MKV and the MP4 were read with GStreamer only (`gst-discoverer-1.0`, a seek, the conversion itself). VLC, mpv and ffmpeg are not installed on the Jetson and were not tried. The record controls of the monitor page were checked by running its script against a stand-in page, not in a browser, and never with the real headset.
- `dev.*` messages are development-only and not in INTERFACES.md. The browser never sends them; the hub accepts them only with `--dev`.
