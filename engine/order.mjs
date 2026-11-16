// The order of a run's clips and the chat summary (§6 step 6, §7.4). Hosted's "Ranked" order (engine/boqo/rank.mjs)
// is applied to the rows of <run>/clips.json:
//   - the pre-render order is Ranked with the judgment held at its neutral value 3: outcome `fails` last, then
//     pct + 0.5, then score, then start. The first 10 in it are rendered;
//   - the final order is Ranked over the rendered clips with their stranger judgments, then the unrendered ones in the
//     pre-render order.
// `n` is a clip's place in that order and `clip-<nn>.mp4` is named by it, so `reorderRun` renumbers the record and
// renames the files (and a thumbnail next to one) to match, going through temporary names so a swap loses nothing.
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { rankClips } from './boqo/rank.mjs';
import { scoreBand, scoreToGrade } from './boqo/score-grade.mjs';
import { handbookChips } from './boqo/handbook-outcomes.mjs';

/** How many clips a run renders by default (P2). */
export const RENDER_FIRST = 10;

/** The judgment the pre-render order holds every clip at, so the term does not move it. */
export const NEUTRAL_JUDGMENT = 3;

/** Frames a stranger judgment reads (§7.4); only the stand-alone chip's reason line quotes it, and chat does not show that. */
const JUDGMENT_FRAMES = 12;

// A ClipRow's replay is {pct, mean}; hosted's rank reads the whole Replay blob through parseReplay.
const replayBlob = (replay) =>
  replay && typeof replay === 'object'
    ? { v: 1, pct: replay.pct, pctRaw: null, heat: replay.mean ?? null, discounted: true, bins: 0, factor: 1, introBins: 0, chapterBins: 0, sha: null }
    : null;

// A ClipRow's judgment is {overall, why, annotation} or null; hosted's rank reads a Stranger.
const strangerBlob = (judgment) =>
  judgment && typeof judgment === 'object' ? { judgment: judgment.overall, why: judgment.why ?? '', frames: JUDGMENT_FRAMES } : null;

const rankInput = (row, judgment) => ({
  score: row.score,
  startSec: row.start,
  replay: replayBlob(row.replay),
  stranger: strangerBlob(judgment),
  standaloneTest: row.standalone ?? null,
  row,
});

const rankRows = (rows, judgmentOf) => rankClips(rows.map((row) => rankInput(row, judgmentOf(row)))).map((x) => x.row);

/** Ranked with `judgment = 3` for every clip. Returns a new array of the same rows. */
export function preRenderOrder(clips) {
  return rankRows(clips, () => ({ overall: NEUTRAL_JUDGMENT }));
}

/** Ranked over the rendered clips with their judgments, then the unrendered ones in pre-render order. */
export function finalOrder(clips) {
  const rendered = clips.filter((c) => c.rendered === true);
  const rest = clips.filter((c) => c.rendered !== true);
  return [...rankRows(rendered, (c) => c.judgment ?? null), ...preRenderOrder(rest)];
}

/** The clip numbers rendered by default: the first `n` in the pre-render order. */
export function renderSet(clips, n = RENDER_FIRST) {
  return preRenderOrder(clips).slice(0, n).map((c) => c.n);
}

const clock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// A B C D for hook, flow, standalone and value: the axes in the order the record keeps them.
const lettersOf = (axes) => ['hook', 'flow', 'standalone', 'value'].map((k) => scoreToGrade(axes?.[k] ?? 0)).join(' ');

/**
 * One line a rendered clip, in the final order, then `+N not rendered` when some are not:
 *   `1 · 87 exceptional · A B C D · Replayed · top 3% · Keeps watching · 4/5 · Needs context · <title> · 0:42`
 * `Replayed` appears only when the video has a heatmap (the row's replay is not null), `Keeps watching` only when a
 * judgment is stored, and the stand-alone chip (`Opens on context` / `Needs context`) only when hosted shows one. Every
 * chip is hosted's own `handbookChips` text. The clip's place in the order is the rank. The length is the rendered file's
 * (`seconds`, after its pauses were cut) when the render stored it.
 */
export function summaryLines(record) {
  const order = finalOrder(record.clips);
  const lines = [];
  let unrendered = 0;
  order.forEach((c, i) => {
    if (c.rendered !== true) {
      unrendered++;
      return;
    }
    const chips = handbookChips({ startSec: c.start, replay: replayBlob(c.replay), stranger: strangerBlob(c.judgment), standaloneTest: c.standalone ?? null });
    lines.push(
      [`${i + 1}`, `${c.score} ${scoreBand(c.score)}`, lettersOf(c.axes), ...chips.map((x) => x.text), c.title, clock(Number.isFinite(c.seconds) ? c.seconds : c.end - c.start)].join(' · '),
    );
  });
  if (unrendered > 0) lines.push(`+${unrendered} not rendered`);
  return lines;
}

const THUMB_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
const nn = (n) => String(n).padStart(2, '0');

// The files of one rendered row: the video, and the thumbnail named by row.thumb or, failing that, one beside the video
// with the same stem. Each is {from, ext, field} with absolute paths.
function filesOf(run, row) {
  if (typeof row.file !== 'string' || row.file === '') return [];
  const abs = (p) => (isAbsolute(p) ? p : resolve(run, p));
  const video = abs(row.file);
  const out = [{ from: video, field: 'file', stored: row.file }];
  if (typeof row.thumb === 'string' && row.thumb !== '') {
    out.push({ from: abs(row.thumb), field: 'thumb', stored: row.thumb });
  } else {
    const stem = join(dirname(video), basename(video, extname(video)));
    for (const ext of THUMB_EXTS) if (existsSync(stem + ext)) out.push({ from: stem + ext, field: null, stored: null });
  }
  return out;
}

// The renames are a plan that is written down first and then carried out to the end, so a crash at any point is finished
// by the next run instead of undone. A file that is mid-move waits as `<its dir>/.order-tmp.<its own name>`, findable by name.
// The journal `<run>/.order-tmp.journal.json` holds the moves, the phase (1: out of the way, 2: into place) and the final
// clips.json text. Every step of finishing it checks the disk first (a temp file is placed once, a record written the same
// bytes twice), so running it again, or after a crash inside it, changes nothing it already did. The journal and clips.json
// are written through a temporary name and a rename, so neither is ever half there.
const TMP = '.order-tmp.';
export const JOURNAL = `${TMP}journal.json`;

// Exported: the stranger record (tools/stranger.mjs) and the panels read (engine/panels-read.mjs) write clips.json the same way.
export function writeAtomic(path, text, rename = renameSync) {
  const next = join(dirname(path), `.order-new.${basename(path)}`);
  writeFileSync(next, text);
  rename(next, path);
}

// The journal, or null when it is absent, empty, truncated or not a journal at all (restoreByName then does the work).
function readJournal(run) {
  let j;
  try {
    j = JSON.parse(readFileSync(join(run, JOURNAL), 'utf8'));
  } catch {
    return null;
  }
  const ok =
    j && (j.phase === 1 || j.phase === 2) && typeof j.record === 'string' && Array.isArray(j.moves) &&
    j.moves.every((m) => m && typeof m.from === 'string' && typeof m.tmp === 'string' && typeof m.to === 'string');
  return ok ? j : null;
}

// Carry a written plan to the end. Returns the refusals (a target held by a file that is not ours), empty when done.
function finishJournal(run, journal, { rename, rm }) {
  const { moves } = journal;
  if (journal.phase === 1) {
    // Out of the way. Nothing is placed in phase 1, so a file still at `from` is one that has not moved yet.
    for (const m of moves) if (existsSync(m.from) && !existsSync(m.tmp)) rename(m.from, m.tmp);
    writeAtomic(join(run, JOURNAL), JSON.stringify({ ...journal, phase: 2 }), rename);
  }
  // Into place. A missing temp file was placed already.
  const errors = [];
  for (const m of moves) {
    if (!existsSync(m.tmp)) continue;
    if (existsSync(m.to)) errors.push(`${basename(m.to)} is already there; ${basename(m.tmp)} is left from an interrupted order`);
  }
  if (errors.length > 0) return errors;
  for (const m of moves) if (existsSync(m.tmp)) rename(m.tmp, m.to);
  writeAtomic(join(run, 'clips.json'), journal.record, rename);
  rm(join(run, JOURNAL));
  return [];
}

// Temp files with no usable journal: back to the name they carry, unless a different file has taken it.
function restoreByName(dirs, rename) {
  const errors = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(TMP) || name === JOURNAL) continue;
      const original = join(dir, name.slice(TMP.length));
      if (existsSync(original)) errors.push(`${name.slice(TMP.length)} is already there; ${name} is left from an interrupted order and is the file that was moved away from that name`);
      else rename(join(dir, name), original);
    }
  }
  return errors;
}

/**
 * Put `<run>/clips.json` in the final order: `n` becomes the place in it (the array follows), and every rendered clip's
 * file (and thumbnail) is renamed to `clip-<nn><ext>` for its new `n`. Two clips that swap are moved through temporary
 * names. Nothing is touched if a file is missing or a target would overwrite a file that is not moving. A run that was
 * interrupted is finished first, to the order it had planned (see the journal above), so every file is under its final
 * name before this one plans. `rename` and `rm` are injectable for tests.
 * @returns {{ ok: false, errors: string[] } | { ok: true, clips: number, rendered: number, renamed: number }}
 */
export function reorderRun(run, { rename = renameSync, rm = (p) => rmSync(p, { force: true }) } = {}) {
  const file = join(run, 'clips.json');
  const journal = readJournal(run);
  if (journal) {
    const refused = finishJournal(run, journal, { rename, rm });
    if (refused.length > 0) return { ok: false, errors: refused };
  }
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`cannot read clips.json: ${err.code ?? err.message}`] };
  }
  if (!record || !Array.isArray(record.clips)) return { ok: false, errors: ['clips.json has no clips array'] };

  if (!journal) {
    const dirs = new Set([run]);
    for (const row of record.clips) for (const f of filesOf(run, row)) dirs.add(dirname(f.from));
    const leftover = restoreByName(dirs, rename);
    if (leftover.length > 0) return { ok: false, errors: leftover };
    if (existsSync(join(run, JOURNAL))) rm(join(run, JOURNAL)); // an unusable one
  }

  const ordered = finalOrder(record.clips);
  const moves = [];
  const errors = [];
  ordered.forEach((row, i) => {
    const n = i + 1;
    if (row.rendered !== true) return;
    for (const f of filesOf(run, row)) {
      if (!existsSync(f.from)) {
        if (f.field === 'file') errors.push(`clip ${row.n}: ${row.file} is not there`);
        continue;
      }
      const name = `clip-${nn(n)}${extname(f.from)}`;
      const to = join(dirname(f.from), name);
      if (to !== f.from) moves.push({ ...f, to, row, name, tmp: join(dirname(f.from), `${TMP}${basename(f.from)}`) });
    }
  });
  const moving = new Set(moves.map((m) => m.from));
  for (const m of moves) if (existsSync(m.to) && !moving.has(m.to)) errors.push(`${basename(m.to)} is already there and is not one of the clips`);
  if (errors.length > 0) return { ok: false, errors };

  for (const m of moves) {
    // the stored path keeps its own folder and separators; only the file name changes
    if (m.field !== null) m.row[m.field] = m.stored.slice(0, m.stored.length - basename(m.stored).length) + m.name;
  }
  ordered.forEach((row, i) => {
    row.n = i + 1;
  });
  record.clips = ordered;
  const text = JSON.stringify(record, null, 2) + '\n';
  const summary = { ok: true, clips: ordered.length, rendered: ordered.filter((c) => c.rendered === true).length, renamed: moves.length };
  if (moves.length === 0) {
    writeAtomic(file, text, rename);
    return summary;
  }
  writeAtomic(join(run, JOURNAL), JSON.stringify({ phase: 1, moves: moves.map((m) => ({ from: m.from, tmp: m.tmp, to: m.to })), record: text }), rename);
  const refused = finishJournal(run, { phase: 1, moves, record: text }, { rename, rm });
  return refused.length > 0 ? { ok: false, errors: refused } : summary;
}
