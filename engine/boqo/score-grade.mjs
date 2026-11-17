// ported from boqo-ai/boqo apps/web/src/components/score-grade.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut: the import of @boqo/core. The one constant it gave, packages/core/src/constants.ts @ bcc9d99cc.
const DECENT_SCORE_FLOOR = 60;

                       
                 
            
            
               
           

const EXCEPTIONAL_FLOOR = 85;
const STRONG_FLOOR = 70;
const WATCHABLE_FLOOR = 40;

/**
 * The rubric's own bands, made visible.
 *
 * `SELECTION_RUBRIC` defines these ranges — "85-100: exceptional", "70-84:
 * strong", "60-69: decent", "40-59: watchable but unremarkable", "below 40:
 * weak" — and the user has never been shown them. A bare 78 says nothing;
 * "78, strong" says what the model meant by it. The two lowest bands arrived
 * with density on 2026-08-27: a project holds a hundred clips now, most of
 * them ordinary, and a page that calls every one of them "weak" is as
 * useless as one that calls every one "decent".
 *
 * The decent floor is DECENT_SCORE_FLOOR, not DEFAULT_MIN_CLIP_SCORE.
 *
 * It used to be the latter, so a clip the filter discarded could never be
 * labelled "decent". That reasoning only holds while the filter is
 * discarding something, though: whenever DEFAULT_MIN_CLIP_SCORE is 0,
 * reading it here would label every clip "decent" and nothing "watchable"
 * or "weak", silently.
 */
export function scoreBand(score        )            {
  if (score >= EXCEPTIONAL_FLOOR) return "exceptional";
  if (score >= STRONG_FLOOR) return "strong";
  if (score >= DECENT_SCORE_FLOOR) return "decent";
  if (score >= WATCHABLE_FLOOR) return "watchable";
  return "weak";
}

/** 0..5 segments, from the same bands the label uses -- the meter and the
 *  word must never disagree about the same number. */
export function meterFill(score        )         {
  const band = scoreBand(score);
  if (band === "exceptional") return 5;
  if (band === "strong") return 4;
  if (band === "decent") return 3;
  if (band === "watchable") return 2;
  return 1;
}

export function bandLabel(band           )         {
  if (band === "exceptional") return "exceptional";
  if (band === "strong") return "strong";
  if (band === "decent") return "decent";
  if (band === "watchable") return "watchable";
  return "weak";
}

/**
 * A letter for one of the four axes.
 *
 * Presentation only, with no storage behind it: the axes are numbers, and
 * OpusClip's own documentation confirms its letters are a UI treatment of a
 * numeric score rather than a separate grade the model returns.
 */
export function scoreToGrade(score        )                              {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}
