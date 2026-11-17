// ported from boqo-ai/boqo apps/worker/src/render/panels-text.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Cut imports: `@boqo/core` and `./headline` become the sibling copies (caption-presets, headline,
// headline-ass: A12's and A13's modules). `ShotPlan` is a type only (pipeline.ts, engine/boqo/plan-shots.mjs).
// A11 first copied HEADLINE_POSITION_MIN/MAX, CAPTION_POSITION_MAX as constants and took `scalePreset`,
// `textElementExtent` and `headlineWindow` as parameters of the three functions that call them; those are the real
// imports now (A13), and the parameters are gone, as in boqo's own signatures.
import { CAPTION_POSITION_MAX, scalePreset } from "./caption-presets.mjs";
import { HEADLINE_POSITION_MAX, HEADLINE_POSITION_MIN } from "./headline.mjs";
import { headlineWindow, textElementExtent } from "./headline-ass.mjs";

/**
 * Text on a stream panel clip (#293, spec §6.4): nothing covers a face. The
 * caption and headline files are built once per clip; captions keep one
 * position per clip, and a text element takes one position per run of the
 * shots it is on screen over (`panelsTextRuns`). A clip with
 * no `panels` shot gets every input back unchanged -- the same object, so its
 * `.ass` files are byte-identical to before this module existed.
 */

const overlaps = (a                                      , b                                      ) =>
  a.startSec < b.endSec && b.startSec < a.endSec;

/**
 * Where a text element's centre goes, as a fraction of frame height. Over a
 * `panels` shot whose top band (the cameras) holds its centre, it moves onto
 * the seam between the bands, `topHeight / outputHeight`, clamped to the
 * headline's own band; over several, onto the lowest of their seams, which
 * covers no camera in any of them. Anywhere else it keeps its position.
 * `element`'s times are on the same axis as `placed`'s shots.
 */
export function panelsTextPosition(input   
                                                                          
                              
                       
 )         {
  const { element, placed, outputHeight } = input;
  const centrePx = element.positionFraction * outputHeight;
  let seamPx                = null;
  for (const entry of placed) {
    if (entry.placement.kind !== "panels") continue;
    if (!overlaps(element, entry.shot)) continue;
    if (centrePx >= entry.placement.topHeight) continue;
    seamPx = Math.max(seamPx ?? 0, entry.placement.topHeight);
  }
  if (seamPx === null) return element.positionFraction;
  return Math.min(HEADLINE_POSITION_MAX, Math.max(HEADLINE_POSITION_MIN, seamPx / outputHeight));
}

/**
 * The lowest seam of any `panels` shot in the clip, as a fraction of frame
 * height: captions, one position per clip, stay below it. Null with no
 * `panels` shot.
 */
export function captionFloor(placed                     , outputHeight        )                {
  let floorPx                = null;
  for (const entry of placed) {
    if (entry.placement.kind === "panels") floorPx = Math.max(floorPx ?? 0, entry.placement.topHeight);
  }
  return floorPx === null ? null : floorPx / outputHeight;
}

const SEAM_TOLERANCE_PX = 0.5;

/**
 * The space left between a seam-placed headline's plate and the caption
 * block under it, as a fraction of frame height (about 19 px at 1920): a
 * chosen breathing room, not a measured quantity.
 */
export const PANELS_TEXT_GAP_FRACTION = 0.01;

/**
 * Where the caption block's top may start, as a fraction of frame height:
 * the seam (`captionFloor`), or lower when a text element sits over a
 * `panels` shot's top band or on its seam -- the headline `panelsTextPosition`
 * centred there -- in which case it is that element's drawn bottom
 * (`textElementExtent`, the plate `buildTextAss` draws) plus
 * PANELS_TEXT_GAP_FRACTION. An element below every seam it is on screen over
 * does not count: it is not one this module placed. Null with no `panels` shot.
 */
export function panelsCaptionFloor(
  placed                     ,
  output            ,
  text                                                                          = [],
)                {
  const seam = captionFloor(placed, output.height);
  if (seam === null) return null;
  let floorPx = seam * output.height;
  for (const element of text) {
    const span = element.span ?? { startSec: 0, endSec: Number.POSITIVE_INFINITY };
    const centrePx = element.settings.positionFraction * output.height;
    // `panelsTextPosition` stored seamPx / height; multiplying back is off by
    // an ulp (at height 1920 (x / 1920) * 1920 > x for x = 496, 498, 500,
    // checked in IEEE doubles), so a headline on the seam needs a tolerance.
    const onSeam = placed.some(
      (entry) =>
        entry.placement.kind === "panels" && overlaps(span, entry.shot) && centrePx <= entry.placement.topHeight + SEAM_TOLERANCE_PX,
    );
    if (!onSeam) continue;
    const extent = textElementExtent(element, output);
    if (extent === null) continue;
    floorPx = Math.max(floorPx, extent.bottom + PANELS_TEXT_GAP_FRACTION * output.height);
  }
  return floorPx / output.height;
}

/**
 * The clip's caption style with its block moved just below the caption
 * floor (`panelsCaptionFloor` over `text`, the clip's drawn text elements
 * after `panelsTextElements`) when any of it would sit above it: the block's
 * top on the floor, capped at CAPTION_POSITION_MAX. The block's half-height is
 * the geometry `layoutCaptions` draws (`maxLines` lines
 * `capHeightPx * lineSpacingRatio` apart, plus the outline), at the scaled
 * preset it draws with. A legacy or `none` preset has no `centreFraction` and
 * is returned as it is, as is every style on a clip with no `panels` shot.
 */
export function panelsCaptionStyle(
  style               ,
  placed                     ,
  output            ,
  text                                                                          = [],
)                {
  if (style.emission !== "positioned") return style;
  const floor = panelsCaptionFloor(placed, output, text);
  if (floor === null) return style;
  const scaled = scalePreset(style, output);
  const halfPx = (((scaled.maxLines - 1) * scaled.lineSpacingRatio + 1) / 2) * scaled.capHeightPx + scaled.outlineWidth;
  const floorPx = floor * output.height;
  if (style.centreFraction * output.height - halfPx >= floorPx) return style;
  return { ...style, centreFraction: Math.min(CAPTION_POSITION_MAX, (floorPx + halfPx) / output.height) };
}

/**
 * The shortest part a split text element is drawn in, in seconds. Only the
 * first part plays the entrance (`buildTextAss`), so it must not be cut
 * shorter than the longest entrance a headline can play: the 380 ms pop,
 * fade and slide and the 400 ms marker sweep (`ANIM_MS`, core's
 * caption-timing.ts) run at up to twice that under the slowest `speed` the
 * brand schema accepts, 0.5 (`BrandHeadline`, core's headline.ts), so 800 ms.
 * The value is that intent, not a measurement; the `type` entrance is longer
 * still but a later part keeps typing on the element's clock. Its cost: a
 * camera-only shot shorter than this inside a seam run keeps the seam plate
 * (possibly over the face for that time), and a `panels` shot that short
 * inside an own run keeps the own position.
 */
export const MIN_PART_SEC = 0.8;

/** Seconds within which two times are one, so float noise makes no part. */
const EDGE_TOLERANCE_SEC = 1e-6;

/**
 * A text element's time on screen cut at the boundaries of the shots it
 * overlaps, neighbours joined into runs of two kinds: a seam run (consecutive
 * `panels` shots whose top band holds the element's centre) sits on the seam
 * by `panelsTextPosition` over that run's shots alone; an own run (any other
 * shot) keeps `positionFraction`. A run on screen for less than MIN_PART_SEC
 * folds into the run before it (the first into the one after) and takes its
 * position. Runs with the same position are joined, so one run comes back for
 * an element that never changes place. Spec §6.4's named fallback, built
 * after production stills showed a whole-clip seam headline on the author's
 * face in a mixed clip's full-camera shots (#293 Task 12, 2026-11-10).
 */
export function panelsTextRuns(input   
                                                                          
                              
                       
 )                                                                        {
  const { element, placed, outputHeight } = input;
  const centrePx = element.positionFraction * outputHeight;
  // A shot on screen for no more than EDGE_TOLERANCE_SEC of the window: its
  // boundary is the window's edge, and it makes no run.
  const over = placed
    .filter(
      (entry) =>
        Math.min(element.endSec, entry.shot.endSec) - Math.max(element.startSec, entry.shot.startSec) > EDGE_TOLERANCE_SEC,
    )
    .sort((a, b) => a.shot.startSec - b.shot.startSec);
  // `shots` are the run's own shots, the ones its position is read from; a
  // folded run adds its time, never its shots.
  const groups                                                                                = [];
  for (const entry of over) {
    const seam = entry.placement.kind === "panels" && centrePx < entry.placement.topHeight;
    const last = groups.at(-1);
    if (last !== undefined && last.seam === seam) last.shots.push(entry);
    else groups.push({ seam, shots: [entry], startSec: entry.shot.startSec, endSec: entry.shot.endSec });
  }
  groups.forEach((group, index) => {
    group.startSec = index === 0 ? element.startSec : group.shots[0] .shot.startSec;
    group.endSec = index === groups.length - 1 ? element.endSec : groups[index + 1] .shots[0] .shot.startSec;
  });
  // No part shorter than MIN_PART_SEC: a short run folds into the run before
  // it (the first into the one after), neighbours left of one kind join, and
  // this repeats until no run is short or one is left.
  for (;;) {
    const short = groups.findIndex((group) => group.endSec - group.startSec < MIN_PART_SEC - EDGE_TOLERANCE_SEC);
    if (short === -1 || groups.length === 1) break;
    const folded = groups[short] ;
    const into = short === 0 ? groups[1]  : groups[short - 1] ;
    into.startSec = Math.min(into.startSec, folded.startSec);
    into.endSec = Math.max(into.endSec, folded.endSec);
    groups.splice(short, 1);
    for (let index = groups.length - 1; index > 0; index -= 1) {
      const before = groups[index - 1] ;
      const after = groups[index] ;
      if (before.seam !== after.seam) continue;
      before.shots.push(...after.shots);
      before.endSec = after.endSec;
      groups.splice(index, 1);
    }
  }
  const runs                                                                        = [];
  for (const { seam, shots, startSec, endSec } of groups) {
    const positionFraction = seam
      ? panelsTextPosition({ element: { startSec, endSec, positionFraction: element.positionFraction }, placed: shots, outputHeight })
      : element.positionFraction;
    const last = runs.at(-1);
    if (last !== undefined && last.positionFraction === positionFraction) last.endSec = endSec;
    else runs.push({ startSec, endSec, positionFraction });
  }
  return runs.length > 0 ? runs : [{ startSec: element.startSec, endSec: element.endSec, positionFraction: element.positionFraction }];
}

/**
 * Each text element (`buildTextAss`'s input) placed per run of shots
 * (`panelsTextRuns`) over its time on screen: its own `span`, or the
 * headline's own window (`headlineWindow`, the one `buildTextAss` draws) when
 * it has none. One run: the element itself when it does not move, else one
 * moved copy, as before runs existed. Several: one element per run, in time
 * order, each with that run's span and position and a `part` that keeps the
 * source's Style line, layers and animation clock in `buildTextAss`. Returns
 * the SAME array when nothing moves, and an unmoved element is the same object.
 */
export function panelsTextElements(
  elements                           ,
  placed                     ,
  output            ,
  clipDurationSec        ,
)                            {
  if (!placed.some((entry) => entry.placement.kind === "panels")) return elements;
  let moved = false;
  const out = elements.flatMap((element) => {
    const window = element.span ?? headlineWindow(element.settings, clipDurationSec);
    const runs = panelsTextRuns({
      element: { ...window, positionFraction: element.settings.positionFraction },
      placed,
      outputHeight: output.height,
    });
    if (runs.length === 1) {
      const positionFraction = runs[0] .positionFraction;
      if (positionFraction === element.settings.positionFraction) return [element];
      moved = true;
      return [{ ...element, settings: { ...element.settings, positionFraction } }];
    }
    moved = true;
    return runs.map((run, index) => ({
      ...element,
      settings: { ...element.settings, positionFraction: run.positionFraction },
      span: { startSec: run.startSec, endSec: run.endSec },
      part: { index, window: { startSec: window.startSec, endSec: window.endSec } },
    }));
  });
  return moved ? out : elements;
}
