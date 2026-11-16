// ported from boqo-ai/boqo packages/core/src/cut-map.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Only the part the render stage needs is ported (constants, guardSpans, mergeSpans, capSpans, cutsDurationSec,
// keptSegments, the two time maps windowToClipSec and clipToWindowSec, which the stream panels read needs, and
// wordsThroughCuts, which moves a clip's caption words onto the cut timeline as captionWordsFor does);
// planCuts, mergeCutLists, clipDurationSec and cutsFromRow are not copied.
// Cut import: CUT_REASONS is `export const CUT_REASONS = { overLimit: "over-limit" } as const;` in packages/core/src/audio-enhance.ts, a module of schemas and strings this skill has no use for.
export const CUT_REASONS = { overLimit: "over-limit" };

/**
 * The cuts Audio Enhance takes out of a clip, and the one map between the two
 * timelines they create (B4 spec §4.4).
 *
 * WINDOW time is the extracted source window a clip is rendered from, 0 at the
 * clip's `start_sec`. CLIP time is the rendered file, shorter by every cut.
 * `clips.cuts` is stored in window time; everything that draws or plays a cut
 * clip -- the renderer's captions, the editor's playhead, waveform and
 * transcript -- maps through the functions here, so they agree with the file
 * by construction.
 *
 * With no cuts every map is the identity, which is what keeps every clip that
 * exists today mapping exactly as before. `[]` and a NULL column mean the same
 * thing; callers pass `cuts ?? []`.
 *
 * In `packages/core` because the worker writes the cuts and `apps/web` reads
 * them: two copies of one time map is the failure this repository records
 * most often. Pure arithmetic, no Node builtins.
 */

/** A removed range in window seconds: sorted, disjoint, `start < end` (as `planCuts` returns them). */
                                                 

/** A filler this close to either end of the clip stays (spec §4.4): a cut there reads as a glitch. */
export const CUT_EDGE_GUARD_SEC = 0.25;

/** Cuts closer than this are merged, gap included: two jump cuts in 0.15 s read as a stutter. */
export const CUT_MERGE_GAP_SEC = 0.15;

/** Never remove more than this share of a clip; past it the clip stays uncut and says why. */
export const CUT_MAX_FRACTION = 0.15;

/**
 * The edge guard: a span that is empty, inverted, non-finite, or reaches
 * within CUT_EDGE_GUARD_SEC of either end of the window is dropped (which
 * also drops every span hanging off an end). Sorted by start; new objects.
 */
export function guardSpans(spans                , windowDurationSec        )        {
  const kept        = [];
  for (const { start, end } of spans) {
    // `!(end > start)` is also true for NaN; an infinite end fails the guard below.
    if (!(end > start)) continue;
    if (start < CUT_EDGE_GUARD_SEC || end > windowDurationSec - CUT_EDGE_GUARD_SEC) continue;
    kept.push({ start, end });
  }
  kept.sort((a, b) => a.start - b.start);
  return kept;
}

/**
 * Neighbours whose gap is under `gapSec` (default CUT_MERGE_GAP_SEC) merge
 * (an overlap is a negative gap, so overlapping spans merge too). Input must
 * be sorted by start. New objects; the input is never mutated.
 */
export function mergeSpans(sorted                , gapSec         = CUT_MERGE_GAP_SEC)        {
  const merged        = [];
  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && cut.start - last.end < gapSec) {
      last.end = Math.max(last.end, cut.end);
    } else {
      merged.push({ start: cut.start, end: cut.end });
    }
  }
  return merged;
}

/** Past `maxFraction` of the window, nothing is cut and the reason says why (spec §9.5). */
export function capSpans(
  cuts       ,
  windowDurationSec        ,
  maxFraction        ,
)                                                                {
  if (cutsDurationSec(cuts) > maxFraction * windowDurationSec) return { cuts: [], skipped: CUT_REASONS.overLimit };
  return { cuts, skipped: null };
}

/** The total time the cuts remove. */
export function cutsDurationSec(cuts                )         {
  let total = 0;
  for (const cut of cuts) total += cut.end - cut.start;
  return total;
}

/**
 * What stays, in window time: the complement of the cuts within
 * `[0, windowDurationSec]`, in order, with no zero-length piece. This is the
 * list the renderer trims and concatenates.
 */
export function keptSegments(windowDurationSec        , cuts                )        {
  const segments        = [];
  let from = 0;
  for (const cut of cuts) {
    if (cut.start > from) segments.push({ start: from, end: cut.start });
    from = cut.end;
  }
  if (windowDurationSec > from) segments.push({ start: from, end: windowDurationSec });
  return segments;
}

/**
 * A window time on the clip's timeline, or `null` strictly inside a cut,
 * where that moment is not in the file at all. Both edges of a cut map to the
 * same clip time -- the join -- because the map is continuous there.
 */
export function windowToClipSec(t, cuts) {
  let removed = 0;
  for (const cut of cuts) {
    if (t <= cut.start) break;
    if (t < cut.end) return null;
    removed += cut.end - cut.start;
  }
  return t - removed;
}

/**
 * A clip time back on the window's timeline. A join maps to the END of its
 * cut, because the frame playing at a join is the first one after the cut --
 * which is what a seek in the source must land on.
 */
export function clipToWindowSec(t, cuts) {
  let windowSec = t;
  for (const cut of cuts) {
    if (windowSec < cut.start) break;
    windowSec += cut.end - cut.start;
  }
  return windowSec;
}

/**
 * Words with window times, moved onto the clip's timeline.
 *
 * A word wholly inside a cut is dropped: it is not in the file. A word
 * straddling a cut's edge is clamped to the side that stays, so its caption
 * never shows during footage it is not in. A word spanning a whole cut keeps
 * both ends, and shrinks by the cut. Every other field is carried over.
 *
 * With no cuts this returns the words unchanged -- the same objects, in a new
 * array -- which is what makes every existing clip's captions byte-identical.
 */
export function wordsThroughCuts(words, cuts) {
  if (cuts.length === 0) return [...words];
  const out = [];
  for (const word of words) {
    let start = word.start;
    let end = word.end;
    let inside = false;
    for (const cut of cuts) {
      if (cut.start <= start && end <= cut.end) {
        inside = true;
        break;
      }
      if (cut.start < start && start < cut.end) start = cut.end;
      if (cut.start < end && end < cut.end) end = cut.start;
    }
    if (inside) continue;
    const clipStart = windowToClipSec(start, cuts);
    const clipEnd = windowToClipSec(end, cuts);
    // Unreachable for sorted, disjoint cuts -- the clamps above leave neither
    // end strictly inside one -- but the map's own type is nullable, so this
    // drops such a word rather than asserting the case away. No test can reach
    // it with cuts `planCuts` would return.
    if (clipStart === null || clipEnd === null) continue;
    out.push({ ...word, start: clipStart, end: clipEnd });
  }
  return out;
}
