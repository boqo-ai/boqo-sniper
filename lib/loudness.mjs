// Loudness, two ways.
//
// Live: the capture's ffmpeg writes a second output through
// `-af ebur128=peak=none -f null -`, which prints a line per 100 ms with the
// momentary loudness (M, a 400 ms window). parseLoudnessLine (boqo's, in
// lib/boqo/loudness-line.mjs) reads a line; createSecondMax keeps the loudest
// reading of each wall-clock second, which is what the detector is fed (after
// hosted's loudBuckets in session.ts, B2).
//
// Per finished segment: `ffmpeg -i seg -vn -af ebur128 -f null -` prints the
// same lines and, last, a summary whose `I:` line is the integrated loudness
// of the whole file. The progress lines carry an `I:` too, so the LAST match
// wins. A replay has no live capture to read lines from; the v0.1 detector
// still reads this until the hosted one (B2) takes the per-second maxima.

export { clampLoudness, parseLoudnessLine } from "./boqo/loudness-line.mjs";
import { spawn } from "node:child_process";
import { toolEnv } from "../engine/env.mjs";
import { LOUDNESS_FLOOR } from "./boqo/loudness-line.mjs";

export { LOUDNESS_FLOOR };

const INTEGRATED = /\bI:\s*(-?\d+(?:\.\d+)?|-inf)\s*LUFS/g;

/** The summary's integrated loudness, or null when ffmpeg printed none. */
export function parseEbur128(stderr) {
  let last = null;
  for (const m of String(stderr).matchAll(INTEGRATED)) last = m[1];
  if (last === null) return null;
  const v = last === "-inf" ? -Infinity : Number(last);
  return Number.isFinite(v) && v > LOUDNESS_FLOOR ? v : LOUDNESS_FLOOR;
}

/** Measure one file: LUFS, or null when it has no audio or cannot be read. `env` defaults to toolEnv() (macOS ffmpeg-full). */
export function measureLoudness(file, { cwd, ffmpeg = "ffmpeg", timeoutMs = 60000, env = toolEnv() } = {}) {
  return new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"], {
        cwd,
        env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseEbur128(stderr));
    });
  });
}

/**
 * The loudest momentary reading of each wall-clock second (epoch seconds, as
 * the watcher's clock counts them). `take` is destructive so a second is
 * counted once; `dropBefore` bounds memory if a second is never taken.
 */
export function createSecondMax() {
  const maxima = new Map();
  return {
    add(atSec, momentary) {
      const second = Math.floor(atSec);
      const have = maxima.get(second);
      if (have === undefined || momentary > have) maxima.set(second, momentary);
    },
    /** The second's loudest reading, or null when none arrived in it. */
    take(second) {
      const max = maxima.get(second);
      maxima.delete(second);
      return max === undefined ? null : max;
    },
    dropBefore(second) {
      for (const key of maxima.keys()) if (key < second) maxima.delete(key);
    },
    get size() {
      return maxima.size;
    },
  };
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
