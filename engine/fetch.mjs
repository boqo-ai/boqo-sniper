// Fetch: read a YouTube video's info and ONE caption track first (no video
// download), then later download only the picked sections, with one fallback
// to a whole download and local cuts. Everything runs through yt-dlp, ffmpeg
// and ffprobe with argument arrays (no shell). Viewer comments (best effort,
// for the selection request) come from `yt-dlp --write-comments`.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toolEnv } from './env.mjs';
import { transcriptMarkdown, wordsFromJson3 } from './words.mjs';
import { segmentsFromWords } from './segments.mjs';

/** @typedef {import('./picks.mjs').Pick} Pick */

export const FORMAT = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]';

const MAX_BUFFER = 64 * 1024 * 1024;
const PAD_SEC = 1;
const CUT_MARGIN_SEC = 2;
const SHORT_BELOW = 0.9;
const WHOLE_RETRY_MS = 5000;
// A caption track with 40 s or more without a word is partial. Measured (2026-11-16) on the five evaluation runs' real
// words.json: the longest gap in four of them was 31 s or less (20, 15, 31 s), the Rothenburg track (a video in two
// languages, the track covering one) had 42, 66 and 74 s holes over the other language's speech. A 205 s hole in the
// fifth (an olive-mill vlog) is flagged too: the track alone cannot tell silence from missing speech.
const PARTIAL_GAP_SEC = 40;
const RETRY_PAD_SEC = 3;
const SECTION_RETRY_MS = 3000;
const COMMENTS_TIMEOUT_MS = 60000;
const COMMENTS_MAX = 200;

const BASE = ['--js-runtimes', 'node', '--no-playlist'];
const round3 = (x) => Math.round(x * 1000) / 1000;

// ---- pure arg builders

/** @param {string} url */
export const infoArgs = (url) => [...BASE, '-J', url];

/**
 * One caption track only: a second, translated one came back HTTP 429.
 * The file lands at `<dir>/captions.<lang>.json3`.
 * @param {string} url
 * @param {{kind: 'manual'|'auto', lang: string}} track
 * @param {string} dir
 */
export const captionArgs = (url, track, dir) => [
  ...BASE,
  '--skip-download',
  track.kind === 'manual' ? '--write-subs' : '--write-auto-subs',
  '--sub-langs',
  track.lang,
  '--sub-format',
  'json3',
  '-o',
  join(dir, 'captions.%(ext)s'),
  url,
];

/**
 * The top-level comments, most relevant first. Hosted reads two pages of 100
 * from the YouTube Data API (relevance order); yt-dlp's equivalent is
 * `max_comments=<total>,<parents>,<replies>,<replies per thread>,<depth>`
 * with a depth of 1 (no replies, so the reply counts are 0) and
 * `comment_sort=top`. The comments come back inside the `-J` info dict.
 * @param {string} url
 */
export const commentArgs = (url) => [
  ...BASE,
  '--skip-download',
  '--write-comments',
  '--extractor-args',
  `youtube:max_comments=${COMMENTS_MAX},${COMMENTS_MAX},0,0,1;comment_sort=top`,
  '-J',
  url,
];

/**
 * Download seconds [s, e] only. `outBase` has no extension.
 * @param {string} url
 * @param {number} s
 * @param {number} e
 * @param {string} outBase
 */
export const sectionArgs = (url, s, e, outBase) => [
  ...BASE,
  '-f',
  FORMAT,
  '--merge-output-format',
  'mp4',
  '--download-sections',
  `*${round3(s)}-${round3(e)}`,
  '-o',
  `${outBase}.%(ext)s`,
  url,
];

/** @param {string} url @param {string} outBase no extension */
export const wholeArgs = (url, outBase) => [...BASE, '-f', FORMAT, '--merge-output-format', 'mp4', '-o', `${outBase}.%(ext)s`, url];

// ---- pure decisions

const hasTrack = (map, key) => Array.isArray(map?.[key]) && map[key].length > 0;
const trackKeys = (map) => Object.keys(map ?? {}).filter((k) => k !== 'live_chat' && hasTrack(map, k));
const baseLang = (l) => String(l).split(/[-_]/)[0].toLowerCase();

// Language codes YouTube uses for one spoken language, or for two that are one language when spoken. Measured
// (2026-11-16, yt-dlp -J on an Urdu-speech video): `language` was `ur`, and the speech track YouTube made from the
// audio was `hi-orig` (there was no `ur-orig`).
const SAME_SPEECH = [['hi', 'ur'], ['he', 'iw'], ['id', 'in'], ['jv', 'jw'], ['no', 'nb', 'nn'], ['tl', 'fil']];
const sameSpeech = (a, b) => a === b || SAME_SPEECH.some((g) => g.includes(a) && g.includes(b));

// A track whose every URL carries `tlang=` is YouTube translating another track, never the speech.
const isTranslation = (entries) => entries.length > 0 && entries.every((f) => typeof f?.url === 'string' && /[?&]tlang=/.test(f.url));
const speechTracks = (map) => trackKeys(map).filter((k) => !isTranslation(map[k]));

/**
 * The one caption track to request, and a note when the video has caption tracks and none was taken. Only a
 * track of the speech itself is taken, never a translation: hosted transcribes the audio, so a caption in
 * another language than the audio would put the wrong words on the clips. Measured (2026-11-16): an Urdu-speech
 * video had `language: "ur"`, an automatic `en-orig` whose text was an English translation of the speech (no
 * `tlang` in its URL, so the URL cannot tell it from the speech), and `hi-orig`, the real speech track. So
 * `en-orig` is the speech only when the video's language is English: a track is the speech when its language is
 * the video's language, or the same spoken language (`hi` for `ur`).
 *
 * Known language, in order: the automatic `<language>-orig` track (word-timed; then a cognate's), a manual
 * track in that language (exact code first, then the bare language, then a regional one). Nothing else: a
 * track in another language is a translation. Unknown language: the one `-orig` track when there is exactly
 * one, else the one manual track when there is exactly one; with two, which is the speech cannot be told.
 * Whisper then.
 * @param {object} info yt-dlp -J output
 * @returns {{ track: { kind: 'manual'|'auto', lang: string } | null, note: string | null }}
 */
export function captionPlan(info) {
  const manual = speechTracks(info?.subtitles);
  const orig = speechTracks(info?.automatic_captions).filter((k) => k.endsWith('-orig'));
  const lang = typeof info?.language === 'string' && info.language ? info.language : null;
  const take = (kind, key) => ({ track: { kind, lang: key }, note: null });
  const none = (why) => ({ track: null, note: manual.length || orig.length ? why : null });

  if (lang) {
    const base = baseLang(lang);
    const pickOrig = orig.find((k) => baseLang(k) === base) ?? orig.find((k) => sameSpeech(baseLang(k), base));
    if (pickOrig) return take('auto', pickOrig);
    const same = manual.filter((k) => baseLang(k) === base);
    const pick = same.find((k) => k === lang) ?? same.find((k) => k === base) ?? same[0];
    if (pick) return take('manual', pick);
    return none(`no caption track is in the video's spoken language (${lang}); the others are translations`);
  }
  if (orig.length === 1) return take('auto', orig[0]);
  if (orig.length === 0 && manual.length === 1) return take('manual', manual[0]);
  return none('the video has caption tracks, but which one is its spoken language cannot be told');
}

/**
 * The one caption track to request, or null when the video has none (or none that is its speech): see
 * `captionPlan`.
 * @param {object} info yt-dlp -J output
 * @returns {{ kind: 'manual'|'auto', lang: string } | null}
 */
export const captionTrackOf = (info) => captionPlan(info).track;

/**
 * Most-replayed heat as `{s, e, v}` (v is 0-1 already); [] when absent.
 * @param {object} info
 */
export function heatOf(info) {
  if (!Array.isArray(info?.heatmap)) return [];
  return info.heatmap
    .filter((h) => h && Number.isFinite(h.start_time) && Number.isFinite(h.end_time) && Number.isFinite(h.value))
    .map((h) => ({ s: h.start_time, e: h.end_time, v: h.value }));
}

/**
 * @param {{ asked: number, got: number|null }} o seconds asked and probed
 * @returns {'ok'|'short'|'failed'} short = under 90% of what was asked
 */
export function sectionResult({ asked, got }) {
  if (got === null || got === undefined || !Number.isFinite(got)) return 'failed';
  return got < asked * SHORT_BELOW ? 'short' : 'ok';
}

/**
 * A pick's section: one second each side (`pad`), clamped to [0, duration].
 * @param {{s: number, e: number}} pick
 * @param {number} [duration]
 * @param {number} [pad]
 */
export function sectionBounds(pick, duration, pad = PAD_SEC) {
  const e = pick.e + pad;
  return { s: round3(Math.max(0, pick.s - pad)), e: round3(Number.isFinite(duration) ? Math.min(duration, e) : e) };
}

const secFile = (dir, i) => join(dir, `sec-${i}.mp4`);

/**
 * The fallback: download the whole video once, then cut every pick locally.
 * A cut starts 2 s before the padded start (a copy cut lands on a keyframe)
 * and that margin is added to `offset`. Cut args use relative names; run
 * ffmpeg with `cwd` = `dir`.
 * @param {string} url
 * @param {Pick[]} picks
 * @param {string} dir
 * @param {number} [duration]
 */
export function planFallback(url, picks, dir, duration) {
  const cuts = picks.map((p, i) => {
    const b = sectionBounds(p, duration);
    const start = round3(Math.max(0, b.s - CUT_MARGIN_SEC));
    const asked = round3(b.e - start);
    return {
      pick: i,
      file: secFile(dir, i),
      offset: round3(p.s - start),
      asked,
      args: ['-y', '-v', 'error', '-ss', String(start), '-i', 'whole.mp4', '-t', String(asked), '-c', 'copy', `sec-${i}.mp4`],
    };
  });
  return { whole: wholeArgs(url, join(dir, 'whole')), wholeFile: join(dir, 'whole.mp4'), cuts };
}

// ---- runners (injectable for tests)

/**
 * yt-dlp's comments as the hosted filter reads them (`RawComment`, text and
 * likes): top-level ones only (`parent` is "root"; a comment with no `parent`
 * counts as top level), those with a text, at most 200. yt-dlp's `text` is plain
 * text and `like_count` its likes (a missing or non-numeric one is 0). Null
 * when the info has no comment list.
 * @param {object} info yt-dlp -J output read with --write-comments
 * @returns {{ text: string, likes: number }[] | null}
 */
export function commentsFromInfo(info) {
  if (!Array.isArray(info?.comments)) return null;
  const out = [];
  for (const c of info.comments) {
    if (out.length === COMMENTS_MAX) break;
    if (!c || typeof c.text !== 'string') continue;
    if (c.parent !== undefined && c.parent !== 'root') continue;
    out.push({ text: c.text, likes: Number.isFinite(c.like_count) ? c.like_count : 0 });
  }
  return out;
}

const exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: MAX_BUFFER, env: toolEnv(), ...opts }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ');
        reject(new Error(err.code === 'ENOENT' ? `${file} is not installed or not on PATH` : `${file} failed: ${tail}`));
      } else resolve({ stdout, stderr });
    });
  });

/** The real yt-dlp, ffprobe and ffmpeg. */
export const realRun = {
  ytdlp: (args, opts) => exec('yt-dlp', args, opts),
  ffmpeg: (args, cwd) => exec('ffmpeg', args, { cwd }),
  /** Duration in seconds, or null when the file is missing or unreadable. */
  probe: async (file) => {
    if (!existsSync(file)) return null;
    try {
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
      const d = Number.parseFloat(stdout);
      return Number.isFinite(d) ? d : null;
    } catch {
      return null;
    }
  },
};

const msg = (err) => (err instanceof Error ? err.message : String(err));

// ---- info

/**
 * The stretches of the video, `minSec` or longer, that the caption words do not cover: between two words, before
 * the first, and after the last when the video's length is known. A track with such a hole is partial: it may be
 * missing speech (another language, or a part YouTube did not caption), which only the track cannot tell from
 * silence.
 * @param {{ s: number, e: number }[]} words
 * @param {number} [duration]
 * @param {number} [minSec]
 * @returns {{ start: number, end: number }[]}
 */
export function captionGaps(words, duration, minSec = PARTIAL_GAP_SEC) {
  if (!Array.isArray(words) || words.length === 0) return [];
  const gaps = [];
  const add = (from, to) => {
    if (to - from >= minSec) gaps.push({ start: Math.round(from * 10) / 10, end: Math.round(to * 10) / 10 });
  };
  let edge = 0;
  for (const w of words) {
    add(edge, w.s);
    edge = Math.max(edge, w.e);
  }
  if (Number.isFinite(duration)) add(edge, duration);
  return gaps;
}

/**
 * Read the video info and ONE caption track; write `info.json`, and when
 * there are captions `words.json`, `segments.json`, `transcript.md` and `transcript-language.txt`, into `dir`.
 * `note` is set when the video has caption tracks and none was its speech (whisper is the way on). `captions` is
 * `partial` when the track has a stretch of 40 s or more without a word (`captionGaps`): the files are written as for
 * `manual` or `auto` (`source` says which), and `gaps` lists the stretches, `{start, end}` in seconds.
 * @param {{ url: string, dir: string, run?: typeof realRun }} o
 * @returns {Promise<{id: string, title: string, duration: number, captions: 'manual'|'auto'|'partial'|'none', chunks: number, note?: string, source?: 'manual'|'auto', gaps?: {start: number, end: number}[]}>}
 */
export async function fetchInfo({ url, dir, run = realRun }) {
  mkdirSync(dir, { recursive: true });
  const { stdout } = await run.ytdlp(infoArgs(url));
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('yt-dlp did not return video info');
  }
  writeFileSync(join(dir, 'info.json'), JSON.stringify(info));

  const head = { id: info.id, title: info.title, duration: info.duration };
  // the transcript language follows the chosen track, so an earlier run's file must not outlive this fetch
  rmSync(join(dir, 'transcript-language.txt'), { force: true });
  const { track, note } = captionPlan(info);
  if (!track) return { ...head, captions: 'none', chunks: 0, ...(note ? { note } : {}) };

  for (const f of readdirSync(dir)) if (/^captions\..*\.json3$/.test(f)) rmSync(join(dir, f));
  await run.ytdlp(captionArgs(url, track, dir));
  const file = readdirSync(dir).find((f) => /^captions\..*\.json3$/.test(f));
  if (!file) throw new Error(`yt-dlp wrote no ${track.lang} caption file`);
  let words;
  try {
    words = wordsFromJson3(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  } catch {
    throw new Error(`the ${track.lang} caption file is not valid json3`);
  }
  if (words.length === 0) return { ...head, captions: 'none', chunks: 0 };

  const md = transcriptMarkdown(words, { heat: heatOf(info) });
  writeFileSync(join(dir, 'words.json'), JSON.stringify(words));
  writeFileSync(join(dir, 'transcript.md'), md.text);
  writeFileSync(join(dir, 'segments.json'), JSON.stringify(segmentsFromWords(words, { source: track.kind })));
  // the language of the words (`hi-orig` is Hindi), which select-request prints, not info.json's `language`
  writeFileSync(join(dir, 'transcript-language.txt'), `${track.lang.replace(/-orig$/, '')}\n`);
  const gaps = captionGaps(words, info.duration);
  if (gaps.length > 0) return { ...head, captions: 'partial', source: track.kind, gaps, chunks: md.chunks };
  return { ...head, captions: track.kind, chunks: md.chunks };
}

/**
 * Viewer comments for the selection request, best effort: write
 * `<dir>/comments.json` (`[{text, likes}]`, top level, at most 200) and return
 * `{ file, count }`, or null on ANY failure (yt-dlp failing, no comments in
 * the info, a slow connection: `timeoutMs` aborts the run). Never throws. An
 * older comments.json is removed first, so a failed read never leaves a stale
 * one for the request to pick up.
 * @param {{ url: string, dir: string, run?: typeof realRun, timeoutMs?: number }} o
 * @returns {Promise<{ file: string, count: number } | null>}
 */
export async function fetchComments({ url, dir, run = realRun, timeoutMs = COMMENTS_TIMEOUT_MS }) {
  const file = join(dir, 'comments.json');
  const abort = new AbortController();
  let timer;
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(file, { force: true });
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`yt-dlp comments took longer than ${timeoutMs} ms`));
      }, timeoutMs);
    });
    const { stdout } = await Promise.race([run.ytdlp(commentArgs(url), { signal: abort.signal }), timedOut]);
    const comments = commentsFromInfo(JSON.parse(stdout));
    if (comments === null) return null;
    writeFileSync(file, JSON.stringify(comments));
    return { file, count: comments.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- sections

/**
 * Download only the picked sections, one at a time (1 s padding each side). YouTube rate-limits parallel
 * requests from one address, and the skill's rule is one yt-dlp call at a time. A section that comes back
 * short or missing is tried once more, alone, with 3 s of padding after a short pause; only a section still
 * bad then makes the whole video download once and be cut locally (the whole download gets one retry). Throws,
 * naming both failures, when that fails too. Every bad section's state goes to stderr.
 * `offset` is where the pick starts inside its file; `s` and `e` are the video seconds the file holds (its 0 is
 * video second `s`), by which the render and the panels read find a clip's section (engine/panels-read.mjs
 * `sourceOf`): by time, never by the pick's place, which `clips order` changes.
 * @param {{ url: string, picks: Pick[], dir: string, duration?: number, run?: typeof realRun, retryMs?: number, sectionRetryMs?: number }} o
 * @returns {Promise<{ files: {pick: number, file: string, offset: number, s: number, e: number}[] }>}
 */
export async function fetchSections({ url, picks, dir, duration, run = realRun, retryMs = WHOLE_RETRY_MS, sectionRetryMs = SECTION_RETRY_MS }) {
  mkdirSync(dir, { recursive: true });
  const bounds = picks.map((p) => sectionBounds(p, duration));
  // yt-dlp skips a file that already exists, whatever range it holds
  picks.forEach((_, i) => rmSync(secFile(dir, i), { force: true }));

  const attempt = async (i, b) => {
    rmSync(secFile(dir, i), { force: true });
    const asked = round3(b.e - b.s);
    let error = null;
    try {
      await run.ytdlp(sectionArgs(url, b.s, b.e, join(dir, `sec-${i}`)));
    } catch (err) {
      error = msg(err);
    }
    const got = error ? null : await run.probe(secFile(dir, i));
    return { state: sectionResult({ asked, got }), asked, got, error };
  };
  const describe = (r) => `${r.state}${r.error ? ` (${r.error})` : r.got === null ? '' : ` (${round3(r.got)} s of ${r.asked} s)`}`;

  const first = [];
  for (let i = 0; i < picks.length; i++) first.push(await attempt(i, bounds[i]));

  // one more try per bad section, alone, with more padding
  const why = new Map();
  for (let i = 0; i < picks.length; i++) {
    if (first[i].state === 'ok') continue;
    const was = describe(first[i]);
    process.stderr.write(`boqo-clips: section ${i + 1} ${was}; trying it once more\n`);
    await new Promise((r) => setTimeout(r, sectionRetryMs));
    const wider = sectionBounds(picks[i], duration, RETRY_PAD_SEC);
    const again = await attempt(i, wider);
    if (again.state === 'ok') {
      bounds[i] = wider;
      first[i] = again;
    } else {
      why.set(i, `${was}; again ${describe(again)}`);
    }
  }

  const files = picks.map((p, i) => ({ pick: i, file: secFile(dir, i), offset: round3(p.s - bounds[i].s), s: bounds[i].s, e: bounds[i].e }));
  const bad = first.map((r, i) => ({ r, i })).filter(({ r }) => r.state !== 'ok');
  if (bad.length === 0) return { files };

  const sectionWhy = bad.map(({ i }) => `pick ${i + 1} ${why.get(i)}`).join('; ');

  process.stderr.write(`boqo-clips: ${bad.length} section(s) came back short or failed, downloading the whole video once\n`);
  const plan = planFallback(url, picks, dir, duration);
  try {
    rmSync(plan.wholeFile, { force: true });
    try {
      await run.ytdlp(plan.whole);
    } catch {
      // measured: a 403 on the first whole download that went through minutes later
      await new Promise((r) => setTimeout(r, retryMs));
      await run.ytdlp(plan.whole);
    }
    if (!existsSync(plan.wholeFile)) throw new Error('no whole.mp4 was written');
    for (const { i } of bad) {
      const cut = plan.cuts[i];
      await run.ffmpeg(cut.args, dir);
      const got = await run.probe(cut.file);
      if (sectionResult({ asked: cut.asked, got }) !== 'ok') throw new Error(`the local cut for pick ${i + 1} came out ${got === null ? 'missing' : 'short'}`);
      files[i].offset = cut.offset;
      files[i].s = round3(picks[i].s - cut.offset);
    }
  } catch (err) {
    throw new Error(`section download failed (${sectionWhy}); the whole-video fallback failed too (${msg(err)})`);
  } finally {
    rmSync(plan.wholeFile, { force: true });
  }
  return { files };
}
