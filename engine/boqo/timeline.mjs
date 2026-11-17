// ported from boqo-ai/boqo packages/core/src/timeline.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo packages/core/src/cut-map.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut: of timeline.ts, everything the stranger transcript does not read (the teaser schema and its import, the hook
// ranges and captions, fileToClipSec, fileToSourceSec, clipRangesToFile, clipTimelineFromRow, clipMomentRanges); of
// cut-map.ts, everything but its two time maps, windowToClipSec and clipToWindowSec (the cut planner, the word and
// segment maps and the audio-enhance import). What is kept is boqo's code and comments as they are; the stranger
// transcript golden runs it with cuts and with hooks (tests/golden/stranger-transcript.json).
//
// ClipTimeline = { originSec: number, cuts: {start, end}[], hook: { ranges: {start, end}[], transitionSec: number } | null }
// A cut is { start, end } in window seconds: sorted, disjoint, start < end.

/**
 * R5 spec §2.5: the one time map, with a hook in it. Extends cut-map.ts, it
 * does not replace it. CLIP time is 0 at the clip's first frame; FILE time is
 * the rendered file's, which starts with the hook. With no hook the two are
 * equal and every function here is today's cut map, so every clip that
 * exists today maps exactly as before (pinned by "with no hook, every map is
 * today's cut map" in timeline.test.ts).
 *
 * Every stored time stays clip time. Only what touches the FILE (players,
 * export, strip, waveform) converts, and only through here.
 */

// ---- packages/core/src/cut-map.ts

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

// ---- packages/core/src/timeline.ts

export function hookLeadSec(tl) {
  if (tl.hook === null) return 0;
  let lead = 0;
  for (const r of tl.hook.ranges) lead += r.end - r.start;
  return lead;
}

export function clipToFileSec(tl, c) {
  return hookLeadSec(tl) + c;
}

/** Always the clip's own occurrence, never a replay; null strictly inside a cut. */
export function sourceToFileSec(tl, s) {
  const c = windowToClipSec(s - tl.originSec, tl.cuts);
  return c === null ? null : hookLeadSec(tl) + c;
}

export function hookFileRanges(tl) {
  if (tl.hook === null) return [];
  const out = [];
  let acc = 0;
  for (const r of tl.hook.ranges) {
    const len = r.end - r.start;
    out.push({ fileStart: acc, fileEnd: acc + len, clipStart: r.start });
    acc += len;
  }
  return out;
}
