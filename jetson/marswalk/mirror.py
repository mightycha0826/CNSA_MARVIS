"""Mirror of the headset's view (role E).

The web app sends what it draws as JPEG pictures over its own WebSocket (web/src/core/mirror.js);
the hub keeps the newest and streams it to browsers:

  /mirror        WebSocket, headset -> hub:
                   binary JPEG frames;
                   text {"info": {...}} when it changed: what the picture is (size, AR or not, camera);
                   text {"stats": {...}} about once a second: numbers about the pictures (quality,
                   kB, fps, delayMs ...), shown on the monitor page and logged every 30 s;
                   text {"ping": x}, answered with {"pong": x} at once.
                 hub -> headset:
                   {"viewers": n, "acks": true} on connect and whenever it changes, so pictures are
                   only made while someone watches (or a recording runs); with "tune": {"fovDeg",
                   "tiltDeg", "view"} once something was set on the monitor page;
                   {"ack": k} after every binary message, k counting them from 1 on this
                   connection: the app sees from it how far behind the hub is and holds back.
                 Either side leaves alone what it does not know, so one of them can be newer.
  /monitor       the page to open on the Jetson's monitor
  /monitor.mjpg  the pictures as one never-ending multipart response (an <img> shows it as video)
  /monitor.json  state, for the page's status line
  /monitor/tune  POST {"fovDeg", "tiltDeg", "view"} (any of them) or {"reset": true}.
                 fovDeg and tiltDeg are the lens the app draws the virtual things with over the
                 camera picture. The browser does not tell the app the camera's lens, so it is set
                 by eye here (grid against the real floor). view is what the picture shows: "full",
                 the wearer's whole view, or "camera", the camera picture filling the frame.
                 Kept in logs/mirror_tune.json for the next start.

  /monitor/record  POST {"on": true|false}: record the pictures and the voices (record.py) into
                 recordings/ as marswalk-<date>-<time>.mkv, turned into an .mp4 afterwards.
  /recordings/<name>  a finished recording as a download.

No Meta account, no developer mode, no internet: only the hotspot the headset is already on.
The room is in the picture only if the browser gave the app a camera; otherwise the background
is plain.
"""
import asyncio
import ipaddress
import json
import logging
import re
import socket
import time
from pathlib import Path

from aiohttp import WSCloseCode, WSMsgType, web

log = logging.getLogger("mirror")

HERE = Path(__file__).resolve().parent
MAX_FRAME = 2 * 1024 * 1024
TUNE_FILE = HERE.parent / "logs" / "mirror_tune.json"
TUNE_RANGE = {"fovDeg": (35.0, 110.0), "tiltDeg": (-25.0, 25.0)}   # as in web/src/core/mirror.js
RECORDING_NAME = re.compile(r"^marswalk-[0-9]{8}-[0-9]{6}\.(mkv|mp4)$")   # what record.py names its files
TUNE_VIEWS = ("full", "camera")   # the wearer's whole view, or the camera picture filling the frame
STATS_MAX_AGE_S = 5.0     # the app's numbers come once a second: older ones are not about this picture
STATS_LOG_EVERY_S = 30.0
REMOTE_SNDBUF = 262144    # bytes the system may hold for a monitor on another machine


def clean_tune(raw) -> dict | None:
    """What is usable of a tune request: the numbers held to their ranges, the view if it is one
    we know. None when there is nothing usable."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for key, (lo, hi) in TUNE_RANGE.items():
        v = raw.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v:
            out[key] = round(min(hi, max(lo, float(v))), 1)
    view = raw.get("view")
    if isinstance(view, str) and view in TUNE_VIEWS:
        out["view"] = view
    return out or None


def is_loopback(host) -> bool:
    """True for an address of this machine itself (127.0.0.1, ::1)."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)   # ::ffff:127.0.0.1 when the hub listens on IPv6
    return ip.is_loopback or bool(mapped and mapped.is_loopback)


def bound_send_buffer(transport) -> bool:
    """Keep a remote monitor from falling seconds behind.

    A monitor on Wi-Fi may take the pictures slower than they come. The system would then let its
    send buffer for the connection grow to megabytes, all of it pictures already too old, and the
    monitor would show what happened seconds ago. With a small buffer the stream waits instead,
    and since it always sends the newest picture, the monitor lags by a picture or two.
    A browser on the Jetson itself is left alone: there nothing queues. True when the buffer was set.
    """
    if transport is None:
        return False
    peer = transport.get_extra_info("peername")
    if not peer or is_loopback(peer[0]):
        return False
    sock = transport.get_extra_info("socket")
    if sock is None:
        return False
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, REMOTE_SNDBUF)
    except OSError:
        return False
    return True


async def close_sockets(sockets):
    """Close WebSockets from our side, all at once. One whose other end does not answer (a
    headset out of reach) gets a second, not the ten that aiohttp would wait."""
    async def close(ws):
        try:
            await asyncio.wait_for(ws.close(code=WSCloseCode.GOING_AWAY), 1.0)
        except (asyncio.TimeoutError, ConnectionResetError, RuntimeError):
            pass
    await asyncio.gather(*(close(ws) for ws in list(sockets)))


BOUNDARY = "marswalkframe"


class Mirror:
    def __init__(self, tune_file: Path | None = TUNE_FILE):
        self.tune_file = tune_file
        self.tune: dict | None = None    # the camera lens and the view as set on the monitor page
        if tune_file is not None:
            try:
                self.tune = clean_tune(json.loads(tune_file.read_text()))
            except (OSError, json.JSONDecodeError):
                pass
        self.sources: set[web.WebSocketResponse] = set()
        self.viewers = 0                 # monitor pages open (/monitor.mjpg streams)
        self.recorder = None             # the hub's recorder, if it has one: while it is on, pictures are wanted too
        self.told = 0                    # the "viewers" the apps were told last
        self.frame: bytes | None = None
        self.seq = 0                 # frames received since the hub started
        self.at = 0.0                # monotonic time of the newest frame
        self.info: dict = {}
        self.source_peer: str | None = None
        self.stats: dict | None = None   # the app's newest numbers about its pictures
        self.stats_at = 0.0              # when they came
        self.stats_from = None           # the connection they came over
        self.stats_logged = None         # (time, frames received) at the last "mirror stats" log line
        self.clock = time.monotonic      # a test puts its own clock here
        self.wake_s = 2.0                # how often a stream with no new picture looks whether its monitor is still there
        self.fresh = asyncio.Condition()
        self.closing = False             # the hub is ending: the streams end, see close()
        self.extra = lambda: {}          # more state for /monitor.json (the hub adds the rescue signal)

    def routes(self, app: web.Application):
        app.router.add_get("/mirror", self.source_handler)
        app.router.add_get("/monitor", self.page)
        app.router.add_get("/monitor.mjpg", self.stream)
        app.router.add_get("/monitor.json", self.status)
        app.router.add_post("/monitor/tune", self.set_tune)
        app.router.add_post("/monitor/record", self.set_record)
        app.router.add_get("/recordings/{name}", self.recording_file)

    async def close(self):
        """The hub is ending. The apps' connections and the monitors' streams would stay open
        for ever and the hub would wait for them: they are ended here."""
        self.closing = True
        await close_sockets(self.sources)
        async with self.fresh:
            self.fresh.notify_all()

    def wanted(self) -> int:
        """The "viewers" the app is told: monitor pages open, and one more while a recording runs,
        so pictures are made for the recording with no page open."""
        recording = self.recorder is not None and self.recorder.on
        return self.viewers + (1 if recording else 0)

    def _hello(self) -> str:
        msg = {"viewers": self.wanted(), "acks": True}   # acks: this hub answers every picture, see source_handler
        if self.tune:
            msg["tune"] = self.tune
        return json.dumps(msg)

    async def _tell_sources(self):
        msg = self._hello()
        self.told = self.wanted()
        for ws in list(self.sources):
            try:
                await ws.send_str(msg)
            except (ConnectionResetError, RuntimeError):
                self.sources.discard(ws)

    # ---------- headset -> hub ----------
    async def source_handler(self, request: web.Request):
        ws = web.WebSocketResponse(heartbeat=10.0, max_msg_size=MAX_FRAME)
        await ws.prepare(request)
        peer = request.remote
        self.sources.add(ws)
        log.info("mirror source connected %s", peer)
        got = 0   # binary messages of this connection so far: the number in the ack
        try:
            await ws.send_str(self._hello())
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    got += 1
                    if msg.data.startswith(b"\xff\xd8"):   # a JPEG; anything else is counted and dropped
                        self.frame, self.at, self.source_peer = bytes(msg.data), self.clock(), peer
                        self.seq += 1
                        if self.recorder is not None and self.recorder.on:
                            self.recorder.frame(self.frame, self.at)
                        async with self.fresh:
                            self.fresh.notify_all()
                        # A recording can end by itself (its time is up, the disk is full) and
                        # nobody presses a button then: the app hears of it with its next picture.
                        if self.wanted() != self.told:
                            await self._tell_sources()
                    # The app counts what it sent against this: it knows how many pictures are
                    # still on the way, and how long one takes to arrive.
                    await ws.send_str(json.dumps({"ack": got}))
                elif msg.type == WSMsgType.TEXT:
                    await self._text(ws, peer, msg.data)
        except ConnectionResetError:
            pass   # gone in the middle of an answer
        finally:
            self.sources.discard(ws)
            if self.stats_from is ws:   # its numbers say nothing once it is gone
                self.stats = self.stats_from = None
            log.info("mirror source gone %s", peer)
        return ws

    async def _text(self, ws: web.WebSocketResponse, peer, data: str):
        """A text message of the app. Every key is looked at by itself and unknown ones are left
        alone, so a newer app can say more than this hub knows."""
        try:
            body = json.loads(data)
        except (json.JSONDecodeError, RecursionError):
            return
        if not isinstance(body, dict):
            return
        if "ping" in body:   # the app measures the way there and back; answered before anything else
            await ws.send_str(json.dumps({"pong": body["ping"]}))
        info = body.get("info")
        if isinstance(info, dict):
            self.info = info
            log.info("mirror from %s: %s", peer, info)
        stats = body.get("stats")
        if isinstance(stats, dict):
            self._keep_stats(ws, peer, stats)

    def _keep_stats(self, ws, peer, stats: dict):
        now = self.clock()
        self.stats, self.stats_at, self.stats_from = stats, now, ws
        # One line every 30 s, and only while pictures come: enough to see afterwards how the
        # link did, without a line a second in the log.
        last = self.stats_logged
        if last is None:
            due = self.seq > 0
        else:
            due = now - last[0] >= STATS_LOG_EVERY_S and self.seq != last[1]
        if due:
            self.stats_logged = (now, self.seq)
            log.info("mirror stats from %s: %s", peer, stats)

    def fresh_stats(self) -> dict | None:
        """The app's numbers, or None when they are older than 5 s or the app is gone."""
        if self.stats is None or self.clock() - self.stats_at > STATS_MAX_AGE_S:
            return None
        return self.stats

    # ---------- hub -> monitor ----------
    async def page(self, _request):
        return web.FileResponse(HERE / "static" / "monitor.html", headers={"Cache-Control": "no-cache"})

    async def status(self, _request):
        age = round(self.clock() - self.at, 2) if self.frame else None
        return web.json_response({"sources": len(self.sources), "viewers": self.viewers, "frames": self.seq,
                                  "ageS": age, "bytes": len(self.frame) if self.frame else 0,
                                  "info": self.info, "from": self.source_peer, "tune": self.tune,
                                  "stats": self.fresh_stats(),
                                  "recording": self.recorder.state() if self.recorder is not None else None,
                                  "recordings": self.recorder.recordings() if self.recorder is not None else [],
                                  **self.extra()},
                                 headers={"Cache-Control": "no-store"})

    async def set_record(self, request: web.Request):
        """POST {"on": true} starts a recording of the pictures (and the voices, record.py),
        {"on": false} ends it. Asking for what already is so is no error."""
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = None
        if not isinstance(body, dict) or not isinstance(body.get("on"), bool):
            return web.json_response({"error": '{"on": true} or {"on": false} expected'}, status=400)
        if self.recorder is None:
            return web.json_response({"error": "this hub has no recorder"}, status=409)
        # In a thread: the start makes a file and the stop waits until the last of it is written,
        # and the pictures and the voices must keep coming through meanwhile.
        try:
            if body["on"] and not self.recorder.on:
                state = await asyncio.to_thread(self.recorder.start)
                log.info("recording started by %s: %s", request.remote, state)
            elif not body["on"] and self.recorder.on:
                state = await asyncio.to_thread(self.recorder.stop)
                log.info("recording stopped by %s: %s", request.remote, state)
        except Exception as err:   # RecordError (disk short, folder), or anything the disk throws
            log.warning("recording: %s", err)
            return web.json_response({"error": str(err)}, status=409)
        await self._tell_sources()   # a recording counts as a viewer: pictures are wanted, or no longer
        return web.json_response({"recording": self.recorder.state()})

    async def recording_file(self, request: web.Request):
        """A finished recording as a download. Only our own file names: nothing else in the folder,
        and no way out of it."""
        name = request.match_info["name"]
        if self.recorder is None or not RECORDING_NAME.fullmatch(name):
            raise web.HTTPNotFound()
        path = self.recorder.folder / name
        if not path.is_file():
            raise web.HTTPNotFound()
        kind = "video/mp4" if name.endswith(".mp4") else "video/x-matroska"   # the second one the system does not know
        return web.FileResponse(path, headers={"Content-Type": kind,
                                               "Content-Disposition": f'attachment; filename="{name}"'})

    async def set_tune(self, request: web.Request):
        try:
            body = await request.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            return web.json_response({"error": "JSON expected"}, status=400)
        if isinstance(body, dict) and body.get("reset"):
            tune = None
        else:
            tune = clean_tune(body)
            if tune is None:
                return web.json_response({"error": "fovDeg, tiltDeg and/or view expected"}, status=400)
            tune = {**(self.tune or {}), **tune}
        self.tune = tune
        if self.tune_file is not None:
            try:
                if tune is None:
                    self.tune_file.unlink(missing_ok=True)
                else:
                    self.tune_file.parent.mkdir(parents=True, exist_ok=True)
                    self.tune_file.write_text(json.dumps(tune))
            except OSError as err:
                log.warning("mirror tune not saved: %s", err)
        # A reset has nothing to send: the app keeps what it has until it is reloaded.
        await self._tell_sources()
        log.info("mirror tune %s by %s", tune, request.remote)
        return web.json_response({"tune": tune})

    async def stream(self, request: web.Request):
        resp = web.StreamResponse(headers={
            "Content-Type": f"multipart/x-mixed-replace; boundary={BOUNDARY}",
            "Cache-Control": "no-store", "Connection": "close"})
        await resp.prepare(request)
        bound_send_buffer(request.transport)
        self.viewers += 1
        await self._tell_sources()
        log.info("monitor opened by %s (%d watching)", request.remote, self.viewers)
        seq = -1
        try:
            while not self.closing and request.transport is not None and not request.transport.is_closing():
                async with self.fresh:
                    try:   # wake up now and then to notice a monitor that went away while no frames came
                        await asyncio.wait_for(self.fresh.wait_for(
                            lambda: self.closing or (self.frame is not None and self.seq != seq)), self.wake_s)
                    except asyncio.TimeoutError:
                        continue
                if self.closing:
                    break
                seq, frame = self.seq, self.frame
                # write() waits while the connection is full: the pictures that come meanwhile
                # are skipped (the newest is taken above), not queued behind this one.
                await resp.write(f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(frame)}\r\n\r\n"
                                 .encode() + frame + b"\r\n")
        except (ConnectionResetError, asyncio.CancelledError, RuntimeError):
            pass
        finally:
            self.viewers -= 1
            await self._tell_sources()
            log.info("monitor closed by %s (%d watching)", request.remote, self.viewers)
        return resp
