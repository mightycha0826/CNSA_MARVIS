"""Run from jetson/:  .venv/bin/python -m unittest discover tests"""
import unittest

from marswalk.alerts import SuitTempAlert
from marswalk.intents import parse
from marswalk.speech import status_sentence, temp_words


class AlertTest(unittest.TestCase):
    def run_seq(self, temps):
        a = SuitTempAlert()
        return [m for t in temps for m in a.update(t)]

    def kinds(self, temps):
        return [(t, p.get("level")) for t, p in self.run_seq(temps)]

    def test_level_follows_the_temperature_down(self):
        # 33.9 is under the critical threshold by more than the margin: back to warn.
        # 28.9 is under the warn threshold by more than the margin: cleared.
        self.assertEqual(self.kinds([25, 30, 31, 35, 34.5, 33.9, 31, 29.5, 28.9, 26]),
                         [("alert.raise", "warn"), ("alert.raise", "critical"),
                          ("alert.raise", "warn"), ("alert.clear", None)])

    def test_alarm_does_not_outlast_the_temperature(self):
        # The fault seen on the hub: critical was still raised at 29 degrees after a peak of 36.
        a = SuitTempAlert()
        for t in [24, 36, 32.6]:
            a.update(t)
        self.assertEqual(a.level, "warn")
        a.update(28.5)
        self.assertIsNone(a.level)

    def test_straight_to_critical_and_straight_back(self):
        self.assertEqual(self.kinds([24, 36, 24]), [("alert.raise", "critical"), ("alert.clear", None)])

    def test_no_alert_below_the_threshold(self):
        self.assertEqual(self.kinds([24, 29.9, 29.5, 29.99, 28]), [])

    def test_hysteresis_no_flapping(self):
        # hovering around a threshold raises once and does not clear inside the margin
        self.assertEqual(self.kinds([30, 29.5, 30.2, 29, 30]), [("alert.raise", "warn")])
        self.assertEqual(self.kinds([35, 34.5, 35.2, 34, 35])[1:], [])

    def test_easing_message(self):
        msgs = self.run_seq([36, 33])
        self.assertEqual(msgs[1][1]["message"], "Ambient temperature is high")

    def test_none_ignored(self):
        self.assertEqual(self.run_seq([None, None]), [])


class IntentTest(unittest.TestCase):
    CASES = {
        # short forms
        "Status.": ("status.report", {}),
        "Navigate": ("nav.start", {"targetId": "near"}),
        "Take me there": ("nav.start", {"targetId": "near"}),
        "Guide me to the nearby point": ("nav.start", {"targetId": "near"}),
        "base": ("nav.home", {}),
        "Stop.": ("nav.stop", {}),
        "Mark waypoint": ("nav.mark", {}),
        "thermal": ("layer.show", {"id": "thermal"}),
        "Elevation.": ("layer.show", {"id": "topo"}),
        "confirm": ("alert.ack", {}),
        "Emergency": ("sos.arm", {}),
        "Mayday, mayday.": ("sos.arm", {}),
        "Cancel rescue": ("sos.cancel", {}),
        "Cancel the rescue signal.": ("sos.cancel", {}),
        "Cancel": ("nav.stop", {}),
        # full sentences still work
        "Take me to the survey site": ("nav.start", {"targetId": "site1"}),
        "Guide me to the sulfur rocks.": ("nav.start", {"targetId": "site1"}),
        "Go back to base": ("nav.home", {}),
        "Return to base.": ("nav.home", {}),
        "Stop navigation": ("nav.stop", {}),
        "Mark here.": ("nav.mark", {}),
        "Show the thermal map": ("layer.show", {"id": "thermal"}),
        "show the slope": ("layer.show", {"id": "slope"}),
        "Status report": ("status.report", {}),
        "Acknowledge alert": ("alert.ack", {}),
        # as the STT sometimes writes them
        "Show the thermo mat.": ("layer.show", {"id": "thermal"}),
        "takeme to the survey site": ("nav.start", {"targetId": "site1"}),
        "Statis.": ("status.report", {}),
        "Acknowlege": ("alert.ack", {}),
    }

    def test_examples(self):
        for text, (intent, slots) in self.CASES.items():
            with self.subTest(text=text):
                r = parse(text)
                self.assertIsNotNone(r)
                self.assertEqual((r["intent"], r["slots"]), (intent, slots))

    def test_wake_word(self):
        self.assertIsNone(parse("take me to the survey site", wake="helmet"))
        self.assertEqual(parse("Helmet, take me to the survey site.", wake="helmet")["intent"],
                         "nav.start")
        self.assertEqual(parse("Helmets status", wake="helmet")["intent"], "status.report")

    def test_unknown_dropped(self):
        # The last ones were commands until the list was pruned: ordinary words must do nothing.
        for text in ["what is for lunch today", "", "shop", "the", "bass", "Night mode", "copy that",
                     "let's go home", "take a photo", "Clear target", "what's the situation"]:
            with self.subTest(text=text):
                self.assertIsNone(parse(text))

    def test_custom_file_and_reload(self):
        import json, os, tempfile, time
        from marswalk.intents import CommandSet
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "c.json")
            def write(cmds):
                with open(path, "w") as f:
                    json.dump({"commands": cmds}, f)
            write([{"intent": "greet", "phrases": ["hello"], "reply": "Visor online"}])
            cs = CommandSet(path)
            r = cs.parse("Hello there")
            self.assertEqual((r["intent"], r["reply"]), ("greet", "Visor online"))
            self.assertIsNone(cs.parse("photograph"))
            write([{"intent": "camera.shot", "phrases": ["photograph", "take a picture"]}])
            os.utime(path, (time.time() + 5, time.time() + 5))   # make the change visible
            self.assertEqual(cs.parse("photograph")["intent"], "camera.shot")
            with open(path, "w") as f:
                f.write("{ not json")
            os.utime(path, (time.time() + 9, time.time() + 9))
            self.assertEqual(cs.parse("photograph")["intent"], "camera.shot")  # old set kept


class MenuTest(unittest.TestCase):
    def test_menu_is_short_and_carries_the_mode(self):
        from marswalk.intents import menu
        entries = menu()[1]
        self.assertEqual([e["say"] for e in entries],
                         ["Status", "Navigate", "Base", "Mark waypoint", "Stop", "Confirm"])
        modes = {e["say"]: e.get("mode") for e in entries}
        # "Mark waypoint" works on both maps (it used to be "Mark target", on the field map only).
        self.assertEqual((modes["Base"], modes["Mark waypoint"], modes["Stop"]), ("mars", None, None))


class SpeechTest(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual(temp_words(24.5), "twenty-four point five degrees")
        self.assertEqual(temp_words(30.0), "thirty degrees")
        self.assertEqual(temp_words(110.04), "one hundred ten degrees")
        self.assertEqual(temp_words(-3.2), "minus three point two degrees")
        self.assertEqual(temp_words(0), "zero degrees")
        self.assertEqual(temp_words(1), "one degree")

    def test_status(self):
        s = status_sentence(36.0, "arduino",
                            {"suit-temp": {"level": "critical"}}, {"navStatus": "ok"})
        self.assertEqual(s, "Ambient temperature thirty-six degrees. One critical alert. "
                            "Route guidance active.")
        self.assertEqual(status_sentence(None, "arduino", {}, {}),
                         "Ambient temperature sensor is not responding. No alerts.")


class MapStoreTest(unittest.TestCase):
    """The field map on disk, in tiles (marswalk/maps.py)."""

    def tile(self, x=0, z=0, obstacle_cells=3):
        # a 4 x 4 tile: `obstacle_cells` obstacles, then floor, then unseen
        return {"x": x, "z": z, "runs": [1, obstacle_cells, 0, 5, 255, 16 - 5 - obstacle_cells]}

    def payload(self, run="abc-0", tiles=None):
        return {"run": run, "cellSizeM": 0.1, "tileCells": 4,
                "tiles": [self.tile()] if tiles is None else tiles,
                "source": "room-scan+depth", "stats": {"obstacles": 3}}

    def test_a_run_is_one_file_holding_the_latest_of_each_tile(self):
        import json
        import tempfile
        from marswalk.maps import MapStore
        with tempfile.TemporaryDirectory() as d:
            store = MapStore(d)
            self.assertIsNone(store.latest)
            self.assertIsNone(store.stored())
            path = store.save(self.payload(tiles=[self.tile(0, 0, 3), self.tile(-1, 2, 1)]))
            # the next update brings one changed tile and one new one; the third is not in it
            self.assertEqual(store.save(self.payload(tiles=[self.tile(0, 0, 4), self.tile(5, -7, 2)])), path)
            data = json.loads(path.read_text())
            self.assertEqual(sorted(data["tiles"]), ["-1,2", "0,0", "5,-7"])
            self.assertEqual(data["tiles"]["0,0"][:2], [1, 4])     # replaced by the later update
            self.assertEqual(data["tiles"]["-1,2"][:2], [1, 1])    # kept from the first
            self.assertEqual((data["updates"], data["tileCells"], data["cellSizeM"]), (2, 4, 0.1))
            other = store.save(self.payload(run="abc-1"))
            self.assertNotEqual(other, path)                   # new coordinates: the old map is kept as it was
            self.assertEqual(len(list(path.parent.glob("field-*.json"))), 2)
            self.assertEqual(len(json.loads(path.read_text())["tiles"]), 3)

    def test_the_newest_run_is_handed_back_as_a_list_of_tiles(self):
        import tempfile
        from marswalk.maps import MapStore
        with tempfile.TemporaryDirectory() as d:
            store = MapStore(d)
            store.save(self.payload(run="old-0", tiles=[self.tile(9, 9)]))
            store.save(self.payload(tiles=[self.tile(0, 0, 3), self.tile(-1, 2, 1)]))
            store.save(self.payload(tiles=[self.tile(0, 0, 4)]))
            m = store.stored()
            self.assertEqual((m["run"], m["cellSizeM"], m["tileCells"], m["updates"]), ("abc-0", 0.1, 4, 2))
            self.assertEqual(sorted((t["x"], t["z"], t["runs"][1]) for t in m["tiles"]), [(-1, 2, 1), (0, 0, 4)])
            self.assertTrue(m["startedAt"] and m["savedAt"])
            self.assertEqual(sorted(m), ["cellSizeM", "run", "savedAt", "startedAt", "tileCells", "tiles", "updates"])

    def test_the_newest_run_survives_a_restart_and_goes_on_in_its_file(self):
        import json
        import tempfile
        from marswalk.maps import MapStore
        with tempfile.TemporaryDirectory() as d:
            store = MapStore(d)
            store.save(self.payload(run="abc-0", tiles=[self.tile(1, 1)]))
            path = store.save(self.payload(run="abc-1", tiles=[self.tile(0, 0, 3), self.tile(-1, 2, 1)]))
            # after a restart of the hub the newest map is still there to hand back
            again = MapStore(d)
            self.assertEqual(again.latest["run"], "abc-1")
            self.assertEqual(sorted((t["x"], t["z"]) for t in again.stored()["tiles"]), [(-1, 2), (0, 0)])
            # the headset is still in that run: its next tiles join the ones from before the restart
            self.assertEqual(again.save(self.payload(run="abc-1", tiles=[self.tile(3, 0, 2)])), path)
            data = json.loads(path.read_text())
            self.assertEqual((sorted(data["tiles"]), data["updates"]), (["-1,2", "0,0", "3,0"], 2))
            # so does an older run that is not the newest: it finds its own file again
            first = again.save(self.payload(run="abc-0", tiles=[self.tile(2, 2)]))
            self.assertEqual(sorted(json.loads(first.read_text())["tiles"]), ["1,1", "2,2"])
            self.assertEqual(len(list(path.parent.glob("field-*.json"))), 2)

    def test_files_that_are_not_maps_in_tiles_are_skipped(self):
        import json
        import os
        import tempfile
        import time
        from pathlib import Path
        from marswalk.maps import MapStore
        with tempfile.TemporaryDirectory() as d:
            good = MapStore(d).save(self.payload())
            # newer than the good one: a map from before the tiles, a broken tile, and no JSON at all
            old_format = {"run": "old-0", "originXZ": [-8, -8], "cellSizeM": 0.1, "cols": 4, "rows": 4,
                          "runs": [255, 16], "savedAt": "2026-01-01T00:00:00", "updates": 1}
            bad_tile = {"run": "bad-0", "cellSizeM": 0.1, "tileCells": 4, "tiles": {"0,0": [1, 15]}}
            later = time.time() + 5
            for name, text in (("field-20990101-000000-old-0.json", json.dumps(old_format)),
                               ("field-20990101-000001-bad-0.json", json.dumps(bad_tile)),
                               ("field-20990101-000002-junk.json", "{ not json")):
                path = Path(d) / name
                path.write_text(text)
                os.utime(path, (later, later))
            store = MapStore(d)
            self.assertEqual(store.latest["run"], "abc-0")
            self.assertEqual(store.files["abc-0"], good)

    def test_what_is_not_a_map_is_refused(self):
        from marswalk.maps import MAX_TILE, MAX_TILES, check
        ok = check(self.payload())
        self.assertEqual(ok["tiles"], {"0,0": [1, 3, 0, 5, 255, 8]})
        for change in ({"run": "../etc"}, {"run": 7}, {"cellSizeM": 0}, {"cellSizeM": "0.1"}, {"cellSizeM": True},
                       {"tileCells": 0}, {"tileCells": 100000}, {"tileCells": 4.0}, {"tileCells": None},
                       {"tiles": "x"}, {"tiles": {"0,0": [0, 16]}}, {"tiles": [[0, 0, [0, 16]]]},
                       {"tiles": [{"x": 0, "z": 0}]},                         # no runs
                       {"tiles": [{"x": 0.5, "z": 0, "runs": [0, 16]}]},      # not a tile number
                       {"tiles": [{"x": "0", "z": 0, "runs": [0, 16]}]},
                       {"tiles": [{"x": True, "z": 0, "runs": [0, 16]}]},
                       {"tiles": [{"x": MAX_TILE + 1, "z": 0, "runs": [0, 16]}]},
                       {"tiles": [{"x": 0, "z": -MAX_TILE - 1, "runs": [0, 16]}]},
                       {"tiles": [{"x": 0, "z": 0, "runs": [1, 3, 0, 5]}]},   # too few cells
                       {"tiles": [{"x": 0, "z": 0, "runs": [0, 17]}]},        # too many
                       {"tiles": [{"x": 0, "z": 0, "runs": [2, 16]}]},        # not a cell value
                       {"tiles": [{"x": 0, "z": 0, "runs": [0, -1, 0, 17]}]},
                       {"tiles": [{"x": 0, "z": 0, "runs": [0, 16.0]}]},
                       {"tiles": [{"x": 0, "z": 0, "runs": [0, 16, 1]}]},
                       {"tiles": [{"x": 0, "z": 0, "runs": "x"}]},
                       {"tiles": [self.tile(), {"x": 1, "z": 0, "runs": [0, 15]}]},   # one bad tile spoils the update
                       {"tiles": [self.tile(i, 0) for i in range(MAX_TILES + 1)]}):
            with self.subTest(change=str(change)[:80]), self.assertRaises(ValueError):
                check({**self.payload(), **change})
        for not_an_object in (None, [], "map", 3):
            with self.subTest(payload=not_an_object), self.assertRaises(ValueError):
                check(not_an_object)

    def test_a_refused_update_leaves_the_run_as_it_was(self):
        import json
        import tempfile
        from marswalk.maps import MapStore
        with tempfile.TemporaryDirectory() as d:
            store = MapStore(d)
            path = store.save(self.payload(tiles=[self.tile(0, 0, 3)]))
            before = path.read_text()
            with self.assertRaises(ValueError):
                store.save(self.payload(tiles=[self.tile(0, 0, 4), {"x": 1, "z": 0, "runs": [0, 15]}]))
            with self.assertRaises(ValueError):   # another tile size in the same run
                store.save({**self.payload(tiles=[{"x": 1, "z": 0, "runs": [0, 4]}]), "tileCells": 2})
            self.assertEqual(path.read_text(), before)
            self.assertEqual(store.latest["updates"], 1)
            self.assertEqual(json.loads(before)["tiles"], {"0,0": [1, 3, 0, 5, 255, 8]})

    def test_a_run_holds_no_more_than_its_share_of_tiles(self):
        import tempfile
        from unittest import mock
        from marswalk import maps
        with tempfile.TemporaryDirectory() as d, mock.patch.object(maps, "MAX_TILES", 3):
            store = maps.MapStore(d)
            store.save(self.payload(tiles=[self.tile(i, 0) for i in range(3)]))
            # full: a new tile is dropped, a tile the run has is still updated
            with self.assertLogs("maps", level="WARNING"):
                store.save(self.payload(tiles=[self.tile(7, 7), self.tile(1, 0, 6)]))
            tiles = store.latest["tiles"]
            self.assertEqual(sorted(tiles), ["0,0", "1,0", "2,0"])
            self.assertEqual(tiles["1,0"][:2], [1, 6])


if __name__ == "__main__":
    unittest.main()


class MirrorTuneTest(unittest.TestCase):
    def test_numbers_are_held_to_their_ranges_and_junk_is_dropped(self):
        from marswalk.mirror import clean_tune
        self.assertEqual(clean_tune({"fovDeg": 58, "tiltDeg": -3.26}), {"fovDeg": 58.0, "tiltDeg": -3.3})
        self.assertEqual(clean_tune({"fovDeg": 500, "tiltDeg": -90}), {"fovDeg": 110.0, "tiltDeg": -25.0})
        self.assertEqual(clean_tune({"fovDeg": "wide", "tiltDeg": 2}), {"tiltDeg": 2.0})
        for junk in (None, [], {}, {"fovDeg": True}, {"fovDeg": float("nan")}):
            self.assertIsNone(clean_tune(junk))

    def test_a_tune_is_kept_for_the_next_start(self):
        import json
        import tempfile
        from pathlib import Path
        from marswalk.mirror import Mirror
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "tune.json"
            path.write_text(json.dumps({"fovDeg": 61, "tiltDeg": 4}))
            self.assertEqual(Mirror(path).tune, {"fovDeg": 61.0, "tiltDeg": 4.0})
            self.assertIn('"tune"', Mirror(path)._hello())
            self.assertIsNone(Mirror(Path(d) / "none.json").tune)


class DictationTest(unittest.TestCase):
    """After voice.dictate the next words of that headset come back as text, not as a command."""

    def run_utterance(self, heard, client):
        import asyncio
        import json
        from marswalk.hub import Hub

        class Stt:
            def transcribe(self, samples, rate):
                return heard

        class Socket:
            sent = []

            async def send_str(self, text):
                self.sent.append(json.loads(text))

        class Stub:
            stt = Stt()
            commands = []

            def _keep_audio(self, *a):
                pass

            def _note_heard(self, *a):
                pass

            async def handle_text_command(self, text):
                self.commands.append(text)

        stub, ws = Stub(), Socket()
        ws.sent, stub.commands = [], []
        client.ws = ws
        asyncio.run(Hub.handle_utterance(stub, b"", 16000, client))
        return ws.sent, stub.commands

    @staticmethod
    def client(dictate):
        from marswalk.hub import Client
        return Client(ws=None, peer="test", dictate=dictate)

    def test_words_after_a_request_are_sent_back_and_are_no_command(self):
        import time
        client = self.client({"id": 7, "until": time.monotonic() + 5})
        sent, commands = self.run_utterance("Rock sample by the door.", client)
        self.assertEqual(commands, [])
        self.assertEqual(sent[0]["type"], "voice.dictation")
        self.assertEqual(sent[0]["payload"], {"id": 7, "text": "Rock sample by the door."})
        self.assertIsNone(client.dictate)            # one utterance only
        sent, commands = self.run_utterance("navigate", client)
        self.assertEqual((sent, commands), ([], ["navigate"]))

    def test_a_noise_keeps_it_listening_and_a_late_word_is_a_command_again(self):
        import time
        client = self.client({"id": 1, "until": time.monotonic() + 5})
        self.assertEqual(self.run_utterance("", client), ([], []))
        self.assertIsNotNone(client.dictate)
        client = self.client({"id": 1, "until": time.monotonic() - 1})
        self.assertEqual(self.run_utterance("stop", client), ([], ["stop"]))


class NewPhrasesTest(unittest.TestCase):
    def test_sos_words_waypoint_record_delete(self):
        for text, intent in [("SOS", "sos.arm"), ("S.O.S.", "sos.arm"), ("rescue", "sos.arm"), ("help me", "sos.arm"),
                             ("cancel rescue", "sos.cancel"), ("mark waypoint", "nav.mark"), ("record", "waypoint.record"),
                             ("delete", "mark.delete"), ("confirm", "alert.ack")]:
            self.assertEqual(parse(text)["intent"], intent, text)


class WaypointStoreTest(unittest.TestCase):
    def test_the_list_comes_back_as_it_was_stored(self):
        import tempfile
        from pathlib import Path
        from marswalk.maps import WaypointStore
        with tempfile.TemporaryDirectory() as d:
            store = WaypointStore(Path(d))
            self.assertIsNone(store.stored())
            store.save({"count": 3, "items": [
                {"id": "wp-a-1", "label": "Rock sample", "room": [1.23456, -2], "runs": ["r-0", "r-1"]},
                {"id": "wp-a-3", "label": "Lander", "cell": [247, 357]}]})
            kept = WaypointStore(Path(d)).stored()
            self.assertEqual(kept["count"], 3)
            self.assertEqual(kept["items"], [
                {"id": "wp-a-1", "label": "Rock sample", "room": [1.235, -2.0], "runs": ["r-0", "r-1"]},
                {"id": "wp-a-3", "label": "Lander", "cell": [247.0, 357.0]}])
            store.save({"items": []})                       # the last one was deleted
            self.assertEqual(store.stored()["items"], [])

    def test_junk_is_refused_and_leaves_the_file_alone(self):
        import tempfile
        from pathlib import Path
        from marswalk.maps import WaypointStore
        with tempfile.TemporaryDirectory() as d:
            store = WaypointStore(Path(d))
            store.save({"items": [{"id": "w", "label": "kept", "cell": [1, 2]}]})
            for bad in (None, {}, {"items": "x"}, {"items": [{"label": "no id", "cell": [1, 2]}]},
                        {"items": [{"id": "w", "room": [1, 2], "cell": [1, 2]}]},
                        {"items": [{"id": "w", "room": [1, float("nan")]}]},
                        {"items": [{"id": "w", "cell": [1]}]}):
                with self.assertRaises(ValueError):
                    store.save(bad)
            self.assertEqual(store.stored()["items"][0]["label"], "kept")
            long = store.save({"items": [{"id": "w", "label": "x" * 500, "room": [0, 0], "runs": [str(i) for i in range(30)]}]})
            self.assertEqual((len(long["items"][0]["label"]), len(long["items"][0]["runs"])), (80, 8))


class FakeRecorder:
    """What the hub hands to its recorder (record.py)."""

    def __init__(self, on=True):
        self.on = on
        self.got = []   # ("mic", pcm, rate, src) and ("speech", pcm, rate, urgent), as they came

    def mic(self, pcm, rate, at=None, src=None):
        self.got.append(("mic", pcm, rate, src))

    def speech(self, pcm, rate, at=None, urgent=False):
        self.got.append(("speech", pcm, rate, urgent))


class RecordingMicTest(unittest.TestCase):
    """While a recording runs, a headset's microphone goes into it: all of it, also what the
    hub does not listen to because it is speaking itself."""

    CHUNK = b"\x10\x00" * 1600

    class Segmenter:
        RATE = 16000

        def __init__(self):
            self.resets, self.fed = 0, []

        def reset(self):
            self.resets += 1

        def feed(self, data, rate):
            self.fed.append(data)
            return []

    @staticmethod
    def stub(recorder, mute_until=0.0):
        class Stub:
            pass
        stub = Stub()
        stub.recorder, stub.mute_until = recorder, mute_until
        return stub

    def test_the_microphone_is_recorded_between_begin_and_end_also_while_the_hub_speaks(self):
        import asyncio
        import time
        from marswalk.hub import Client, Hub
        rec = FakeRecorder()
        stub = self.stub(rec, mute_until=time.monotonic() + 60)   # the hub is speaking
        client = Client(ws=None, peer="10.42.0.7")
        Hub.on_audio(stub, client, self.CHUNK)
        self.assertEqual(rec.got, [])                # before mic.begin nothing says what this is
        asyncio.run(Hub.on_mic_begin(stub, client, {"sampleRate": 48000}))
        client.segmenter = seg = self.Segmenter()    # as a headset that streams has one
        Hub.on_audio(stub, client, self.CHUNK)
        self.assertEqual(rec.got, [("mic", self.CHUNK, 48000, id(client))])
        self.assertEqual((seg.resets, seg.fed), (1, []))          # recorded, but not listened to
        stub.mute_until = 0.0
        Hub.on_audio(stub, client, self.CHUNK)
        self.assertEqual((len(rec.got), seg.fed), (2, [self.CHUNK]))
        asyncio.run(Hub.on_mic_end(stub, client, {}))
        Hub.on_audio(stub, client, self.CHUNK)
        self.assertEqual(len(rec.got), 2)

    def test_push_to_talk_and_a_hub_without_a_recogniser_are_recorded_too(self):
        import asyncio
        from marswalk.hub import Client, Hub
        rec = FakeRecorder()
        stub = self.stub(rec)
        client = Client(ws=None, peer="test")
        asyncio.run(Hub.on_mic_begin(stub, client, {}))            # hold to talk, at the usual 16 kHz
        Hub.on_audio(stub, client, self.CHUNK)
        self.assertEqual(rec.got, [("mic", self.CHUNK, 16000, id(client))])
        self.assertEqual(bytes(client.mic_buf), self.CHUNK)        # and it is still an utterance for the hub
        client.mic_on = False    # a stream on a hub that has no model to cut it into utterances
        Hub.on_audio(stub, client, self.CHUNK)
        self.assertEqual(len(rec.got), 2)

    def test_nothing_goes_to_a_recorder_that_is_off(self):
        import asyncio
        from marswalk.hub import Client, Hub
        rec = FakeRecorder(on=False)
        client = Client(ws=None, peer="test")
        asyncio.run(Hub.on_mic_begin(self.stub(rec), client, {}))
        Hub.on_audio(self.stub(rec), client, self.CHUNK)
        self.assertEqual(rec.got, [])

    def test_two_connections_from_one_address_are_two_streams(self):
        import asyncio
        from marswalk.hub import Client, Hub
        rec = FakeRecorder()
        stub = self.stub(rec)
        one, two = Client(ws=None, peer="127.0.0.1"), Client(ws=None, peer="127.0.0.1")
        for client in (one, two):
            asyncio.run(Hub.on_mic_begin(stub, client, {}))
            Hub.on_audio(stub, client, self.CHUNK)
        self.assertNotEqual(rec.got[0][3], rec.got[1][3])


class RecordingSpeechTest(unittest.TestCase):
    """What the hub says goes into the recording at the moment it goes out to the headsets."""

    PCM = b"\x01\x02" * 5000

    def say(self, recorder, priority="normal", clients=1):
        import asyncio
        from marswalk.hub import Hub
        events, pcm = [], self.PCM

        class Tts:
            sample_rate = 22050

            def synthesize(self, text):
                return pcm

        class Stub:
            tts = Tts()
            say_epoch = 0
            mute_until = 0.0

            async def broadcast(self, type_, payload, exclude=None):
                events.append(type_)

            async def broadcast_bytes(self, data):
                events.append(len(data))

        stub = Stub()
        stub.recorder, stub.clients = recorder, set(range(clients))
        taken = recorder.speech
        recorder.speech = lambda *a, **kw: (events.append("recorded"), taken(*a, **kw))

        async def run():
            stub.tts_lock = asyncio.Lock()
            await Hub.say(stub, "Route recalculated.", priority)
        asyncio.run(run())
        return events

    def test_the_whole_utterance_is_handed_over_as_it_begins_to_go_out(self):
        rec = FakeRecorder()
        self.assertEqual(self.say(rec), ["tts.begin", "recorded", 4096, 4096, 1808, "tts.end"])
        self.assertEqual(rec.got, [("speech", self.PCM, 22050, False)])

    def test_urgent_speech_is_marked_so_it_cuts_the_one_before_it_in_the_recording_too(self):
        rec = FakeRecorder()
        self.say(rec, "urgent")
        self.assertEqual(rec.got, [("speech", self.PCM, 22050, True)])

    def test_no_recording_or_nobody_to_hear_it_and_nothing_is_handed_over(self):
        rec = FakeRecorder(on=False)
        self.assertEqual(self.say(rec), ["tts.begin", 4096, 4096, 1808, "tts.end"])
        rec = FakeRecorder()
        self.assertNotIn("recorded", self.say(rec, clients=0))
        self.assertEqual(rec.got, [])


def hub_args(folder, **more):
    """The options of a hub that needs no models and no sensor, and writes into `folder` only."""
    import argparse
    return argparse.Namespace(serial="none", stt="null", tts="tone", lang="en", warn_c=30.0, critical_c=35.0,
                              margin_c=1.0, wake_word=None, keep_audio=0, dev=False, static=None,
                              maps_dir=str(folder / "maps"), recordings_dir=str(folder / "recordings"), **more)


class HubRecorderTest(unittest.TestCase):
    def test_the_options_reach_the_recorder_and_the_mirror_has_it(self):
        import tempfile
        from pathlib import Path
        from marswalk.hub import Hub
        with tempfile.TemporaryDirectory() as d:
            hub = Hub(hub_args(Path(d), record_max_min=5.0, no_convert=True))
            self.assertEqual((hub.recorder.folder, hub.recorder.max_seconds, hub.recorder.convert),
                             (Path(d) / "recordings", 300.0, False))
            self.assertIs(hub.mirror.recorder, hub.recorder)
            self.assertFalse((Path(d) / "recordings").exists())    # made with the first recording, not before
            hub = Hub(hub_args(Path(d), record_max_min=30.0, no_convert=False))
            self.assertEqual((hub.recorder.max_seconds, hub.recorder.convert), (1800.0, True))


try:
    from aiohttp.test_utils import AioHTTPTestCase
except ImportError:      # the rest of this file needs no aiohttp
    AioHTTPTestCase = None


@unittest.skipIf(AioHTTPTestCase is None, "needs aiohttp")
class WholeHubRecordingTest(AioHTTPTestCase or unittest.TestCase):
    """A whole hub (no models, the beep for a voice) behind a test server: a headset's pictures,
    its microphone and the hub's own speech end up in one file."""

    PICTURE = b"\xff\xd8\xff\xc0\x00\x0b\x08\x00\x30\x00\x40\x01\x01\x11\x00\xff\xd9"   # a frame header of 64 x 48, no more

    def setUp(self):
        import tempfile
        from pathlib import Path
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        super().setUp()

    async def get_application(self):
        from marswalk.hub import Hub, build_app
        self.hub = Hub(hub_args(self.folder, record_max_min=30.0, no_convert=True))
        self.hub.recorder.min_free_bytes = self.hub.recorder.stop_free_bytes = 0   # whatever this machine's disk has
        return build_app(self.hub)

    async def headset(self):
        """The two connections of the app: the messages and the voices, and the pictures."""
        ws = await self.client.ws_connect("/ws")
        pictures = await self.client.ws_connect("/mirror")
        self.addAsyncCleanup(ws.close)
        self.addAsyncCleanup(pictures.close)
        await pictures.receive_json()
        return ws, pictures

    async def record(self, on):
        resp = await self.client.post("/monitor/record", json={"on": on})
        self.assertEqual(resp.status, 200)
        return (await resp.json())["recording"]

    @staticmethod
    def message(type_, payload):
        import json
        return json.dumps({"type": type_, "ts": 0, "payload": payload})

    async def test_pictures_microphone_and_speech_are_in_the_file(self):
        import asyncio
        import json
        import struct
        from aiohttp import WSMsgType
        from marswalk import record
        ws, pictures = await self.headset()
        name = (await self.record(True))["name"]
        self.assertEqual(await pictures.receive_json(), {"viewers": 1, "acks": True})
        await asyncio.sleep(0.15)    # so the first 100 ms of microphone lie inside the recording
        await pictures.send_bytes(self.PICTURE)
        await ws.send_str(self.message("mic.begin", {"sampleRate": 16000}))
        await ws.send_bytes(struct.pack("<1600h", *[1000] * 1600))
        await asyncio.sleep(0.2)     # the hub's speech turns the microphone down: let it be over first
        await ws.send_str(self.message("voice.say", {"text": "Base has your signal."}))
        while True:                  # the beep comes back to the headset
            msg = await asyncio.wait_for(ws.receive(), 5.0)
            if msg.type == WSMsgType.TEXT and json.loads(msg.data)["type"] == "tts.end":
                break
        await asyncio.sleep(0.4)     # the headset is still playing it
        end = await self.record(False)
        self.assertEqual((end["on"], end["name"], end["frames"]), (False, name, 1))
        path = self.folder / "recordings" / f"{name}.mkv"
        self.assertGreater(record.mkv_seconds(path), 0.7)
        try:                                   # the small Matroska reader of the recorder's tests
            from test_record import blocks, read
        except ImportError:                    # run as tests.test_hub_units
            from tests.test_record import blocks, read
        found = blocks(read(path)[0])          # (ms, track, flags, data)
        self.assertEqual({data for _ms, track, _flags, data in found if track == 1}, {self.PICTURE})
        self.assertEqual(end["audio"], record.np is not None)
        if record.np is None:
            return
        sound = record.np.frombuffer(b"".join(data for _ms, track, _flags, data in found if track == 2), "<i2").astype(int)
        self.assertGreater(int((sound == 1000).sum()), 4000)   # the microphone's 100 ms, brought to 48 kHz
        self.assertGreater(int(abs(sound).max()), 6000)        # the hub's beep, far louder than that

    async def test_a_recording_that_runs_is_finished_when_the_hub_ends(self):
        from marswalk import record
        _ws, pictures = await self.headset()
        name = (await self.record(True))["name"]
        await pictures.receive_json()
        await pictures.send_bytes(self.PICTURE)
        self.assertEqual(await pictures.receive_json(), {"ack": 1})
        await self.app.shutdown()    # the first thing a hub does when it is told to end
        self.assertFalse(self.hub.recorder.on)
        path = self.folder / "recordings" / f"{name}.mkv"
        self.assertIsNotNone(record.mkv_seconds(path))    # its length is written: the file was closed properly
        self.assertIn(self.PICTURE, path.read_bytes())
        self.assertEqual(self.hub.recorder.recordings()[0]["state"], "master only")   # no MP4 begun that would be cut off
        with self.assertLogs("mirror", "WARNING"):
            resp = await self.client.post("/monitor/record", json={"on": True})
        self.assertEqual(resp.status, 409)                # and none begins on a hub that is ending
