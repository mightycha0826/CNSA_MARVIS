"""The recorder (marswalk/record.py). Run from jetson/:  .venv/bin/python -m unittest discover tests

Everything but the last class runs without GStreamer: the files are read back by the small
Matroska reader below, and the conversion is stood in for by a one-line Python program.
"""
import base64
import errno
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from marswalk import record
from marswalk.record import AudioMix, MkvWriter, RecordError, Recorder, jpeg_size, mkv_seconds

# Two small JPEGs, made once with
#   gst-launch-1.0 videotestsrc num-buffers=1 pattern=smpte ! video/x-raw,width=64,height=48 ! jpegenc quality=40 ! filesink
#   gst-launch-1.0 videotestsrc num-buffers=1 pattern=ball ! video/x-raw,width=80,height=32 ! jpegenc quality=40 ! filesink
JPEG_64x48 = base64.b64decode("""
/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKB
TmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8
fHz/wAARCAAwAEADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQID
AAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlq
c3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3
+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEI
FEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImK
kpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDq
6AKzfeP1r5qv/Fl6s2WxSn/1zV9Ll3+7R+f5s+bx3+8S+X5IqzfeH0rjzD+KvT/M54bFO6/h/GuzKPt/L9T6bIf+Xny/UpzfcH1rszD+
EvX/ADPpoblWf/UtXHl3+8x+f5M58d/u8vl+aKdfVnzR6dXyhuVm+8frXzVf+LL1ZstilP8A65q+ly7/AHaPz/NnzeO/3iXy/JFWb7w+
lceYfxV6f5nPDYp3X8P412ZR9v5fqfTZD/y8+X6lOb7g+tdmYfwl6/5n00NyrP8A6lq48u/3mPz/ACZz47/d5fL80U6+rPmj06vlDcrN
94/Wvmq/8WXqzZbFKf8A1zV9Ll3+7R+f5s+bx3+8S+X5IqzfeH0rjzD+KvT/ADOeGxTuv4fxrsyj7fy/U+myH/l58v1Kc33B9a7Mw/hL
1/zPpoblWf8A1LVx5d/vMfn+TOfHf7vL5fminX1Z80enV8oblZvvH6181X/iy9WbLYpT/wCuavpcu/3aPz/NnzeO/wB4l8vyRVm+8PpX
HmH8Ven+Zzw2Kd1/D+NdmUfb+X6n02Q/8vPl+pTm+4PrXZmH8Jev+Z9NDcqz/wCpauPLv95j8/yZz47/AHeXy/NFOvqz5oi87/Z/Wuf2
/ked9e/u/j/wDd0zwx/aVjHd/a/K8zd8vlZxgkdc+1eFXX72R6VCp7SmpWJ9S07+wtOifzfP/ebMbdvXJz1PpXZg5c/7vsexha+ns7bH
O3dx9plD7duFxjOa6KuD9pK/N+BVel7WXNexPpOq/YDKPJ8zzMfxYxjPt715MJ8p4GJw3t7a2sWNR1T+0bZY/J8vD7s7s9iPT3pzqcyt
YnD4T2EubmuWtJsXsLyC83q+DhUPy7ywxgHvye2eAenAOR2m8+vsYhJDZl/m2sDIBjgkEdfl4PPHTNAHA17Z8seheF/+QBa/8D/9DNeX
iP4jPfwf8CPz/MqeNP8AkExf9dx/6C1dGX/xX6f5HqYX436HEV7R6JHH978K+WPELKfdFAHXGNFcPIUfdI2Xdd249gADg5Gfc56DdQBA
riRB5G5ZZRskKKOCx5O3Pf5cEdiT9QD/2Q==
""")
JPEG_80x32 = base64.b64decode("""
/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKB
TmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8
fHz/wAARCAAgAFADAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQID
AAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlq
c3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3
+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEI
FEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImK
kpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDk
qACgBQCxAAyTwBQB3WgaFHZQrPOoe4YZ5/hoA3aACgDL1nRYdThJChZwPlcf1oA8+mieCV4pBh0OCKAGUAFABQAUAanhy3W51iFWGQuW
I+lAHolABQAUAFAHDeMLdYdTWRRjzUyfrQBgUAFABQAUAa3hiZYdahLHAYFfzoA9CoAKACgAoA4jxlMsmpRxg5Mac/jQBz1ABQAUAFAD
kdo3V0OGU5BoA9C0TV4tTtlBYCdRh1/rQBqUAFAFLU9Sh022MkrDdj5V7k0AedXVw93cSTynLOcmgCGgAoA//9k=
""")
JPEGS = [JPEG_64x48, JPEG_80x32]

needs_numpy = unittest.skipIf(record.np is None, "the sound needs numpy")
np = record.np


# ---------- a small Matroska reader, written apart from the writer ----------
SEGMENT, INFO, TRACKS, ENTRY, CLUSTER = 0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0x1F43B675
SEEK_HEAD, SEEK, CUES, CUE_POINT, CUE_PLACE, VOID = 0x114D9B74, 0x4DBB, 0x1C53BB6B, 0xBB, 0xB7, 0xEC
HOLDERS = (0x1A45DFA3, SEGMENT, INFO, TRACKS, ENTRY, 0xE0, 0xE1, CLUSTER, SEEK_HEAD, SEEK, CUES, CUE_POINT, CUE_PLACE)   # they hold elements


def number_at(data, at):
    """An EBML number: its bytes as one number (the length marker still in it), and how many bytes."""
    n = 1
    while not data[at] & (0x100 >> n):
        n += 1
    return int.from_bytes(data[at:at + n], "big"), n


def parse(data, at=0, end=None):
    """A Matroska file as a list of (id, value, open): value is such a list again for the elements
    that hold others, bytes for the rest; open says that the element's length was left open.
    An element that runs past the one that holds it fails here."""
    end = len(data) if end is None else end
    out = []
    while at < end:
        id_, n = number_at(data, at)
        at += n
        size, n = number_at(data, at)
        at += n
        size -= 1 << 7 * n
        is_open = size == (1 << 7 * n) - 1
        stop = end if is_open else at + size
        if stop > end:
            raise AssertionError(f"element {id_:X} runs {stop - end} bytes past its holder")
        out.append((id_, parse(data, at, stop) if id_ in HOLDERS else data[at:stop], is_open))
        at = stop
    return out


def some(elements, id_):
    return [value for i, value, _ in elements if i == id_]


def one(elements, id_):
    found = some(elements, id_)
    if len(found) != 1:
        raise AssertionError(f"{len(found)} elements {id_:X}, one expected")
    return found[0]


def number(raw):
    return int.from_bytes(raw, "big")


def blocks(segment):
    """The blocks of a file in the order they stand in it: (ms, track, flags, data)."""
    out = []
    for cluster in some(segment, CLUSTER):
        base = number(one(cluster, 0xE7))
        for raw in some(cluster, 0xA3):
            rel, flags = struct.unpack(">hB", raw[1:4])
            out.append((base + rel, raw[0] & 0x7F, flags, raw[4:]))
    return out


def read(path):
    """A file's segment, and whether its length was left open."""
    top = parse(Path(path).read_bytes())
    return one(top, SEGMENT), [is_open for i, _, is_open in top if i == SEGMENT][0]


def cues(path):
    """The cues of a finished file, found the way a player finds them: [(ms, track, the id that stands at the place)]."""
    raw = Path(path).read_bytes()
    body = raw.index(bytes.fromhex("18538067")) + 4 + 8        # places are counted from the segment's first byte
    segment = one(parse(raw), SEGMENT)
    pointer = one(one(segment, SEEK_HEAD), SEEK)
    if one(pointer, 0x53AB) != bytes.fromhex("1C53BB6B"):
        raise AssertionError("the head does not point to the cues")
    at = body + number(one(pointer, 0x53AC))
    (id_, points, _), = parse(raw, at, len(raw))               # the cues are the last thing in the file
    if id_ != CUES:
        raise AssertionError(f"{id_:X} where the cues should be")
    out = []
    for point in some(points, CUE_POINT):
        place = one(point, CUE_PLACE)
        start = body + number(one(place, 0xF1))
        out.append((number(one(point, 0xB3)), number(one(place, 0xF7)), raw[start:start + 4].hex().upper()))
    return out


def pcm(value, count):
    return struct.pack(f"<{count}h", *[value] * count)


def wait_for(what, seconds=10.0):
    end = time.monotonic() + seconds
    while not what():
        if time.monotonic() > end:
            raise AssertionError("waited too long")
        time.sleep(0.005)


class FullDisk:
    """A file that takes `room` more bytes; of the write that is too much for it, it takes half and
    fails, and from then on it takes nothing until it is given room again."""

    def __init__(self, f, room):
        self.f, self.room = f, room

    def write(self, data):
        if len(data) > self.room:
            self.f.write(bytes(data[:min(self.room, len(data) // 2)]))
            self.room = 0
            raise OSError(errno.ENOSPC, "No space left on device")
        self.room -= len(data)
        return self.f.write(data)

    def __getattr__(self, name):
        return getattr(self.f, name)


class Clock:
    """The recorder's clock in the tests' hand: time passes when a test says so."""

    def __init__(self):
        self.t = 5000.0

    def __call__(self):
        return self.t


class JpegSizeTest(unittest.TestCase):
    def test_width_and_height_of_real_pictures(self):
        self.assertEqual(jpeg_size(JPEG_64x48), (64, 48))
        self.assertEqual(jpeg_size(JPEG_80x32), (80, 32))

    def test_what_has_no_frame_header_has_no_size(self):
        cut = JPEG_64x48.index(b"\xff\xc0")       # the frame header
        for junk in (b"", b"\xff", b"\xff\xd8", b"\xff\xd8\xff\xd9", b"GIF89a" + bytes(40), JPEG_64x48[1:],
                     JPEG_64x48[:cut], JPEG_64x48[:cut + 6], b"\xff\xd8" + bytes(50),
                     JPEG_64x48[:cut] + b"\xff\xda" + JPEG_64x48[cut:]):     # picture data before any frame header
            with self.subTest(junk=junk[:12]):
                self.assertIsNone(jpeg_size(junk))

    def test_fill_bytes_and_a_progressive_frame_are_read_too(self):
        cut = JPEG_64x48.index(b"\xff\xc0")
        self.assertEqual(jpeg_size(JPEG_64x48[:cut] + b"\xff\xff" + JPEG_64x48[cut:]), (64, 48))
        progressive = JPEG_64x48[:cut] + b"\xff\xc2" + JPEG_64x48[cut + 2:]
        self.assertEqual(jpeg_size(progressive), (64, 48))


class MkvWriterTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "a.mkv"

    def write(self, **kw):
        """A second and a half: a picture every 70 ms, 100 ms of sound every 100 ms, in the order of their times."""
        w = MkvWriter(self.path, **kw)
        wrote = [(ms, 1, JPEGS[i % 2] + bytes([i])) for i, ms in enumerate(range(0, 1500, 70))]
        wrote += [(ms, 2, pcm(ms + 1, 4800)) for ms in range(0, 1500, 100)]
        wrote.sort(key=lambda b: b[:2])
        for ms, track, data in wrote:
            (w.video if track == 1 else w.audio)(ms, data)
        return w, wrote

    def test_the_header_names_both_tracks(self):
        w, _ = self.write()
        w.close()
        top = parse(self.path.read_bytes())
        self.assertEqual([i for i, _, _ in top], [0x1A45DFA3, SEGMENT])
        head = one(top, 0x1A45DFA3)
        self.assertEqual(one(head, 0x4282), b"matroska")
        self.assertEqual((number(one(head, 0x4287)), number(one(head, 0x4285))), (2, 2))   # nothing newer than SimpleBlock
        segment = one(top, SEGMENT)
        self.assertEqual([i for i, _, _ in segment][:3], [SEEK_HEAD, INFO, TRACKS])     # before the first cluster
        self.assertEqual([i for i, _, _ in segment][-1], CUES)
        self.assertEqual(number(one(one(segment, INFO), 0x2AD7B1)), 1000000)   # times are milliseconds
        video, audio = some(one(segment, TRACKS), ENTRY)
        self.assertEqual((number(one(video, 0xD7)), number(one(video, 0x83)), one(video, 0x86)), (1, 1, b"V_MJPEG"))
        picture = one(video, 0xE0)
        self.assertEqual((number(one(picture, 0xB0)), number(one(picture, 0xBA))), (64, 48))   # from the first picture
        self.assertEqual((number(one(audio, 0xD7)), number(one(audio, 0x83)), one(audio, 0x86)),
                         (2, 2, b"A_PCM/INT/LIT"))
        sound = one(audio, 0xE1)
        self.assertEqual((struct.unpack(">d", one(sound, 0xB5))[0], number(one(sound, 0x9F)), number(one(sound, 0x6264))),
                         (48000.0, 1, 16))
        self.assertEqual((number(one(video, 0x9C)), number(one(audio, 0x9C))), (0, 0))          # one frame to a block
        self.assertNotEqual(number(one(video, 0x73C5)), number(one(audio, 0x73C5)))

    def test_the_blocks_come_back_as_they_were_written(self):
        w, wrote = self.write()
        w.close()
        segment, is_open = read(self.path)
        self.assertFalse(is_open)
        back = blocks(segment)
        self.assertEqual([(ms, track, data) for ms, track, _, data in back], wrote)     # byte for byte, in order
        self.assertEqual({flags for _, _, flags, _ in back}, {0x80})                    # each one stands alone
        clusters = some(segment, CLUSTER)
        self.assertEqual([number(one(c, 0xE7)) for c in clusters], [0, 500, 1000])
        self.assertFalse(any(is_open for i, _, is_open in segment if i == CLUSTER))     # their lengths are written
        for c in clusters:
            self.assertEqual(c[0][0], 0xE7)                                             # the time comes first
        self.assertEqual(w.bytes, self.path.stat().st_size)

    def test_close_writes_the_length_and_the_duration(self):
        w, _ = self.write()
        raw = self.path.read_bytes()                  # while it is being written: what is on the disk so far
        segment, is_open = read(self.path)
        self.assertTrue(is_open)
        self.assertEqual(some(one(segment, INFO), 0x4489), [])
        self.assertEqual(([i for i, _, _ in segment][0], some(segment, CUES)), (VOID, []))    # no cues yet, and no pointer
        self.assertIsNone(mkv_seconds(self.path))
        self.assertEqual([number(one(c, 0xE7)) for c in some(segment, CLUSTER)], [0, 500])   # whole clusters only
        self.assertEqual(len(raw), w.bytes)
        w.close()
        segment, is_open = read(self.path)
        self.assertFalse(is_open)
        # the last block is the sound from 1400 ms on, 100 ms long
        self.assertEqual(struct.unpack(">d", one(one(segment, INFO), 0x4489))[0], 1500.0)
        self.assertEqual(mkv_seconds(self.path), 1.5)
        after = self.path.read_bytes()
        self.assertEqual((len(after), len(blocks(segment))), (w.bytes, 22 + 15))
        w.close()                                     # a second close changes nothing
        self.assertEqual(self.path.read_bytes(), after)

    def test_the_cues_say_where_each_cluster_begins(self):
        w, _ = self.write()
        w.close()
        # each cluster's first picture: a player that jumps wants to land on one
        self.assertEqual(cues(self.path), [(0, 1, "1F43B675"), (560, 1, "1F43B675"), (1050, 1, "1F43B675")])
        w = MkvWriter(self.path)
        for ms in (0, 100, 600, 700):                 # pictures stopped: the sound's blocks stand in
            w.audio(ms, pcm(1, 4800))
        w.video(750, JPEG_64x48)
        w.close()
        self.assertEqual(cues(self.path), [(0, 2, "1F43B675"), (750, 1, "1F43B675")])

    def test_a_write_the_disk_refuses_leaves_whole_clusters_only(self):
        w = MkvWriter(self.path)
        w.video(0, JPEG_64x48)
        w.video(100, JPEG_80x32)
        w.video(500, JPEG_64x48)                      # the first cluster is on the disk now
        before = self.path.read_bytes()
        w._f = FullDisk(w._f, room=1000)              # room for half of the next one
        w.video(600, JPEG_80x32)
        with self.assertRaises(OSError):
            w.video(1000, JPEG_64x48)
        self.assertEqual(self.path.read_bytes(), before)            # the half that went in is cut off again
        self.assertEqual(w.bytes, len(before))
        w._f.room = 10**9                             # room again: it goes on behind the last whole cluster
        w.video(1100, JPEG_80x32)
        w.close()
        segment, is_open = read(self.path)
        self.assertFalse(is_open)
        self.assertEqual([(ms, data) for ms, _, _, data in blocks(segment)],
                         [(0, JPEG_64x48), (100, JPEG_80x32), (1100, JPEG_80x32)])
        self.assertEqual(cues(self.path), [(0, 1, "1F43B675"), (1100, 1, "1F43B675")])

    def test_a_longer_duration_can_be_given(self):
        w, _ = self.write()
        w.close(2000.5)
        self.assertEqual(mkv_seconds(self.path), 2.0005)
        w, _ = self.write()
        w.close(100.0)                                # shorter than what is in the file: the file wins
        self.assertEqual(mkv_seconds(self.path), 1.5)

    def test_a_block_never_goes_back_in_time(self):
        w = MkvWriter(self.path)
        for ms in (0, 400, 300, 900, 899, 40000):
            w.video(ms, JPEG_64x48)
        w.close()
        segment, _ = read(self.path)
        self.assertEqual([ms for ms, _, _, _ in blocks(segment)], [0, 400, 400, 900, 900, 40000])
        self.assertEqual([number(one(c, 0xE7)) for c in some(segment, CLUSTER)], [0, 900, 40000])

    def test_without_sound_there_is_one_track(self):
        w, wrote = self.write(audio=False)
        w.close()
        segment, _ = read(self.path)
        self.assertEqual([one(e, 0x86) for e in some(one(segment, TRACKS), ENTRY)], [b"V_MJPEG"])
        self.assertEqual([(ms, data) for ms, track, _, data in blocks(segment)],
                         [(ms, data) for ms, track, data in wrote if track == 1])
        self.assertEqual(mkv_seconds(self.path), 1.47)          # the last picture

    def test_the_picture_size_can_be_given_or_stays_a_plain_one(self):
        w = MkvWriter(self.path, size=(1280, 960))
        w.video(0, JPEG_64x48)
        w.close()
        picture = one(some(one(read(self.path)[0], TRACKS), ENTRY)[0], 0xE0)
        self.assertEqual((number(one(picture, 0xB0)), number(one(picture, 0xBA))), (1280, 960))
        w = MkvWriter(self.path)                       # no picture came at all
        w.audio(0, pcm(1, 4800))
        w.close()
        picture = one(some(one(read(self.path)[0], TRACKS), ENTRY)[0], 0xE0)
        self.assertEqual((number(one(picture, 0xB0)), number(one(picture, 0xBA))), record.NO_PICTURE)


@needs_numpy
class AudioMixTest(unittest.TestCase):
    def runs(self, samples):
        """The mix as stretches of one value: [(first sample, count, value)], silence left out."""
        edges = np.flatnonzero(np.diff(samples)) + 1
        starts = np.concatenate([[0], edges])
        return [(int(a), int(b - a), int(samples[a])) for a, b in zip(starts, np.concatenate([edges, [len(samples)]]))
                if samples[a]]

    def test_sound_lies_where_its_time_is_and_silence_around_it(self):
        mix = AudioMix()
        mix.add_mic(pcm(1000, 4800), 48000, 1.1)          # arrived at 1.1 s: it was heard from 1.0 s on
        got = mix.take(2.0)
        self.assertEqual((got.dtype, len(got)), (np.dtype("<i2"), 96000))
        self.assertEqual(self.runs(got), [(48000, 4800, 1000)])
        self.assertEqual(len(mix.take(2.0)), 0)           # nothing new up to there
        self.assertEqual(len(mix.take(1.0)), 0)
        mix.add_mic(pcm(1000, 4800), 48000, 1.5, src="late")   # for a time that was taken already: lost
        got = mix.take(2.5)
        self.assertEqual((len(got), self.runs(got)), (24000, []))

    def test_a_stream_is_laid_end_to_end_whatever_the_jitter(self):
        mix = AudioMix()
        for i, late in enumerate([0.0, 0.2, 0.05, 0.24, 0.0, 0.1, 0.2, 0.0]):
            mix.add_mic(pcm(100 + i, 1600), 16000, 1.1 + i * 0.1 + late)
        self.assertEqual(self.runs(mix.take(3.0)), [(48000 + i * 4800, 4800, 100 + i) for i in range(8)])

    def test_after_a_pause_the_sound_goes_where_it_arrived(self):
        mix = AudioMix()
        mix.add_mic(pcm(100, 1600), 16000, 1.1)
        mix.add_mic(pcm(200, 1600), 16000, 2.0)           # 0.8 s later than end to end: more than 0.25 s
        mix.add_mic(pcm(300, 1600), 16000, 2.1)           # and the next one at the usual pace: it was a pause
        mix.add_mic(pcm(400, 1600), 16000, 2.2)
        self.assertEqual(self.runs(mix.take(3.0)),
                         [(48000, 4800, 100), (91200, 4800, 200), (96000, 4800, 300), (100800, 4800, 400)])

    def test_a_late_chunk_with_nothing_behind_it_stands_where_it_arrived(self):
        mix = AudioMix()
        mix.add_mic(pcm(100, 1600), 16000, 1.1)
        mix.add_mic(pcm(200, 1600), 16000, 2.0)
        self.assertEqual(self.runs(mix.take(1.5)), [(48000, 4800, 100)])      # not its time yet
        self.assertEqual(self.runs(mix.take(3.0)), [(91200 - 72000, 4800, 200)])

    def test_just_inside_the_quarter_second_it_stays_in_line(self):
        mix = AudioMix()
        mix.add_mic(pcm(100, 1600), 16000, 1.1)
        mix.add_mic(pcm(200, 1600), 16000, 1.44)          # 0.24 s late
        mix.add_mic(pcm(300, 1600), 16000, 1.54)
        self.assertEqual(self.runs(mix.take(3.0)), [(48000, 4800, 100), (52800, 4800, 200), (57600, 4800, 300)])

    def test_chunks_the_link_held_back_stay_in_line(self):
        mix = AudioMix()
        mix.add_mic(pcm(100, 1600), 16000, 1.1)
        for i in range(6):                                # 0.6 s of sound, all at once, half a second late
            mix.add_mic(pcm(200 + i, 1600), 16000, 1.7)
        mix.add_mic(pcm(300, 1600), 16000, 1.8)
        self.assertEqual(self.runs(mix.take(3.0)), [(48000, 4800, 100)]
                         + [(52800 + i * 4800, 4800, 200 + i) for i in range(6)] + [(81600, 4800, 300)])

    def test_a_stream_that_sends_too_much_does_not_run_away(self):
        mix = AudioMix()
        for i in range(40):                               # 4 s of sound in 2 s
            mix.add_mic(pcm(100, 1600), 16000, 1.0 + (i + 1) * 0.05)
        got = mix.take(10.0)
        last = int(np.flatnonzero(got)[-1]) / 48000
        self.assertGreater(last, 3.0)
        self.assertLess(last, 3.0 + 0.25 + 0.1)           # never more than the quarter second and a chunk ahead

    def test_two_microphones_are_added(self):
        mix = AudioMix()
        for i in range(3):
            mix.add_mic(pcm(100, 1600), 16000, 1.1 + i * 0.1, src="a")
            mix.add_mic(pcm(20, 800), 8000, 1.2 + i * 0.1, src="b")
        self.assertEqual(self.runs(mix.take(3.0)), [(48000, 4800, 100), (52800, 9600, 120), (62400, 4800, 20)])

    def test_the_hub_speaks_a_moment_after_it_sent(self):
        mix = AudioMix()
        mix.add_speech(pcm(2000, 22050), 22050, 1.0)
        self.assertEqual(self.runs(mix.take(4.0)), [(round(1.12 * 48000), 48000, 2000)])

    def test_speech_waits_for_the_speech_before_it_and_urgent_speech_cuts_it(self):
        mix = AudioMix()
        mix.add_speech(pcm(2000, 22050), 22050, 1.0)      # plays 1.12 .. 2.12
        mix.add_speech(pcm(3000, 11025), 22050, 1.5)      # sent while that plays: behind it, 2.12 .. 2.62
        self.assertEqual(self.runs(mix.take(4.0)), [(53760, 48000, 2000), (101760, 24000, 3000)])
        mix = AudioMix()
        mix.add_speech(pcm(2000, 22050), 22050, 1.0)
        mix.add_speech(pcm(3000, 11025), 22050, 1.5, urgent=True)   # cut at 1.5, the new one from 1.62
        self.assertEqual(self.runs(mix.take(4.0)), [(53760, 72000 - 53760, 2000), (77760, 24000, 3000)])

    def test_the_microphone_is_turned_down_while_the_hub_speaks(self):
        mix = AudioMix()
        for i in range(40):
            mix.add_mic(pcm(10000, 1600), 16000, (i + 1) * 0.1)
        mix.add_speech(pcm(0, 22050), 22050, 1.0)         # a second of it, heard from 1.12 to 2.12
        got = mix.take(4.0)

        def at(seconds):
            return int(got[round(seconds * 48000)])
        self.assertEqual([at(s) for s in (0.0, 0.5, 0.97, 1.0, 1.5, 2.12, 2.42, 2.45, 3.9)],
                         [10000, 10000, 10000, 1500, 1500, 1500, 1500, 10000, 10000])   # 0.3 s after the last word
        self.assertTrue(1500 < at(0.99) < 10000 and 1500 < at(2.43) < 10000)             # no step: down and up over 20 ms
        self.assertTrue(np.all(np.diff(got[round(0.97 * 48000):round(1.0 * 48000)]) <= 0))

    def test_what_is_too_loud_stops_at_the_top(self):
        mix = AudioMix()
        mix.add_mic(pcm(30000, 4800), 48000, 1.1, src="a")
        mix.add_mic(pcm(30000, 4800), 48000, 1.1, src="b")
        mix.add_mic(pcm(-30000, 4800), 48000, 1.2, src="a")
        mix.add_mic(pcm(-30000, 4800), 48000, 1.2, src="b")
        self.assertEqual(self.runs(mix.take(2.0)), [(48000, 4800, 32767), (52800, 4800, -32768)])

    def test_another_rate_keeps_its_length_and_its_pitch(self):
        for rate in (8000, 16000, 22050, 44100, 48000, 96000):
            with self.subTest(rate=rate):
                mix = AudioMix()
                tone = struct.pack(f"<{rate}h", *[int(8000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(rate)])
                mix.add_mic(tone, rate, 2.0)              # one second, heard from 1.0 s on
                got = mix.take(3.0)
                sounding = np.flatnonzero(got)
                self.assertLessEqual(abs(int(sounding[0]) - 48000), 2)      # the tone itself begins at zero
                self.assertLessEqual(abs(int(sounding[-1]) - 95999), 2)
                spectrum = np.abs(np.fft.rfft(got[48000:96000].astype(float)))
                self.assertEqual(int(spectrum.argmax()), 440)
                self.assertGreater(spectrum[440] / 24000, 7500)             # and as loud as it was

    def test_odd_chunk_lengths_join_without_a_seam(self):
        mix = AudioMix()                                  # 147 samples at 44.1 kHz are 160 at 48 kHz: 1470 -> 1600
        at, total = 1.0, 0
        for n in (441, 440, 443, 1000, 7, 4410, 333):     # none of them a whole number of samples at 48 kHz
            at += n / 44100
            total += n
            mix.add_mic(pcm(500, n), 44100, at)
        (first, count, value), = self.runs(mix.take(3.0))
        self.assertEqual(value, 500)
        self.assertLessEqual(abs(first - 48000), 1)
        self.assertLessEqual(abs(count - total * 48000 / 44100), 1)

    def test_taken_in_pieces_it_is_the_same_sound(self):
        def fill(mix):
            for i in range(30):
                mix.add_mic(pcm(4000 + i, 1600), 16000, (i + 1) * 0.1)
            mix.add_speech(pcm(9000, 15000), 22050, 0.9)
            mix.add_speech(pcm(-7000, 5000), 22050, 1.4, urgent=True)
        whole, pieces = AudioMix(), AudioMix()
        fill(whole)
        fill(pieces)
        parts = [pieces.take(ms / 1000) for ms in list(range(100, 3000, 100)) + [2950, 3000, 3500]]
        self.assertTrue(np.array_equal(np.concatenate(parts), whole.take(3.5)))

    def test_no_numpy_no_mix(self):
        with mock.patch.object(record, "np", None), self.assertRaises(RecordError):
            AudioMix()


class RecorderTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.folder = Path(self.dir.name) / "recordings"      # not there yet: the recorder makes it

    def recorder(self, **kw):
        kw.setdefault("convert", False)
        kw.setdefault("min_free_bytes", 0)       # the tests do not depend on how full this machine's disk is
        r = Recorder(self.folder, **kw)
        r.clock = Clock()
        self.addCleanup(r.close)
        return r

    def feed(self, r, seconds, speech_at=None):
        """Pictures about 12 a second at an uneven pace, the microphone in chunks of 100 ms, and
        the clock moved on in steps of 100 ms as it all comes in. Returns the pictures: (ms, jpeg)."""
        t0, fed, t, i = r.clock.t, [], 0.02, 0
        gaps = [0.05, 0.11, 0.07, 0.13, 0.06, 0.09]
        for step in range(round(seconds * 10)):
            if step / 10 == speech_at:
                r.speech(pcm(5000, 22050), 22050, t0 + speech_at)
            while t < (step + 1) / 10:
                fed.append((round(t * 1000), JPEGS[i % 2] + bytes([i])))
                r.frame(fed[-1][1], t0 + t)
                t = round(t + gaps[i % 6], 2)
                i += 1
            r.clock.t = t0 + (step + 1) / 10
            r.mic(pcm(1000, 1600), 16000)        # stamped with the clock: it has just arrived
        return fed

    @needs_numpy
    def test_a_recording_holds_the_pictures_and_the_sound_in_the_order_of_their_times(self):
        r = self.recorder()
        self.assertFalse(r.on)
        self.assertIsNone(r.state())
        self.assertEqual(r.recordings(), [])
        began = r.start()
        name = began["name"]
        self.assertRegex(name, r"^marswalk-[0-9]{8}-[0-9]{6}$")
        self.assertEqual(began, {"on": True, "name": name, "seconds": 0.0, "frames": 0,
                                 "bytes": (self.folder / f"{name}.mkv").stat().st_size, "audio": True, "dropped": 0})
        self.assertTrue(r.on)
        fed = self.feed(r, 3.0, speech_at=2.0)
        # It is written as it goes, a second behind: the sound of a moment may come after its picture.
        wait_for(lambda: r.state()["frames"] > 0 and r.state()["bytes"] > began["bytes"])
        running = r.state()
        self.assertEqual((running["on"], running["seconds"]), (True, 3.0))
        self.assertLessEqual(running["frames"], len([ms for ms, _ in fed if ms < 2000]))
        self.assertEqual(r.recordings(), [{"name": name, "seconds": 3.0, "mkv": mock.ANY, "mp4": None,
                                           "state": "recording"}])
        fed += [(ms + 3000, jpeg) for ms, jpeg in self.feed(r, 1.0)]
        ended = r.stop()
        path = self.folder / f"{name}.mkv"
        self.assertEqual(ended, {"on": False, "name": name, "seconds": 4.0, "frames": len(fed),
                                 "bytes": path.stat().st_size, "audio": True, "dropped": 0})
        self.assertEqual(r.state(), ended)
        self.assertFalse(r.on)

        segment, is_open = read(path)
        self.assertFalse(is_open)
        back = blocks(segment)
        order = [(ms, track) for ms, track, _, _ in back]
        self.assertEqual(order, sorted(order))                                   # by time, a picture before the sound of its moment
        self.assertEqual([(ms, data) for ms, track, _, data in back if track == 1], fed)   # every picture, as it was
        sound = [(ms, data) for ms, track, _, data in back if track == 2]
        self.assertEqual([ms for ms, _ in sound], list(range(0, 4000, 100)))
        self.assertEqual({len(data) for _, data in sound}, {9600})
        tracks = [track for _, track in order]
        self.assertLess(tracks.index(2), 3)                                      # the sound is between the pictures,
        self.assertLess(max(len(run) for run in re.findall("1+", "".join(map(str, tracks)))), 4)   # not behind them
        self.assertEqual(struct.unpack(">d", one(one(segment, INFO), 0x4489))[0], 4000.0)
        picture = one(some(one(segment, TRACKS), ENTRY)[0], 0xE0)
        self.assertEqual((number(one(picture, 0xB0)), number(one(picture, 0xBA))), (64, 48))

        mixed = np.frombuffer(b"".join(data for _, data in sound), dtype="<i2")

        def at(seconds):
            return int(mixed[round(seconds * 48000)])
        # the microphone; turned down under the hub's speech, which is heard from 2.12 s for a second
        self.assertEqual([at(s) for s in (0.01, 1.0, 1.9, 2.05, 2.2, 3.0, 3.2, 3.5, 3.99)],
                         [1000, 1000, 1000, 150, 5150, 5150, 150, 1000, 1000])

        self.assertEqual(r.recordings(), [{"name": name, "seconds": 4.0, "mkv": path.stat().st_size, "mp4": None,
                                           "state": "master only"}])
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), [f"{name}.mkv"])

    def test_nothing_is_taken_while_no_recording_runs(self):
        r = self.recorder()
        r.frame(JPEG_64x48)
        r.mic(pcm(1, 1600), 16000)
        r.speech(pcm(1, 1600), 16000)
        self.assertIsNone(r.stop())
        self.assertIsNone(r.state())
        self.assertFalse(self.folder.exists())

    def test_starting_twice_is_one_recording_and_stopping_twice_one_end(self):
        r = self.recorder()
        first = r.start()
        r.clock.t += 1.0
        again = r.start()
        self.assertEqual((again["name"], again["seconds"]), (first["name"], 1.0))
        ended = r.stop()
        self.assertEqual(r.stop(), ended)
        self.assertEqual(len(list(self.folder.iterdir())), 1)

    def test_two_recordings_in_one_second_have_two_names(self):
        r = self.recorder()
        with mock.patch.object(record.time, "time", return_value=1763211045.0):
            a = r.start()["name"]
            r.stop()
            b = r.start()["name"]
            r.stop()
        self.assertEqual((a, b), (time.strftime("marswalk-%Y%m%d-%H%M%S", time.localtime(1763211045)),
                                  time.strftime("marswalk-%Y%m%d-%H%M%S", time.localtime(1763211046))))
        self.assertEqual([x["name"] for x in r.recordings()], [b, a])           # the newest first

    def test_a_short_disk_refuses_the_start(self):
        r = self.recorder(min_free_bytes=10**18)
        with self.assertRaises(RecordError) as refused:
            r.start()
        self.assertIn("disk short", str(refused.exception))
        self.assertFalse(r.on)
        self.assertIsNone(r.state())
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_no_folder_refuses_the_start(self):
        in_the_way = Path(self.dir.name) / "file"
        in_the_way.write_text("not a folder")
        r = Recorder(in_the_way / "recordings", convert=False, min_free_bytes=0)
        with self.assertRaises(RecordError):
            r.start()
        self.assertFalse(r.on)
        self.assertEqual(r.recordings(), [])

    def test_it_ends_itself_at_the_time_limit(self):
        r = self.recorder(max_seconds=2.0)
        name = r.start()["name"]
        t0 = r.clock.t
        for seconds in (0.5, 0.6, 1.5, 2.5):
            r.frame(JPEG_64x48, t0 + seconds)
        r.clock.t = t0 + 3.0
        wait_for(lambda: not r.on)
        ended = r.state()
        self.assertEqual((ended["stopped"], ended["seconds"], ended["frames"]), ("time limit", 2.0, 3))
        segment, is_open = read(self.folder / f"{name}.mkv")
        self.assertFalse(is_open)
        self.assertEqual(max(ms for ms, _, _, _ in blocks(segment)), 2000)
        self.assertEqual(mkv_seconds(self.folder / f"{name}.mkv"), 2.0)
        r.frame(JPEG_64x48)                         # nothing runs: nothing is taken
        self.assertEqual(r.stop(), ended)

    def test_it_ends_itself_when_the_disk_runs_full(self):
        disk = types.SimpleNamespace(free=10**9)
        with mock.patch.object(record.shutil, "disk_usage", lambda folder: disk):
            r = self.recorder(min_free_bytes=10**6)
            r.start()
            r.frame(JPEG_64x48)
            r.frame(JPEG_64x48, r.clock.t + 1.0)
            r.clock.t += 3.0
            wait_for(lambda: r.state()["frames"] > 0)      # it writes, with all the room there is
            self.assertTrue(r.on)
            disk.free = 4 * 10**5                   # under half of what a start takes
            r.clock.t += 3.0
            wait_for(lambda: not r.on)
        self.assertEqual((r.state()["stopped"], r.state()["seconds"]), ("disk full", 6.0))

    def test_a_disk_that_refuses_a_write_ends_the_recording_and_the_file_still_reads(self):
        r = self.recorder()
        name = r.start()["name"]
        t0 = r.clock.t
        writer = r._rec.writer
        # room for the first cluster (half a second: five pictures, and the sound if there is any), not for the second
        writer._f = FullDisk(writer._f, room=60000 if record.np is not None else 10000)
        for i in range(30):
            r.frame(JPEG_64x48, t0 + i * 0.1)
        r.clock.t = t0 + 4.0
        with self.assertLogs("record", level="WARNING"):
            wait_for(lambda: not r.on)
        ended = r.state()
        self.assertEqual((ended["stopped"], ended["frames"]), ("disk full", 5))
        path = self.folder / f"{name}.mkv"
        self.assertEqual(ended["bytes"], path.stat().st_size)
        segment, is_open = read(path)                # as a recording whose writer died: open, and whole as far as it goes
        self.assertTrue(is_open)
        self.assertEqual([ms for ms, track, _, _ in blocks(segment) if track == 1], [0, 100, 200, 300, 400])
        self.assertEqual(r.recordings()[0]["state"], "master only")

    def test_a_picture_that_stood_is_written_again_where_its_time_ends(self):
        r = self.recorder()
        name = r.start()["name"]
        t0 = r.clock.t
        a, b, c = JPEG_64x48 + b"a", JPEG_80x32 + b"b", JPEG_64x48 + b"c"
        for seconds, jpeg in ((0.0, a), (0.25, b), (2.0, c), (2.1, a)):
            r.frame(jpeg, t0 + seconds)
        r.clock.t = t0 + 4.0
        self.assertEqual(r.stop()["frames"], 4)      # the headset's own
        segment, _ = read(self.folder / f"{name}.mkv")
        self.assertEqual([(ms, data) for ms, track, _, data in blocks(segment) if track == 1],
                         [(0, a), (250, b), (1967, b), (2000, c), (2100, a), (3967, a), (4000, a)])

    def test_what_is_not_a_picture_is_left_out_and_counted(self):
        r = self.recorder()
        name = r.start()["name"]
        t0 = r.clock.t
        r.frame(b"\xff\xd8\xff\xd9", t0 + 0.1)       # begins like a JPEG, holds no picture
        r.frame(JPEG_80x32, t0 + 0.2)
        r.frame(JPEG_64x48[:100], t0 + 0.3)
        r.frame(JPEG_64x48, t0 - 1.0)                # from before the beginning
        r.clock.t = t0 + 0.4
        ended = r.stop()
        self.assertEqual((ended["frames"], ended["dropped"]), (1, 3))
        segment, _ = read(self.folder / f"{name}.mkv")
        self.assertEqual([data for _, track, _, data in blocks(segment) if track == 1], [JPEG_80x32])
        picture = one(some(one(segment, TRACKS), ENTRY)[0], 0xE0)
        self.assertEqual((number(one(picture, 0xB0)), number(one(picture, 0xBA))), (80, 32))

    def test_pictures_are_left_out_when_the_disk_does_not_keep_up(self):
        r = self.recorder()
        gate = threading.Event()
        clock = r.clock

        def stuck():                                 # the writing thread hangs here; the test's own calls pass
            if threading.current_thread().name == "recorder":
                gate.wait(20.0)
            return clock.t
        with mock.patch.object(record, "MAX_WAITING", 10):
            r.start()
            r.clock = stuck
            for i in range(50):
                r.frame(JPEGS[i % 2], clock.t + i * 0.01)
            waiting = r.state()
            self.assertEqual(waiting["frames"], 0)
            self.assertGreaterEqual(waiting["dropped"], 50 - 12)
            self.assertLess(waiting["dropped"], 50)
            clock.t += 1.0
            gate.set()
            ended = r.stop()
        self.assertEqual(ended["frames"] + ended["dropped"], 50)     # each one is in the file or counted
        self.assertEqual(ended["dropped"], waiting["dropped"])

    def test_without_numpy_it_records_the_pictures_only(self):
        with mock.patch.object(record, "np", None):
            r = self.recorder()
            name = r.start()["name"]
            t0 = r.clock.t
            r.frame(JPEG_64x48, t0 + 0.1)
            r.mic(pcm(1000, 1600), 16000, t0 + 0.2)
            r.speech(pcm(1000, 1600), 16000, t0 + 0.2)
            r.frame(JPEG_80x32, t0 + 0.3)
            r.clock.t = t0 + 0.5
            ended = r.stop()
        self.assertEqual((ended["audio"], ended["frames"], ended["seconds"]), (False, 2, 0.5))
        segment, _ = read(self.folder / f"{name}.mkv")
        self.assertEqual(len(some(one(segment, TRACKS), ENTRY)), 1)
        self.assertEqual([(ms, track) for ms, track, _, _ in blocks(segment)], [(100, 1), (300, 1)])

    def test_close_finishes_the_file_and_begins_no_conversion(self):
        with mock.patch.object(record, "convert_command", side_effect=AssertionError("no conversion at shutdown")):
            r = self.recorder(convert=True)
            name = r.start()["name"]
            r.frame(JPEG_64x48, r.clock.t + 0.1)
            r.clock.t += 1.0
            r.close()
            self.assertFalse(r.on)
            self.assertEqual(r.state()["seconds"], 1.0)
            self.assertEqual(mkv_seconds(self.folder / f"{name}.mkv"), 1.0)
            self.assertEqual([x["state"] for x in r.recordings()], ["master only"])
            r.close()                                # twice is once

    # ---------- the list ----------
    def test_the_list_tells_what_is_in_the_folder_the_newest_first(self):
        self.folder.mkdir()
        w = MkvWriter(self.folder / "marswalk-20261115-100000.mkv")
        w.video(0, JPEG_64x48)
        w.close(12345.0)
        (self.folder / "marswalk-20261115-100000.mp4").write_bytes(b"x" * 10)
        (self.folder / "marswalk-20261115-110000.mkv").write_bytes(b"not a recording at all")
        (self.folder / "marswalk-20261115-120000.mp4").write_bytes(b"x" * 7)       # its master was deleted
        w = MkvWriter(self.folder / "marswalk-20261115-130000.mkv")                # its writer died: no duration in it
        w.video(0, JPEG_64x48)
        w._flush()
        for other in ("marswalk-20261115-140000.mp4.part", "marswalk-2026.mkv", "notes.txt",
                      "marswalk-20261115-150000.mkv.bak", "xmarswalk-20261115-160000.mkv"):
            (self.folder / other).write_bytes(b"x")
        r = self.recorder()
        size = (self.folder / "marswalk-20261115-100000.mkv").stat().st_size
        self.assertEqual(r.recordings(), [
            {"name": "marswalk-20261115-130000", "seconds": None, "mkv": w.bytes, "mp4": None, "state": "master only"},
            {"name": "marswalk-20261115-120000", "seconds": None, "mkv": None, "mp4": 7, "state": "ready"},
            {"name": "marswalk-20261115-110000", "seconds": None, "mkv": 22, "mp4": None, "state": "master only"},
            {"name": "marswalk-20261115-100000", "seconds": 12.3, "mkv": size, "mp4": 10, "state": "ready"}])
        w.close()

    def test_the_list_stops_at_twenty(self):
        self.folder.mkdir()
        for i in range(25):
            (self.folder / f"marswalk-20261115-10{i:02d}00.mkv").write_bytes(b"x")
        listed = self.recorder().recordings()
        self.assertEqual(len(listed), 20)
        self.assertEqual((listed[0]["name"], listed[-1]["name"]), ("marswalk-20261115-102400", "marswalk-20261115-100500"))

    def test_what_a_killed_conversion_left_is_cleared_away(self):
        self.folder.mkdir()
        old, fresh = self.folder / "marswalk-20261115-100000.mp4.part", self.folder / "marswalk-20261115-110000.mp4.part"
        old.write_bytes(b"x")
        fresh.write_bytes(b"x")
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        self.recorder()
        self.assertEqual((old.exists(), fresh.exists()), (False, True))      # a fresh one may be another hub's, at work

    # ---------- the conversion, with a small program in GStreamer's place ----------
    def converted_by(self, program, **kw):
        """A short recording, converted by `python -c program OUT` in place of gst-launch."""
        calls = []

        def command(mkv, out, size, audio):
            calls.append((mkv.name, out.name, size, audio))
            return None if program is None else [sys.executable, "-c", program, str(out)]
        with mock.patch.object(record, "convert_command", command):
            r = self.recorder(convert=True, **kw)
            name = r.start()["name"]
            r.frame(JPEG_80x32, r.clock.t + 0.1)
            r.clock.t += 0.5
            r.stop()
            wait_for(lambda: r.recordings()[0]["state"] != "converting")
        self.assertEqual(calls, [(f"{name}.mkv", f"{name}.mp4.part", (80, 32), record.np is not None)])
        return r, name

    def test_the_mp4_gets_its_name_when_it_is_whole(self):
        r, name = self.converted_by("import sys; open(sys.argv[1], 'wb').write(b'an mp4')")
        self.assertEqual(r.recordings(), [{"name": name, "seconds": 0.5, "mkv": mock.ANY, "mp4": 6, "state": "ready"}])
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), [f"{name}.mkv", f"{name}.mp4"])
        self.assertNotIn("stopped", r.state())

    def test_a_conversion_that_fails_leaves_the_master_and_says_so(self):
        with self.assertLogs("record", level="WARNING") as logged:
            r, name = self.converted_by("import sys; open(sys.argv[1], 'wb').write(b'half'); "
                                        "open(sys.argv[1] + '.tmp', 'wb').write(b'x'); "
                                        "sys.stderr.write('no such element'); sys.exit(1)")
        self.assertEqual([(x["state"], x["mp4"]) for x in r.recordings()], [("failed", None)])
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), [f"{name}.mkv"])     # nothing half-made stays
        self.assertIn("no such element", logged.output[-1])

    def test_a_conversion_that_writes_nothing_has_failed(self):
        with self.assertLogs("record", level="WARNING"):
            r, name = self.converted_by("pass")
        self.assertEqual(r.recordings()[0]["state"], "failed")

    def test_where_gstreamer_is_missing_the_master_is_all_there_is(self):
        with self.assertLogs("record", level="WARNING"):
            r, name = self.converted_by(None)
        self.assertEqual(r.recordings()[0]["state"], "master only")

    def test_conversions_take_their_turns(self):
        turns = Path(self.dir.name) / "turns.log"
        program = ("import sys, time\n"
                   "log = open(sys.argv[2], 'a')\n"
                   "log.write('begin '), log.flush(), time.sleep(0.3)\n"
                   "open(sys.argv[1], 'wb').write(b'an mp4')\n"
                   "log.write('end '), log.flush()\n")
        with mock.patch.object(record, "convert_command",
                               lambda mkv, out, size, audio: [sys.executable, "-c", program, str(out), str(turns)]):
            r = self.recorder(convert=True)
            for _ in range(2):
                r.start()
                r.frame(JPEG_80x32, r.clock.t + 0.1)
                r.clock.t += 0.5
                r.stop()
            self.assertEqual([x["state"] for x in r.recordings()], ["converting", "converting"])   # one waits
            wait_for(lambda: [x["state"] for x in r.recordings()] == ["ready", "ready"], 60.0)
        self.assertEqual(turns.read_text().split(), ["begin", "end", "begin", "end"])    # never two at a time

    def test_close_ends_the_conversion_that_runs(self):
        program = "import sys, time; open(sys.argv[1], 'wb').write(b'half'); time.sleep(120)"
        began = time.monotonic()
        with mock.patch.object(record, "convert_command",
                               lambda mkv, out, size, audio: [sys.executable, "-c", program, str(out)]):
            r = self.recorder(convert=True)
            name = r.start()["name"]
            r.frame(JPEG_80x32, r.clock.t + 0.1)
            r.clock.t += 0.5
            r.stop()
            wait_for((self.folder / f"{name}.mp4.part").exists)
            self.assertEqual(r.recordings()[0]["state"], "converting")
            r.close()
        self.assertLess(time.monotonic() - began, 60.0)
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), [f"{name}.mkv"])
        self.assertEqual(r.recordings()[0]["state"], "master only")

    def test_a_recording_without_pictures_is_not_converted(self):
        with mock.patch.object(record, "convert_command", side_effect=AssertionError("nothing to convert")):
            r = self.recorder(convert=True)
            r.start()
            r.clock.t += 0.5
            r.stop()
            self.assertEqual(r.recordings()[0]["state"], "master only")


class ConvertCommandTest(unittest.TestCase):
    def command(self, missing=(), **kw):
        with mock.patch.object(record, "_have", lambda element: element not in missing), \
                mock.patch.object(record.shutil, "which", lambda tool: None if tool in missing else "/usr/bin/" + tool):
            return record.convert_command(Path("/r/a.mkv"), Path("/r/a.mp4.part"), **kw)

    def test_both_tracks_at_an_even_size_and_30_pictures_a_second(self):
        cmd = self.command(size=(641, 481), audio=True)
        line = " ".join(cmd)
        self.assertEqual(cmd[:5], ["nice", "-n", "15", "gst-launch-1.0", "-q"])
        self.assertIn("location=/r/a.mkv", cmd)
        self.assertIn("location=/r/a.mp4.part", cmd)
        self.assertIn("width=640,height=480,framerate=30/1", line)
        for part in ("matroskademux", "jpegdec", "x264enc", "h264parse", "voaacenc bitrate=128000", "aacparse",
                     "mp4mux name=m faststart=true"):
            self.assertIn(part, line)

    def test_without_sound_there_is_no_sound_branch(self):
        line = " ".join(self.command(size=(640, 480), audio=False, missing=("voaacenc",)))
        self.assertIn("x264enc", line)
        self.assertNotIn("audio", line)

    def test_the_two_parsers_may_be_missing_the_rest_may_not(self):
        line = " ".join(self.command(size=(640, 480), audio=True, missing=("h264parse", "aacparse", "nice")))
        self.assertTrue(line.startswith("gst-launch-1.0"))
        self.assertNotIn("parse", line)
        for needed in ("gst-launch-1.0", "x264enc", "mp4mux", "matroskademux", "jpegdec", "voaacenc"):
            self.assertIsNone(self.command(size=(640, 480), audio=True, missing=(needed,)), needed)
        self.assertIsNone(self.command(size=(8, 8), audio=True))


TOOLS = all(shutil.which(tool) for tool in ("gst-launch-1.0", "gst-inspect-1.0", "gst-discoverer-1.0"))


@unittest.skipUnless(TOOLS and record.np is not None, "needs GStreamer's tools (gst-launch-1.0, gst-discoverer-1.0) and numpy")
class RealToolsTest(unittest.TestCase):
    """Six seconds through the recorder, then what GStreamer itself says about the two files."""

    def discover(self, path):
        """What gst-discoverer says of a file: its line about the pictures, the one about the sound, the seconds."""
        found = subprocess.run(["gst-discoverer-1.0", "-v", str(path)], capture_output=True, text=True, timeout=120)
        self.assertEqual(found.returncode, 0, found.stdout + found.stderr)
        h, m, s = re.search(r"Duration: (\d+):(\d+):([\d.]+)", found.stdout).groups()
        video = re.search(r"^\s*video #\d+: (.*)$", found.stdout, re.M)
        audio = re.search(r"^\s*audio #\d+: (.*)$", found.stdout, re.M)
        self.assertTrue(video and audio, found.stdout)
        return video[1], audio[1], int(h) * 3600 + int(m) * 60 + float(s)

    def test_gstreamer_reads_the_master_and_makes_the_mp4(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d) / "recordings"
            pictures = []
            for pattern in ("smpte", "ball", "pinwheel", "circular"):
                made = subprocess.run(["gst-launch-1.0", "-q", "videotestsrc", "num-buffers=1", f"pattern={pattern}", "!",
                                       "video/x-raw,width=640,height=480", "!", "jpegenc", "!", "filesink",
                                       f"location={d}/{pattern}.jpg"], capture_output=True, text=True, timeout=120)
                if made.returncode:
                    self.skipTest("this GStreamer makes no JPEGs: " + made.stderr.strip()[-200:])
                pictures.append(Path(d, f"{pattern}.jpg").read_bytes())
            if record.convert_command(folder / "a.mkv", folder / "a.mp4.part", (640, 480), True) is None:
                self.skipTest("this GStreamer lacks a part the conversion needs")

            def tone(freq, rate, count, first=0, loud=8000):
                return struct.pack(f"<{count}h", *[int(loud * math.sin(2 * math.pi * freq * (first + i) / rate))
                                                   for i in range(count)])
            r = Recorder(folder, min_free_bytes=0)
            r.clock = Clock()
            self.addCleanup(r.close)
            name = r.start()["name"]
            t0, t, fed = r.clock.t, 0.03, 0
            gaps = [0.05, 0.11, 0.07, 0.13, 0.06, 0.09]         # about 12 a second
            for step in range(60):
                if step == 20:
                    r.speech(tone(880, 22050, 22050, loud=12000), 22050, t0 + 2.0)
                while t < (step + 1) / 10:
                    r.frame(pictures[int(t) % 4], t0 + t)
                    t += gaps[fed % 6]
                    fed += 1
                r.clock.t = t0 + (step + 1) / 10
                r.mic(tone(440, 16000, 1600, step * 1600), 16000)
            ended = r.stop()
            self.assertEqual((ended["seconds"], ended["frames"], ended["dropped"]), (6.0, fed, 0))

            mkv, mp4 = folder / f"{name}.mkv", folder / f"{name}.mp4"
            video, audio, seconds = self.discover(mkv)
            self.assertEqual(seconds, 6.0)
            for part in ("image/jpeg", "width=(int)640", "height=(int)480"):
                self.assertIn(part, video)
            for part in ("audio/x-raw", "S16LE", "channels=(int)1", "rate=(int)48000"):
                self.assertIn(part, audio)

            wait_for(lambda: r.recordings()[0]["state"] != "converting", 300.0)
            self.assertEqual(r.recordings(), [{"name": name, "seconds": 6.0, "mkv": mkv.stat().st_size,
                                               "mp4": mp4.stat().st_size, "state": "ready"}])
            self.assertEqual(sorted(p.name for p in folder.iterdir()), [mkv.name, mp4.name])
            video, audio, seconds = self.discover(mp4)
            self.assertAlmostEqual(seconds, 6.0, delta=0.15)
            for part in ("video/x-h264", "width=(int)640", "height=(int)480", "framerate=(fraction)30/1"):
                self.assertIn(part, video)
            for part in ("audio/mpeg", "mpegversion=(int)4", "rate=(int)48000", "channels=(int)1"):
                self.assertIn(part, audio)


if __name__ == "__main__":
    unittest.main()
