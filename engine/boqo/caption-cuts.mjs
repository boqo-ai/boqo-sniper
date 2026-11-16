// ported from boqo-ai/boqo packages/core/src/caption-cuts.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
/**
 * The scene cuts `layoutCaptions` breaks caption groups at, derived from a
 * clip's own shot list.
 *
 * Every shot START except the first: the clip's own opening is not a cut,
 * it is where the clip begins, and offering it as one would invite a break
 * before the first word. Everything after it is a real camera change, which
 * an edited interview uses to cut to whoever is talking -- so a cut is a
 * speaker change the transcript may not have recorded (see the run loop in
 * `apps/worker/src/render/captions.ts`).
 *
 * This exists because the renderer and the clip editor's live composite
 * both need the identical list, and for a while they disagreed: the
 * renderer passed `shots.slice(1).map(...)` and the editor's stage passed
 * `shots.map(...)`, so the composite offered a cut at the clip's own t=0
 * that the burned-in captions never saw. Nearly always inert -- a first
 * shot starts at 0 and no word starts before it -- but `cutSec` is named in
 * the design spec as the one input most likely to be silently wrong, and
 * two hand-written spellings of one list is exactly how it gets that way.
 * One function, two callers, and they cannot drift.
 *
 * Structurally typed on `{ startSec }` rather than on `SidecarShot`,
 * because the two callers hold different shot types (the renderer's own
 * `ShotPlan` and the sidecar's `SidecarShot`) over the same field.
 */
export function cutSecFromShots(shots                                 )           {
  return shots.slice(1).map((shot) => shot.startSec);
}
