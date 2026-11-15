// Loudness of one finished segment, in LUFS (after boqo's hosted watcher).
//
// `ffmpeg -i seg -vn -af ebur128 -f null -` prints a progress line per 100 ms
// and, last, a summary whose `I:` line is the integrated loudness of the
// whole file. The progress lines carry an `I:` too, so the LAST match wins.

import { spawn } from "node:child_process";

/** Digital silence prints -inf; the detector sees this floor instead. */
export const LOUDNESS_FLOOR = -70;

const INTEGRATED = /\bI:\s*(-?\d+(?:\.\d+)?|-inf)\s*LUFS/g;

/** The summary's integrated loudness, or null when ffmpeg printed none. */
export function parseEbur128(stderr) {
  let last = null;
  for (const m of String(stderr).matchAll(INTEGRATED)) last = m[1];
  if (last === null) return null;
  const v = last === "-inf" ? -Infinity : Number(last);
  return Number.isFinite(v) && v > LOUDNESS_FLOOR ? v : LOUDNESS_FLOOR;
}

/** Measure one file: LUFS, or null when it has no audio or cannot be read. */
export function measureLoudness(file, { cwd, ffmpeg = "ffmpeg", timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawn(ffmpeg, ["-nostdin", "-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"], {
        cwd,
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
