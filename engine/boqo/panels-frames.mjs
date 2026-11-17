// ported from boqo-ai/boqo apps/worker/src/panels/frames.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import { readFile } from "node:fs/promises";

/** One sampled frame as the reader sends it. */
                                     

/**
 * The closest a step frame may come to its shot's edge: a quarter second, or
 * a quarter of a shot shorter than one second. The final review found a seek
 * within one 30 fps frame of a 6 s file's end (5.970 s) makes ffmpeg write
 * nothing and exit 0 (ffmpeg-static 7.0.2, the reviewer's run, 2026-11-09;
 * production's 5.1.9 not run), and that the old bound let 2.2% of shot
 * lengths from 2 to 60 s sample that close (the reviewer's count).
 */
const EDGE_MARGIN_SEC = 0.25;

/**
 * When to sample a clip (spec §6.1: every shot gets at least one frame).
 * Each shot gets its midpoint, then frames `stepSec` apart either side of it,
 * each at least `min(EDGE_MARGIN_SEC, length / 4)` inside the shot so no
 * frame sits on a cut or past the window's last frame. Past `maxFrames`,
 * the extra frames are thinned evenly across the clip, midpoints last.
 *
 * `maxFrames` is a hard cap: never more images than that in one request,
 * because a request over the API's image limit fails the whole read. When
 * the shots outnumber it, their midpoints are themselves thinned evenly, and
 * a shot left without a frame takes the nearest sample in time at placement
 * (`samplesByShot` in render/panels-plan.ts). Sorted, in the shots' own timeline.
 */
export function sampleTimes(shots                                                 , stepSec        , maxFrames        )           {
  const midpoints           = [];
  const others           = [];
  const step = Number.isFinite(stepSec) && stepSec > 0 ? stepSec : null;
  for (const shot of shots) {
    const length = shot.endSec - shot.startSec;
    if (!(length > 0)) continue;
    const mid = shot.startSec + length / 2;
    midpoints.push(mid);
    if (step === null) continue;
    const reach = length / 2 - Math.min(EDGE_MARGIN_SEC, length / 4);
    for (let k = 1; k * step <= reach; k++) others.push(mid - k * step, mid + k * step);
  }
  const cap = Math.max(0, Math.floor(maxFrames));
  midpoints.sort((a, b) => a - b);
  others.sort((a, b) => a - b);
  const room = Math.max(0, cap - midpoints.length);
  return [...thinEvenly(midpoints, cap), ...thinEvenly(others, room)].sort((a, b) => a - b);
}

/** `count` of the sorted `values`, spread evenly by index; all of them when they fit. */
function thinEvenly(values                   , count        )           {
  if (values.length <= count) return [...values];
  return Array.from({ length: count }, (_, i) => values[Math.floor(((i + 0.5) * values.length) / count)] );
}

/**
 * The frame ffmpeg wrote at `outPath`, or null when it wrote none or an empty
 * file, which a seek at or past the last frame does while exiting 0 (see
 * EDGE_MARGIN_SEC). The caller skips that frame rather than failing the ask.
 */
export async function readFrameFile(outPath        )                         {
  try {
    const jpeg = await readFile(outPath);
    return jpeg.length > 0 ? jpeg : null;
  } catch (error) {
    if ((error                         ).code === "ENOENT") return null;
    throw error;
  }
}

/** Whether `extracted` of `wanted` frames is enough to ask on: half or more, and at least one. */
export function enoughFrames(extracted        , wanted        )          {
  return extracted > 0 && extracted * 2 >= wanted;
}

/**
 * One frame at `atSec`, `width` pixels wide with the source's aspect, as a
 * JPEG. The seek comes before `-i` so ffmpeg seeks the input rather than
 * decoding from the start. Every thread pool is capped at one, the worker's
 * rule since the pid-limit incident (the engineering record's "ffmpeg sized
 * its thread pools"), as stranger/frames.ts does.
 */
export function frameArgs(input                                                                 )           {
  return [
    "-hide_banner", "-loglevel", "error", "-y", "-filter_threads", "1", "-threads", "1",
    "-ss", input.atSec.toFixed(3), "-i", input.path,
    "-frames:v", "1", "-vf", `scale=${input.width}:-2`, "-q:v", "3", "-threads", "1", input.outPath,
  ];
}
