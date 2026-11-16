// Which program records the stream, and how (tools/watch.mjs runs it).
//
// yt-dlp by default: it is the path that has run live. streamlink only when
// <home>/boqo-sniper/config.json says "capture": "streamlink". It skips
// Twitch's ads, but in this beta it is untested on a live stream, and through
// an ad break it writes nothing, so its stall limit is longer.

import fs from "node:fs/promises";
import path from "node:path";
import { sniperHome } from "./session.mjs";

/** No new segment for this long while capturing: the source is stuck, kill it and start over. */
export const STALL_SEC = 60;
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
 */
export function captureCommand(tool, channel) {
  if (tool === "streamlink") {
    return {
      cmd: "streamlink",
      args: ["--twitch-disable-ads", "--stream-sorting-excludes", ">1080p60", "--stdout", `twitch.tv/${channel}`, "best"],
    };
  }
  return {
    cmd: "yt-dlp",
    args: ["-q", "-f", "best[height<=1080]/best", "-o", "-", `https://www.twitch.tv/${channel}`],
  };
}

export function stallSecFor(tool) {
  return tool === "streamlink" ? STREAMLINK_STALL_SEC : STALL_SEC;
}
