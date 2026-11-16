// The ring buffer, as arithmetic (after boqo's hosted watcher).
//
// The buffer is a folder of 10 s MPEG-TS segments, each named by the UTC
// wall-clock second it opened (`seg_20261115203045.ts`). A segment here is
// `{ n, t0 }`: `n` is an index the watcher counts, `t0` the epoch second it
// opened on. Nothing in this file touches the disk, so every rule is pinned
// by a test on a synthetic listing.

import { stamp } from "./session.mjs";

export const SEGMENT_SEC = 10;
/** The buffer keeps this much of the newest stream. */
export const HORIZON_SEC = 720;
/** A cut is this long at most: 120 s before the peak, 30 s after. */
export const WINDOW_SEC = 150;
export const POST_ROLL_SEC = 30;
/**
 * Two segments whose starts are further apart than this have a hole between
 * them (a capture that restarted, a stall, an ad the source left out). A
 * segment runs 10 to 12 s (it ends on a keyframe) and its name is rounded to
 * the second, so 13 s is still one unbroken stream.
 */
export const GAP_SEC = 13;

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

/**
 * Every segment that overlaps [from, to] (epoch seconds). The edges are not
 * symmetric on purpose: a segment starting exactly at `to` still counts, but
 * one that ends exactly at `from` holds nothing inside the window.
 */
export function segmentsCovering(segs, from, to, segSec = SEGMENT_SEC) {
  return segs.filter((s) => s.t0 <= to && s.t0 + segSec > from);
}

/**
 * The segments that fell out of the newest `horizonSec` of the buffer: safe
 * to unlink. The horizon runs back from the end of the newest segment, so a
 * stream that paused does not empty its own buffer.
 */
export function pruneBefore(segs, horizonSec = HORIZON_SEC, segSec = SEGMENT_SEC) {
  if (segs.length === 0) return [];
  const newestEnd = Math.max(...segs.map((s) => s.t0)) + segSec;
  return segs.filter((s) => s.t0 + segSec <= newestEnd - horizonSec);
}

/**
 * Where a segment's chat ends: the next segment's start, but never more than
 * a second past this segment's own length. Without the cap the segment before
 * a hole in the capture owns the whole hole's chat, and a 20 s hole reads as
 * a spike of three times the usual chatters.
 */
export function chatWindowEnd(seg, next, segSec = SEGMENT_SEC) {
  return Math.min(next?.t0 ?? Infinity, seg.t0 + segSec + 1);
}

/** The segments in start order, split wherever two starts are more than GAP_SEC apart. */
function runs(segs, gapSec = GAP_SEC) {
  const sorted = [...segs].sort((a, b) => a.t0 - b.t0);
  const out = [];
  for (const s of sorted) {
    const run = out.at(-1);
    if (run && s.t0 - run.at(-1).t0 <= gapSec) run.push(s);
    else out.push([s]);
  }
  return out;
}

/**
 * The window that ends `postRollSec` after the peak and is `windowSec` long,
 * clamped to what the buffer still holds and to the unbroken run of segments
 * around the peak: a cut never joins segments across a hole, because the
 * video would then run shorter than the wall clock and the peak and chat
 * times would drift off it. `peakOffsetSec` is where the peak sits counted
 * from the cut's first segment (the cut starts on that segment's boundary).
 * Null when the buffer has nothing in the window.
 */
export function planCut(segs, peakAt, windowSec = WINDOW_SEC, postRollSec = POST_ROLL_SEC, segSec = SEGMENT_SEC) {
  if (segs.length === 0) return null;
  const all = runs(segs);
  // the run that holds the peak, else the last one that started before it
  const run =
    all.find((r) => r[0].t0 <= peakAt && peakAt < r.at(-1).t0 + segSec) ?? all.filter((r) => r[0].t0 <= peakAt).at(-1);
  if (!run) return null;
  const endAt = Math.min(peakAt + postRollSec, run.at(-1).t0 + segSec);
  const startAt = Math.max(peakAt + postRollSec - windowSec, run[0].t0);
  if (startAt >= endAt) return null;
  const covering = segmentsCovering(run, startAt, endAt, segSec);
  if (covering.length === 0) return null;
  return { startAt, endAt, segments: covering, peakOffsetSec: Math.max(0, peakAt - covering[0].t0) };
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
