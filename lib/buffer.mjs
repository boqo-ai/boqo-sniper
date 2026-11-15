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
 * The window that ends `postRollSec` after the peak and is `windowSec` long,
 * clamped to what the buffer still holds. `peakOffsetSec` is where the peak
 * sits inside the cut's first segment onward (the cut starts on that
 * segment's boundary). Null when the buffer has nothing in the window.
 */
export function planCut(segs, peakAt, windowSec = WINDOW_SEC, postRollSec = POST_ROLL_SEC, segSec = SEGMENT_SEC) {
  if (segs.length === 0) return null;
  const oldest = Math.min(...segs.map((s) => s.t0));
  const endAt = peakAt + postRollSec;
  const startAt = Math.max(endAt - windowSec, oldest);
  if (startAt >= endAt) return null;
  const covering = segmentsCovering(segs, startAt, endAt, segSec);
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
