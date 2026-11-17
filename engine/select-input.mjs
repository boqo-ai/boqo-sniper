// ported from boqo-ai/boqo apps/worker/src/ingest/metadata.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// ported from boqo-ai/boqo apps/worker/src/select/handler.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// A partial hand port, not a strip: heatmapOf, descriptionOf and chaptersOf are
// parseHeatmap, parseDescription and parseChapters; buildSelectionInput is the
// `input` half of loadSelectionInput. The goldens compare its output with boqo's.
// The SelectionInput of one selection request, built from what the skill has:
// a yt-dlp info dict (null for a local file; only an `extractor_key` of Youtube gives the video context), the run's sentence segments,
// the viewer comments (or null), and the person's choices. It derives every
// field the way hosted `loadSelectionInput` (apps/worker/src/select/handler.ts)
// and `parseSourceMetadata` (apps/worker/src/ingest/metadata.ts) do, at the
// pin named in engine/boqo/PIN, with the production values as constants:
//   - the replay tunables and the bridge span are the defaults;
//   - `feedback` and `seed` are always empty (they come from boqo's database);
//   - the opener and the context line are off, so no field for them exists.
// Untrusted text is cleaned here (see cleanSegment); the ported modules are not touched.
// tests/select-request.test.mjs compares the message built from this input
// with the one boqo's own chain builds (tests/golden/build-user-message-*.json).
import { clipTargetFor } from './boqo/clip-target.mjs';
import { normalizePrompt } from './boqo/normalize-prompt.mjs';
import { GENRE_PRESETS, CLIP_LENGTH_PRESETS, resolveClipLength, resolveGenre } from './boqo/selection-presets.mjs';
import { sanitiseQuote } from './boqo/quote-text.mjs';
import { pickReactions } from './boqo/viewer-reactions.mjs';
import { videoContextOf } from './boqo/video-context.mjs';
import { DEFAULT_BRIDGE_MAX_SEC, DEFAULT_REPLAY_TUNABLES } from './boqo/replay-config.mjs';
import { curveBins, discountHeatmap } from './boqo/replay.mjs';
import { findPeakRegions } from './boqo/peaks.mjs';

// parseSourceMetadata's caps (apps/worker/src/ingest/metadata.ts).
const MAX_DESCRIPTION_CHARS = 5000;
const MAX_STORED_CHAPTERS = 200;
const MAX_CHAPTER_TITLE_CHARS = 200;

const NUL = /\u0000/g;
const LONE_SURROGATE = /\p{Cs}/gu;
const stripUnstorable = (text) => text.replace(NUL, '').replace(LONE_SURROGATE, '');
const cut = (text, max) => Array.from(text).slice(0, max).join('');
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const isRecord = (v) => typeof v === 'object' && v !== null;

// The agent that reads the request has a shell on the person's machine, and
// captions, titles, descriptions and comments are other people's text.
// Hosted's `buildUserMessage` already passes the title, channel, description,
// chapter titles, reactions and the creator's request through `sanitiseQuote`
// or `neutraliseFences`; it writes a transcript line as it is, so the segment
// text is cleaned here, upstream, with the same ported `sanitiseQuote` (control
// characters and line breaks become one space, links go, quotes become ',
// runs of three or more angle brackets are cut down) and no length cap. The
// ported functions stay byte-identical to boqo's.
const NO_CAP = Number.MAX_SAFE_INTEGER;
const cleanSegment = (s) => {
  if (!isRecord(s) || typeof s.text !== 'string') throw new Error('a transcript segment has no text');
  // A hand-edited file may hold a string or nothing as the speaker: only a whole number leads a line.
  const speaker = Number.isInteger(s.speaker) ? s.speaker : null;
  return { ...s, speaker, text: sanitiseQuote(s.text, NO_CAP) };
};

// A BCP-47-shaped tag (the transcript language is printed in the request), else English.
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const languageOf = (v) => (typeof v === 'string' && LANGUAGE_TAG.test(v) ? v : null);

// yt-dlp names the extractor that read the page. Only YouTube's own are a
// YouTube video's title and description (hosted: `sourceKind === "youtube"`).
const isYoutube = (info) => isRecord(info) && info.extractor_key === 'Youtube';

/** yt-dlp heatmap `{start_time, end_time, value}` as hosted's `HeatmapEntry`, or null. */
function heatmapOf(value) {
  if (!Array.isArray(value)) return null;
  const entries = value.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const { start_time: s, end_time: e, value: v } = raw;
    return typeof s === 'number' && typeof e === 'number' && typeof v === 'number' ? [{ startTime: s, endTime: e, value: v }] : [];
  });
  return entries.length > 0 ? entries : null;
}

function descriptionOf(value) {
  const raw = str(value);
  const text = raw === null ? '' : stripUnstorable(raw).trim();
  return text === '' ? null : cut(text, MAX_DESCRIPTION_CHARS);
}

/** yt-dlp chapters `{start_time, title}` as hosted's `Chapter[]`, sorted, at most 200, or null. */
function chaptersOf(value) {
  if (!Array.isArray(value)) return null;
  const chapters = value.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const { start_time: start, title } = raw;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return [];
    if (typeof title !== 'string') return [];
    const trimmed = cut(stripUnstorable(title).trim(), MAX_CHAPTER_TITLE_CHARS);
    return trimmed === '' ? [] : [{ startSec: start, title: trimmed }];
  });
  if (chapters.length === 0) return null;
  return chapters.sort((a, b) => a.startSec - b.startSec).slice(0, MAX_STORED_CHAPTERS);
}

/** Hosted: `project.durationSec ?? segments.at(-1).end`, the duration being yt-dlp's, rounded. `segments` are the run's (non-empty). */
export function durationOf(info, segments) {
  const d = isRecord(info) ? info.duration : undefined;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.round(d) : segments.at(-1).end;
}

/** The discounted most-replayed curve of a yt-dlp info dict (null: none, flat, or under three usable bins). The markers and the replay percentiles read it. */
export function replayCurveOf(info) {
  const meta = isRecord(info) ? info : {};
  const chapters = chaptersOf(meta.chapters);
  return discountHeatmap(heatmapOf(meta.heatmap), (chapters ?? []).map((c) => c.startSec), DEFAULT_REPLAY_TUNABLES);
}

/** The transcript language the request names: the caller's, then yt-dlp's, else English. */
export function languageFor(info, language = null) {
  return languageOf(language) ?? languageOf(isRecord(info) ? info.language : undefined) ?? 'en';
}

/**
 * @param {{
 *   info?: object | null,
 *   segments: { start: number, end: number, text: string, speaker: number | null }[],
 *   comments?: { text: string, likes: number }[] | null,
 *   genre?: string, length?: string, prompt?: string | null, language?: string | null,
 * }} o info is yt-dlp's `-J` output, null for a local file; comments null means
 *   none were read (no reaction block), [] means read and none qualified.
 */
export function buildSelectionInput({ info = null, segments, comments = null, genre = 'auto', length = 'auto', prompt = null, language = null }) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('there are no transcript segments to select from');
  const clean = segments.map(cleanSegment);
  const known = (list, key, what) => {
    if (!list.some((p) => p.key === key)) throw new Error(`unknown ${what} "${key}": use ${list.map((p) => p.key).join(', ')}`);
  };
  known(GENRE_PRESETS, genre, 'genre');
  known(CLIP_LENGTH_PRESETS, length, 'length');

  const meta = isRecord(info) ? info : {};
  const durationSec = durationOf(info, clean);
  const chapters = chaptersOf(meta.chapters);
  const reactions = comments === null ? null : pickReactions(comments, durationSec);
  // The curve is discounted once and the markers are read off it (B9 spec §3.5).
  const replay = replayCurveOf(info);

  return {
    language: languageFor(info, language),
    durationSec,
    segments: clean,
    peaks: findPeakRegions(replay === null ? null : curveBins(replay), durationSec),
    bridgeMaxSec: DEFAULT_BRIDGE_MAX_SEC,
    maxClips: clipTargetFor(durationSec),
    genre: resolveGenre(genre),
    clipLength: resolveClipLength(length),
    source: videoContextOf({
      sourceKind: isYoutube(info) ? 'youtube' : 'upload',
      title: str(meta.title),
      channelName: str(meta.channel) ?? str(meta.uploader),
      description: descriptionOf(meta.description),
      chapters,
      viewerReactions: reactions,
    }),
    prompt: normalizePrompt(prompt),
    feedback: [],
    seed: null,
  };
}
