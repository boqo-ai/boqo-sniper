// ported from boqo-ai/boqo apps/watcher/src/constants.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Only the four values the skill's capture and buffer use (production values, no env reads).
export const SEGMENT_SEC = 6;
export const POST_ROLL_SEC = 30;
export const PRUNE_MARGIN_SEC = 60;
/** No new segment for this long while streamlink lives → tear down and re-resolve (§4.11). */
export const CAPTURE_STALL_SEC = 45;
