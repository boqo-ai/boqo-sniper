// ported from boqo-ai/boqo packages/core/src/clip-target.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Cut: the import of packages/core/src/constants.ts. The three values clipTargetFor
// and keepCeilingFor read, at the pin; the scene constants go with the scene path.
const CLIPS_PER_MINUTE = 1.0;
const MAX_CLIPS_PER_PROJECT = 120;
const SELECT_KEEP_HEADROOM = 1.25;

/**
 * How many clips a source of this length is worth.
 *
 * A flat cap gives a twenty-minute video and a two-hour video the same ten
 * clips; this scales with duration instead, which is the whole reason it
 * exists.
 *
 * The floor of 1 matters: `Math.round` takes anything under thirty seconds
 * to 0, and "return 0 clips" is a different instruction from "return 1 if
 * you find one". The ceiling bounds one project's blast radius — roughly an
 * hour of render and a couple of gigabytes of R2 — rather than expressing a
 * view about how many clips a long video deserves.
 */
export function clipTargetFor(durationSec        )         {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1;
  const raw = Math.round((durationSec / 60) * CLIPS_PER_MINUTE);
  return Math.min(Math.max(raw, 1), MAX_CLIPS_PER_PROJECT);
}

/**
 * The shared body of `keepCeilingFor` and `sceneKeepCeilingFor`: apply the
 * headroom multiplier to a target, then clamp to whichever ceiling the
 * caller owns.
 *
 * Extracted rather than left as two hand-copied blocks differing only in
 * which constant they clamp against — this codebase's own `booleanFromEnv`
 * exists for the identical reason (two hand-copied env switches drifted and
 * only one got fixed), and the working convention it set is to stop at two
 * copies, not to let a third appear with its own chance to drift.
 */
function applyHeadroom(target        , ceiling        )         {
  return Math.min(Math.round(target * SELECT_KEEP_HEADROOM), ceiling);
}

/**
 * The most clips selection will keep for a project whose target is `target`.
 * Bounded by MAX_CLIPS_PER_PROJECT, which no headroom may exceed.
 */
export function keepCeilingFor(target        )         {
  return applyHeadroom(target, MAX_CLIPS_PER_PROJECT);
}
