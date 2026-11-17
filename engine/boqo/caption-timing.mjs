// ported from boqo-ai/boqo packages/core/src/caption-timing.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
                                                                 
                                                          

/**
 * The numbers and rules the worker compiles into ASS (`\t`, `\fad`, `\move`)
 * and the browser preview evaluates (caption-visual.ts), defined once so the
 * two cannot drift. Before this file the preview carried its own copies of
 * `animMs`, `within`, `keyColourOf`, `tiltOf` and every duration below.
 */

/** Base durations in ms, before dividing by a style's `speed`. */
export const ANIM_MS = {
  /** The `scale` emphasis ramp with `animatePop`. */
  emphasisPop: 80,
  /** The spoken word's pop entrance, 60% to 100%. */
  wordPop: 120,
  /** Bounce: grow to 115%, then settle to 100%. */
  bounceUp: 180,
  bounceDown: 300,
  /** A caption line's fade, and its slide, which share one window. */
  lineEntrance: 280,
  /** A caption's highlighter sweep. */
  marker: 220,
  /** A styled headline's pop / fade / slide. */
  headlineEntrance: 380,
  /** A headline highlighter's sweep when it is not riding a slide. */
  headlineSweep: 400,
  /** One character of the headline typewriter. */
  typeStride: 35,
}         ;

/** How far a caption line rises into place, and a headline falls, in CAP HEIGHTS. */
export const LINE_SLIDE_CAP_HEIGHTS = 0.55;
export const HEADLINE_SLIDE_CAP_HEIGHTS = 0.9;

/** A duration in ms for an animation of `baseMs`, divided by speed; at least 1 ms. */
export const animMs = (baseMs        , speed                    ) => Math.max(1, Math.round(baseMs / (speed ?? 1)));

/** min(animation, event): an animation never runs past the event that carries it. */
export const withinEvent = (ms        , eventMs        ) => Math.max(1, Math.min(ms, Math.max(1, Math.floor(eventMs))));

/** The key-word colour: accentColours[1], or the cycle's colour for this key word's place. */
export function keyColourOf(preset                         , wl                   )         {
  const first = preset.accentColours[1] ?? preset.accentColours[0] ;
  if (!preset.cycleColours || wl.keyOrdinal === null) return first;
  const cycle = [first, ...preset.cycleColours];
  return cycle[wl.keyOrdinal % cycle.length] ;
}

/**
 * A tilted word's angle in the CSS sense (positive = clockwise), alternating by
 * the key word's clip-wide ordinal, 0-based like the mockup's `kIdx`: even -3,
 * odd +3. The ASS emission negates it (see the worker).
 */
export const tiltDegOf = (wl                   ) => ((wl.keyOrdinal ?? 0) % 2 === 1 ? 3 : -3);
