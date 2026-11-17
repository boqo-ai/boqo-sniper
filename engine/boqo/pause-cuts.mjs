// ported from boqo-ai/boqo packages/core/src/pause-cuts.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut: `import { CUT_REASONS } from "./audio-enhance"` was used only in a return type, which is gone.
import { capSpans, guardSpans, mergeSpans,          } from "./cut-map.mjs";

/**
 * Tighten pauses (B6 spec §4.3): the quiet part of a transcript gap becomes
 * a cut, shrunk so the next word keeps its lead-in. Pure arithmetic, in
 * `packages/core` because the worker plans it and the tests pin it; the two
 * ffmpeg passes that find the quiet runs live in the worker.
 *
 * Why not the transcript alone: measured 2026-10-05 on seven real videos
 * (spec §1.2), a transcript gap is sirens, a music bed or game audio far more
 * often than it is silence -- 91% of the "silent" time in a bodycam
 * compilation was sound. The quiet runs are the evidence; the transcript is
 * the guard that keeps a cut off a word.
 */

                           
                                                                      
                 
                                                       
                           
                                                       
                            
                                                                              
                      
  

/** The spec's numbers (§7); the worker's EDIT_PAUSE_* variables override them at runtime. */
export const PAUSE_DEFAULTS                        = Object.freeze({
  minSec: 1.2,
  keepAfterWordSec: 0.15,
  keepBeforeWordSec: 0.25,
  maxFraction: 0.5,
});

/** A run the detector found below the floor, in window seconds. */
                                                      

/**
 * The gaps between consecutive transcribed words of at least `minSec`
 * (spec §4.3 step 1). The lead before the first word and the tail after the
 * last are not gaps: a clip's edges belong to selection and the opener.
 *
 * Each gap is measured from the latest word end seen so far, not from the
 * previous word's end: with two speakers overlapping, a short word can sit
 * inside a longer one, and a gap measured from the short word's end would
 * open over the longer word still being spoken. Words are sorted by start
 * first; the input is not mutated.
 */
export function transcriptGaps(words                                           , minSec        )        {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const gaps        = [];
  if (sorted.length === 0) return gaps;
  let reach = sorted[0] .end;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i] ;
    if (next.start - reach >= minSec) gaps.push({ start: reach, end: next.start });
    reach = Math.max(reach, next.end);
  }
  return gaps;
}

/**
 * The cut list for one window (spec §4.3 steps 2-5): each intersection of a
 * gap with a quiet run that is at least `minSec` long is a pause; a pause
 * `[a, b]` becomes the cut `[a + keepAfter, b - keepBefore]`; then the
 * edge guard, the merge and the pause cap of cut-map.ts. `gaps` and
 * `pauses` are counts for the log line (spec §4.6), both counted BEFORE the
 * guard and the cap: `pauses` is what was found, not what was cut, and an
 * over-limit window reports its pauses with no cuts. New objects throughout.
 *
 * A cut never overlaps a word, because every cut lies inside a gap, and
 * `transcriptGaps` opens a gap only after every word that started before it
 * has ended and closes it at the next word's start. The merge therefore runs
 * within each gap, never across one: with keeps under CUT_MERGE_GAP_SEC the
 * cuts either side of a word shorter than that gap would otherwise merge over
 * it. The guard and the cap only drop cuts. The worker's reader
 * (`pauseConfigFromEnv`) accepts a keep pair only when each keep is at least
 * CUT_MERGE_GAP_SEC and the two together are below the minimum, because the
 * pipeline's later `mergeCutLists` of filler and pause cuts does merge across
 * gaps; this function stays total for any config it is handed. The property test in
 * tests/pause-cuts.test.ts pins all of this over generated words and configs.
 */
export function planPauseCuts(input   
                                                   
                                 
                            
                      
 )                                                                                              {
  const { minSec, keepAfterWordSec, keepBeforeWordSec, maxFraction } = input.config;
  const windowDurationSec = input.windowDurationSec;
  if (!Number.isFinite(windowDurationSec) || windowDurationSec <= 0) return { cuts: [], skipped: null, gaps: 0, pauses: 0 };

  const gaps = transcriptGaps(input.words, minSec);
  const kept        = [];
  let pauses = 0;
  for (const gap of gaps) {
    const spans        = [];
    for (const run of input.quietRuns) {
      const start = Math.max(gap.start, run.start);
      const end = Math.min(gap.end, run.end);
      if (end - start < minSec) continue;
      pauses += 1;
      // A config whose keeps meet or exceed the minimum would make this cut
      // empty or inverted; guardSpans drops such a span, so the rule stays total.
      spans.push({ start: start + keepAfterWordSec, end: end - keepBeforeWordSec });
    }
    // Gaps come sorted and disjoint, so appending per gap keeps `kept` sorted.
    kept.push(...mergeSpans(guardSpans(spans, windowDurationSec)));
  }
  const planned = capSpans(kept, windowDurationSec, maxFraction);
  return { cuts: planned.cuts, skipped: planned.skipped, gaps: gaps.length, pauses };
}
