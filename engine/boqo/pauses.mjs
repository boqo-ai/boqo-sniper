// ported from boqo-ai/boqo apps/worker/src/render/pauses.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
import { PAUSE_DEFAULTS, planPauseCuts,                                           } from "./pause-cuts.mjs";

// Cut: `import { log, logError } from "../logger"`, the worker's structured logger. The skill has no log
// stream; detectPauses records why in its outcome instead (`skipped`), and logPauses is not copied.
// Cut: `import type { ExecFn } from "../exec"`. `exec` is injected, as in the worker: `(command, args,
// { timeoutMs }) => Promise<{ stdout, stderr }>`. This module never imports child_process.

/**
 * Cut: `PAUSE_REASONS` from packages/core/src/audio-enhance.ts, copied literally. Why Tighten pauses did
 * not run or cut (B6 spec §4.6); "over-limit" is the same string the filler cap writes.
 */
export const PAUSE_REASONS = {
  disabled: "disabled",
  noAudio: "no-audio",
  noWords: "no-words",
  detectFailed: "detect-failed",
  overLimit: "over-limit",
};

/**
 * Cut: `DEFAULT_PAUSE_FLOOR_DB` and `DEFAULT_PAUSE_DETECT_CONFIG` from apps/worker/src/edit/config.ts, which
 * the worker overrides from EDIT_PAUSE_MIN_SEC, EDIT_PAUSE_KEEP_AFTER_WORD_SEC, EDIT_PAUSE_KEEP_BEFORE_WORD_SEC,
 * EDIT_PAUSE_MAX_FRACTION and EDIT_PAUSE_FLOOR_DB (pauseConfigFromEnv). The skill fixes the defaults.
 */
/** How far below the window's mean level counts as quiet (spec §4.2). A starting point the gate tunes. */
export const DEFAULT_PAUSE_FLOOR_DB = 25;

export const DEFAULT_PAUSE_DETECT_CONFIG = Object.freeze({
  ...PAUSE_DEFAULTS,
  floorDb: DEFAULT_PAUSE_FLOOR_DB,
});

/**
 * Cut: `editPausesEnabledFromEnv()` (apps/worker/src/edit/config.ts), the kill switch:
 * `booleanFromEnv("EDIT_PAUSES_ENABLED", true)`. Tighten pauses is on by default, and on in production.
 */
export const EDIT_PAUSES_ENABLED = true;

/**
 * Finding a window's pauses (B6 spec §4.2): two audio-only ffmpeg passes on
 * the extracted window, then core's rule. The first reads the window's mean
 * level; the second lists every run that sits `floorDb` below it for at
 * least the minimum pause. Both filters were confirmed present on the
 * production worker's ffmpeg 5.1.9 by `ffmpeg -h filter=…` through
 * `railway ssh` (2026-10-05, spec §1.3), and both builds' stderr is captured
 * in tests/fixtures/ffmpeg-*detect*-{local,production}.txt, which the
 * parsers are tested against.
 *
 * Nothing here throws: a detector that fails records why and the clip
 * renders without pause cuts (spec §8).
 */

/**
 * Every thread pool capped, the shape of enhance/align.ts's analysis passes
 * and blur/acquire.ts's poster frame: `-filter_threads` is global, `-threads`
 * before `-i` caps the decoder and after it the encoder. No `-loglevel
 * error`: both filters report at info level, which is what is parsed.
 */
function analysisArgs(path        , filter        )           {
  return [
    "-nostdin", "-hide_banner", "-nostats", "-filter_threads", "1", "-threads", "1",
    "-i", path, "-vn", "-af", filter, "-threads", "1", "-f", "null", "-",
  ];
}

export function meanVolumeArgs(path        )           {
  return analysisArgs(path, "volumedetect");
}

/** A number for a filtergraph: three decimals at most, so float noise (-46.099999…) never reaches ffmpeg. */
function graphNumber(value        )         {
  return String(Number(value.toFixed(3)));
}

export function silenceDetectArgs(path        , noiseDb        , minSec        )           {
  return analysisArgs(path, `silencedetect=noise=${graphNumber(noiseDb)}dB:d=${graphNumber(minSec)}`);
}

/** A decimal as ffmpeg prints one with %f or %g, exponent included (`2.08333e-05`). */
const NUMBER = String.raw`-?\d+(?:\.\d+)?(?:e[-+]?\d+)?`;
const MEAN_VOLUME = new RegExp(String.raw`mean_volume:\s*(-inf|${NUMBER})\s*dB`, "gi");
const SILENCE_START = new RegExp(String.raw`silence_start:\s*(${NUMBER})`, "i");
const SILENCE_END = new RegExp(String.raw`silence_end:\s*(${NUMBER})`, "i");

/**
 * The `mean_volume: <n> dB` line: `-Infinity` for `-inf` (no signal at all),
 * null when there is no such line (the output did not parse). The last line
 * wins: ffmpeg 8.1.2 prints a `n_samples: 0` report from a graph it tears
 * down before the real run (captured in the local fixture), and a build that
 * printed a mean there too would otherwise be read instead of the real one.
 */
export function parseMeanVolumeDb(stderr        )                {
  const matches = [...stderr.matchAll(MEAN_VOLUME)];
  const last = matches.at(-1);
  if (last === undefined) return null;
  if (last[1] .toLowerCase() === "-inf") return -Infinity;
  const value = Number(last[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * `silence_start` / `silence_end` pairs as runs, clamped to the window. A
 * start with no end -- the file ended quiet -- closes at the window's end;
 * an end with no start is ignored. Read line by line, so the order in which
 * a build interleaves these with its other output does not matter (5.1.9
 * prints the last `silence_end` after the run summary, 8.1.2 before it).
 */
export function parseQuietRuns(stderr        , windowDurationSec        )             {
  const runs             = [];
  let open                = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = SILENCE_START.exec(line);
    if (start !== null) {
      open = Number(start[1]);
      continue;
    }
    const end = SILENCE_END.exec(line);
    if (end !== null && open !== null) {
      runs.push({ start: open, end: Number(end[1]) });
      open = null;
    }
  }
  if (open !== null) runs.push({ start: open, end: windowDurationSec });
  return runs
    .map((run) => ({ start: Math.max(0, run.start), end: Math.min(windowDurationSec, run.end) }))
    .filter((run) => Number.isFinite(run.start) && Number.isFinite(run.end) && run.end > run.start);
}

                            
              
                              
                                                                                       
               
                                           
                
                                                                                                 
                 
                                                                           
                        
                         
  

/**
 * The outcome of a pass that cut nothing and was skipped for `reason`: no
 * cuts, nothing counted, no level read. One literal, shared by the detector
 * and by the two callers that skip it before it runs (no audio stream).
 */
export function pauseSkipped(reason             )               {
  return { cuts: [], skipped: reason, gaps: 0, quiet: 0, pauses: 0, meanDb: null, floorDb: null };
}

export async function detectPauses(
  deps                  ,
  input   
                       
                              
                                                                    
                                                     
                              
                            
                                                                                    
                   
   ,
)                        {
  if (input.words.length < 2) return pauseSkipped(PAUSE_REASONS.noWords);
  try {
    const level = await deps.exec("ffmpeg", meanVolumeArgs(input.windowPath), { timeoutMs: input.timeoutMs() });
    const meanDb = parseMeanVolumeDb(level.stderr);
    if (meanDb === null) {
      // Thrown to the catch below so the stderr tail is logged as `detail`
      // (logger.ts reads `.stderr` off the error) and recorded as detect-failed.
      throw Object.assign(new Error("volumedetect printed no mean_volume"), { stderr: level.stderr });
    }
    if (meanDb === -Infinity) return pauseSkipped(PAUSE_REASONS.noAudio);
    const floorDb = meanDb - input.config.floorDb;
    const runs = await deps.exec("ffmpeg", silenceDetectArgs(input.windowPath, floorDb, input.config.minSec), {
      timeoutMs: input.timeoutMs(),
    });
    const quietRuns = parseQuietRuns(runs.stderr, input.windowDurationSec);
    const planned = planPauseCuts({ words: input.words, quietRuns, windowDurationSec: input.windowDurationSec, config: input.config });
    return {
      cuts: planned.cuts,
      skipped: planned.skipped === null ? null : PAUSE_REASONS.overLimit,
      gaps: planned.gaps,
      quiet: quietRuns.length,
      pauses: planned.pauses,
      meanDb,
      floorDb,
    };
  } catch (error) {
    // Cut: logError(...) "pause detection failed; rendering without pause cuts". The reason is the outcome's `skipped`.
    return pauseSkipped(PAUSE_REASONS.detectFailed);
  }
}
