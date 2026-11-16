// ported from boqo-ai/boqo apps/watcher/src/audio/loudness.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
/**
 * ffmpeg's ebur128 filter prints one line per 100 ms of audio (measured in
 * the watcher image, Task 13 step 1 — the fixture beside this module's test
 * is that recording): `… t: 12.3 … M: -18.9 …`. `M` is the momentary
 * loudness in LUFS over the last 400 ms — the "audio energy" of C1 design
 * §4.5. The session stamps each parsed line with the wall clock as it
 * arrives, so `t` (stream time) is carried but not relied on.
 */
const LINE = /\bt:\s*(-?[\d.]+)\s.*?\bM:\s*(-?[\d.]+|-inf)/;

/** Digital silence would print -inf; the ramp measured in the image (Task 13 step 1) prints a very negative finite number instead (`M:-120.7`). -70 is the floor the detector sees either way. */
export const LOUDNESS_FLOOR = -70;

export function clampLoudness(lufs        )         {
  return Number.isFinite(lufs) && lufs > LOUDNESS_FLOOR ? lufs : LOUDNESS_FLOOR;
}

export function parseLoudnessLine(line        )                                          {
  const match = LINE.exec(line);
  if (!match) return null;
  const t = Number(match[1]);
  const momentary = match[2] === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[2]);
  if (!Number.isFinite(t)) return null;
  return { t, momentary: clampLoudness(momentary) };
}
