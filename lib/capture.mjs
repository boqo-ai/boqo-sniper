// Which program records the stream, and how (tools/watch.mjs runs it).
//
// The source reads the channel's page (boqo's streamUrl: https://www.twitch.tv/<login>, https://kick.com/<slug>).
// yt-dlp by default: it is the path that has run live. streamlink only when
// <home>/boqo-sniper/config.json says "capture": "streamlink". It skips
// Twitch's ads, but in this beta it is untested on a live stream, and through
// an ad break it writes nothing, so its stall limit is longer.

import fs from "node:fs/promises";
import path from "node:path";
import { resolveChannel, sniperHome } from "./session.mjs";
import { streamUrl } from "./boqo/stream.mjs";
import { parseSegmentList } from "./buffer.mjs";
import { CAPTURE_STALL_SEC, SEGMENT_SEC } from "./boqo/watch-constants.mjs";

/** No new segment for this long while capturing: the source is stuck, kill it and start over (boqo's CAPTURE_STALL_SEC). */
export const STALL_SEC = CAPTURE_STALL_SEC;
/** streamlink with --twitch-disable-ads writes nothing for the length of an ad break (60 s and up). */
export const STREAMLINK_STALL_SEC = 180;

/** The skill's config.json, or {} when it is missing, unreadable or not an object; `warning` says why it was ignored. */
export async function readConfig() {
  const file = path.join(sniperHome(), "config.json");
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    return { config: {}, warning: err.code === "ENOENT" ? null : `cannot read ${file}: ${err.code ?? err.message}` };
  }
  try {
    const config = JSON.parse(text);
    if (config && typeof config === "object" && !Array.isArray(config)) return { config, warning: null };
  } catch {}
  return { config: {}, warning: `${file} is not a JSON object; recording with yt-dlp` };
}

/** "yt-dlp" or "streamlink" for this config and what is installed (`has.ytdlp`, `has.streamlink`); throws when it cannot record. */
export function chooseCapture(config, has) {
  if (config?.capture === "streamlink") {
    if (!has.streamlink) throw new Error('config.json says "capture": "streamlink", and streamlink is not on PATH');
    return "streamlink";
  }
  if (!has.ytdlp) throw new Error("yt-dlp is not on PATH");
  return "yt-dlp";
}

/**
 * The source command; it writes the stream to stdout. Both stop at 1080p.
 * streamlink weighs a stream name as its height plus its frame rate (1080p60
 * is 1140), so ">1080p60" leaves out only what is above 1080p60.
 * `channel` is anything resolveChannel takes: `{platform, channel}`, a link, a bare Twitch login. Twitch's ad
 * skipping is Twitch's alone.
 */
export function captureCommand(tool, channel) {
  const c = resolveChannel(channel);
  if (tool === "streamlink") {
    return {
      cmd: "streamlink",
      args: [
        ...(c.platform === "twitch" ? ["--twitch-disable-ads"] : []),
        "--stream-sorting-excludes", ">1080p60", "--stdout", streamUrl(c), "best",
      ],
    };
  }
  return {
    cmd: "yt-dlp",
    args: ["-q", "-f", "best[height<=1080]/best", "-o", "-", streamUrl(c)],
  };
}

export function stallSecFor(tool) {
  return tool === "streamlink" ? STREAMLINK_STALL_SEC : STALL_SEC;
}

/** The ffmpeg's thread cap: a stream copy and one audio filter have no frame-level work to parallelise. */
export const CAPTURE_THREADS = 1;

/**
 * The capture's ffmpeg, after boqo's buildCaptureFfmpegArgs with the source on
 * stdin (hosted pipes streamlink, here yt-dlp or streamlink). Two outputs from
 * one input: the buffer, a stream copy cut into `segmentSec` MPEG-TS files
 * (run it with the buffer folder as cwd), and a null output carrying ebur128,
 * whose momentary loudness lines (a line per 100 ms) arrive on stderr, so the
 * log level is info. `-map 0:a:0` exits ffmpeg 1 on a video-only stream.
 *
 * The files are named by a counter, `seg_%06d.ts` from `startNumber`, which the
 * watcher continues after a restart: a name made from the clock (boqo's `%s.ts`,
 * or `-strftime`) is reused when a stalled source catches up in a burst, and
 * ffmpeg then overwrites the earlier segment under it (measured 2026-11-16: a
 * 60 s file fed without -re opened 10 segments under one name and kept the last).
 * `listFile` is ffmpeg's segment list (csv, `live`: each row is written when its
 * segment is closed): `name,start,end` in stream seconds, which is where the
 * watcher takes a segment's time from (createCaptureClock in lib/buffer.mjs).
 */
export function captureFfmpegArgs({ segmentSec = SEGMENT_SEC, threads = CAPTURE_THREADS, startNumber = 0, listFile = "segments.csv" } = {}) {
  const t = String(threads);
  return [
    "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
    // before -i, where ffmpeg reads global options; after it they become per-output and the cap does not bind
    "-threads", t, "-filter_threads", t, "-filter_complex_threads", t,
    "-i", "pipe:0",
    // output 1: the buffer
    "-map", "0:v:0", "-map", "0:a:0", "-c", "copy",
    "-f", "segment", "-segment_time", String(segmentSec), "-segment_format", "mpegts", "-reset_timestamps", "1",
    "-segment_start_number", String(startNumber),
    "-segment_list", listFile, "-segment_list_type", "csv", "-segment_list_flags", "live",
    "seg_%06d.ts",
    // output 2: the loudness series on stderr, nothing written
    "-map", "0:a:0", "-af", "ebur128=peak=none", "-f", "null", "-",
  ];
}

/**
 * The rows `listFile` (in `dir`) gained since byte `offset`, and the offset to read from next: only whole lines are
 * taken, so a row ffmpeg is still writing is left for the next call, and a row is never read twice. A missing file
 * (the capture has not closed its first segment) is no rows.
 */
export async function readSegmentRows(dir, listFile, offset) {
  let handle;
  try {
    handle = await fs.open(path.join(dir, listFile), "r");
  } catch (err) {
    if (err.code === "ENOENT") return { rows: [], offset };
    throw err;
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return { rows: [], offset };
    const buf = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
    const text = buf.toString("utf8", 0, bytesRead);
    const end = text.lastIndexOf("\n") + 1;
    return { rows: parseSegmentList(text.slice(0, end)), offset: offset + Buffer.byteLength(text.slice(0, end)) };
  } finally {
    await handle.close();
  }
}

/**
 * What to say, and end the watch on, when yt-dlp was turned away by kick.com; null for anything else (offline, a
 * missing channel, a network error). Read from yt-dlp 2026.08.19's source, not run against kick.com here: its Kick
 * extractor asks kick.com's channel API with `impersonate=True` (extractor/kick.py `_call_api`); with no browser to
 * impersonate (curl_cffi) it only warns and sends the request plain (extractor/common.py `_request_webpage`), and a
 * refusal ends it with the HTTPError's text, `HTTP Error 403: Forbidden` (networking/exceptions.py). A plain request
 * from this box's network was answered 403 (the ledger's Task B3 probe, 2026-11-16, Node's fetch). A capture and a
 * live check refused so would otherwise read as an offline channel: nothing recorded, every poll "not live", and the
 * watch ending `offline` 10 polls later, with no word of why.
 */
export function kickRefusal(text) {
  if (!/HTTP Error 403\b/.test(String(text ?? ""))) return null;
  return (
    "kick refused the capture: yt-dlp got HTTP Error 403 from kick.com, which sits behind Cloudflare " +
    "(Kick support is experimental; yt-dlp needs a browser to impersonate, see yt-dlp --list-impersonate-targets)"
  );
}

/**
 * A line the capture's ffmpeg prints on every segment it opens, at the info
 * level the loudness lines need ("[segment @ 0x…] Opening 'seg_….ts' for
 * writing"). It says nothing about a failure, and a dozen of them would push a
 * dying capture's real error out of the failure tail.
 */
export function isSegmentOpening(line) {
  return /^\[segment @ [^\]]+\] Opening '.*' for writing\s*$/.test(line);
}
