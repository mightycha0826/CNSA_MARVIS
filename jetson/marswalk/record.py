"""A recording of the headset's view with its sound (role E).

While one runs, the pictures the mirror gets (mirror.py) go into a file as they came, with one
sound track beside them: the headset's microphone and the hub's own speech, mixed.

  Recorder    what the hub talks to: start, stop, frame, mic, speech, state, recordings
  MkvWriter   the file, NAME.mkv: Matroska written by hand, the JPEGs untouched (V_MJPEG) and
              16-bit sound at 48 kHz. Nothing is decoded or encoded while recording, so it
              costs the Jetson next to nothing and a picture is kept exactly as it was sent.
  AudioMix    the two sounds on one time line

After the stop GStreamer makes NAME.mp4 from the MKV (H.264 + AAC, 30 pictures a second: the
file to hand on), at low priority and one recording at a time. The MKV stays as the master.
On a machine without GStreamer there is only the MKV ("master only"): a file for a player that
knows Matroska, as VLC and mpv do.

No aiohttp in here, and numpy is optional: without it a recording has pictures only.
"""
import errno
import logging
import math
import os
import queue
import re
import shutil
import struct
import subprocess
import threading
import time
from pathlib import Path

try:
    import numpy as np   # optional, like the speech models: the hub starts without it
except ImportError:
    np = None

log = logging.getLogger("record")

RATE = 48000              # the sound track: 48 kHz, mono, 16 bit
FILE = re.compile(r"(marswalk-[0-9]{8}-[0-9]{6})\.(mkv|mp4)")   # the names mirror.py hands out
LISTED = 20               # recordings() tells of this many, the newest
HOLD_S = 1.0              # pictures and sound wait this long before they are written: the sound of a
                          # moment can come after its picture, and the file wants them in order
STEP_S = 0.1              # the sound goes into the file in pieces of this length
CLUSTER_MS = 500          # a cluster of the file holds no more time than this
MAX_WAITING = 200         # with more than this waiting for the disk, pictures are left out
MAX_WAITING_SOUND = 2000  # and past this the sound too: a disk that hangs must not eat the memory
STOP_FREE = 1024**3       # a recording ends itself when the disk has less than this left
STILL_MS = 250            # a picture that stood longer than this is written once more where its time ends
FRAME_MS = 33             # one picture's time in the MP4
SPEECH_DELAY_S = 0.12     # the headset plays the hub's speech this long after the hub began to send it
SPEECH_TAIL_S = 0.3       # the microphone stays turned down this long after the speech
MIC_UNDER_SPEECH = 0.15   # how far down: the microphone hears the headset's own speaker
RAMP_S = 0.02             # turned down and up again over this long, so it does not click
DRIFT_S = 0.25            # a microphone chunk this far from where its arrival puts it is looked at


class RecordError(Exception):
    """A recording cannot begin; the text says why, for the monitor page."""


def jpeg_size(data: bytes) -> tuple[int, int] | None:
    """Width and height of a JPEG, from its frame header; None when there is none to read."""
    if data[:2] != b"\xff\xd8":
        return None
    at, end = 2, len(data)
    while at + 4 <= end:
        if data[at] != 0xFF:
            return None
        marker = data[at + 1]
        if marker == 0xFF:                              # a fill byte before the marker
            at += 1
        elif marker == 0x01 or 0xD0 <= marker <= 0xD8:  # markers that stand alone
            at += 2
        elif marker in (0xD9, 0xDA):                    # the picture data begins: no frame header came
            return None
        elif 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if at + 9 > end:
                return None
            height, width = struct.unpack(">HH", data[at + 5:at + 9])
            return (width, height) if width and height else None
        else:
            at += 2 + int.from_bytes(data[at + 2:at + 4], "big")
    return None


# ---------- the file ----------
# The ids of the Matroska elements used here (matroska.org, "Element Specification").
EBML, SEGMENT, VOID = 0x1A45DFA3, 0x18538067, 0xEC
INFO, TIMESTAMP_SCALE, MUXING_APP, WRITING_APP, DATE_UTC, DURATION = (
    0x1549A966, 0x2AD7B1, 0x4D80, 0x5741, 0x4461, 0x4489)
TRACKS, TRACK_ENTRY, TRACK_NUMBER, TRACK_UID, TRACK_TYPE, FLAG_LACING, CODEC_ID = (
    0x1654AE6B, 0xAE, 0xD7, 0x73C5, 0x83, 0x9C, 0x86)
VIDEO, PIXEL_WIDTH, PIXEL_HEIGHT = 0xE0, 0xB0, 0xBA
AUDIO, SAMPLING_FREQUENCY, CHANNELS, BIT_DEPTH = 0xE1, 0xB5, 0x9F, 0x6264
CLUSTER, TIMESTAMP, SIMPLE_BLOCK = 0x1F43B675, 0xE7, 0xA3
SEEK_HEAD, SEEK, SEEK_ID, SEEK_POSITION = 0x114D9B74, 0x4DBB, 0x53AB, 0x53AC
CUES, CUE_POINT, CUE_TIME, CUE_TRACK_POSITIONS, CUE_TRACK, CUE_CLUSTER_POSITION = (
    0x1C53BB6B, 0xBB, 0xB3, 0xB7, 0xF7, 0xF1)
OPEN_SIZE = b"\x01" + b"\xff" * 7    # "length not known", in eight bytes: the place close() writes the length to
NO_PICTURE = (640, 480)              # the size written for a recording no picture came into


def _id(n: int) -> bytes:
    return n.to_bytes((n.bit_length() + 7) // 8, "big")


def _size(n: int, width: int = 0) -> bytes:
    """A length as EBML writes it: the first set bit tells how many bytes it takes."""
    if not width:
        width = 1
        while n >= (1 << 7 * width) - 1:     # all ones means "not known", so it is no length
            width += 1
    return ((1 << 7 * width) | n).to_bytes(width, "big")


def _el(id_: int, payload: bytes) -> bytes:
    return _id(id_) + _size(len(payload)) + payload


def _uint(id_: int, n: int, width: int = 0) -> bytes:
    return _el(id_, n.to_bytes(width or max(1, (n.bit_length() + 7) // 8), "big"))


def _text(id_: int, s: str) -> bytes:
    return _el(id_, s.encode())


def _elements(data: bytes, at: int, end: int):
    """The elements between two places of a Matroska file: (id, where its contents begin, where they end)."""
    while at < end:
        n = 9 - data[at].bit_length()
        id_ = int.from_bytes(data[at:at + n], "big")
        at += n
        n = 9 - data[at].bit_length()
        size = int.from_bytes(data[at:at + n], "big") & ((1 << 7 * n) - 1)
        at += n
        stop = end if size == (1 << 7 * n) - 1 else min(end, at + size)
        yield id_, at, stop
        at = stop


def mkv_seconds(path) -> float | None:
    """How long a recording's file says it is; None when it does not say (its writer died, or it still runs)."""
    try:
        with open(path, "rb") as f:
            data = f.read(1024)
        for id_, a, b in _elements(data, 0, len(data)):
            if id_ == SEGMENT:
                for id_, a, b in _elements(data, a, len(data)):
                    if id_ == INFO:
                        for id_, a, b in _elements(data, a, b):
                            if id_ == DURATION and b - a == 8:
                                return struct.unpack(">d", data[a:b])[0] / 1000
                        return None
    except (OSError, IndexError, ValueError):
        pass
    return None


class MkvWriter:
    """One recording as a Matroska file: track 1 the pictures (V_MJPEG), track 2 the sound
    (A_PCM/INT/LIT, 48 kHz, mono, 16 bit) unless `audio` is False. Times are milliseconds
    from the beginning; blocks are expected in the order of their times.

    The file is a whole one from its first byte on: its length and its duration are left open,
    which Matroska allows, and written by close(). A recording whose writer died still plays.
    close() also writes the list of where each cluster begins (the cues) behind the last one, and
    where that list is into the head of the file: a player jumps by it, and without it some
    (GStreamer's) jump to the wrong place in a file they have not read through yet.
    """

    def __init__(self, path, audio: bool = True, size: tuple[int, int] | None = None, rate: int = RATE):
        self.size = size           # of the pictures; read from the first one when it is not given
        self.has_audio = audio
        self.rate = rate
        self.bytes = 0             # in the file so far
        self.frames = 0            # pictures in the file so far, not counting those written a second time
        self._blocks: list[bytes] = []   # the cluster being filled: kept here until it is whole
        self._counted = 0          # the pictures in it that count
        self._cluster_ms = 0
        self._cue: tuple[int, int] | None = None     # its first picture, (time, track); its first block if it has none
        self._cues: list[tuple[int, int, int]] = []  # for every cluster on the disk: that, and where it begins
        self._last_ms = 0          # no block is written with a time before the one before it
        self._end_ms = 0.0         # where the last block ends
        # EBML 1, ids of up to 4 bytes, lengths of up to 8; Matroska as of its version 2, which
        # brought the SimpleBlock: nothing newer is used, so the oldest readers take the file.
        head = _el(EBML, _uint(0x4286, 1) + _uint(0x42F7, 1) + _uint(0x42F2, 4) + _uint(0x42F3, 8)
                   + _text(0x4282, "matroska") + _uint(0x4287, 2) + _uint(0x4285, 2))
        self._size_at = len(head) + len(_id(SEGMENT))
        self._body = self._size_at + len(OPEN_SIZE)     # places inside the file are counted from here
        # Where the cues are and the duration are not known yet: empty elements keep their bytes.
        seek = _el(VOID, bytes(len(self._seek(0)) - 2))
        date = int((time.time() - 978307200) * 1e9)      # Matroska counts from the year 2001
        info = _el(INFO, _uint(TIMESTAMP_SCALE, 1000000) + _text(MUXING_APP, "marswalk")
                   + _text(WRITING_APP, "marswalk hub") + _el(DATE_UTC, struct.pack(">q", date))
                   + _el(VOID, bytes(9)))
        self._duration_at = self._body + len(seek) + len(info) - 11
        # The picture size goes last in its entry and its entry first in the list, so its place is known:
        # it is written again when the first picture has come.
        picture = self._picture(size or (0, 0))
        entries = _el(TRACK_ENTRY, _uint(TRACK_NUMBER, 1) + _uint(TRACK_UID, 1) + _uint(TRACK_TYPE, 1)
                      + _uint(FLAG_LACING, 0) + _text(CODEC_ID, "V_MJPEG") + _el(VIDEO, picture))
        self._picture_at = len(entries) - len(picture)
        if audio:
            entries += _el(TRACK_ENTRY, _uint(TRACK_NUMBER, 2) + _uint(TRACK_UID, 2) + _uint(TRACK_TYPE, 2)
                           + _uint(FLAG_LACING, 0) + _text(CODEC_ID, "A_PCM/INT/LIT")
                           + _el(AUDIO, _el(SAMPLING_FREQUENCY, struct.pack(">d", rate))
                                 + _uint(CHANNELS, 1) + _uint(BIT_DEPTH, 16)))
        tracks = _el(TRACKS, entries)
        self._picture_at += self._body + len(seek) + len(info) + len(tracks) - len(entries)
        self._f = open(path, "wb", buffering=0)     # each write goes straight to the system, nothing is held back here
        try:
            self._append([head + _id(SEGMENT) + OPEN_SIZE + seek + info + tracks])
        except OSError:
            self._f.close()
            raise

    @staticmethod
    def _picture(size) -> bytes:
        return _uint(PIXEL_WIDTH, size[0], 2) + _uint(PIXEL_HEIGHT, size[1], 2)

    @staticmethod
    def _seek(cues_at: int) -> bytes:
        """The head's pointer to the cues. Always the same length, whatever the place."""
        return _el(SEEK_HEAD, _el(SEEK, _el(SEEK_ID, _id(CUES)) + _uint(SEEK_POSITION, cues_at, 8)))

    def _append(self, pieces: list):
        """Onto the end of the file, all of it or nothing: what a disk that ran full took the
        half of is cut off again, so the file ends with its last whole cluster."""
        try:
            for piece in pieces:
                left = memoryview(piece)
                while len(left):
                    left = left[self._f.write(left):]
        except OSError:
            self._f.truncate(self.bytes)
            self._f.seek(0, os.SEEK_END)
            raise
        self.bytes += sum(len(piece) for piece in pieces)

    def _rewrite(self, at: int, data: bytes):
        self._f.seek(at)
        self._f.write(data)
        self._f.seek(0, os.SEEK_END)

    def video(self, ms: int, jpeg: bytes, again: bool = False):
        """A picture. `again`: it is one that was written before (the recorder repeats a picture
        that stood for long), so it is not counted."""
        if self.size is None:
            self.size = jpeg_size(jpeg)
            if self.size:
                self._rewrite(self._picture_at, self._picture(self.size))
        ms = self._block(1, ms, jpeg)
        self._counted += not again
        self._end_ms = max(self._end_ms, ms)

    def audio(self, ms: int, pcm: bytes):
        if self.has_audio:
            ms = self._block(2, ms, pcm)
            self._end_ms = max(self._end_ms, ms + len(pcm) / 2 * 1000 / self.rate)

    def _block(self, track: int, ms: int, data: bytes) -> int:
        ms = max(int(ms), self._last_ms)
        self._last_ms = ms
        if not self._blocks or ms - self._cluster_ms >= CLUSTER_MS:
            self._flush()
            self._cluster_ms, self._cue = ms, None
        if self._cue is None or (track == 1 and self._cue[1] != 1):
            self._cue = (ms, track)
        # track number, the time within the cluster, and "a whole picture": every block stands alone
        self._blocks += [_id(SIMPLE_BLOCK) + _size(len(data) + 4) + bytes([0x80 | track])
                         + struct.pack(">hB", ms - self._cluster_ms, 0x80), data]
        return ms

    def _flush(self):
        """The cluster that was being filled goes to the disk, with its length in front."""
        if not self._blocks:
            return
        # They are taken out first: if the disk refuses them they are gone, not written twice.
        blocks, counted, self._blocks, self._counted = self._blocks, self._counted, [], 0
        at, stamp = self.bytes - self._body, _uint(TIMESTAMP, self._cluster_ms)
        self._append([_id(CLUSTER) + _size(len(stamp) + sum(len(b) for b in blocks)) + stamp, *blocks])
        self._cues.append((*self._cue, at))
        self.frames += counted

    def close(self, duration_ms: float | None = None):
        """Writes what is still waiting, the cues, and the length and the duration into their places."""
        if self._f.closed:
            return
        try:
            self._flush()
            if self._cues:
                cues_at = self.bytes - self._body
                self._append([_el(CUES, b"".join(
                    _el(CUE_POINT, _uint(CUE_TIME, ms) + _el(CUE_TRACK_POSITIONS, _uint(CUE_TRACK, track)
                                                             + _uint(CUE_CLUSTER_POSITION, at)))
                    for ms, track, at in self._cues))])
                self._rewrite(self._body, self._seek(cues_at))
            self._rewrite(self._size_at, _size(self.bytes - self._body, 8))
            self._rewrite(self._duration_at, _el(DURATION, struct.pack(">d", max(self._end_ms, duration_ms or 0.0))))
            if self.size is None:
                self._rewrite(self._picture_at, self._picture(NO_PICTURE))
        finally:
            self._f.close()


# ---------- the sound ----------
def _samples(pcm):
    return np.frombuffer(pcm, dtype="<i2", count=len(pcm) // 2).astype(np.float32)


class AudioMix:
    """The microphone and the hub's speech on one time line, in seconds since the recording began.

    add_mic and add_speech put sound onto the line, take() hands out the next stretch of it as
    16-bit samples, silence where nothing was put. What is added for a time already taken is lost.
    """

    def __init__(self, rate: int = RATE):
        if np is None:
            raise RecordError("the sound track needs numpy")
        self.rate = rate
        self.at = 0                          # the sample the next take begins with
        self._mic = np.zeros(0, np.float32)  # the microphones, from self.at on
        self._say = np.zeros(0, np.float32)  # the hub's speech, from self.at on
        self._talk: list[tuple[float, float]] = []   # when the hub speaks: the microphone is turned down there
        self._say_end = 0.0                  # where the speech put last ends
        self._streams: dict = {}             # per microphone: where its next chunk goes, and a chunk that waits

    def _put(self, track: str, first: int, x):
        """Adds samples to a track from sample `first` on. What lies before the last take is left out."""
        off = first - self.at
        if off < 0:
            x, off = x[-off:], 0
        if not len(x):
            return
        buf = getattr(self, track)
        if off + len(x) > len(buf):
            buf = np.concatenate([buf, np.zeros(off + len(x) - len(buf), np.float32)])
            setattr(self, track, buf)
        buf[off:off + len(x)] += x

    def _fit(self, x, src_rate: int, pos: float):
        """Samples at `src_rate` as samples of the mix, for a stretch that begins at sample `pos` of
        the line. `pos` may lie between two samples: the chunks of a stream then join without a seam.
        Returns the first sample and the samples."""
        first = math.floor(pos + 0.5)
        count = math.floor(pos + len(x) * self.rate / src_rate + 0.5) - first
        if src_rate == self.rate and abs(first - pos) < 1e-6:
            return first, x
        return first, np.interp((np.arange(count) + (first - pos)) * (src_rate / self.rate),
                                np.arange(len(x)), x).astype(np.float32)

    def add_mic(self, pcm: bytes, src_rate: int, at_s: float, src=None):
        """A chunk of a microphone's stream that arrived at `at_s`. `src` tells the streams apart
        when more than one headset sends.

        The stream has no gaps, so a chunk goes right behind the one before it, and its arrival
        is only looked at when the two are more than DRIFT_S apart. A chunk that comes later than
        that waits for the next one: if that is right on its heels, the link had held them back
        and no sound is missing, so they stay in line. If not, the microphone had stopped for a
        while and the sound goes where its arrival puts it."""
        x = _samples(pcm)
        if not len(x) or src_rate <= 0:
            return
        length = len(x) * self.rate / src_rate
        want = at_s * self.rate - length          # a chunk is sent when its last sample was heard
        s = self._streams.setdefault(src, {"pos": None, "held": None})
        held, s["held"] = s["held"], None
        if held:
            if at_s - held["at"] > 0.5 * held["length"] / self.rate:
                s["pos"] = held["want"]
            self._line_up(s, held)
        chunk = {"x": x, "rate": src_rate, "at": at_s, "want": want, "length": length}
        if s["pos"] is None:
            s["pos"] = want
        elif s["pos"] - want > DRIFT_S * self.rate:
            return      # the line is ahead of the clock (a stream that sends too much): this one is left out
        elif want - s["pos"] > DRIFT_S * self.rate:
            s["held"] = chunk
            return
        self._line_up(s, chunk)

    def _line_up(self, s: dict, chunk: dict):
        self._put("_mic", *self._fit(chunk["x"], chunk["rate"], s["pos"]))
        s["pos"] += chunk["length"]

    def add_speech(self, pcm: bytes, src_rate: int, at_s: float, urgent: bool = False):
        """A whole utterance of the hub, at the moment the hub begins to send it. The headset plays
        it a moment later, and behind what it is still playing; an urgent one cuts that off."""
        x = _samples(pcm)
        if not len(x) or src_rate <= 0:
            return
        if urgent and self._say_end > at_s:
            cut = max(0, round(at_s * self.rate) - self.at)
            self._say[cut:] = 0
            self._talk = [(a, min(b, at_s + SPEECH_TAIL_S)) for a, b in self._talk if a < at_s]
            self._say_end = at_s
        start = max(at_s + SPEECH_DELAY_S, self._say_end)
        self._put("_say", *self._fit(x, src_rate, start * self.rate))
        self._say_end = start + len(x) / src_rate
        self._talk.append((start - SPEECH_DELAY_S, self._say_end + SPEECH_TAIL_S))

    def _mic_gain(self, n: int):
        """How loud the microphone is for the next n samples: turned down while the hub speaks."""
        t0, t1 = self.at / self.rate, (self.at + n) / self.rate
        gain = None
        for a, b in self._talk:
            if a - RAMP_S < t1 and b + RAMP_S > t0:
                if gain is None:
                    t = (self.at + np.arange(n)) / self.rate
                    gain = np.ones(n, np.float32)
                gain = np.minimum(gain, np.interp(t, [a - RAMP_S, a, b, b + RAMP_S],
                                                  [1, MIC_UNDER_SPEECH, MIC_UNDER_SPEECH, 1]).astype(np.float32))
        return gain

    def _cut(self, track: str, n: int):
        buf = getattr(self, track)
        head = buf[:n] if len(buf) >= n else np.concatenate([buf, np.zeros(n - len(buf), np.float32)])
        setattr(self, track, buf[n:].copy())
        return head

    def take(self, until_s: float):
        """The mix from where the last take ended up to `until_s`, as 16-bit samples."""
        n = round(until_s * self.rate) - self.at
        if n <= 0:
            return np.zeros(0, "<i2")
        for s in self._streams.values():
            held = s["held"]
            if held and held["want"] < self.at + n:    # nothing followed it: it stands where it arrived
                s["pos"], s["held"] = held["want"], None
                self._line_up(s, held)
        mic, say = self._cut("_mic", n), self._cut("_say", n)
        gain = self._mic_gain(n)
        if gain is not None:
            mic = mic * gain
        self.at += n
        self._talk = [(a, b) for a, b in self._talk if (b + RAMP_S) * self.rate > self.at]
        return np.clip(np.rint(mic + say), -32768, 32767).astype("<i2")


# ---------- the MP4 ----------
_HAVE: dict[str, bool] = {}


def _have(element: str) -> bool:
    """Whether this machine's GStreamer has the element. Asked once."""
    if element not in _HAVE:
        try:
            _HAVE[element] = subprocess.run(["gst-inspect-1.0", "--exists", element], timeout=60,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            _HAVE[element] = False
    return _HAVE[element]


def convert_command(mkv: Path, out: Path, size: tuple[int, int], audio: bool) -> list[str] | None:
    """The gst-launch line that makes the MP4 of a recording; None when this machine cannot.

    H.264 at a constant quality and 30 pictures a second, whatever pace they came at; AAC beside it.
    The pictures are brought to the first one's size, with bars when a later one has another shape.
    """
    need = ["matroskademux", "multiqueue", "jpegdec", "videoconvert", "videoscale", "videorate", "x264enc", "mp4mux"]
    if audio:
        need += ["audioconvert", "audioresample", "voaacenc"]
    width, height = size[0] & ~1, size[1] & ~1       # H.264 takes even sizes only
    if not shutil.which("gst-launch-1.0") or not all(_have(e) for e in need) or width < 16 or height < 16:
        return None
    # One reader feeds both tracks. The multiqueue lets either run ahead of the other as far as it
    # takes (the encoder looks a second ahead; pictures may have stopped for a while), where two
    # plain queues would wait for each other for ever.
    cmd = ["gst-launch-1.0", "-q", "-e", "filesrc", f"location={mkv}", "!", "matroskademux", "name=d",
           "multiqueue", "name=q", "max-size-bytes=0", "max-size-time=0",
           "mp4mux", "name=m", "faststart=true", f"faststart-file={out}.tmp", "!", "filesink", f"location={out}",
           "d.video_0", "!", "q.sink_0", "q.src_0", "!", "jpegdec", "!", "videoconvert", "!", "videoscale", "!",
           "videorate", "!", f"video/x-raw,format=I420,width={width},height={height},framerate=30/1,pixel-aspect-ratio=1/1",
           "!", "x264enc", "pass=qual", "quantizer=19", "speed-preset=faster", "key-int-max=60", "threads=3", "!"]
    cmd += (["h264parse", "!"] if _have("h264parse") else []) + ["m.video_0"]
    if audio:
        cmd += ["d.audio_0", "!", "q.sink_1", "q.src_1", "!", "audioconvert", "!", "audioresample", "!",
                "voaacenc", "bitrate=128000", "!"]
        cmd += (["aacparse", "!"] if _have("aacparse") else []) + ["m.audio_0"]
    return (["nice", "-n", "15"] if shutil.which("nice") else []) + cmd


# ---------- the recorder ----------
class _Recording:
    """The one that runs: its file, what waits to be written, and its counts."""

    def __init__(self, name: str, writer: MkvWriter, t0: float):
        self.name = name
        self.writer = writer
        self.t0 = t0                 # the recorder's clock at the beginning
        self.audio = writer.has_audio
        self.waiting: queue.Queue = queue.Queue()
        self.dropped = 0             # pictures left out
        self.shown: tuple[int, bytes] | None = None   # the last picture and its time
        self.sound_ms = 0            # the sound is in the file up to here
        self.stop_at: float | None = None   # set by stop(): seconds since the beginning
        self.thread: threading.Thread | None = None


class Recorder:
    """Start and stop a recording, feed it, and tell about the ones in the folder.

    frame, mic, speech and state are called from the hub's event loop and never wait for the
    disk: they only hand over. A thread of its own does the writing.
    """

    def __init__(self, folder: Path, convert: bool = True, max_seconds: float = 1800.0,
                 min_free_bytes: int = 2 * 1024**3):
        self.folder = Path(folder)
        self.convert = convert
        self.max_seconds = max_seconds
        self.min_free_bytes = min_free_bytes
        self.stop_free_bytes = min(STOP_FREE, min_free_bytes // 2)
        self.clock = time.monotonic      # the tests put their own clock here
        self._lock = threading.Lock()    # start and the end of a recording, one at a time
        self._rec: _Recording | None = None
        self._last: dict | None = None   # how the last recording ended: what state() says while none runs
        self._made: dict[str, str] = {}  # name -> "converting" | "failed" | "master only", for this hub's recordings
        self._lengths: dict = {}         # name -> seconds, as far as known
        self._one = threading.Lock()     # one conversion at a time: the Jetson has other work
        self._procs: set = set()         # the gst-launch that runs
        self._workers: list[threading.Thread] = []
        self._closing = False
        # What a conversion left behind when the hub was stopped under it. One that still runs
        # (another hub on the same folder) writes all the time, so its file is never this old.
        try:
            for left in self.folder.glob("marswalk-*.mp4.part*"):
                if time.time() - left.stat().st_mtime > 600:
                    left.unlink()
        except OSError:
            pass

    @property
    def on(self) -> bool:
        return self._rec is not None

    def start(self) -> dict:
        """Begins marswalk-YYYYmmdd-HHMMSS.mkv in the folder. RecordError when it cannot."""
        with self._lock:
            if self._rec is not None:
                return self.state()
            if self._closing:
                raise RecordError("the hub is shutting down")
            try:
                self.folder.mkdir(parents=True, exist_ok=True)
                free = shutil.disk_usage(self.folder).free
            except OSError as err:
                raise RecordError(f"no folder for the recordings: {err}") from None
            if free < self.min_free_bytes:
                raise RecordError(f"disk short: {free / 1024**3:.1f} GB free, "
                                  f"a recording wants {self.min_free_bytes / 1024**3:.1f} GB")
            wall = time.time()
            while True:      # two in one second: the later one takes the next second's name
                name = time.strftime("marswalk-%Y%m%d-%H%M%S", time.localtime(wall))
                if not any((self.folder / f"{name}.{ext}").exists() for ext in ("mkv", "mp4")):
                    break
                wall += 1
            try:
                writer = MkvWriter(self.folder / f"{name}.mkv", audio=np is not None)
            except OSError as err:
                raise RecordError(f"the file cannot be made: {err}") from None
            rec = _Recording(name, writer, self.clock())
            rec.thread = threading.Thread(target=self._run, args=(rec,), name="recorder", daemon=True)
            self._made.pop(name, None)
            self._rec = rec
            rec.thread.start()
            log.info("recording %s%s", name, "" if rec.audio else " (pictures only: no numpy)")
            return self.state()

    def stop(self) -> dict | None:
        """Ends the recording: what waited is written, the file is finished, and the MP4 is begun
        in the background. Returns how it ended; with none running, how the last one ended."""
        rec = self._rec
        if rec is not None:
            if rec.stop_at is None:
                rec.stop_at = self.clock() - rec.t0
            rec.waiting.put(("stop",))
            rec.thread.join(30.0)
        return self.state()

    def close(self):
        """The hub is shutting down: the file is finished, but no conversion is begun that would
        be killed with the hub, and the one that runs is ended."""
        self._closing = True
        self.stop()
        for proc in list(self._procs):
            proc.kill()
        for worker in self._workers:
            worker.join(5.0)

    def frame(self, jpeg: bytes, at: float | None = None):
        """A picture, as the headset sent it. `at` is the clock's time it came at; now when left out."""
        rec = self._rec
        if rec is None:
            return
        if rec.waiting.qsize() > MAX_WAITING:
            rec.dropped += 1
            return
        rec.waiting.put(("frame", (self.clock() if at is None else at) - rec.t0, jpeg))

    def mic(self, pcm: bytes, rate: int, at: float | None = None, src=None):
        """A chunk of a headset's microphone, 16-bit mono. `src` tells two headsets apart."""
        self._sound("mic", pcm, rate, at, src)

    def speech(self, pcm: bytes, rate: int, at: float | None = None, urgent: bool = False):
        """A whole utterance of the hub, at the moment it begins to send it. `urgent` as in
        tts.begin: the headset then cuts what it is playing."""
        self._sound("speech", pcm, rate, at, urgent)

    def _sound(self, kind: str, pcm: bytes, rate: int, at: float | None, more):
        rec = self._rec
        if rec is None or not rec.audio or rec.waiting.qsize() > MAX_WAITING_SOUND:
            return
        rec.waiting.put((kind, (self.clock() if at is None else at) - rec.t0, pcm, rate, more))

    def state(self) -> dict | None:
        """The recording that runs, or how the last one ended; None when there was none yet."""
        rec = self._rec
        if rec is None:
            return dict(self._last) if self._last else None
        return {"on": True, "name": rec.name, "seconds": round(max(0.0, self.clock() - rec.t0), 1),
                "frames": rec.writer.frames, "bytes": rec.writer.bytes, "audio": rec.audio, "dropped": rec.dropped}

    def recordings(self) -> list[dict]:
        """What is in the folder, the newest first: name, length, the sizes of the two files, and
        where the MP4 stands."""
        found: dict[str, dict] = {}
        try:
            for entry in os.scandir(self.folder):
                m = FILE.fullmatch(entry.name)
                try:
                    if m:
                        found.setdefault(m[1], {})[m[2]] = entry.stat().st_size
                except OSError:
                    pass                # deleted this moment
        except OSError:
            return []                   # no folder yet: nothing was recorded
        rec, out = self._rec, []
        for name in sorted(found, reverse=True)[:LISTED]:
            sizes = found[name]
            if rec is not None and rec.name == name:
                state, seconds = "recording", round(max(0.0, self.clock() - rec.t0), 1)
            else:
                made = self._made.get(name)
                state = "converting" if made == "converting" else "ready" if "mp4" in sizes else made or "master only"
                seconds = self._length(name, sizes.get("mkv"))
            out.append({"name": name, "seconds": seconds, "mkv": sizes.get("mkv"), "mp4": sizes.get("mp4"),
                        "state": state})
        return out

    def _length(self, name: str, mkv_bytes: int | None) -> float | None:
        """A finished recording's length: known from making it, or read from its file, once."""
        if name not in self._lengths and mkv_bytes is not None:
            seconds = mkv_seconds(self.folder / f"{name}.mkv")
            self._lengths[name] = None if seconds is None else round(seconds, 1)
        return self._lengths.get(name)

    # ---------- the writing thread ----------
    def _run(self, rec: _Recording):
        mix = AudioMix() if rec.audio else None
        pictures: list[tuple[float, bytes]] = []    # in the order they came, until their time is written
        stepped = checked = 0.0
        end = why = None
        try:
            while end is None:
                try:
                    item = rec.waiting.get(timeout=STEP_S)
                except queue.Empty:
                    item = None
                now = self.clock() - rec.t0
                while item is not None:
                    if item[0] == "frame":
                        pictures.append(item[1:])
                    elif item[0] == "mic":
                        mix.add_mic(item[2], item[3], item[1], item[4])
                    elif item[0] == "speech":
                        mix.add_speech(item[2], item[3], item[1], item[4])
                    try:
                        item = rec.waiting.get_nowait()
                    except queue.Empty:
                        item = None
                if rec.stop_at is not None:
                    end = rec.stop_at
                elif now >= self.max_seconds:
                    end, why = self.max_seconds, "time limit"
                elif now - checked >= 2.0:
                    checked = now
                    if shutil.disk_usage(self.folder).free < self.stop_free_bytes:
                        end, why = now, "disk full"
                if end is not None or now - stepped >= STEP_S:
                    stepped = now
                    self._write(rec, mix, pictures, now - HOLD_S if end is None else end, end is not None)
        except OSError as err:
            why = "disk full" if err.errno == errno.ENOSPC else "write error"
            log.warning("recording %s broke off: %s", rec.name, err)
        except Exception:
            why = "error"
            log.exception("recording %s broke off", rec.name)
        self._finish(rec, self.clock() - rec.t0 if end is None else end, why)

    def _write(self, rec: _Recording, mix, pictures: list, upto: float, last: bool):
        """Everything up to `upto` seconds goes to the file, pictures and sound in the order of
        their times. The sound goes in whole pieces of STEP_S; the rest of it at the very end.

        A picture stands until the next one comes. A program that evens out the pace of the
        pictures takes for each moment the one nearest in time (GStreamer does, for the MP4), so
        after a pause the next picture would show early by half the pause. Where a picture stood
        for longer than STILL_MS it is therefore written once more, one picture's time before the
        next one. At the end of the recording too, and there a second time, or the MP4's pictures
        would end half way to it."""
        upto_ms = int(upto * 1000) if last else int(upto / STEP_S) * int(STEP_S * 1000)
        blocks, later = [], []      # a block: (time, track, data, is it a picture written again)

        def again(ms: int, end: bool = False):
            if rec.shown and ms - rec.shown[0] > STILL_MS:
                blocks.append((ms - FRAME_MS, 1, rec.shown[1], True))
                if end:
                    blocks.append((ms, 1, rec.shown[1], True))

        for seconds, jpeg in pictures:
            ms = round(seconds * 1000)
            if not (ms < upto_ms or (last and seconds <= upto)):
                later.append((seconds, jpeg))
            elif ms < 0 or jpeg_size(jpeg) is None:
                rec.dropped += 1                 # from before the beginning, or not a picture
            else:
                again(ms)
                blocks.append((ms, 1, jpeg, False))
                rec.shown = (ms, jpeg)
        pictures[:] = later
        if last:
            again(upto_ms, end=True)
        while mix is not None and rec.sound_ms < upto_ms:
            until = min(rec.sound_ms + int(STEP_S * 1000), upto_ms)
            blocks.append((rec.sound_ms, 2, mix.take(until / 1000).tobytes(), False))
            rec.sound_ms = until
        for ms, track, data, repeated in sorted(blocks, key=lambda b: b[:2]):
            if track == 1:
                rec.writer.video(ms, data, repeated)
            else:
                rec.writer.audio(ms, data)

    def _finish(self, rec: _Recording, end: float, why: str | None):
        try:
            rec.writer.close(end * 1000)
        except Exception as err:   # the file keeps its open length: it still plays. Whatever went
            # wrong, the recording must be over after this, or no other could ever begin.
            why = why or ("disk full" if getattr(err, "errno", None) == errno.ENOSPC else "write error")
            log.warning("recording %s not finished cleanly: %s", rec.name, err)
        final = {"on": False, "name": rec.name, "seconds": round(end, 1), "frames": rec.writer.frames,
                 "bytes": rec.writer.bytes, "audio": rec.audio, "dropped": rec.dropped}
        if why:
            final["stopped"] = why
        log.info("recording %s ended%s: %.1f s, %d pictures (%d left out), %.1f MB", rec.name,
                 f" ({why})" if why else "", end, rec.writer.frames, rec.dropped, rec.writer.bytes / 1e6)
        with self._lock:
            self._lengths[rec.name] = final["seconds"]
            worker = None
            if self.convert and not self._closing and rec.writer.frames and rec.writer.size:
                self._made[rec.name] = "converting"
                worker = threading.Thread(target=self._convert, args=(rec.name, rec.writer.size, rec.audio, end),
                                          name="convert", daemon=True)
                self._workers = [w for w in self._workers if w.is_alive()] + [worker]
            else:
                self._made[rec.name] = "master only"
            self._last = final
            self._rec = None
        if worker:
            worker.start()

    # ---------- the conversion thread ----------
    def _convert(self, name: str, size: tuple[int, int], audio: bool, seconds: float):
        """NAME.mkv -> NAME.mp4. Written beside it as NAME.mp4.part and given its name when whole."""
        mkv, mp4 = self.folder / f"{name}.mkv", self.folder / f"{name}.mp4"
        part = self.folder / f"{name}.mp4.part"
        with self._one:
            cmd = None if self._closing else convert_command(mkv, part, size, audio)
            if cmd is None:
                self._made[name] = "master only"
                if not self._closing:
                    log.warning("no MP4 of %s: GStreamer or one of its parts is missing here", name)
                return
            began, err, code = time.monotonic(), b"", None
            try:
                proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.PIPE, start_new_session=True)
                self._procs.add(proc)
                if self._closing:      # close() looked for it a moment too early
                    proc.kill()
                try:
                    err = proc.communicate(timeout=600 + 20 * seconds)[1]
                except subprocess.TimeoutExpired:
                    proc.kill()
                    err = proc.communicate()[1] + b" (took too long)"
                code = proc.returncode
                self._procs.discard(proc)
                if code == 0 and part.stat().st_size > 0:
                    os.replace(part, mp4)
                    self._made.pop(name, None)
                    log.info("MP4 of %s made in %.0f s: %.1f MB", name, time.monotonic() - began,
                             mp4.stat().st_size / 1e6)
                    return
            except OSError as oserr:
                err += str(oserr).encode()
            finally:
                for left in (part, Path(f"{part}.tmp")):
                    left.unlink(missing_ok=True)
            if self._closing:
                self._made[name] = "master only"     # ended with the hub, not by a fault
                return
            self._made[name] = "failed"
            log.warning("no MP4 of %s (gst-launch said %s): %s", name, code,
                        err.decode(errors="replace").strip()[-400:])
