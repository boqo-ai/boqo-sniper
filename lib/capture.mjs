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
 * named by the UTC second they open (the caller runs it with TZ=UTC0 in the
 * buffer folder), and a null output carrying ebur128, whose momentary
 * loudness lines (a line per 100 ms) arrive on stderr, so the log level is
 * info. `-map 0:a:0` exits ffmpeg 1 on a video-only stream.
 */
export function captureFfmpegArgs({ segmentSec = SEGMENT_SEC, threads = CAPTURE_THREADS } = {}) {
  const t = String(threads);
  return [
    "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
    // before -i, where ffmpeg reads global options; after it they become per-output and the cap does not bind
    "-threads", t, "-filter_threads", t, "-filter_complex_threads", t,
    "-i", "pipe:0",
    // output 1: the buffer
    "-map", "0:v:0", "-map", "0:a:0", "-c", "copy",
    "-f", "segment", "-segment_time", String(segmentSec), "-segment_format", "mpegts", "-reset_timestamps", "1",
    "-strftime", "1", "seg_%Y%m%d%H%M%S.ts",
    // output 2: the loudness series on stderr, nothing written
    "-map", "0:a:0", "-af", "ebur128=peak=none", "-f", "null", "-",
  ];
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
