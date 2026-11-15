"""Marswalk Jetson hub (role E).

One process, one origin:
  https://<host>:8443/     web app (web/dist, or the built-in connection test page)
  wss://<host>:8443/ws     WebSocket, docs/INTERFACES.md section 4
  https://<host>:8443/monitor   what the headset app is drawing, live (mirror.py)
Optional --http-port serves the same app over plain HTTP for the adb-reverse fallback
(http://localhost:<port> on the headset is a secure context).

Run:  python -m marswalk.hub --help
"""
import argparse
import asyncio
import json
import logging
import re
import signal
import ssl
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

from aiohttp import WSMsgType, web

from . import intents, speech
from .maps import MapStore, WaypointStore
from .mirror import Mirror, close_sockets
from .record import Recorder
from .alerts import SUIT_TEMP_MESSAGES, SuitTempAlert, Thresholds
from .sensors import SuitTemp
from .voice import make_segmenter, make_stt, make_tts

log = logging.getLogger("hub")

HERE = Path(__file__).resolve().parent
JETSON_DIR = HERE.parent
REPO_DIR = JETSON_DIR.parent
LOG_DIR = JETSON_DIR / "logs"
TTS_CHUNK = 4096  # bytes per binary frame
MUTE_TAIL_S = 0.6  # keep microphones muted this long after the hub's own speech ends
DICTATE_S = 12.0   # how long a headset's request for dictation waits for words
ALERT_SPEECH = [SUIT_TEMP_MESSAGES["critical"]]  # spoken by the hub; synthesized at startup
GONE = (ConnectionResetError, RuntimeError)   # what sending to a client that has left raises


def envelope(type_: str, payload: dict) -> str:
    return json.dumps({"type": type_, "ts": int(time.time() * 1000), "payload": payload},
                      ensure_ascii=False)


def append_line(path: Path, line: str):
    """One line onto a log file. A full disk or a missing folder never breaks the hub."""
    try:
        path.parent.mkdir(exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


@dataclass
class Client:
    """One connection (a headset, or tools/fake_quest.py) and what the hub keeps for it."""
    ws: web.WebSocketResponse
    peer: str
    mic_buf: bytearray = field(default_factory=bytearray)   # push-to-talk audio between mic.begin and mic.end
    mic_rate: int = 16000
    mic_on: bool = False
    mic_live: bool = False            # between mic.begin and mic.end: what comes is this headset's microphone
    segmenter: object | None = None   # set while the client streams its microphone continuously
    dictate: dict | None = None       # {"id", "until"} while this headset wants its next words as text


class Hub:
    def __init__(self, args):
        self.args = args
        self.clients: set[web.WebSocketResponse] = set()
        self.suit = SuitTemp(args.serial)
        self.alert = SuitTempAlert(Thresholds(args.warn_c, args.critical_c, args.margin_c))
        self.stt = make_stt(args.stt, args.lang)
        self.tts = make_tts(args.tts, args.lang)
        self.tts.warm(ALERT_SPEECH)
        self.say_epoch = 0          # bumped by every urgent utterance
        self.mute_until = 0.0       # monotonic time until which microphones are ignored
        self.heard_log = LOG_DIR / "heard.log"
        self.menu_version = -1      # command menu version last sent to the headsets
        self.state = {"mode": "normal", "navStatus": None, "targetId": None}
        self.active_alerts: dict[str, dict] = {}
        self.tts_lock = asyncio.Lock()
        self.maps = MapStore(Path(args.maps_dir))
        self.waypoints = WaypointStore(Path(args.maps_dir))
        self.mirror = Mirror()
        self.mirror.extra = lambda: {"rescue": self.rescue}
        # The demo video: the monitor's pictures with the wearer's voice and the hub's own (record.py).
        self.recorder = Recorder(Path(getattr(args, "recordings_dir", JETSON_DIR / "recordings")),
                                 convert=not getattr(args, "no_convert", False),
                                 max_seconds=getattr(args, "record_max_min", 30.0) * 60.0)
        self.mirror.recorder = self.recorder
        self.rescue: dict | None = None   # the rescue signal that is up, if any
        # What a client may send (docs/INTERFACES.md section 4): message type -> handler(client, payload).
        self.handlers = {
            "hello": self.on_hello,
            "mic.begin": self.on_mic_begin,
            "mic.end": self.on_mic_end,
            "voice.dictate": self.on_voice_dictate,
            "voice.text": self.on_voice_text,
            "voice.status": self.on_voice_status,
            "voice.say": self.on_voice_say,
            "client.log": self.on_client_log,
            "state": self.on_state,
            "map.store": self.on_map_store,
            "map.request": self.on_map_request,
            "waypoints.store": self.on_waypoints_store,
            "waypoints.request": self.on_waypoints_request,
            "rescue.signal": self.handle_rescue,
        }

    # ---------- broadcast ----------
    async def _to_all(self, send, exclude=None):
        """Call `send(ws)` for every client but `exclude`; one that has left is forgotten."""
        for ws in list(self.clients):
            if ws is exclude:
                continue
            try:
                await send(ws)
            except GONE:
                self.clients.discard(ws)

    async def broadcast(self, type_: str, payload: dict, exclude=None):
        msg = envelope(type_, payload)
        await self._to_all(lambda ws: ws.send_str(msg), exclude)

    async def broadcast_bytes(self, data: bytes):
        await self._to_all(lambda ws: ws.send_bytes(data))

    # ---------- telemetry loop (1 Hz) ----------
    async def telemetry_loop(self):
        while True:
            r = self.suit.reading()
            await self.broadcast("telemetry", r)
            # commands.json changed: give the headsets the new menu
            version, menu = intents.menu()
            if version != self.menu_version:
                self.menu_version = version
                await self.broadcast("voice.commands", {"commands": menu})
            before = self.alert.level
            for type_, payload in self.alert.update(r["suitTempC"]):
                # The reading goes into the log with the alert, so a surprising alarm can be explained.
                log.info("%s %s at %.1f C (%s)", type_, payload, r["suitTempC"], r["source"])
                if type_ == "alert.raise":
                    self.active_alerts[payload["id"]] = payload
                else:
                    self.active_alerts.pop(payload["id"], None)
                await self.broadcast(type_, payload)
                if type_ == "alert.raise" and payload["level"] == "critical" and before != "critical":
                    asyncio.create_task(self.say(payload["message"], "urgent"))
            await asyncio.sleep(1.0)

    # ---------- voice ----------
    async def say(self, text: str, priority: str = "normal"):
        """TTS -> tts.begin, binary PCM frames, tts.end (to every client).

        An urgent utterance drops normal ones that are still waiting or being sent.
        (Audio already delivered is cut by the browser when it sees priority "urgent".)
        """
        text = (text or "").strip()
        if not text:
            return
        if priority == "urgent":
            self.say_epoch += 1
        epoch = self.say_epoch
        log.info("say [%s] %s", priority, text)
        try:
            pcm = await asyncio.to_thread(self.tts.synthesize, text)
        except Exception:
            log.exception("TTS failed for %r", text)
            return
        async with self.tts_lock:
            if epoch != self.say_epoch:
                log.info("dropped (urgent speech came first): %s", text)
                return
            # Do not listen while speaking: the headset microphone hears its own speaker.
            secs = len(pcm) / 2 / self.tts.sample_rate
            self.mute_until = time.monotonic() + secs + MUTE_TAIL_S
            await self.broadcast("tts.begin", {"sampleRate": self.tts.sample_rate,
                                               "priority": priority})
            if self.recorder.on and self.clients:   # the recording holds what a headset was given to play
                self.recorder.speech(pcm, self.tts.sample_rate, urgent=priority == "urgent")
            for i in range(0, len(pcm), TTS_CHUNK):
                if epoch != self.say_epoch:
                    break
                await self.broadcast_bytes(pcm[i:i + TTS_CHUNK])
            await self.broadcast("tts.end", {})

    async def handle_text_command(self, text: str):
        cmd = intents.parse(text, self.args.wake_word)
        self._note_heard(text, cmd)
        if cmd is None:
            log.info("no command in %r", text)
            return
        reply = cmd.pop("reply", None)
        log.info("voice.command %s", cmd)
        await self.broadcast("voice.command", cmd)
        if cmd["intent"] == "status.report":   # the hub answers this one itself
            await self.say(self.status_sentence())
        elif reply:
            await self.say(reply)

    def _note_heard(self, text: str, cmd: dict | None):
        """Everything the recognizer heard, matched or not: the material for tuning commands.json."""
        append_line(self.heard_log, f"{time.strftime('%H:%M:%S')}\t{cmd['intent'] if cmd else '-'}\t{text}")

    def _note_client(self, peer, kind: str, p: dict):
        """Headset diagnostics (errors, AR session events, a position heartbeat) in logs/headset.log."""
        append_line(LOG_DIR / "headset.log",
                    f"{time.strftime('%H:%M:%S')}\t{peer}\t{kind}\t{json.dumps(p, ensure_ascii=False)}")

    async def handle_utterance(self, samples, rate: int, client: Client | None = None):
        """One utterance of a headset: a command, or, while that headset asked for dictation
        (voice.dictate: the name of a waypoint), the words themselves, sent back to it alone."""
        try:
            text = await asyncio.to_thread(self.stt.transcribe, samples, rate)
        except Exception:
            log.exception("STT failed")
            return
        await asyncio.to_thread(self._keep_audio, samples, rate, text)
        wanted = client.dictate if client else None
        if wanted and time.monotonic() < wanted["until"]:
            if not text.strip():
                return                      # a noise, not words: keep listening
            client.dictate = None
            log.info("dictation %r", text)
            self._note_heard(text, {"intent": "(dictation)"})
            try:
                await client.ws.send_str(envelope("voice.dictation", {"id": wanted["id"], "text": text.strip()}))
            except GONE:
                pass
            return
        if text:
            await self.handle_text_command(text)

    def _keep_audio(self, samples, rate: int, text: str):
        """The last --keep-audio utterances as WAV files in logs/utterances/, named by time and by
        what the recogniser made of them: the only way to tell a bad microphone from a bad guess."""
        keep = self.args.keep_audio
        if keep <= 0:
            return
        try:
            import numpy as np   # optional, like the speech models: the hub starts without it
            x = (np.frombuffer(samples, dtype="<i2").astype(np.float32) / 32768.0
                 if isinstance(samples, (bytes, bytearray)) else np.asarray(samples, dtype=np.float32))
            if not len(x):
                return
            peak = float(np.abs(x).max())
            rms = float(np.sqrt(np.mean(x * x)))
            log.info("utterance %.1fs peak %.3f rms %.4f -> %r", len(x) / rate, peak, rms, text)
            folder = LOG_DIR / "utterances"
            folder.mkdir(parents=True, exist_ok=True)
            slug = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")[:40] or "nothing"
            with wave.open(str(folder / f"{time.strftime('%Y%m%d-%H%M%S')}_{slug}.wav"), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(rate)
                w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
            for old in sorted(folder.glob("*.wav"))[:-keep]:
                old.unlink()
        except Exception:   # never let the bookkeeping break the voice path
            log.exception("could not keep the utterance audio")

    def status_sentence(self) -> str:
        r = self.suit.reading()
        return speech.status_sentence(r["suitTempC"], r["source"], self.active_alerts, self.state)

    # ---------- websocket ----------
    async def ws_handler(self, request: web.Request):
        ws = web.WebSocketResponse(heartbeat=5.0, max_msg_size=8 * 1024 * 1024)
        await ws.prepare(request)
        client = Client(ws, request.remote)
        self.clients.add(ws)
        log.info("client connected %s (%d total)", client.peer, len(self.clients))
        try:
            # send current alert state so a reconnecting headset is in sync
            for a in self.active_alerts.values():
                await ws.send_str(envelope("alert.raise", a))
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    self.on_audio(client, msg.data)
                elif msg.type == WSMsgType.TEXT:
                    await self.on_message(client, msg.data)
        finally:
            self.clients.discard(ws)
            log.info("client gone %s (%d left)", client.peer, len(self.clients))
        return ws

    def on_audio(self, client: Client, data: bytes):
        """A binary frame is microphone audio: 16-bit mono PCM at the rate given in mic.begin."""
        if client.mic_live and self.recorder.on:
            # Before the mute, and with or without a recogniser: the recording hears the wearer always.
            # Each connection is a stream of its own, also two from one address.
            self.recorder.mic(data, client.mic_rate, src=id(client))
        if client.segmenter is not None:
            if time.monotonic() < self.mute_until:
                client.segmenter.reset()        # the hub is speaking: not a command
                return
            for samples in client.segmenter.feed(data, client.mic_rate):
                asyncio.create_task(self.handle_utterance(samples, client.segmenter.RATE, client))
        elif client.mic_on:
            client.mic_buf += data

    async def on_message(self, client: Client, data: str):
        """A text frame is one message: { type, ts, payload }. Its type picks the handler."""
        try:
            m = json.loads(data)
            type_, p = m["type"], m.get("payload") or {}
        except (json.JSONDecodeError, KeyError, TypeError):
            log.warning("bad message from %s: %.80s", client.peer, data)
            return
        handler = self.handlers.get(type_)
        if handler:
            await handler(client, p)
        elif type_.startswith("dev.") and self.args.dev:
            await self.handle_dev(type_, p)
        else:
            log.info("ignored %s from %s", type_, client.peer)

    # ---------- one handler per message type: (client, payload) ----------
    async def on_hello(self, client: Client, p: dict):
        log.info("hello from %s: %s", client.peer, p)
        await client.ws.send_str(envelope("voice.commands", {"commands": intents.menu()[1]}))

    async def on_mic_begin(self, client: Client, p: dict):
        client.mic_rate = int(p.get("sampleRate", 16000))
        client.mic_live = True
        if p.get("stream"):
            # Continuous stream: the hub finds the utterances itself.
            client.segmenter = client.segmenter or make_segmenter()
            if client.segmenter is None:
                log.warning("streaming mic from %s but no VAD model "
                            "(tools/get_models.sh)", client.peer)
            else:
                client.segmenter.reset()
                log.info("mic stream from %s (%d Hz)", client.peer, client.mic_rate)
        else:
            client.segmenter = None
            client.mic_buf.clear()
            client.mic_on = True

    async def on_mic_end(self, client: Client, p: dict):
        client.mic_live = False
        if client.segmenter is not None:
            client.segmenter = None
            log.info("mic stream from %s ended", client.peer)
        elif client.mic_on:
            client.mic_on = False
            audio = bytes(client.mic_buf)
            client.mic_buf.clear()
            await self.handle_utterance(audio, client.mic_rate, client)

    async def on_voice_dictate(self, client: Client, p: dict):
        """The next thing said is not a command but a text (a waypoint's name)."""
        if p.get("on"):
            secs = p.get("seconds")
            secs = min(30.0, max(3.0, float(secs))) if isinstance(secs, (int, float)) else DICTATE_S
            client.dictate = {"id": p.get("id"), "until": time.monotonic() + secs}
            log.info("dictation asked by %s for %.0f s", client.peer, secs)
        else:
            client.dictate = None

    async def on_voice_text(self, client: Client, p: dict):
        """A command picked from the headset's menu: same path as a spoken one."""
        asyncio.create_task(self.handle_text_command(str(p.get("text", ""))))

    async def on_voice_status(self, client: Client, p: dict):
        log.info("voice status from %s: %s", client.peer, p)

    async def on_voice_say(self, client: Client, p: dict):
        asyncio.create_task(self.say(p.get("text", ""), p.get("priority", "normal")))

    async def on_client_log(self, client: Client, p: dict):
        kind = p.pop("kind", "?")
        (log.debug if kind == "beat" else log.warning if kind in
         ("error", "rejection", "console.error") else log.info)("headset %s [%s] %s", client.peer, kind, p)
        self._note_client(client.peer, kind, p)

    async def on_state(self, client: Client, p: dict):
        self.state.update(p)

    async def on_map_store(self, client: Client, p: dict):
        """The tiles of the field map that changed on the headset: onto the disk (maps.py)."""
        try:
            path = await asyncio.to_thread(self.maps.save, p)
        except (ValueError, OSError) as err:
            log.warning("map from %s not stored: %s", client.peer, err)
        else:
            if self.maps.latest["updates"] == 1:
                log.info("storing the field map of run %s in %s", p.get("run"), path.name)

    async def on_map_request(self, client: Client, p: dict):
        stored = self.maps.stored()   # the newest run, every tile of it
        if stored:
            await client.ws.send_str(envelope("map.stored", stored))

    async def on_waypoints_store(self, client: Client, p: dict):
        """The places the wearer marked: kept beside the maps for the next session."""
        try:
            kept = await asyncio.to_thread(self.waypoints.save, p)
        except (ValueError, OSError) as err:
            log.warning("waypoints from %s not stored: %s", client.peer, err)
        else:
            log.info("stored %d waypoints from %s", len(kept["items"]), client.peer)

    async def on_waypoints_request(self, client: Client, p: dict):
        # Always answered, also with an empty list: the headset sends what it has
        # marked while the link was down only after it has seen what is kept here.
        kept = await asyncio.to_thread(self.waypoints.stored)
        await client.ws.send_str(envelope("waypoints.stored", kept or {"items": [], "count": 0}))

    async def handle_rescue(self, client: Client, p: dict):
        """The emergency button of a headset (web/src/hud/rescue.js).

        The crew is virtual: the other headsets on the hub get an alert, the monitor page shows
        it, and a few seconds later the hub acknowledges in the crew's name and says that this
        acknowledgement is simulated.
        """
        sender, peer = client.ws, client.peer

        async def others(type_: str, payload: dict):
            await self.broadcast(type_, payload, exclude=sender)

        if not p.get("active"):
            if self.rescue:
                log.warning("RESCUE SIGNAL from %s cancelled", peer)
            self.rescue = None
            await sender.send_str(envelope("rescue.state", {"active": False}))
            await others("alert.clear", {"id": "crew-rescue"})
            asyncio.create_task(self.say("Rescue signal cancelled."))
            return
        position = p.get("position") if isinstance(p.get("position"), list) else None
        self.rescue = {"active": True, "from": peer, "at": time.strftime("%H:%M:%S"), "position": position,
                       "suitTempC": p.get("suitTempC"), "batteryPct": p.get("batteryPct"),
                       "acknowledged": False, "by": None}
        signal = self.rescue
        log.warning("RESCUE SIGNAL from %s: %s", peer, signal)
        await sender.send_str(envelope("rescue.state", signal))
        await others("alert.raise", {"id": "crew-rescue", "level": "warn",
                                     "message": "Rescue signal from a crew member"})
        asyncio.create_task(self.say("Rescue signal sent. Your position is shared with the crew.", "urgent"))

        async def acknowledge():
            await asyncio.sleep(5.0)
            if self.rescue is signal:           # still the same signal, not cancelled meanwhile
                signal.update(acknowledged=True, by="Base crew (simulated)")
                try:
                    await sender.send_str(envelope("rescue.state", signal))
                except GONE:
                    pass
                await self.say("Base has your signal.")
        asyncio.create_task(acknowledge())

    async def handle_dev(self, type_: str, p: dict):
        """Dev-only messages (enabled with --dev). Not part of INTERFACES.md;
        the browser never sends them. Used by tools/fake_quest.py."""
        if type_ == "dev.text":            # skip STT, test the intent parser
            await self.handle_text_command(p.get("text", ""))
        elif type_ == "dev.temp":          # set the mock ambient temperature
            self.suit.mock_c = float(p["suitTempC"])
            log.info("dev: mock temp = %.1f", self.suit.mock_c)


# ---------- web app ----------
def build_app(hub: Hub) -> web.Application:
    app = web.Application()
    app.router.add_get("/ws", hub.ws_handler)
    hub.mirror.routes(app)   # /mirror, /monitor: the headset's view on a monitor

    static_dir = Path(hub.args.static).resolve() if hub.args.static else None
    if static_dir and (static_dir / "index.html").exists():
        log.info("serving web app from %s", static_dir)
    else:
        if static_dir:
            log.warning("%s/index.html not found; serving the connection test page", static_dir)
        static_dir = HERE / "static"

    async def index(_):
        return web.FileResponse(static_dir / "index.html",
                                headers={"Cache-Control": "no-cache"})
    app.router.add_get("/", index)
    app.router.add_static("/", static_dir, show_index=False)

    tasks = []

    async def on_startup(app):
        tasks.extend([asyncio.create_task(hub.telemetry_loop()),
                      asyncio.create_task(hub.suit.run())])

    async def on_shutdown(app):
        # First of all: a recording that runs is finished, not cut off. In a thread, the disk
        # may take a moment. Then the connections that never end by themselves are closed, or
        # the hub would wait for them and be killed while it waits.
        await asyncio.to_thread(hub.recorder.close)
        await close_sockets(hub.clients)
        await hub.mirror.close()

    async def on_cleanup(app):
        for t in tasks:
            t.cancel()
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app


async def serve(args):
    hub = Hub(args)
    # At the end the hub closes its lasting connections itself (build_app, on_shutdown); what
    # is still busy after that, a download, gets 2 s and not aiohttp's minute.
    runner = web.AppRunner(build_app(hub), shutdown_timeout=2.0)
    await runner.setup()

    cert, key = Path(args.cert_dir) / "cert.pem", Path(args.cert_dir) / "key.pem"
    if cert.exists() and key.exists():
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(cert, key)
        await web.TCPSite(runner, args.host, args.port, ssl_context=ctx).start()
        log.info("HTTPS  https://%s:%d/   wss://.../ws", args.host, args.port)
    else:
        log.warning("no cert in %s (run tools/make_cert.sh); HTTPS disabled", args.cert_dir)
        if not args.http_port:
            args.http_port = args.port
    if args.http_port:
        await web.TCPSite(runner, args.host, args.http_port).start()
        log.info("HTTP   http://%s:%d/   ws://.../ws  (localhost / adb reverse only)",
                 args.host, args.http_port)
    log.info("stt=%s tts=%s serial=%s dev=%s wake=%s", hub.stt.name, hub.tts.name,
             args.serial or "auto", args.dev, args.wake_word)
    # Ctrl-C ends the wait from outside; "kill" and the one click start send TERM. Either way
    # the hub ends tidily: a recording that runs is finished first (build_app, on_shutdown).
    stop = asyncio.Event()
    try:
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
    except (NotImplementedError, RuntimeError):
        pass   # a system without such signals
    try:
        await stop.wait()
    finally:
        await runner.cleanup()


def main():
    p = argparse.ArgumentParser(description="Marswalk Jetson hub")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8443, help="HTTPS + WSS port")
    p.add_argument("--http-port", type=int, default=0,
                   help="also serve plain HTTP (for adb reverse / localhost), e.g. 8080")
    p.add_argument("--static", default=str(REPO_DIR / "web" / "dist"),
                   help="built web app dir (default: web/dist)")
    p.add_argument("--cert-dir", default=str(JETSON_DIR / "certs"))
    p.add_argument("--serial", default=None,
                   help="serial port (default: first /dev/ttyACM* or ttyUSB*; 'none' = mock only)")
    p.add_argument("--warn-c", type=float, default=30.0)
    p.add_argument("--critical-c", type=float, default=35.0)
    p.add_argument("--margin-c", type=float, default=1.0,
                   help="an alert steps down once the temperature is this far under its threshold")
    p.add_argument("--stt", default="auto", help="auto | sensevoice | null")
    p.add_argument("--tts", default="auto", help="auto | supertonic | tone")
    p.add_argument("--lang", default="en", help="speech language code for STT and TTS")
    p.add_argument("--wake-word", default=None,
                   help="only obey speech containing this word, e.g. 'helmet' (noisy rooms)")
    p.add_argument("--keep-audio", type=int, default=100,
                   help="keep the last N utterances as WAV in logs/utterances/ for tuning (0 = keep none)")
    p.add_argument("--maps-dir", default=str(JETSON_DIR / "maps"),
                   help="where the field maps sent by the headset are kept")
    p.add_argument("--recordings-dir", default=str(JETSON_DIR / "recordings"),
                   help="where the monitor page's recordings go")
    p.add_argument("--record-max-min", type=float, default=30.0, help="a recording ends by itself after this long")
    p.add_argument("--no-convert", action="store_true", help="keep the recordings as .mkv, make no .mp4")
    p.add_argument("--dev", action="store_true", help="accept dev.* messages from tools/fake_quest.py")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(name)-7s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
