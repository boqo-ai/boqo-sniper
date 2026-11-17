// Momentary loudness, the audio signal the detector reads.
//
// Live: the capture's ffmpeg writes a second output through
// `-af ebur128=peak=none -f null -`, which prints a line per 100 ms with the
// momentary loudness (M, a 400 ms window). parseLoudnessLine (boqo's, in
// lib/boqo/loudness-line.mjs) reads a line; the watcher stamps it with its
// clock as it arrives, and the tick feed (lib/ticks.mjs) hands the detector the
// loudest reading of each second, as hosted's session does.
//
// Replay: there is no live capture to read lines from, so measureMomentary runs
// the same filter over one finished segment and returns its readings with
// their `t` (seconds into the file); the replay stamps each at the segment's
// start plus `t`.

export { clampLoudness, parseLoudnessLine } from "./boqo/loudness-line.mjs";
import { spawn } from "node:child_process";
import { toolEnv } from "../engine/env.mjs";
import { LOUDNESS_FLOOR, parseLoudnessLine } from "./boqo/loudness-line.mjs";

export { LOUDNESS_FLOOR };

/**
 * The momentary readings of one file, [{ t, momentary }] in order, through the
 * capture's own filter (`ebur128=peak=none`). Empty when the file has no audio
 * or cannot be read. `env` defaults to toolEnv() (macOS ffmpeg-full).
 */
export function measureMomentary(file, { cwd, ffmpeg = "ffmpeg", timeoutMs = 60000, env = toolEnv() } = {}) {
  return new Promise((resolve) => {
    const readings = [];
    const read = lineReader((line) => {
      const parsed = parseLoudnessLine(line);
      if (parsed) readings.push(parsed);
    });
    let child;
    try {
      child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=none", "-f", "null", "-"], {
        cwd,
        env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve([]);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on("data", read);
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      read("\n");
      resolve(readings);
    });
  });
}

/** A `data` handler that hands `onLine` each complete line of what a pipe writes; a partial line waits for its end. */
export function lineReader(onLine) {
  let pending = "";
  return (chunk) => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
}
