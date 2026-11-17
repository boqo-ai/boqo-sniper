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
 * between one word's START and the next one's start ends a segment. Start to
 * start, not end to start: on YouTube auto captions `wordsFromJson3` ends a word
 * at the next word's start but never more than 1.0 s after its own, so a word's
 * end is a synthesized one and an end-to-start gap is 0 unless the caption
 * event's own span ends the word earlier (so under 1.0 s of spacing it is
 * almost always 0; read out of `engine/words.mjs`; the data below agrees: of 17,828
 * real auto words 825 have any gap at all). Spec section 7.2 wrote the rule as
 * the end-to-start gap; E2 changed the metric (a deviation from the spec's
 * wording) because that gap cannot reach the values that agree best. Only
 * `source: 'auto'` splits on a pause; manual and whisper words are split on
 * punctuation and the word cap alone, so nothing else uses this measure.
 *
 * Measured 2026-11-17 (Task E2): five E1/E2 eval videos, YouTube auto `-orig`
 * tracks (hi, hi, ru, fil, en) against hosted boqo's Deepgram segments. A
 * boundary is a segment end; a match is a hosted boundary with a skill boundary
 * within 0.3 s, one to one; both sides restricted to the span the words cover
 * (1,562 hosted boundaries; 2,364 skill ones at 0.8 s).
 *   - Start to start, 0.8 s: pooled F1 0.298 (P 0.247, R 0.375). Per video F1:
 *     hi-1 0.100, hi-2 0.134, ru 0.330, fil 0.178, en 0.458; macro mean 0.240. Pooled F1 is 0.269 at 0.5, 0.289 at 0.6, 0.293
 *     at 0.7, 0.296 at 0.9, 0.287 at 1.0: a plateau from 0.6 to 1.0, with the
 *     same peak at 0.2 s and at 0.5 s tolerance.
 *   - The old end-to-start gap, best positive value (0.1 s): pooled F1 0.255;
 *     0.247 at the previous default 0.6 (macro 0.197), falling slowly to 0.225
 *     at 3.0. It is nearly flat because the cap hides every pause under 1.0 s.
 *   - Time-block bootstrap (120 s blocks), start to start 0.8 minus gap 0.6:
 *     +0.050 pooled F1, 95% CI [+0.017, +0.088]. Random placement of as many
 *     boundaries as the 0.8 s rule makes scores 0.128.
 * fil and en agree better with the old gap at 0.6 (by 0.015 and 0.057 F1). Agreement is weak in absolute terms (hosted splits on sentences and
 * speakers, not on pauses), and hi-1 and hi-2 are Hindi speech that
 * Deepgram transcribed as English.
 */
export const PAUSE_SPLIT_SEC = 0.8;

const SOURCES = ['manual', 'auto', 'whisper'];
const EPS = 1e-9;

// ported from boqo-ai/boqo apps/worker/src/transcribe/normalize.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// segmentsFromWords, the fallback split: a segment ends after a word that ends
// in . ! or ? (and an optional closing double quote), or when it holds
// MAX_SEGMENT_WORDS words; what is left at the end is a segment too. Hosted
// also splits on a speaker change: there is no speaker locally. The pause rule
// (`source: 'auto'` only) is this module's own and is not in the port.
/**
 * @param {Word[]} words
 * @param {{ source: 'manual'|'auto'|'whisper', pauseSplitSec?: number }} opts
 *   `manual` (cues re-split into sentences) and `whisper` are punctuated: split
 *   on . ! ? or at 40 words. `auto` (unpunctuated, word-timed) also splits when
 *   two words start at least `pauseSplitSec` apart (see PAUSE_SPLIT_SEC), so
 *   hand-built words with true ends should not be passed as 'auto'.
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
    if (source === 'auto' && current.length > 0 && word.s - current.at(-1).s >= pauseSplitSec - EPS) flush();
    current.push(word);
    if (/[.!?]"?$/.test(word.w) || current.length >= MAX_SEGMENT_WORDS) flush();
  }
  flush();

  return segments;
}
