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
 * Words from a YouTube json3 caption track. Sound tags (`[Music]`,
 * `[Applause]`) are dropped as in `wordsFromWhisper`. Each seg starts at
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
  const spoken = dropNonSpeech(raw, (r) => r.w);
  return spoken.map((r, i) => {
    const s = r.startMs / 1000;
    const cap = s + MAX_WORD_SEC;
    const next = spoken[i + 1];
    let e = next ? next.startMs / 1000 : r.endMs === null ? cap : r.endMs / 1000;
    e = Math.min(e, cap);
    if (e <= s) e = s + MIN_WORD_SEC;
    return { w: r.w, s: round3(s), e: round3(e) };
  });
}

// whisper's non-speech items: wholly bracketed ([BLANK_AUDIO], [Music],
// (laughs), several in a row) or only music notes. They are not words to burn in.
const NON_SPEECH = /^(?:\[[^\]]*\]|\([^)]*\)|[♪♫♬\s])+$/;

// whisper with one word per item also splits a tag across items: " (upbeat" +
// " music)". An item that opens a bracket (or a note) without closing it opens
// a span; the item that ends with the matching closer ends it.
const OPENERS = [
  { open: /^\(/, hasClose: /\)/, close: /\)[.,!?;:'"…-]*$/ },
  { open: /^\[/, hasClose: /\]/, close: /\][.,!?;:'"…-]*$/ },
  { open: /^[♪♫♬]/, hasClose: /^.[^]*[♪♫♬]/, close: /[♪♫♬][.,!?;:'"…-]*$/ },
];
// A span is at most this many items, opener included: an unmatched "(" in
// real speech must not eat the rest of the transcript.
const MAX_TAG_ITEMS = 6;

/** Drops items inside split sound tags; `texts` are trimmed, in order. */
function splitTagFlags(texts) {
  const drop = new Array(texts.length).fill(false);
  for (let i = 0; i < texts.length; i++) {
    if (drop[i]) continue;
    const o = OPENERS.find((x) => x.open.test(texts[i]) && !x.hasClose.test(texts[i]));
    if (!o) continue;
    for (let j = i + 1; j < texts.length && j < i + MAX_TAG_ITEMS; j++) {
      if (o.close.test(texts[j])) {
        for (let k = i; k <= j; k++) drop[k] = true;
        break;
      }
    }
  }
  return drop;
}

/**
 * Items that are speech: whole-item sound tags and tags split across items
 * are dropped (the same rules for whisper and for YouTube captions). Order is
 * kept.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} textOf trimmed text of an item
 * @returns {T[]}
 */
function dropNonSpeech(items, textOf) {
  const kept = items.filter((it) => !NON_SPEECH.test(textOf(it)));
  const drop = splitTagFlags(kept.map(textOf));
  return kept.filter((_, i) => !drop[i]);
}

const STACK_SEC = 0.03;
const STACK_WORD_SEC = 0.35;

/**
 * whisper sometimes puts several words on one ~10 ms stamp, so a caption group
 * would flash at once. A run of words whose starts are within 0.03 s of the
 * run's first gets the span from that start to the next word's start (or, at
 * the end of the list, the run's last end), at most 0.35 s a word, split
 * evenly. The run never passes the next word. A word does not move earlier
 * than it started, except by a millisecond or two when the gap before the next
 * word is that tight. `words` is sorted; mutated.
 */
function spreadStacked(words) {
  let i = 0;
  while (i < words.length) {
    let j = i + 1;
    while (j < words.length && words[j].s - words[i].s <= STACK_SEC + 1e-9) j++;
    const n = j - i;
    if (n >= 2) {
      const start = words[i].s;
      const hasNext = j < words.length;
      const after = hasNext ? words[j].s : Infinity;
      // With a next word the run ends at that word's start, never past it;
      // the run's last source end only matters when the run ends the list.
      const end = Math.min(hasNext ? after : words[j - 1].e, start + STACK_WORD_SEC * n);
      // The run must fit below `after` at 1 ms a word; if not, leave it be.
      if (!hasNext || after - start >= n * 0.001) {
        const step = (end - start) / n;
        const starts = [];
        for (let k = 0; k < n; k++) {
          // even split first, then the floor (never earlier than the word's own
          // start), then clamp into the gap so every later word keeps 1 ms,
          // then strictly increasing.
          let s = Math.max(round3(start + k * step), words[i + k].s);
          s = Math.min(s, round3(after - (n - k) * 0.001));
          if (k > 0 && s <= starts[k - 1]) s = round3(starts[k - 1] + 0.001);
          starts.push(s);
        }
        for (let k = 0; k < n; k++) {
          const w = words[i + k];
          w.s = starts[k];
          w.e = k < n - 1 ? starts[k + 1] : Math.max(round3(end), round3(starts[k] + 0.001));
        }
      }
    }
    i = j;
  }
  return words;
}

/**
 * Words from whisper.cpp `-oj` JSON (`offsets` are milliseconds). Non-speech
 * items (`[BLANK_AUDIO]`, `(music)`, `♪`) and sound tags split across items
 * (`(upbeat` + `music)`) are dropped; words stacked on one timestamp are
 * spread out.
 * @param {object} j parsed whisper JSON
 * @param {number} [offsetSec] added to every time, for a cut that starts later
 * @returns {Word[]}
 */
export function wordsFromWhisper(j, offsetSec = 0) {
  const items = Array.isArray(j?.transcription) ? j.transcription : [];
  const kept = [];
  for (const it of items) {
    const text = typeof it?.text === 'string' ? it.text.trim() : '';
    const from = num(it?.offsets?.from);
    const to = num(it?.offsets?.to);
    if (!text || from === null || to === null) continue;
    kept.push({ text, from, to });
  }
  const out = dropNonSpeech(kept, (x) => x.text).map(({ text, from, to }) => {
    const s = round3(offsetSec + from / 1000);
    let e = round3(offsetSec + to / 1000);
    if (e <= s) e = round3(s + MIN_WORD_SEC);
    return { w: text, s, e };
  });
  return spreadStacked(out.sort((a, b) => a.s - b.s));
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

/**
 * The text of `transcript.md`: the chunks of `transcriptChunks` joined by a
 * blank line, ending with a newline. `text` is '' when there are no words.
 * @param {Word[]} words
 * @param {Parameters<typeof transcriptChunks>[1]} [opts]
 * @returns {{ text: string, chunks: number }}
 */
export function transcriptMarkdown(words, opts) {
  const chunks = transcriptChunks(words, opts);
  return { text: chunks.length ? chunks.join('\n\n') + '\n' : '', chunks: chunks.length };
}
