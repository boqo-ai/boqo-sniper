// The selection check and the run's record (§7.3). The person's agent writes
// <run>/selection.json in hosted's SelectionResponse shape; checkSelection
// validates it exactly as hosted's zod schema does (engine/boqo/selection-schema.mjs),
// then runs hosted's own order of work after the model answers
// (apps/worker/src/select/handler.ts, the clip path, at the pin named in
// engine/boqo/PIN): snapAndFilter, then replayOf and deriveStandaloneTest for
// each kept clip. The result is <run>/clips.json, the record every later step reads.
//
// Production values are constants here: minScore 0, no seed window, sha null,
// the default replay tunables, the count target one clip a minute and the keep
// ceiling that is 1.25 times it (both from engine/boqo/clip-target.mjs).
import { SelectionResponse, normaliseAlternatives } from './boqo/selection-schema.mjs';
import { CLIP_LENGTH_PRESETS, resolveClipLength } from './boqo/selection-presets.mjs';
import { clipTargetFor, keepCeilingFor } from './boqo/clip-target.mjs';
import { snapAndFilter } from './boqo/snap.mjs';
import { deriveStandaloneTest } from './boqo/standalone.mjs';
import { DEFAULT_REPLAY_TUNABLES, replayOf } from './boqo/replay.mjs';

/** How many errors are listed before the rest are only counted. */
export const MAX_ERRORS = 40;

// The skill asks for exactly two (the rubric and the field's description say so). Hosted's schema
// does not enforce it: `normaliseAlternatives` keeps what is usable. The agent is held to the
// instruction here, and the record keeps the normalised list, as hosted stores it.
const ALTERNATIVES_WANTED = 2;

// A zod path as the agent reads it in selection.json: ['clips', 1, 'score'] is clips[1].score.
function pathOf(path) {
  if (path.length === 0) return 'selection';
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`)).join('');
}

function listed(errors) {
  if (errors.length <= MAX_ERRORS) return errors;
  return [...errors.slice(0, MAX_ERRORS), `and ${errors.length - MAX_ERRORS} more`];
}

// The wire's snake_case mapped as hosted's parseSelectionMessage does.
const candidateOf = (clip) => ({
  startSec: clip.start_sec,
  endSec: clip.end_sec,
  title: clip.title,
  hook: clip.hook,
  score: clip.score,
  hookScore: clip.hook_score,
  flowScore: clip.flow_score,
  standaloneScore: clip.standalone_score,
  valueScore: clip.value_score,
  emphasisWords: clip.emphasis_words,
  standalone: { standsAlone: clip.stands_alone, claim: clip.claim, bridgeFromSec: clip.bridge_from_sec, contextLine: clip.context_line },
  titleAlternatives: normaliseAlternatives(clip.title, clip.title_alternatives),
});

/**
 * @param {unknown} raw the parsed selection.json
 * @param {{
 *   segments: { start: number, end: number, text: string, speaker: number | null }[],
 *   durationSec: number,
 *   heat: object | null,
 *   length?: string,
 *   video?: { id?: string | null, title?: string | null, language?: string | null },
 * }} o `heat` is the discounted most-replayed curve (engine/boqo/replay.mjs `discountHeatmap`), or null;
 *   `length` is a clip-length preset key (auto when absent).
 * @returns {{ ok: false, errors: string[] } | { ok: true, record: object, dropped: Record<string, number> }}
 */
export function checkSelection(raw, { segments, durationSec, heat, length = 'auto', video = {} }) {
  if (!Array.isArray(segments) || segments.length === 0) return { ok: false, errors: ['there are no transcript segments to snap to'] };
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { ok: false, errors: ['the video has no duration'] };
  if (!CLIP_LENGTH_PRESETS.some((p) => p.key === length)) {
    return { ok: false, errors: [`unknown length "${length}": use ${CLIP_LENGTH_PRESETS.map((p) => p.key).join(', ')}`] };
  }

  const parsed = SelectionResponse.safeParse(raw);
  const errors = parsed.success ? [] : parsed.error.issues.map((i) => `${pathOf(i.path)}: ${i.message}`);
  // After the schema's own issues, and only where title_alternatives is an array (a wrong type is already one of them).
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.clips)) {
    raw.clips.forEach((clip, i) => {
      const alternatives = clip?.title_alternatives;
      if (Array.isArray(alternatives) && alternatives.length !== ALTERNATIVES_WANTED) {
        errors.push(`clips[${i}]: title_alternatives must have exactly ${ALTERNATIVES_WANTED} (got ${alternatives.length})`);
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors: listed(errors) };

  const target = clipTargetFor(durationSec);
  const cap = keepCeilingFor(target);
  const band = resolveClipLength(length);
  const { kept, dropped } = snapAndFilter(parsed.data.clips.map(candidateOf), segments, {
    minScore: 0,
    maxClips: cap,
    hardMinSec: band.hardMinSec,
    hardMaxSec: band.hardMaxSec,
    seedWindow: null,
  });

  const starts = segments.map((s) => s.start);
  // R12: numbered 1..N in snapAndFilter's order (transcript order). `clips order` rewrites `n` later.
  const clips = kept.map((clip, i) => {
    const replay = replayOf(heat ?? null, { startSec: clip.startSec, endSec: clip.endSec }, DEFAULT_REPLAY_TUNABLES, null);
    return {
      n: i + 1,
      start: clip.startSec,
      end: clip.endSec,
      title: clip.title,
      title_alternatives: clip.titleAlternatives,
      hook: clip.hook,
      score: clip.score,
      axes: { hook: clip.hookScore, flow: clip.flowScore, standalone: clip.standaloneScore, value: clip.valueScore },
      emphasis_words: clip.emphasisWords,
      standalone: deriveStandaloneTest(clip.standalone, starts, null, clip.startSec).test,
      // hosted's `heat` is the window's mean heat; null when there is no curve or no bin in the window
      replay: replay.pct === null ? null : { pct: replay.pct, mean: replay.heat },
      judgment: null,
      panels: null,
      rendered: false,
      file: null,
      notes: [],
    };
  });

  const reasons = {};
  for (const d of dropped) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
  return {
    ok: true,
    record: {
      version: 1,
      video: { id: video.id ?? null, title: video.title ?? null, duration: durationSec, language: video.language ?? null },
      target,
      cap,
      clips,
    },
    dropped: reasons,
  };
}
