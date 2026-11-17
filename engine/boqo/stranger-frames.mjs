// ported from boqo-ai/boqo apps/worker/src/stranger/frames.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import { readdir } from "node:fs/promises";
import path from "node:path";
                                      

/**
 * The corpus's keyframes, reproduced to the letter (B9 spec §4.2 step 3).
 * Each detail below names the line of docs/research/scripts/annotate.py
 * (read whole, 2026-10-18) or of the corpus's extraction command it copies,
 * docs/research/scripts/process_clip.py:79 (read 2026-10-18).
 */

/** Frame extraction can take a while on a long clip; well above a minute of footage at 1/5 fps. */
const EXTRACT_TIMEOUT_MS = 120_000;

/**
 * Which extracted frames are sent: annotate.py:50-52, `if len(frames) > 12:
 * step = len(frames) / 12; frames = [frames[int(i * step)] for i in range(12)]`,
 * with 12 as `max`. `int()` truncates toward zero, which is `Math.floor` for
 * the non-negative values here, and `i * (n / max)` is the same double as
 * Python's `i * step` because both compute the division first.
 */
export function thinIndexes(n        , max        )           {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = n / max;
  return Array.from({ length: max }, (_, i) => Math.floor(i * step));
}

/**
 * Python's `f"{x:.0f}"` for a non-negative double: the exact binary value
 * rounded to the nearest integer, a tie going to the even one. Not
 * `Math.round`, which sends every tie up: annotate.py's label for n = 13,
 * i = 6 is `30 * (13 / 12)`, which is exactly 32.5 as a double (measured
 * 2026-10-18, `python3 -c 'print(repr(6*5*(13/12)))'` -> 32.5) and prints 32.
 * `x - floor(x)` is exact for these magnitudes, so the tie test is on the
 * double itself, never on a decimal reconstruction of it.
 */
export function pyRound0(x        )         {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * annotate.py:70, `f"keyframe {i + 1} at ~{i * 5 * (len(all) / max(1, len(frames))):.0f}s"`:
 * `n` the frames extracted, `kept` the frames sent. Evaluated in Python's
 * order, `(i * 5) * (n / kept)`, so the double matches before rounding.
 */
export function frameLabel(i        , n        , kept        )         {
  return `keyframe ${i + 1} at ~${pyRound0(i * 5 * (n / Math.max(1, kept)))}s`;
}

/**
 * The corpus's extraction, byte for byte in its filter (spec §4.2 step 3):
 * docs/research/scripts/process_clip.py:79 (read 2026-10-18; the filter is
 * not in annotate.py), `ffmpeg -hide_banner -loglevel error -y -i <video>
 * -vf fps=1/5,scale=360:-2 <dir>/k%03d.jpg` -- one frame every 5 s, 360 px wide, into `k%03d.jpg`. Then annotate.py:49's
 * `sorted(glob("k*.jpg"))` -- a plain sort of the names, which `%03d` keeps in
 * frame order up to 999 frames -- and the thinning above.
 *
 * Every thread pool is capped (B9 final review, F3): `-filter_threads 1` and
 * `-threads 1` before `-i` for the decoder, `-threads 1` after it for the
 * encoder. That is the worker's rule since the pid-limit incident (the
 * engineering record's "ffmpeg sized its thread pools"), and
 * apps/worker/src/render/pauses.ts:28's analysis args are the precedent. The
 * `-vf` string is unchanged, so the frames are the corpus's pixels; only the
 * thread counts differ from process_clip.py.
 */
export async function extractFrames(exec        , videoPath        , dir        , max        )                                              {
  await exec(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-y", "-filter_threads", "1", "-threads", "1",
      "-i", videoPath, "-vf", "fps=1/5,scale=360:-2", "-threads", "1", `${dir}/k%03d.jpg`,
    ],
    { timeoutMs: EXTRACT_TIMEOUT_MS },
  );
  const all = (await readdir(dir)).filter((name) => /^k.*\.jpg$/.test(name)).sort();
  return { files: thinIndexes(all.length, max).map((i) => path.join(dir, all[i] )), total: all.length };
}
