// ported from boqo-ai/boqo packages/core/src/standalone.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
import { z } from "zod";
// Cut: the import of packages/core/src/viral.ts and the editor-only tail of the module
// (parseContextLinePlan, ContextLineEditSchema, ContextLineEditError, applyContextLineEdit):
// the skill has no editor, and they alone needed `contextLineProblem`.

export const STANDALONE_OUTCOMES = ["stands", "bridged", "context", "fails"]         ;
                                                                     

/** The longest context line a stand-alone test may carry (spec figure, B9 #190). */
export const CONTEXT_LINE_MAX = 60;

/** The longest claim kept; `deriveStandaloneTest` clamps to it (B9 #190). */
export const CLAIM_MAX = 200;

/** The `standalone_test` column: whether a clip makes sense on its own, and what repaired it. */
export const StandaloneTestSchema = z.object({
  v: z.literal(1),
  outcome: z.enum(STANDALONE_OUTCOMES),
  claim: z.string(),
  bridgeFromSec: z.number().nullable(),
  contextLine: z.string().max(CONTEXT_LINE_MAX).nullable(),
  sha: z.string().nullable(),
  /** The editor's edit (part C). Absent on every row that selection writes. */
  plan: z.object({ on: z.boolean(), text: z.string() }).nullable().optional(),
  /**
   * Whether the render that shipped the clip's file drew the context line
   * (B9 final review, F1). Written only on a `context` outcome, by the
   * render's ready landing (apps/worker/src/render/handler.ts). Absent means
   * unknown: no render has landed since the test was written, so no surface
   * may claim the line is on the file.
   */
  drawn: z.boolean().optional(),
});
                                                                  

/** Total, like every jsonb reader here. */
export function parseStandaloneTest(raw         )                        {
  const parsed = StandaloneTestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * What the model answers per clip, after the wire's snake_case is mapped
 * (apps/worker/src/select/anthropic.ts). The four fields are required on the
 * wire; this type stays a plain object so `deriveStandaloneTest` can judge a
 * self-contradicting answer instead of the schema refusing it.
 */
                                
                       
                
                               
                             
  

/**
 * The segment start nearest `value`; a tie goes to the lower start. Core
 * cannot import the worker's `nearestEdge` (apps/worker/src/select/snap.ts),
 * which keeps the first edge in iteration order on a tie. This is equivalent
 * to it for sorted starts, which is what the transcript gives (read
 * 2026-10-18), and breaks the tie on the lower start explicitly. `starts` is
 * non-empty here.
 */
function nearestOf(value        , starts                   )         {
  let best = starts[0] ;
  for (const start of starts) {
    const d = Math.abs(start - value);
    const bd = Math.abs(best - value);
    if (d < bd || (d === bd && start < best)) best = start;
  }
  return best;
}

/**
 * Turn the model's four fields into the `standalone_test` column value. The
 * outcome is derived here, never asked of the model, so the answer cannot
 * name an outcome its own fields contradict. A contradictory answer (a line
 * on a clip that stands alone, a bridge on one that does not) is judged by
 * the fields that agree with the verdict and flagged, so the caller can log
 * it. Length overflow is handled here too, not refused on the wire: a claim
 * over `CLAIM_MAX` is clamped, and a context line over `CONTEXT_LINE_MAX` is
 * treated as absent (`lineDropped`), since a truncated line would be a
 * sentence the speaker never said. `undefined` (a candidate that never carried the question, as every
 * scene part) yields no test.
 *
 * `bridgeFromSec` is the LATER start the clip would have had without the
 * bridging line it now opens on (spec §5.1), so it must lie after the clip's
 * own snapped `startSec`. A snapped bridge at or before `startSec` is the
 * reversed reading: it is dropped, the answer is judged as if it carried no
 * bridge, and flagged (B9 final review, F4).
 */
export function deriveStandaloneTest(
  answer                              ,
  segmentStarts                   ,
  sha               ,
  startSec        ,
)                                                                               {
  if (answer === undefined) return { test: null, inconsistent: false, lineDropped: false };

  const line = answer.contextLine === null ? "" : answer.contextLine.trim();
  const hasLine = line !== "";
  const tooLong = line.length > CONTEXT_LINE_MAX;
  const claim = answer.claim.trim().slice(0, CLAIM_MAX);

  if (answer.standsAlone) {
    const snapped =
      answer.bridgeFromSec === null || segmentStarts.length === 0
        ? answer.bridgeFromSec
        : nearestOf(answer.bridgeFromSec, segmentStarts);
    const reversed = snapped !== null && !(snapped > startSec);
    const bridgeFromSec = reversed ? null : snapped;
    return {
      test: {
        v: 1,
        outcome: bridgeFromSec === null ? "stands" : "bridged",
        claim,
        bridgeFromSec,
        contextLine: null,
        sha,
      },
      inconsistent: hasLine || reversed,
      lineDropped: false,
    };
  }
  const usable = hasLine && !tooLong;
  return {
    test: {
      v: 1,
      outcome: usable ? "context" : "fails",
      claim,
      bridgeFromSec: null,
      contextLine: usable ? line : null,
      sha,
    },
    inconsistent: answer.bridgeFromSec !== null,
    lineDropped: tooLong,
  };
}
