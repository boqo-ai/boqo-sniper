// Fetch: read a YouTube video's info and ONE caption track first (no video
// download), then later download only the picked sections, with one fallback
// to a whole download and local cuts. Everything runs through yt-dlp, ffmpeg
// and ffprobe with argument arrays (no shell).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { transcriptMarkdown, wordsFromJson3 } from './words.mjs';

/** @typedef {import('./picks.mjs').Pick} Pick */

export const FORMAT = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]';

const MAX_BUFFER = 64 * 1024 * 1024;
const PAD_SEC = 1;
const CUT_MARGIN_SEC = 2;
const SHORT_BELOW = 0.9;
const WHOLE_RETRY_MS = 5000;
const CONCURRENCY = 3;

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

/**
 * The one caption track to request, or null when the video has none.
 * Order: a manual track in the video's language (exact code first, then the
 * bare language, then a regional one), the automatic `<base>-orig` track, any
 * manual track, `en-orig`, any other `-orig` track.
 * @param {object} info yt-dlp -J output
 * @returns {{ kind: 'manual'|'auto', lang: string } | null}
 */
export function captionTrackOf(info) {
  const manual = trackKeys(info?.subtitles);
  const auto = trackKeys(info?.automatic_captions);
  const lang = typeof info?.language === 'string' && info.language ? info.language : null;

  if (lang) {
    const base = baseLang(lang);
    const same = manual.filter((k) => baseLang(k) === base);
    const pick = same.find((k) => k === lang) ?? same.find((k) => k === base) ?? same[0];
    if (pick) return { kind: 'manual', lang: pick };
    if (auto.includes(`${base}-orig`)) return { kind: 'auto', lang: `${base}-orig` };
  }
  if (manual.length) return { kind: 'manual', lang: manual[0] };
  if (auto.includes('en-orig')) return { kind: 'auto', lang: 'en-orig' };
  const anyOrig = auto.find((k) => k.endsWith('-orig'));
  return anyOrig ? { kind: 'auto', lang: anyOrig } : null;
}

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
 * A pick's section: one second each side, clamped to [0, duration].
 * @param {{s: number, e: number}} pick
 * @param {number} [duration]
 */
export function sectionBounds(pick, duration) {
  const e = pick.e + PAD_SEC;
  return { s: round3(Math.max(0, pick.s - PAD_SEC)), e: round3(Number.isFinite(duration) ? Math.min(duration, e) : e) };
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

const exec = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: MAX_BUFFER, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ');
        reject(new Error(err.code === 'ENOENT' ? `${file} is not installed or not on PATH` : `${file} failed: ${tail}`));
      } else resolve({ stdout, stderr });
    });
  });

/** The real yt-dlp, ffprobe and ffmpeg. */
export const realRun = {
  ytdlp: (args) => exec('yt-dlp', args),
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
 * Read the video info and ONE caption track; write `info.json`, and when
 * there are captions `words.json` and `transcript.md`, into `dir`.
 * @param {{ url: string, dir: string, run?: typeof realRun }} o
 * @returns {Promise<{id: string, title: string, duration: number, captions: 'manual'|'auto'|'none', chunks: number}>}
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
  const track = captionTrackOf(info);
  if (!track) return { ...head, captions: 'none', chunks: 0 };

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
  return { ...head, captions: track.kind, chunks: md.chunks };
}

// ---- sections

async function pool(n, items, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Download only the picked sections (1 s padding each side, 3 at a time).
 * If any comes back short or missing, download the whole video once and cut
 * the bad ones locally (the whole download gets one retry). Throws, naming both failures, when that fails too.
 * `offset` is where the pick starts inside its file.
 * @param {{ url: string, picks: Pick[], dir: string, duration?: number, run?: typeof realRun, retryMs?: number }} o
 * @returns {Promise<{ files: {pick: number, file: string, offset: number}[] }>}
 */
export async function fetchSections({ url, picks, dir, duration, run = realRun, retryMs = WHOLE_RETRY_MS }) {
  mkdirSync(dir, { recursive: true });
  const bounds = picks.map((p) => sectionBounds(p, duration));
  // yt-dlp skips a file that already exists, whatever range it holds
  picks.forEach((_, i) => rmSync(secFile(dir, i), { force: true }));

  const first = await pool(CONCURRENCY, picks, async (_, i) => {
    const b = bounds[i];
    const asked = round3(b.e - b.s);
    let error = null;
    try {
      await run.ytdlp(sectionArgs(url, b.s, b.e, join(dir, `sec-${i}`)));
    } catch (err) {
      error = msg(err);
    }
    const got = error ? null : await run.probe(secFile(dir, i));
    return { state: sectionResult({ asked, got }), asked, got, error };
  });

  const files = picks.map((p, i) => ({ pick: i, file: secFile(dir, i), offset: round3(p.s - bounds[i].s) }));
  const bad = first.map((r, i) => ({ r, i })).filter(({ r }) => r.state !== 'ok');
  if (bad.length === 0) return { files };

  const sectionWhy = bad
    .map(({ r, i }) => `pick ${i + 1} ${r.state}${r.error ? ` (${r.error})` : r.got === null ? '' : ` (${round3(r.got)} s of ${r.asked} s)`}`)
    .join('; ');

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
    }
  } catch (err) {
    throw new Error(`section download failed (${sectionWhy}); the whole-video fallback failed too (${msg(err)})`);
  } finally {
    rmSync(plan.wholeFile, { force: true });
  }
  return { files };
}
