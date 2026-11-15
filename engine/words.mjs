// Words and transcript chunks: one word list from YouTube json3 captions or
// whisper.cpp JSON, and the timestamped transcript the agent reads.

/**
 * One spoken word, times in seconds, `s < e`.
 * @typedef {{ w: string, s: number, e: number }} Word
 */

const MAX_WORD_SEC = 1.0;
const MIN_WORD_SEC = 0.01;

const round3 = (x) => Math.round(x * 1000) / 1000;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * Words from a YouTube json3 caption track. Each seg starts at
 * `tStartMs + tOffsetMs`. A word ends where the next one starts, and never
 * runs longer than one second; the last word ends at its event's end, also
 * capped.
 * @param {object} j parsed json3
 * @returns {Word[]}
 */
export function wordsFromJson3(j) {
  const events = Array.isArray(j?.events) ? j.events : [];
  const raw = [];
  for (const ev of events) {
    const t0 = num(ev?.tStartMs);
    if (t0 === null || !Array.isArray(ev.segs)) continue;
    const d = num(ev.dDurationMs);
    for (const seg of ev.segs) {
      const text = typeof seg?.utf8 === 'string' ? seg.utf8.trim() : '';
      if (!text) continue;
      const startMs = t0 + (num(seg.tOffsetMs) ?? 0);
      raw.push({ w: text, startMs, endMs: d === null ? null : t0 + d });
    }
  }
  raw.sort((a, b) => a.startMs - b.startMs);
  return raw.map((r, i) => {
    const s = r.startMs / 1000;
    const cap = s + MAX_WORD_SEC;
    const next = raw[i + 1];
    let e = next ? next.startMs / 1000 : r.endMs === null ? cap : r.endMs / 1000;
    e = Math.min(e, cap);
    if (e <= s) e = s + MIN_WORD_SEC;
    return { w: r.w, s: round3(s), e: round3(e) };
  });
}

// whisper's non-speech items: wholly bracketed ([BLANK_AUDIO], [_BEG_],
// [Music], (laughs)) or only music notes. They are not words to burn in.
const NON_SPEECH = /^(?:\[[^\]]*\]|\([^)]*\)|[\u266a\u266b\s]+)$/;

/**
 * Words from whisper.cpp `-oj` JSON (`offsets` are milliseconds). Non-speech
 * items (`[BLANK_AUDIO]`, `(music)`, `♪`) are dropped.
 * @param {object} j parsed whisper JSON
 * @param {number} [offsetSec] added to every time, for a cut that starts later
 * @returns {Word[]}
 */
export function wordsFromWhisper(j, offsetSec = 0) {
  const items = Array.isArray(j?.transcription) ? j.transcription : [];
  const out = [];
  for (const it of items) {
    const text = typeof it?.text === 'string' ? it.text.trim() : '';
    const from = num(it?.offsets?.from);
    const to = num(it?.offsets?.to);
    if (!text || NON_SPEECH.test(text) || from === null || to === null) continue;
    const s = round3(offsetSec + from / 1000);
    let e = round3(offsetSec + to / 1000);
    if (e <= s) e = round3(s + MIN_WORD_SEC);
    out.push({ w: text, s, e });
  }
  return out.sort((a, b) => a.s - b.s);
}

/**
 * Words overlapping [s, e], rebased so `s` becomes 0 and clamped to
 * [0, e - s]: a word straddling an edge is cut at it, so no consumer can emit
 * a negative time or a caption past the clip end.
 * @param {Word[]} words
 * @param {number} s
 * @param {number} e
 * @returns {Word[]}
 */
export function wordsInRange(words, s, e) {
  return words
    .filter((x) => x.e > s && x.s < e)
    .map((x) => ({ w: x.w, s: round3(Math.max(0, x.s - s)), e: round3(Math.min(e - s, x.e - s)) }));
}

const pad2 = (n) => String(n).padStart(2, '0');

/** mm:ss under an hour, h:mm:ss from an hour up. */
function stamp(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

/**
 * The transcript the agent reads: `## Part N (start–end)` chunks of
 * `[mm:ss] text` lines. A line that overlaps a heat entry with `v >= 0.6`
 * ends with ` ▲`.
 * @param {Word[]} words
 * @param {{ lineSec?: number, chunkSec?: number, heat?: {s:number,e:number,v:number}[] }} [opts]
 * @returns {string[]} one string per chunk
 */
export function transcriptChunks(words, opts = {}) {
  const { lineSec = 8, chunkSec = 900, heat = [] } = opts;
  const hot = heat.filter((h) => h && h.v >= 0.6);
  const sorted = [...words].sort((a, b) => a.s - b.s);
  if (sorted.length === 0) return [];

  const chunks = [];
  let chunk = null;
  let line = null;
  const closeLine = () => {
    if (!line) return;
    const marked = hot.some((h) => h.s < line.end && h.e > line.start);
    chunk.lines.push(`[${stamp(line.start)}] ${line.text.join(' ')}${marked ? ' ▲' : ''}`);
    line = null;
  };

  for (const x of sorted) {
    const idx = Math.floor(x.s / chunkSec);
    if (!chunk || idx !== chunk.idx) {
      closeLine();
      chunk = { idx, lines: [], end: 0 };
      chunks.push(chunk);
    }
    if (line && x.s >= line.start + lineSec) closeLine();
    if (!line) line = { start: x.s, end: x.e, text: [] };
    line.text.push(x.w);
    line.end = Math.max(line.end, x.e);
    chunk.end = Math.max(chunk.end, x.e);
  }
  closeLine();

  return chunks.map((c, i) => {
    const from = c.idx * chunkSec;
    const to = i === chunks.length - 1 ? Math.min(from + chunkSec, Math.ceil(c.end)) : from + chunkSec;
    return [`## Part ${i + 1} (${stamp(from)}–${stamp(to)})`, ...c.lines].join('\n');
  });
}
