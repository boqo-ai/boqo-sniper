// A file's length, for the moment run (lib/moment-run.mjs) and the capture tests. Not part of the vendored engine.

import { spawnSync } from "node:child_process";
import { toolEnv } from "../engine/env.mjs";

/**
 * Seconds of media in a file, by ffprobe, run with `env` (default toolEnv():
 * on macOS it finds Homebrew's keg-only ffmpeg-full).
 */
export function durationOf(file, env = toolEnv()) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
    encoding: "utf8",
    env,
    windowsHide: true,
  });
  if (r.error) throw new Error(`ffprobe could not run: ${r.error.code ?? r.error.message}`);
  const d = Number(String(r.stdout).trim());
  if (r.status !== 0 || !Number.isFinite(d) || d <= 0) {
    throw new Error(`ffprobe found no length in ${file}: ${String(r.stderr).trim().slice(-200) || "no output"}`);
  }
  return d;
}
