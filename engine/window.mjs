// The clip window: extract it, settle its end, tighten its pauses (spec §7.5 steps 1-2).
//
// The skill's orchestrator over the copies in engine/boqo/, in the order the hosted render runs them:
//   1. settle-end   handler.ts: an end on the next sentence's first sound moves back into the quiet before it,
//                   read from the SOURCE, before anything is extracted (so the window ends where the clip ends);
//   2. extract      pipeline.ts: `extractArgs`, stream copy;
//   3. pauses       pipeline.ts: probe for audio, `detectPauses` (silencedetect at mean - 25 dB for 1.2 s,
//                   overlapped with transcript gaps), merge (no filler cuts here), snap to packet times;
//                   hosted runs `mergeCutLists` over the pause cuts and the filler cuts; it is omitted here
//                   because with no filler cuts, joining the pause cuts alone is a no-op at the production
//                   keeps: the gap between two pause cuts around a word is at least 0.4 s (0.15 s kept after
//                   the word plus 0.25 s kept before the next), over the 0.15 s merge gap;
//   4. cut          pipeline.ts: `cutWindowArgs`, the x264 veryfast CRF 16 / AAC 192k intermediate.
//
// This file is the skill's own and is not held by a golden of its own: every rule it calls is. It imports no
// child_process: `exec(command, args, { timeoutMs }) -> Promise<{ stdout, stderr }>` is injected, rejecting when
// the command fails.
import { join } from 'node:path';
import { keptSegments } from './boqo/cut-map.mjs';
import { cutWindowArgs, frameTimesArgs, parseFrameTimes, snapCutsToFrames } from './boqo/cut-window.mjs';
import { extractArgs } from './boqo/extract.mjs';
import { DEFAULT_PAUSE_DETECT_CONFIG, EDIT_PAUSES_ENABLED, PAUSE_REASONS, detectPauses, pauseSkipped } from './boqo/pauses.mjs';
import { settleEnd } from './boqo/settle-end.mjs';
import { wordsWithin } from './boqo/words.mjs';

/** apps/worker/src/render/handler.ts `SETTLE_TIMEOUT_MS`. */
export const SETTLE_TIMEOUT_MS = 30_000;

/**
 * boqo bounds every render step by the job's remaining time. A skill has no job clock, so each ffmpeg call
 * gets this ceiling: a window is seconds of video, and nothing here should take minutes.
 */
export const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Cut: `settleEndEnabledFromEnv()` (apps/worker/src/render/config.ts), `booleanFromEnv("RENDER_SETTLE_END_ENABLED",
 * true)`. Unset reads on, and it is on in production.
 */
export const SETTLE_END_ENABLED = true;

/**
 * Cut: `filterThreadsFromEnv()` and `encodeThreadsFromEnv()` (render/config.ts), `RENDER_FILTER_THREADS` default 2
 * and `RENDER_ENCODE_THREADS` default 4: the worker's pid caps, kept so the argv is the hosted one.
 */
export const FILTER_THREADS = 2;
export const ENCODE_THREADS = 4;

/**
 * boqo's `hasAudioProbeArgs` and `probeHasAudio` (render/pipeline.ts, a module this skill does not copy): a probe
 * that fails reads as "no audio".
 */
const hasAudioProbeArgs = (path) => ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path];

async function probeHasAudio(exec, path) {
  try {
    const { stdout } = await exec('ffprobe', hasAudioProbeArgs(path), { timeoutMs: STEP_TIMEOUT_MS });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The skill's `{ w, s, e }` words (engine/words.mjs) as the `{ word, start, end }` the copies read.
 * @param {{ w: string, s: number, e: number }[]} words
 */
const hostedWords = (words) => words.map((x) => ({ word: x.w, start: x.s, end: x.e }));

/**
 * Extracts a clip's window from `source` and tightens its pauses.
 *
 * Each call needs its OWN `dir`: the files in it have fixed names (`window.mp4`, `window-cut.mp4`), so two calls on
 * one `dir` overwrite each other's window. `words` must be ascending by `s`, as a transcript is: `wordsWithin`
 * clamps each word's end against the next one in ARRAY order, so an unsorted list gets wrong ends.
 *
 * `startSec`, `endSec` and `words` share ONE timeline, the one of `source`'s own clock. For a downloaded section
 * that is the section's, so the caller subtracts the section's offset first (as `renderClip` does with its `offset`).
 * `words` are `{ w, s, e }`, the whole transcript or any superset of the window.
 *
 * Returns `file` (the window, cut when there were cuts), `startSec` and `endSec` (the window as extracted: the
 * end is the settled one), `cuts` (snapped to frames, in WINDOW time: 0 at `startSec`; `[]` for none), `settle`
 * (settle-end's result) and `pauses` (the pause detector's outcome: why it cut nothing, counts, levels).
 * Settle-end and the pause detector never fail the call: an ffmpeg that fails there keeps the end, or renders
 * without cuts, and the result says why. Extract and the cut encode throw.
 *
 * @param {{ source: string, startSec: number, endSec: number, words: { w: string, s: number, e: number }[],
 *   dir: string, exec: (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<{ stdout: string, stderr: string }> }} o
 */
export async function prepareWindow({ source, startSec, endSec, words, dir, exec }) {
  const bWords = hostedWords(words);

  const settle = await settleEnd(
    { exec },
    { sourceUrl: source, words: bWords, startSec, endSec, enabled: SETTLE_END_ENABLED, timeoutMs: SETTLE_TIMEOUT_MS },
  );
  const settledEnd = settle.status === 'settled' ? settle.endSec : endSec;

  const rawPath = join(dir, 'window.mp4');
  await exec('ffmpeg', extractArgs({ url: source, startSec, endSec: settledEnd, outPath: rawPath }), { timeoutMs: STEP_TIMEOUT_MS });

  const windowDurationSec = settledEnd - startSec;
  let pauses;
  let hasAudio = null;
  if (!EDIT_PAUSES_ENABLED) {
    pauses = pauseSkipped(PAUSE_REASONS.disabled);
  } else {
    hasAudio = await probeHasAudio(exec, rawPath);
    pauses = hasAudio
      ? await detectPauses(
          { exec },
          {
            windowPath: rawPath,
            windowDurationSec,
            words: wordsWithin(bWords, startSec, settledEnd),
            config: DEFAULT_PAUSE_DETECT_CONFIG,
            timeoutMs: () => STEP_TIMEOUT_MS,
          },
        )
      : pauseSkipped(PAUSE_REASONS.noAudio);
  }

  let file = rawPath;
  let cuts = [];
  if (pauses.cuts.length > 0) {
    const { stdout } = await exec('ffprobe', frameTimesArgs(rawPath), { timeoutMs: STEP_TIMEOUT_MS });
    // A cut shorter than a frame snaps to nothing, and then the clip stays uncut (boqo logs it; the result shows `cuts: []`).
    cuts = snapCutsToFrames(pauses.cuts, parseFrameTimes(stdout));
    if (cuts.length > 0) {
      hasAudio ??= await probeHasAudio(exec, rawPath);
      file = join(dir, 'window-cut.mp4');
      await exec(
        'ffmpeg',
        cutWindowArgs({
          inPath: rawPath,
          outPath: file,
          keep: keptSegments(windowDurationSec, cuts),
          hasAudio,
          filterThreads: FILTER_THREADS,
          encodeThreads: ENCODE_THREADS,
        }),
        { timeoutMs: STEP_TIMEOUT_MS },
      );
    }
  }
  return { file, startSec, endSec: settledEnd, cuts, settle, pauses };
}
