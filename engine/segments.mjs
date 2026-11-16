// Sentence segments from a word list, the shape hosted selection reads and
// snaps clip edges to: [{start, end, text, speaker}]. Built locally from YouTube
// captions or whisper, so `speaker` is always null.

/** @typedef {import('./words.mjs').Word} Word */
/** @typedef {{ start: number, end: number, text: string, speaker: null }} Segment */

/**
 * Words a segment holds before it is split, whatever the punctuation. Hosted
 * has the same cap for the case where neither a sentence end nor a speaker
 * change ever comes: without it a stream with no punctuation is one segment
 * spanning the whole video.
 */
export const MAX_SEGMENT_WORDS = 40;

/**
 * Auto captions carry no punctuation, so a pause of at least this many seconds
 * between one word's end and the next one's start ends a segment. Provisional:
 * tuned against Deepgram's segments on the evaluation videos (Task E2).
 *
 * What it means on real YouTube auto captions: `wordsFromJson3` ends a word at
 * the next word's start, but never more than 1.0 s after its own start. So a
 * word's end is a synthesized one, and the gap this rule measures is
 * `next.s - prev.s - 1.0` when the 1 s cap binds and 0 when it does not. At
 * 0.6 a split therefore needs next.s - prev.s >= 1.6 s, i.e. PAUSE_SPLIT_SEC
 * plus up to 1.0 s start to start. A value below about 1.0 s changes nothing
 * on real auto captions: every start-to-start spacing under 1 s has a gap of
 * 0. On words with true ends (whisper-like, hand-built) it is the plain gap.
 * The metric is spec section 7.2 as written; E2 tunes the value and may
 * change the metric on real tracks.
 */
export const PAUSE_SPLIT_SEC = 0.6;

const SOURCES = ['manual', 'auto', 'whisper'];
const EPS = 1e-9;

// ported from boqo-ai/boqo apps/worker/src/transcribe/normalize.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
// segmentsFromWords, the fallback split: a segment ends after a word that ends
// in . ! or ? (and an optional closing double quote), or when it holds
// MAX_SEGMENT_WORDS words; what is left at the end is a segment too. Hosted
// also splits on a speaker change: there is no speaker locally. The pause rule
// (`source: 'auto'` only) is this module's own and is not in the port.
/**
 * @param {Word[]} words
 * @param {{ source: 'manual'|'auto'|'whisper', pauseSplitSec?: number }} opts
 *   `manual` (cues re-split into sentences) and `whisper` are punctuated: split
 *   on . ! ? or at 40 words. `auto` (unpunctuated, word-timed) also splits on a
 *   pause (see PAUSE_SPLIT_SEC for what that is on real json3 words).
 * @returns {Segment[]}
 */
export function segmentsFromWords(words, { source, pauseSplitSec = PAUSE_SPLIT_SEC } = {}) {
  if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`);
  if (!Number.isFinite(pauseSplitSec) || pauseSplitSec <= 0) throw new Error('pauseSplitSec must be a positive number of seconds');
  const list = words
    .filter((x) => x && typeof x.w === 'string' && x.w.trim() !== '')
    .map((x) => ({ w: x.w.trim(), s: x.s, e: x.e }))
    .sort((a, b) => a.s - b.s);

  const segments = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    segments.push({ start: current[0].s, end: current.at(-1).e, text: current.map((x) => x.w).join(' '), speaker: null });
    current = [];
  };

  for (const word of list) {
    if (source === 'auto' && current.length > 0 && word.s - current.at(-1).e >= pauseSplitSec - EPS) flush();
    current.push(word);
    if (/[.!?]"?$/.test(word.w) || current.length >= MAX_SEGMENT_WORDS) flush();
  }
  flush();

  return segments;
}
