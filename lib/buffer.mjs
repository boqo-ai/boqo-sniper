// The ring buffer, as arithmetic (after boqo's hosted watcher).
//
// The buffer is a folder of 6 s MPEG-TS segments, named by a counter that only
// goes up (`seg_000042.ts`; lib/capture.mjs), never by the clock: a name from
// the wall clock is reused when a stalled stream catches up in a burst, and the
// newer segment then overwrites the older one. A segment here is
// `{ n, t0, cap }`: `n` is an index the watcher counts, `t0` the epoch second
// it opened on (from the capture's segment list and the clock that stamps it,
// see createCaptureClock), `cap` the capture it came from (the watcher counts them).
// Nothing in this file touches the disk, so every rule is pinned by a test on
// a synthetic listing.
//
// The coverage, prune and cut arithmetic is boqo's own (lib/boqo/buffer.mjs,
// pinned by goldens); this file adapts it to the skill's segments (seconds
// and `t0`, where boqo's are milliseconds and `startSec`) and adds what the
// skill needs and boqo's single unbroken capture does not: holes between
// captures (planCut's runs) and the chat window of a segment.

import { stamp } from "./session.mjs";
import * as port from "./boqo/buffer.mjs";
import { POST_ROLL_SEC, PRUNE_MARGIN_SEC, SEGMENT_SEC } from "./boqo/watch-constants.mjs";

export { POST_ROLL_SEC, PRUNE_MARGIN_SEC, SEGMENT_SEC };
/** A cut is this long at most (boqo's default session windowSec): 270 s before the peak, 30 s after. */
export const WINDOW_SEC = 300;
/** The buffer keeps the window plus a margin: hosted prunes at now - windowSec - PRUNE_MARGIN_SEC. */
export const HORIZON_SEC = WINDOW_SEC + PRUNE_MARGIN_SEC;
/**
 * Two segments of one capture whose starts are further apart than this have a
 * hole between them (an ad streamlink left out, a network pause). Measured
 * (2026-11-16, jynxzi, a live yt-dlp capture of 10 s segments): every file was
 * 10.0 to 10.2 s long while the wall-clock names of the time landed 4 to 14 s
 * apart, so delivery jitter stays well under 25 s (not yet measured at the 6 s
 * segments of this capture). Measured the same day: a TS with a 30 s jump in
 * its timestamps, through the production segmenter, gives contiguous segment-list
 * rows (ffmpeg's discontinuity correction flattens the jump), so a hole inside
 * one capture is not in the list's times. It shows in when the rows are read:
 * createCaptureClock splits the capture where read times run more than this
 * later than the stream's own times allow, and a capture restart is always a
 * hole, however close (see the `cap` field in planCut).
 */
export const GAP_SEC = 25;

const NAME = /^seg_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.ts$/;

/**
 * `seg_YYYYMMDDHHMMSS.ts` in UTC; no colons, so it is a legal name on Windows. The name of a replay's input file
 * (and what v0.1 wrote into its buffer): a replay reads each file's offset from it. The live buffer is not named so.
 */
export function segmentName(t0) {
  return `seg_${stamp(new Date(t0 * 1000)).replace("-", "")}.ts`;
}

/** The epoch second a replay file's name encodes (see segmentName), or null for any other name. */
export function parseSegmentName(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

/** The buffer's file name for segment number `n`: `seg_000042.ts`, a counter ffmpeg continues from `-segment_start_number`. */
export function segmentFileName(n) {
  return `seg_${String(n).padStart(6, "0")}.ts`;
}

/** The counter in a buffer file name, or null for any other name. */
export function parseSegmentNumber(name) {
  const m = /^seg_(\d{6,})\.ts$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * The rows of ffmpeg's `-segment_list_type csv` (`seg_000007.ts,0.000000,6.023222`: the file, then its start and end
 * in the capture's stream seconds, the first segment starting at 0), complete lines only: a line still being written
 * has no newline yet and is read on the next call.
 */
export function parseSegmentList(text) {
  const rows = [];
  for (const line of String(text).split("\n").slice(0, -1)) {
    const [name, start, end] = line.replace(/\r$/, "").split(",");
    if (parseSegmentNumber(name ?? "") === null || !Number.isFinite(Number(start)) || !Number.isFinite(Number(end))) continue;
    rows.push({ name, start: Number(start), end: Number(end) });
  }
  return rows;
}

/**
 * Epoch seconds for a capture's segments. The segment list gives each one's place in the capture's stream time, and
 * that is spaced evenly whatever the stream's delivery was (a live HLS capture catching up writes ten segments in one
 * second; the wall clock would put them all on one instant). The one unknown is where stream time 0 sits on the wall
 * clock. A row is read at `seenAt`, no earlier than its content could have been live, so `seenAt - row.end` is never
 * below the truth, and the smallest of them so far is the best estimate (the anchor): a capture reading live, one row
 * a segment, gets (read time - length) = the second ffmpeg opened the segment, which is how hosted stamps (its `%s`
 * names); one catching up from a backlog converges as it reaches the live edge. The anchor only goes down, so a
 * segment's `t0` only moves earlier, by at most the delivery jitter seen so far.
 *
 * A hole in the content (the source dropped for a minute and resumed) is invisible in the list: ffmpeg flattens the
 * timestamp jump, so the later rows are contiguous with the earlier ones, and the anchor, which only goes down, would
 * stamp every later segment early by the hole's length. A hole and a catch-up both read late, and differ in how they
 * end. A catch-up reads its backlog at one instant, so the lag (`seenAt - row.end` above the anchor) falls by a row
 * every row and is back inside GAP_SEC in a few; after a hole it stays where it is, row after row, read one segment
 * apart. So when the lag is above GAP_SEC for two rows in a row and has not fallen by more than half a segment
 * between them, the shift is permanent: a new epoch starts from those two rows (`splitBack: 1`, the previous row
 * moves to it too), with its own anchor, and the caller treats the epoch as a new run (a hole, as a capture restart
 * is). A slower catch-up than about 2x reads as a shift too: its cost is one hole, not a wrong time.
 * `observe` returns `{ epoch, splitBack, gapSec }`; `t0(startSec, epoch)` stamps a segment of that epoch (default: the newest).
 */
export function createCaptureClock({ gapSec = GAP_SEC, fallSec = SEGMENT_SEC / 2 } = {}) {
  const anchors = [Infinity];
  let run = 0; // consecutive rows whose lag is above gapSec and not falling
  let prev = null; // the previous shifted row's { lag, v }
  return {
    observe(row, seenAt) {
      const v = seenAt - row.end;
      const epoch = anchors.length - 1;
      const lag = v - anchors[epoch];
      if (lag > gapSec) {
        run = prev !== null && lag >= prev.lag - fallSec ? run + 1 : 1;
        const before = prev;
        prev = { lag, v };
        if (run >= 2) {
          anchors.push(Math.min(before.v, v));
          run = 0;
          prev = null;
          return { epoch: anchors.length - 1, splitBack: 1, gapSec: lag };
        }
        return { epoch, splitBack: 0, gapSec: 0 };
      }
      run = 0;
      prev = null;
      if (v < anchors[epoch]) anchors[epoch] = v;
      return { epoch, splitBack: 0, gapSec: 0 };
    },
    t0(startSec, epoch = anchors.length - 1) {
      return anchors[epoch] + startSec;
    },
  };
}

/** boqo's functions read `startSec`; wrap each segment once, unwrap what they return. */
const toPort = (segs) => segs.map((seg) => ({ path: seg.name ?? "", startSec: seg.t0, size: 0, seg }));
const fromPort = (wrapped) => wrapped.map((w) => w.seg);

/**
 * Every segment that overlaps [from, to] (epoch seconds). The edges are not
 * symmetric on purpose: a segment starting exactly at `to` still counts, but
 * one that ends exactly at `from` holds nothing inside the window.
 */
export function segmentsCovering(segs, from, to, segSec = SEGMENT_SEC) {
  return fromPort(port.segmentsCovering(toPort(segs), from * 1000, to * 1000, segSec));
}

/**
 * The segments that fell out of the newest `horizonSec` of the buffer: safe
 * to unlink. Hosted counts the horizon back from the wall clock; here it runs
 * back from the end of the newest segment, so a stream that paused does not
 * empty its own buffer. A segment ending exactly on the horizon stays (boqo's
 * strict `<`).
 */
export function pruneBefore(segs, horizonSec = HORIZON_SEC, segSec = SEGMENT_SEC) {
  if (segs.length === 0) return [];
  const newestEnd = Math.max(...segs.map((s) => s.t0)) + segSec;
  return fromPort(port.pruneBefore(toPort(segs), newestEnd - horizonSec, segSec));
}

/**
 * The segments in start order, split wherever two starts are more than
 * GAP_SEC apart or a new capture begins (`cap`, the capture a segment came
 * from; segments without one join by time alone).
 */
function runs(segs, gapSec = GAP_SEC) {
  const sorted = [...segs].sort((a, b) => a.t0 - b.t0);
  const out = [];
  for (const s of sorted) {
    const run = out.at(-1);
    const prev = run?.at(-1);
    const sameCapture = prev?.cap === undefined || s.cap === undefined || prev.cap === s.cap;
    if (run && sameCapture && s.t0 - prev.t0 <= gapSec) run.push(s);
    else out.push([s]);
  }
  return out;
}

/**
 * boqo's planCut, run on the unbroken run of segments around the peak: a cut
 * never joins segments across a hole, because the video would then run shorter
 * than the wall clock and the peak and chat times would drift off it. The
 * window ends `postRollSec` after the peak and is `windowSec` long, clamped to
 * what the run still holds; `startAt` and `endAt` are epoch seconds, and
 * `peakOffsetSec` is where the peak sits counted from the cut's first segment
 * (the cut starts on that segment's boundary). Null when the buffer has
 * nothing in the window.
 */
export function planCut(segs, peakAt, windowSec = WINDOW_SEC, postRollSec = POST_ROLL_SEC, segSec = SEGMENT_SEC) {
  if (segs.length === 0) return null;
  const all = runs(segs);
  // the run that holds the peak, else the last one that started before it
  const run =
    all.find((r) => r[0].t0 <= peakAt && peakAt < r.at(-1).t0 + segSec) ?? all.filter((r) => r[0].t0 <= peakAt).at(-1);
  if (!run) return null;
  const plan = port.planCut(toPort(run), peakAt * 1000, windowSec, postRollSec, segSec);
  if (!plan) return null;
  return {
    startAt: plan.startAt / 1000,
    endAt: Math.min(plan.endAt / 1000, run.at(-1).t0 + segSec),
    segments: fromPort(plan.segments),
    peakOffsetSec: plan.peakOffsetSec,
  };
}

/** The concat demuxer's list: `file '<name>'`, a quote inside the name as `'\''`. */
export function concatList(files) {
  return files.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'\n`).join("");
}

/**
 * Stream copy, never a re-encode. `aac_adtstoasc` turns the TS's ADTS audio
 * framing into mp4's; `+faststart` puts the moov atom first. The list names
 * its files relative to its own folder, so run it with that folder as cwd.
 */
export function concatArgs(listPath, outPath) {
  return [
    "-nostdin", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart",
    outPath,
  ];
}

/** At most this many moments wait to be judged; a new one past that is skipped. */
export const MAX_QUEUE = 10;
/** A moment is about 140 MB: with less than this free, a new one is skipped. */
export const MIN_FREE_BYTES = 3e9;

/**
 * Why a new moment is not cut: "queue" when `unclaimed` moments already wait
 * (nobody judges them as fast as they come), "disk" when `freeBytes` is short
 * (null: unknown, so cut). Null when it is cut.
 */
export function skipCut({ unclaimed, freeBytes }, { maxQueue = MAX_QUEUE, minFreeBytes = MIN_FREE_BYTES } = {}) {
  if (unclaimed >= maxQueue) return "queue";
  if (freeBytes !== null && freeBytes !== undefined && freeBytes < minFreeBytes) return "disk";
  return null;
}
