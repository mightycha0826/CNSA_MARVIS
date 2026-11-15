"""The mirror (marswalk/mirror.py): a real Mirror in an aiohttp app on a port of its own.

Run from jetson/:  .venv/bin/python -m unittest discover tests
"""
import asyncio
import json
import socket
import tempfile
import unittest
from pathlib import Path

from aiohttp import WSMsgType, web
from aiohttp.test_utils import AioHTTPTestCase

from marswalk import mirror as mirror_module
from marswalk.mirror import BOUNDARY, Mirror, bound_send_buffer, clean_tune, is_loopback

JPEG = b"\xff\xd8\xff\xe0" + bytes(range(256)) * 4 + b"\xff\xd9"   # starts like a JPEG; the hub looks no further
JPEG_2 = b"\xff\xd8\xff\xe0" + b"second picture" * 50 + b"\xff\xd9"
NOT_A_JPEG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class CleanTuneViewTest(unittest.TestCase):
    def test_a_view_we_know_is_kept(self):
        self.assertEqual(clean_tune({"view": "camera"}), {"view": "camera"})
        self.assertEqual(clean_tune({"view": "full"}), {"view": "full"})

    def test_a_view_goes_along_with_the_numbers(self):
        self.assertEqual(clean_tune({"fovDeg": 58, "tiltDeg": -3.26, "view": "camera"}),
                         {"fovDeg": 58.0, "tiltDeg": -3.3, "view": "camera"})
        self.assertEqual(clean_tune({"fovDeg": 500, "view": "full", "zoom": 2}),
                         {"fovDeg": 110.0, "view": "full"})

    def test_any_other_view_is_dropped(self):
        for junk in ("sideways", "Camera", "", 1, True, None, ["camera"], {"view": "camera"}):
            self.assertIsNone(clean_tune({"view": junk}), junk)
            self.assertEqual(clean_tune({"tiltDeg": 2, "view": junk}), {"tiltDeg": 2.0}, junk)

    def test_a_reset_alone_is_not_a_tune(self):
        # {"reset": true} is the request's business (set_tune), not a value to keep.
        self.assertIsNone(clean_tune({"reset": True}))


class LoopbackTest(unittest.TestCase):
    def test_this_machine_and_other_machines(self):
        for host in ("127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"):
            self.assertTrue(is_loopback(host), host)
        for host in ("10.42.0.57", "192.168.0.4", "fe80::1", "::ffff:10.42.0.57", "", "localhost", None):
            self.assertFalse(is_loopback(host), host)


class FakeSocket:
    def __init__(self, fails=False):
        self.calls = []
        self.fails = fails

    def setsockopt(self, *args):
        if self.fails:
            raise OSError("not allowed")
        self.calls.append(args)


class FakeTransport:
    def __init__(self, peer, sock):
        self.extra = {"peername": peer, "socket": sock}

    def get_extra_info(self, name, default=None):
        return self.extra.get(name, default)


class SendBufferTest(unittest.TestCase):
    def test_a_remote_monitor_gets_a_small_send_buffer(self):
        sock = FakeSocket()
        self.assertTrue(bound_send_buffer(FakeTransport(("10.42.0.57", 51234), sock)))
        self.assertEqual(sock.calls, [(socket.SOL_SOCKET, socket.SO_SNDBUF, 262144)])

    def test_a_monitor_on_the_jetson_itself_is_left_alone(self):
        sock = FakeSocket()
        self.assertFalse(bound_send_buffer(FakeTransport(("127.0.0.1", 51234), sock)))
        self.assertEqual(sock.calls, [])

    def test_a_system_that_refuses_does_no_harm(self):
        self.assertFalse(bound_send_buffer(FakeTransport(("10.42.0.57", 51234), FakeSocket(fails=True))))
        self.assertFalse(bound_send_buffer(FakeTransport(("10.42.0.57", 51234), None)))
        self.assertFalse(bound_send_buffer(FakeTransport(None, FakeSocket())))
        self.assertFalse(bound_send_buffer(None))

    def test_a_real_socket_takes_it(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            before = sock.getsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF)
            self.assertTrue(bound_send_buffer(FakeTransport(("10.42.0.57", 51234), sock)))
            after = sock.getsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF)
            # The system may round or cap the number; it must have taken one of its own.
            self.assertNotEqual(after, before)
            self.assertGreater(after, 0)


class FakeRecorder:
    def __init__(self, on):
        self.on = on


class MirrorCase(AioHTTPTestCase):
    """A Mirror behind a test server; the tune file is in a folder of the test's own."""

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.tune_path = Path(folder.name) / "logs" / "mirror_tune.json"   # the folder is made on the first save
        self.now = 1000.0   # the mirror's clock, moved by hand
        super().setUp()

    async def get_application(self):
        self.mirror = Mirror(self.tune_path)
        self.mirror.clock = lambda: self.now
        self.mirror.wake_s = 0.05   # a closed stream is noticed at once, not after 2 s
        app = web.Application()
        self.mirror.routes(app)
        return app

    async def source(self):
        """A headset app connecting: the socket and the hub's first message."""
        ws = await self.client.ws_connect("/mirror")
        self.addAsyncCleanup(ws.close)
        return ws, await self.told(ws)

    async def told(self, ws):
        return await asyncio.wait_for(ws.receive_json(), 2.0)

    async def settled(self, ws):
        """Wait until the hub has dealt with everything sent so far (it reads in order)."""
        await ws.send_json({"ping": "settled"})
        self.assertEqual(await self.told(ws), {"pong": "settled"})

    async def state(self):
        resp = await self.client.get("/monitor.json")
        self.assertEqual(resp.status, 200)
        return await resp.json()

    async def tune(self, body):
        resp = await self.client.post("/monitor/tune", json=body)
        return resp.status, await resp.json()


class HelloAndTuneTest(MirrorCase):
    async def test_the_hello_says_that_pictures_are_acked(self):
        _ws, hello = await self.source()
        self.assertEqual(hello, {"viewers": 0, "acks": True})

    async def test_a_view_alone_is_a_valid_tune_and_is_kept_in_the_file(self):
        self.assertEqual(await self.tune({"view": "camera"}), (200, {"tune": {"view": "camera"}}))
        self.assertEqual(json.loads(self.tune_path.read_text()), {"view": "camera"})
        self.assertEqual((await self.state())["tune"], {"view": "camera"})

    async def test_a_tune_with_a_view_is_handed_to_a_connecting_source(self):
        await self.tune({"fovDeg": 61, "tiltDeg": 4})
        await self.tune({"view": "camera"})   # joins the numbers, does not replace them
        tune = {"fovDeg": 61.0, "tiltDeg": 4.0, "view": "camera"}
        self.assertEqual(json.loads(self.tune_path.read_text()), tune)
        _ws, hello = await self.source()
        self.assertEqual(hello, {"viewers": 0, "acks": True, "tune": tune})
        # and by the next hub that starts with this file
        self.assertEqual(Mirror(self.tune_path).tune, tune)
        self.assertEqual(json.loads(Mirror(self.tune_path)._hello()), hello)

    async def test_a_source_that_is_connected_hears_of_a_change(self):
        ws, _hello = await self.source()
        await self.tune({"view": "camera"})
        self.assertEqual(await self.told(ws), {"viewers": 0, "acks": True, "tune": {"view": "camera"}})
        await self.tune({"view": "full", "fovDeg": 70})
        self.assertEqual(await self.told(ws), {"viewers": 0, "acks": True, "tune": {"view": "full", "fovDeg": 70.0}})

    async def test_a_view_we_do_not_know_changes_nothing(self):
        await self.tune({"view": "camera"})
        status, body = await self.tune({"view": "sideways"})
        self.assertEqual(status, 400)
        self.assertIn("error", body)
        status, body = await self.tune({"view": "sideways", "tiltDeg": -2})   # the number is taken, the view stays
        self.assertEqual((status, body), (200, {"tune": {"view": "camera", "tiltDeg": -2.0}}))

    async def test_a_reset_clears_the_view_with_the_rest(self):
        await self.tune({"fovDeg": 61, "view": "camera"})
        self.assertTrue(self.tune_path.exists())
        ws, _hello = await self.source()
        self.assertEqual(await self.tune({"reset": True}), (200, {"tune": None}))
        self.assertFalse(self.tune_path.exists())
        self.assertEqual(await self.told(ws), {"viewers": 0, "acks": True})
        self.assertIsNone((await self.state())["tune"])
        self.assertIsNone(Mirror(self.tune_path).tune)

    async def test_a_body_that_is_not_json_is_refused(self):
        resp = await self.client.post("/monitor/tune", data=b"view=camera")
        self.assertEqual(resp.status, 400)
        self.assertIsNone(self.mirror.tune)


class SourceTest(MirrorCase):
    async def test_every_binary_message_is_acked_with_its_number(self):
        ws, _hello = await self.source()
        await ws.send_bytes(JPEG)
        self.assertEqual(await self.told(ws), {"ack": 1})
        self.assertEqual((self.mirror.seq, self.mirror.frame), (1, JPEG))
        await ws.send_bytes(NOT_A_JPEG)   # counted and acked, but not kept and not shown
        self.assertEqual(await self.told(ws), {"ack": 2})
        self.assertEqual((self.mirror.seq, self.mirror.frame), (1, JPEG))
        await ws.send_bytes(JPEG_2)
        self.assertEqual(await self.told(ws), {"ack": 3})
        self.assertEqual((self.mirror.seq, self.mirror.frame), (2, JPEG_2))
        state = await self.state()
        self.assertEqual((state["frames"], state["bytes"]), (2, len(JPEG_2)))

    async def test_the_count_is_each_connection_s_own(self):
        first, _ = await self.source()
        for n in (1, 2, 3):
            await first.send_bytes(JPEG)
            self.assertEqual(await self.told(first), {"ack": n})
        second, _ = await self.source()   # the app reconnected, or a second headset
        await second.send_bytes(JPEG)
        self.assertEqual(await self.told(second), {"ack": 1})
        await first.send_bytes(JPEG)
        self.assertEqual(await self.told(first), {"ack": 4})

    async def test_pictures_sent_in_a_row_are_acked_in_a_row(self):
        ws, _hello = await self.source()
        for _ in range(5):
            await ws.send_bytes(JPEG)
        self.assertEqual([await self.told(ws) for _ in range(5)], [{"ack": n} for n in range(1, 6)])

    async def test_a_ping_is_answered_with_what_it_carried(self):
        ws, _hello = await self.source()
        for value in (17, 1731700000123.5, "a1", None, {"t": 12.5, "n": 3}, [1, "two"]):
            await ws.send_json({"ping": value})
            self.assertEqual(await self.told(ws), {"pong": value})

    async def test_a_ping_between_pictures_keeps_its_place(self):
        ws, _hello = await self.source()
        await ws.send_bytes(JPEG)
        await ws.send_json({"ping": 1})
        await ws.send_bytes(JPEG)
        self.assertEqual([await self.told(ws) for _ in range(3)], [{"ack": 1}, {"pong": 1}, {"ack": 2}])

    async def test_info_is_kept_as_before(self):
        ws, _hello = await self.source()
        info = {"width": 960, "height": 540, "ar": True, "mode": "field", "view": "camera"}
        await ws.send_json({"info": info})
        await self.settled(ws)
        self.assertEqual((await self.state())["info"], info)

    async def test_what_the_hub_does_not_know_does_no_harm(self):
        ws, _hello = await self.source()
        await ws.send_json({"info": {"width": 640, "height": 480}, "later": {"anything": [1, 2]}})
        await ws.send_json({"hello": "from a newer app", "version": 9})
        await ws.send_json({"info": "not a dict", "stats": [1, 2, 3]})
        await ws.send_str("not json at all")
        await ws.send_str("[1, 2, 3]")
        await ws.send_str("null")
        await ws.send_json({"stats": {"fps": 10, "somethingNew": "text"}, "ping": 5, "extra": True})
        self.assertEqual(await self.told(ws), {"pong": 5})
        await ws.send_bytes(JPEG)
        self.assertEqual(await self.told(ws), {"ack": 1})
        state = await self.state()
        self.assertEqual(state["sources"], 1)
        self.assertEqual(state["info"], {"width": 640, "height": 480})
        self.assertEqual(state["stats"], {"fps": 10, "somethingNew": "text"})


class StatsTest(MirrorCase):
    STATS = {"quality": 0.72, "kB": 48.3, "fps": 10, "delayMs": 85, "baseMs": 12, "captureMs": 3.1,
             "encodeMs": 9.4, "held": 0}

    async def test_the_newest_stats_are_served_and_go_stale(self):
        self.assertIsNone((await self.state())["stats"])
        ws, _hello = await self.source()
        await ws.send_json({"stats": self.STATS})
        await self.settled(ws)
        self.assertEqual((await self.state())["stats"], self.STATS)
        self.now += 4.9
        self.assertEqual((await self.state())["stats"], self.STATS)
        self.now += 0.2   # 5.1 s old: the app stopped telling
        self.assertIsNone((await self.state())["stats"])
        newer = {**self.STATS, "quality": 0.5, "delayMs": 240}
        await ws.send_json({"stats": newer})
        await self.settled(ws)
        self.assertEqual((await self.state())["stats"], newer)

    async def test_stats_go_with_the_app(self):
        ws, _hello = await self.source()
        await ws.send_json({"stats": self.STATS})
        await self.settled(ws)
        await ws.close()
        for _ in range(100):   # the hub notices the close a moment later
            if not self.mirror.sources:
                break
            await asyncio.sleep(0.01)
        state = await self.state()
        self.assertEqual(state["sources"], 0)
        self.assertIsNone(state["stats"])

    async def test_one_log_line_every_30_s_while_pictures_arrive(self):
        ws, _hello = await self.source()

        async def lines_after(*, picture, seconds):
            """Stats sent after `seconds` more, with or without a picture before them: the log lines they made."""
            self.now += seconds
            with self.assertLogs("mirror", level="INFO") as logs:
                mirror_module.log.info("marker")   # assertLogs wants at least one line
                if picture:
                    await ws.send_bytes(JPEG)
                    await self.told(ws)
                await ws.send_json({"stats": self.STATS})
                await self.settled(ws)
            return [r.getMessage() for r in logs.records if r.getMessage().startswith("mirror stats")]

        self.assertEqual(await lines_after(picture=False, seconds=0), [])     # no picture yet: nothing to report
        first = await lines_after(picture=True, seconds=1)
        self.assertEqual(len(first), 1)
        self.assertIn("'kB': 48.3", first[0])
        self.assertEqual(await lines_after(picture=True, seconds=1), [])      # a second later: too soon
        self.assertEqual(await lines_after(picture=True, seconds=28), [])     # 29 s after the line
        self.assertEqual(len(await lines_after(picture=True, seconds=1)), 1)  # 30 s after it
        self.assertEqual(await lines_after(picture=False, seconds=31), [])    # no picture since the last line
        self.assertEqual(len(await lines_after(picture=True, seconds=1)), 1)


class MonitorTest(MirrorCase):
    async def part(self, resp):
        """The next picture of an open /monitor.mjpg response."""
        head = await asyncio.wait_for(resp.content.readuntil(b"\r\n\r\n"), 2.0)
        lines = head.decode().split("\r\n")
        self.assertEqual(lines[0], f"--{BOUNDARY}")
        self.assertIn("Content-Type: image/jpeg", lines)
        length = int(next(l for l in lines if l.startswith("Content-Length:")).split(":")[1])
        body = await asyncio.wait_for(resp.content.readexactly(length), 2.0)
        self.assertEqual(await asyncio.wait_for(resp.content.readexactly(2), 2.0), b"\r\n")
        return body

    async def test_viewers_are_the_streams_that_are_open(self):
        ws, hello = await self.source()
        self.assertEqual(hello["viewers"], 0)
        resp = await self.client.get("/monitor.mjpg")
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers["Content-Type"], f"multipart/x-mixed-replace; boundary={BOUNDARY}")
        self.assertEqual(await self.told(ws), {"viewers": 1, "acks": True})
        self.assertEqual((await self.state())["viewers"], 1)
        second = await self.client.get("/monitor.mjpg")
        self.assertEqual(await self.told(ws), {"viewers": 2, "acks": True})
        second.close()
        self.assertEqual(await self.told(ws), {"viewers": 1, "acks": True})
        resp.close()
        self.assertEqual(await self.told(ws), {"viewers": 0, "acks": True})
        self.assertEqual((await self.state())["viewers"], 0)

    async def test_the_stream_delivers_the_picture_that_was_sent(self):
        ws, _hello = await self.source()
        resp = await self.client.get("/monitor.mjpg")
        self.addCleanup(resp.close)
        await self.told(ws)   # viewers: 1
        await ws.send_bytes(JPEG)
        self.assertEqual(await self.told(ws), {"ack": 1})
        self.assertEqual(await self.part(resp), JPEG)
        await ws.send_bytes(NOT_A_JPEG)   # never reaches a monitor
        await ws.send_bytes(JPEG_2)
        self.assertEqual(await self.part(resp), JPEG_2)

    async def test_a_monitor_that_opens_later_gets_the_picture_the_hub_has(self):
        ws, _hello = await self.source()
        await ws.send_bytes(JPEG)
        await self.told(ws)
        resp = await self.client.get("/monitor.mjpg")
        self.addCleanup(resp.close)
        self.assertEqual(await self.part(resp), JPEG)

    async def test_a_recording_counts_as_one_more_viewer(self):
        # The recorder is the hub's; the mirror only asks whether it is on.
        self.mirror.recorder = FakeRecorder(on=True)
        ws, hello = await self.source()
        self.assertEqual(hello, {"viewers": 1, "acks": True})   # no page open, and pictures are still wanted
        self.assertEqual((await self.state())["viewers"], 0)    # pages watching, as before
        resp = await self.client.get("/monitor.mjpg")
        self.assertEqual(await self.told(ws), {"viewers": 2, "acks": True})
        self.mirror.recorder.on = False
        resp.close()
        self.assertEqual(await self.told(ws), {"viewers": 0, "acks": True})

    async def test_the_state_keeps_its_fields(self):
        self.mirror.extra = lambda: {"rescue": None}   # as the hub adds it
        state = await self.state()
        self.assertEqual(state, {"sources": 0, "viewers": 0, "frames": 0, "ageS": None, "bytes": 0, "info": {},
                                 "from": None, "tune": None, "stats": None, "rescue": None})
        ws, _hello = await self.source()
        await ws.send_json({"info": {"width": 640, "height": 480, "ar": True}})
        await ws.send_bytes(JPEG)
        await self.told(ws)
        self.now += 1.5
        state = await self.state()
        self.assertEqual(state.pop("from"), "127.0.0.1")
        self.assertEqual(state, {"sources": 1, "viewers": 0, "frames": 1, "ageS": 1.5, "bytes": len(JPEG),
                                 "info": {"width": 640, "height": 480, "ar": True}, "tune": None, "stats": None,
                                 "rescue": None})

    async def test_the_page_is_served(self):
        resp = await self.client.get("/monitor")
        self.assertEqual(resp.status, 200)
        self.assertIn("text/html", resp.headers["Content-Type"])
        self.assertIn("/monitor.mjpg", await resp.text())


class OversizeTest(MirrorCase):
    async def test_a_message_that_is_too_large_ends_the_connection_only(self):
        ws, _hello = await self.source()
        await ws.send_bytes(b"\xff\xd8" + b"\x00" * mirror_module.MAX_FRAME)
        msg = await asyncio.wait_for(ws.receive(), 2.0)
        self.assertIn(msg.type, (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED))
        self.assertEqual(self.mirror.seq, 0)
        _ws, hello = await self.source()   # the hub is still there for the next connection
        self.assertEqual(hello, {"viewers": 0, "acks": True})


if __name__ == "__main__":
    unittest.main()
