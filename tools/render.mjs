#!/usr/bin/env node
// node tools/render.mjs --run <run> [--n 1,2,3 | --all | --first 10] [--brand <name>] [--src <file>] [--words <words.json>]
//   Renders clips of <run>/clips.json by their number `n` (engine/render.mjs, boqo's pipeline): `--first K` the rows
//   numbered 1 to K (after `clips order`, the first K in the pre-render order; the default is --first 10), `--n` the
//   numbers listed, `--all` every row. Each goes to <run>/out/clip-<nn>.mp4 with its thumbnail <run>/out/clip-<nn>.jpg,
//   and its row in clips.json gets `rendered: true`, `file`, `thumb`, `seconds`, `notes`, and the window as rendered
//   (`window: {start, end}` in the video's seconds, `cuts` its pause cuts in window seconds), written atomically
//   after each clip.
//   The video: the downloaded sections (<run>/sections.json from `fetch.mjs sections`, the clip's file by its place
//   in clips.json, as the panels read finds it), or `--src <file>`, the whole video or a local file. The words:
//   <run>/words.json unless --words. The brand: the kit named by --brand, else the default kit, else boqo's Default
//   template with no logo.
//   Prints one JSON line, {"rendered":[{"n","file","thumb","seconds","notes"}],"failed":[{"n","error"}]}: exit 0 when
//   nothing failed, 1 when a clip failed (the others still render). {"error":"..."} and exit 1 when nothing could
//   start.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { loadBlazeFace } from '../engine/blazeface.mjs';
import { defaultBrand, defaultBrandName, loadBrand } from '../engine/brand.mjs';
import { JOURNAL, selectRows, writeAtomic } from '../engine/order.mjs';
import { PanelsError, sourceOf } from '../engine/panels-read.mjs';
import { realExec, renderClip } from '../engine/render.mjs';

// The one JSON line and the exit code, carried to the end of main rather than printed with process.exit: once
// onnxruntime-node is loaded, process.exit() aborts the process on macOS (`libc++abi: ... mutex lock failed: Invalid
// argument`, seen 2026-11-16 on CI's macos-latest runner: the clip rendered and its line printed, the exit status was
// lost). Ending by itself, as tools/doctor.mjs does after loading it, is the intended way out.
class Stop extends Error {
  constructor(obj, code) {
    super(obj.error ?? 'stop');
    this.obj = obj;
    this.code = code;
  }
}
const say = (obj, code) => {
  throw new Stop(obj, code);
};
const fail = (msg) => say({ error: msg }, 1);

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${what} ${path}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what} ${path} is not valid JSON`);
  }
}

const VALUE_FLAGS = { '--run': 'run', '--n': 'n', '--first': 'first', '--brand': 'brand', '--src': 'src', '--words': 'words' };

function parse(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') {
      opt.all = true;
      continue;
    }
    const key = VALUE_FLAGS[a];
    if (!key) fail(a.startsWith('--') ? `unknown flag ${a}` : `unexpected argument ${a}`);
    if (i + 1 >= argv.length) fail(`${a} needs a value`);
    opt[key] = argv[++i];
  }
  return opt;
}

// The rows to render, by n, in n order.
function pick(record, opt) {
  try {
    return selectRows(record, opt);
  } catch (err) {
    return fail(err.message);
  }
}

// A path stored in clips.json: relative to the run, with forward slashes.
const stored = (run, abs) => relative(run, abs).split(sep).join('/');

async function main(argv) {
  const opt = parse(argv);
  if (opt.run === undefined) fail('--run <run folder> is required');
  const run = resolve(opt.run);
  const recordPath = join(run, 'clips.json');
  if (existsSync(join(run, JOURNAL))) fail('an interrupted order is pending: run clips.mjs order first, then render');
  const record = readJson(recordPath, 'clips.json');
  if (!record || !Array.isArray(record.clips)) fail('clips.json has no clips array');
  const rows = pick(record, opt);
  if (rows.length === 0) fail('no clip to render');

  const words = readJson(opt.words !== undefined ? resolve(opt.words) : join(run, 'words.json'), 'words file');
  if (!Array.isArray(words)) fail('the words file must hold an array of {w, s, e}');

  let brand;
  try {
    if (opt.brand !== undefined) brand = await loadBrand(opt.brand, { missingLogo: 'keep' });
    else if (await defaultBrandName()) brand = await loadBrand(undefined, { missingLogo: 'keep' });
    else brand = defaultBrand('default');
  } catch (err) {
    fail(err.message);
  }

  // The source of each row before any render starts, so a missing section stops the batch before it costs anything.
  const sources = new Map();
  for (const row of rows) {
    try {
      sources.set(row.n, sourceOf(run, record, row, opt.src));
    } catch (err) {
      fail(err instanceof PanelsError ? err.message : `clip ${row.n}: ${err.message}`);
    }
  }

  // The face model loads once for the batch. When it cannot load, each clip tries on its own and frames Fit with
  // the note that says why (engine/faces.mjs).
  let detector;
  try {
    detector = await loadBlazeFace();
  } catch {
    detector = undefined;
  }
  const sceneCutsCache = new Map();
  const rendered = [];
  const failed = [];
  for (const row of rows) {
    const at = sources.get(row.n);
    try {
      await coversClip(at, row);
      const r = await renderClip({ run, row, brand, sourceFile: at.file, offset: at.offset, words, sceneCutsCache, detector });
      // Written per clip, onto clips.json as it is now (a judgment recorded meanwhile stays), to the row with this n
      // and these edges.
      const now = readJson(recordPath, 'clips.json');
      const target = Array.isArray(now?.clips) ? now.clips.find((c) => c?.n === row.n && c.start === row.start && c.end === row.end) : undefined;
      if (!target) throw new Error('clips.json changed while it rendered (its row is gone or renumbered): run clips.mjs order, then render it again');
      Object.assign(target, {
        rendered: true,
        file: stored(run, r.file),
        thumb: stored(run, r.thumb),
        seconds: r.seconds,
        notes: r.notes,
        window: r.window,
        cuts: r.cuts,
      });
      writeAtomic(recordPath, JSON.stringify(now, null, 2) + '\n');
      rendered.push({ n: row.n, file: r.file, thumb: r.thumb, seconds: r.seconds, notes: r.notes });
    } catch (err) {
      failed.push({ n: row.n, error: err instanceof Stop ? err.obj.error : err.message });
    }
  }
  await detector?.release?.();
  say({ rendered, failed }, failed.length > 0 ? 1 : 0);
}

// A section file shorter than its clip is the wrong file for it (sections.json from another set of picks): refuse it
// rather than render other seconds under this clip's number.
async function coversClip(at, row) {
  const { stdout } = await realExec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', at.file]);
  const length = Number(stdout.trim());
  if (Number.isFinite(length) && length + 0.5 < at.offset + (row.end - row.start)) {
    throw new Error(`${at.file} holds ${length.toFixed(1)} s, too short for clip ${row.n} at ${at.offset} s: fetch its section again`);
  }
}

main(process.argv.slice(2))
  .then(
    () => null,
    (err) => (err instanceof Stop ? err : new Stop({ error: err.message }, 1)),
  )
  .then((stop) => {
    if (stop === null) return;
    process.stdout.write(JSON.stringify(stop.obj) + '\n');
    process.exitCode = stop.code;
  });
