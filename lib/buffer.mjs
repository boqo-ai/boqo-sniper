// The ring buffer, as arithmetic (after boqo's hosted watcher).
//
// The buffer is a folder of 6 s MPEG-TS segments, each named by the UTC
// wall-clock second it opened (`seg_20261115203045.ts`). A segment here is
// `{ n, t0, cap }`: `n` is an index the watcher counts, `t0` the epoch second
// it opened on, `cap` the capture it came from (the watcher counts them).
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
 * hole between them (an ad streamlink left out, a network pause). A segment's
 * name is the wall-clock second ffmpeg opened it, and a live stream arrives in
 * bursts: in a live yt-dlp capture of 10 s segments (jynxzi, 2026-11-16) every
 * file was 10.0 to 10.2 s long while consecutive starts landed 4 to 14 s
 * apart. 25 s is clear of that jitter (measured at 10 s segments, not yet at
 * the 6 s segments of this capture). With 6 s segments a hole shows as starts
 * more than 25 s apart, so one shorter than 19 s is not seen. A capture
 * restart is always a hole, however close (see the `cap` field in planCut).
 */
export const GAP_SEC = 25;

const NAME = /^seg_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.ts$/;

/** `seg_YYYYMMDDHHMMSS.ts` in UTC; no colons, so it is a legal name on Windows. */
export function segmentName(t0) {
  return `seg_${stamp(new Date(t0 * 1000)).replace("-", "")}.ts`;
}

/** The epoch second a segment file name encodes, or null for any other name. */
export function parseSegmentName(name) {
  const m = NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
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
