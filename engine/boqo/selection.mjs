// ported from boqo-ai/boqo packages/core/src/selection.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// Types only, as JSDoc, plus the one value the file holds that the skill uses. The
// SelectionInput, ClipSelector and scene types are not part of the skill: the person's
// agent is the selector, and select-input.mjs builds the one input it needs.

/**
 * Most characters a clip title may hold: the selection wire bound
 * (`apps/worker/src/select/anthropic.ts`), the alternatives' clamp, and the
 * title PATCH's limit (Task 3.4).
 */
export const CLIP_TITLE_MAX_CHARS = 200;

/**
 * One sentence of the transcript (packages/core/src/transcription.ts at the pin).
 * @typedef {{ start: number, end: number, text: string, speaker: number | null }} TranscriptSegment
 */

/**
 * What the model answers per clip, after the wire's snake_case is mapped
 * (packages/core/src/standalone.ts at the pin).
 * @typedef {{ standsAlone: boolean, claim: string, bridgeFromSec: number | null, contextLine: string | null }} StandaloneAnswer
 */

/**
 * One clip the model proposed, or after snapping one clip boqo will render. The
 * same shape carries both because snapping only moves the boundaries; it never
 * changes what the clip is. The four axes are presentation: `score` stays the
 * model's own overall judgement and snapAndFilter ranks on it. `emphasisWords`
 * is possibly empty. `titleAlternatives` holds 0-2 after `normaliseAlternatives`.
 * @typedef {{
 *   startSec: number,
 *   endSec: number,
 *   title: string,
 *   hook: string,
 *   score: number,
 *   hookScore: number,
 *   flowScore: number,
 *   standaloneScore: number,
 *   valueScore: number,
 *   emphasisWords: string[],
 *   standalone?: StandaloneAnswer,
 *   titleAlternatives: string[],
 * }} ClipCandidate
 */

/**
 * @typedef {'no_segments' | 'inverted' | 'too_short' | 'too_long' | 'below_threshold' | 'overlaps' | 'over_cap' | 'seed_window'} DropReason
 * @typedef {{ candidate: ClipCandidate, snapped: ClipCandidate | null, reason: DropReason }} DroppedClip
 * @typedef {{ kept: ClipCandidate[], dropped: DroppedClip[] }} SnapResult
 * @typedef {{ minScore: number, maxClips: number, hardMinSec: number, hardMaxSec: number, seedWindow?: { startSec: number, endSec: number } | null }} SnapOptions
 */
