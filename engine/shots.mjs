// The clip's shots: scene cuts on the extracted window (spec §7.5 step 3).
//
// The skill's orchestrator over engine/boqo/scenes.mjs, the shape of `detectShots` in boqo's
// apps/worker/src/render/pipeline.ts, in its adaptive ("signals") mode only:
//   1. one ffmpeg pass over the window: every frame's scene score to stdout, a 64x36 greyscale copy of every frame
//      to `<dir>/frames.gray` (`sceneSignalArgs`);
//   2. `parseSceneScores` on stdout and `parseGrayFrames` on the file;
//   3. `cutsFromSignals` at the production thresholds (CUT_OPTIONS);
//   4. `shotsFrom`, shots under 0.5 s merged into the one before.
//
// Not copied from `detectShots`: the fixed-threshold mode (RENDER_SCENE_THRESHOLD, unset in production), the
// creator's own split cuts (`applyUserCuts`, a Studio feature the skill has no surface for) and its log lines. A
// greyscale file that cannot be read, or whose frame count differs from the score count, does not throw and is not
// logged: `grayFrames` and `frames` in the result carry the two counts, and a caller that cares compares them.
//
// This file is the skill's own and is not held by a golden of its own: every rule it calls is. It imports no
// child_process: `exec(command, args, { timeoutMs }) -> Promise<{ stdout, stderr }>` is injected, rejecting when
// the command fails. Each call needs its own `dir` (the greyscale file has a fixed name).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CUT_OPTIONS, GRAY_HEIGHT, GRAY_WIDTH, MIN_SHOT_SEC, cutsFromSignals, parseGrayFrames, parseSceneScores, sceneSignalArgs, shotsFrom,
} from './boqo/scenes.mjs';
import { STEP_TIMEOUT_MS } from './window.mjs';

/**
 * Finds the cuts in a window and the contiguous shots they make.
 *
 * `windowPath` is the window `prepareWindow` returned (`file`, cut when there were pause cuts) and `durationSec`
 * its length AFTER those cuts: `shotsFrom` partitions exactly what the clip is, so a caller subtracts the cut time
 * itself. Returns `shots` (`{ startSec, endSec }`, covering `[0, durationSec]` with no gap or overlap; one shot
 * when there are no cuts), `cuts` (the cut times), `frames` (scores parsed), `grayFrames` (greyscale frames read),
 * `cutsStrong` and `cutsWeak` (how many cuts the ratio arm alone made, and how many the persistence arm decided),
 * and `sceneMs`.
 *
 * @param {{ exec: (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<{ stdout: string, stderr: string }> }} deps
 * @param {{ windowPath: string, dir: string, durationSec: number }} input
 */
export async function detectShots({ exec }, { windowPath, dir, durationSec }) {
  const startedAt = Date.now();
  const grayPath = join(dir, 'frames.gray');
  const { stdout } = await exec('ffmpeg', sceneSignalArgs({ path: windowPath, grayPath }), { timeoutMs: STEP_TIMEOUT_MS });
  const sceneMs = Date.now() - startedAt;
  const scores = parseSceneScores(stdout);

  // A truncated or missing rawvideo output degrades to the ratio arm alone: the persistence arm only ever ADDS
  // recall, so losing it costs cuts and cannot invent them (boqo's comment, in pipeline.ts).
  let grayFrames = [];
  try {
    grayFrames = parseGrayFrames(await readFile(grayPath), GRAY_WIDTH, GRAY_HEIGHT);
  } catch {
    grayFrames = [];
  }

  const found = cutsFromSignals(scores, grayFrames, CUT_OPTIONS);
  return {
    shots: shotsFrom(found.cuts, durationSec, MIN_SHOT_SEC),
    cuts: found.cuts,
    frames: scores.length,
    grayFrames: grayFrames.length,
    cutsStrong: found.strong,
    cutsWeak: found.weak,
    sceneMs,
  };
}
