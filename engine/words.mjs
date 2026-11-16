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

// A speaker change is `>>` (also `&gt;&gt;`, or a lone `>`), alone or glued to
// the word that follows. A speaker dash is a `-` alone, or `- ` opening an event.
const MARK_ONLY = /^(?:>|&gt;)+$/;
const MARK_LEAD = /^(?:>>+|(?:&gt;){2,})\s*/;
const DASH_LEAD = /^-\s+/;

/**
 * The seg text without a speaker mark ('' when nothing is left). A mark inside
 * a word, and hyphens that belong to a word (`well-known`, `-5`), stay.
 * @param {string} text trimmed
 * @param {boolean} atStart no speech seg has come yet in this event
 */
function speakerStripped(text, atStart) {
  let t = text;
  if (MARK_ONLY.test(t)) return '';
  t = t.replace(MARK_LEAD, '');
  if (atStart) t = t.replace(DASH_LEAD, '');
  return t === '-' || MARK_ONLY.test(t) ? '' : t;
}

/**
 * Words from a YouTube json3 caption track. Sound tags (`[Music]`,
 * `[Applause]`) are dropped as in `wordsFromWhisper`, and so are speaker
 * marks (`>>`, a speaker dash); a dropped mark gives its time to no one. Each seg starts at
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
    let atStart = true;
    for (const seg of ev.segs) {
      const text = speakerStripped(typeof seg?.utf8 === 'string' ? seg.utf8.trim() : '', atStart);
      if (!text) continue;
      atStart = false;
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

const LINE_MAX_SEC = 8;
const PAUSE_SEC = 0.7;
const AROUND_SPAN_SEC = 30;

const minSec = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const sec2 = (s) => (Math.round(s * 100) / 100).toFixed(2);

/**
 * The words near a time, as the lines the agent reads to set a clip edge:
 * every word overlapping [around - span, around + span] (from clamped at 0),
 * grouped into lines of `[m:ss] text (start-end)`, the seconds exact to 0.01.
 * A line closes after a word ending a sentence, at a pause over 0.7 s, or once
 * it is 8 s long. Blank and malformed words are skipped; `words` need not be
 * sorted.
 * @param {Word[]} words
 * @param {number} around seconds
 * @param {number} [span] seconds each side, default 30
 * @returns {{ lines: string[], from: number, to: number }}
 */
export function wordsAround(words, around, span = AROUND_SPAN_SEC) {
  const from = Math.max(0, around - span);
  const to = around + span;
  const list = words
    .filter((x) => x && Number.isFinite(x.s) && Number.isFinite(x.e) && String(x.w ?? '').trim())
    .filter((x) => x.e > from && x.s < to)
    .sort((a, b) => a.s - b.s);
  const lines = [];
  let cur = null;
  const close = () => {
    if (cur) lines.push(`[${minSec(cur.s)}] ${cur.text.join(' ')} (${sec2(cur.s)}-${sec2(cur.e)})`);
    cur = null;
  };
  for (const x of list) {
    if (cur) {
      const sentenceEnd = /[.?!]["')\]]*$/.test(String(cur.last.w).trim());
      if (sentenceEnd || x.s - cur.last.e > PAUSE_SEC || x.s - cur.s >= LINE_MAX_SEC) close();
    }
    if (!cur) cur = { s: x.s, e: x.e, text: [], last: x };
    cur.text.push(String(x.w).trim());
    cur.e = Math.max(cur.e, x.e);
    cur.last = x;
  }
  close();
  return { lines, from, to };
}

const FIND_SPAN_SEC = 60;
const FIND_MIN_SCORE = 0.6;
// a word pair under this similarity counts as no match at all
const TOKEN_MIN_SIM = 0.5;
const EPS = 1e-9;

/**
 * The tokens a phrase is compared by: its words (split at white space),
 * lowercase, with everything but letters, digits and combining marks dropped
 * (`Don’t,` is `dont`, `Q&A` is `qa`, `5.5` is `55`); a word with nothing
 * left is no token.
 * @param {string} text
 * @returns {string[]}
 */
function tokensOf(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/u)
    .map((t) => t.replace(/[^\p{L}\p{N}\p{M}]+/gu, ''))
    .filter(Boolean);
}

/** Levenshtein distance. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 for the same token, less for a misspelling, 0 for a different word. */
function tokenSim(a, b) {
  if (a === b) return 1;
  const v = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  return v >= TOKEN_MIN_SIM ? v : 0;
}

/**
 * Where a quoted phrase is spoken: the run of words within [near - span,
 * near + span] (from clamped at 0) that best matches the phrase's words in
 * order, ignoring case, punctuation and apostrophes, and allowing a misspelt,
 * missing or extra word.
 *
 * A window's score is its best in-order pairing of phrase words with window
 * words (1 a pair for the same word, less for a misspelling, 0 for another
 * word) over the longer of the two. A window opens on a word that pairs, or
 * on as many unpaired words as the phrase has unpaired words before its first
 * pair (a word standing where the quote's first word would be); the same at
 * its end. The best score wins, then the window closest to `near`, then the
 * longer window. Blank, punctuation-only and malformed words are skipped;
 * `words` need not be sorted.
 * @param {Word[]} words
 * @param {string} phrase
 * @param {number} near seconds
 * @param {number} [span] seconds each side, default 60
 * @returns {{ s: number, e: number, match: string, score: number } | null}
 *   `s` the window's first word's start, `e` its last word's end, `match`
 *   those words as written; null when no window scores 0.6 or more
 */
export function findPhrase(words, phrase, near, span = FIND_SPAN_SEC) {
  const want = tokensOf(phrase);
  if (want.length === 0) throw new Error('the phrase has no words');
  const from = Math.max(0, near - span);
  const to = near + span;
  // only words with something to compare: a lone `-` or `♪` is no word
  const list = (Array.isArray(words) ? words : [])
    .filter((x) => x && Number.isFinite(x.s) && Number.isFinite(x.e) && typeof x.w === 'string')
    .filter((x) => x.e > from && x.s < to && tokensOf(x.w).length > 0)
    .sort((a, b) => a.s - b.s);
  const toks = [];
  list.forEach((x, wi) => {
    for (const t of tokensOf(x.w)) toks.push({ t, wi });
  });

  const m = want.length;
  const sim = want.map((p) => toks.map((x) => tokenSim(p, x.t)));
  const minLen = Math.max(1, Math.ceil(m * FIND_MIN_SCORE - EPS));
  const maxLen = Math.floor(m / FIND_MIN_SCORE + EPS);

  // Does the window toks[i .. i+len) keep its edges? cols[b][a] is the best
  // pairing of want[0..a) with the window's first b tokens.
  const edgesOk = (cols, i, len) => {
    let a = m;
    let b = len;
    const pairs = [];
    while (a > 0 && b > 0) {
      const v = cols[b][a];
      const pv = sim[a - 1][i + b - 1];
      if (pv > 0 && Math.abs(v - cols[b - 1][a - 1] - pv) <= EPS) {
        pairs.push([a - 1, b - 1]);
        a--;
        b--;
      } else if (Math.abs(v - cols[b - 1][a]) <= EPS) b--;
      else a--;
    }
    if (pairs.length === 0) return false;
    const [lastP, lastW] = pairs[0];
    const [firstP, firstW] = pairs.at(-1);
    return firstW <= firstP && len - 1 - lastW <= m - 1 - lastP;
  };

  let best = null;
  for (let i = 0; i < toks.length; i++) {
    const cols = [new Array(m + 1).fill(0)];
    for (let j = i; j < toks.length && j - i < maxLen; j++) {
      const prev = cols.at(-1);
      const col = [0];
      for (let a = 1; a <= m; a++) col[a] = Math.max(prev[a], col[a - 1], prev[a - 1] + sim[a - 1][j]);
      cols.push(col);
      const len = j - i + 1;
      if (len < minLen) continue;
      const score = col[m] / Math.max(m, len);
      if (score < FIND_MIN_SCORE - EPS || (best && score < best.score - EPS)) continue;
      const s = list[toks[i].wi].s;
      const e = list[toks[j].wi].e;
      const dist = near < s ? s - near : near > e ? near - e : 0;
      const better =
        !best ||
        score > best.score + EPS ||
        dist < best.dist - EPS ||
        (Math.abs(dist - best.dist) <= EPS && len > best.len);
      if (better && edgesOk(cols, i, len)) best = { score, dist, len, s, e, first: toks[i].wi, last: toks[j].wi };
    }
  }
  if (!best) return null;
  const match = list.slice(best.first, best.last + 1).map((x) => x.w.trim()).join(' ');
  return { s: best.s, e: best.e, match, score: Math.round(best.score * 100) / 100 };
}
