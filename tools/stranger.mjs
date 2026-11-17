#!/usr/bin/env node
// node tools/stranger.mjs frames --clip <clip.mp4> --dir <out dir> [--run <run dir> --n <clip number>]
// node tools/stranger.mjs record --run <run dir> --n <clip number> --file <annotation.json>
//   The hosted "stranger" judgment (apps/worker/src/stranger/handler.ts, at the pin in engine/boqo/PIN), with the
//   person's agent as the model.
//   frames  writes the frames of the rendered clip, 1 every 5 s at 360 px wide (`fps=1/5,scale=360:-2`), thinned to
//           at most 12, as <dir>/k01.jpg, k02.jpg, ...; and <dir>/transcript.txt, the clip's transcript (at most
//           6,000 characters); and <dir>/turn.txt, the user turn in order (each frame's label, then the image, then
//           the closing text block). --run and --n (the clip's row in <run>/clips.json, <run>/segments.json for the
//           lines) give the transcript; without them transcript.txt is empty. Prints {"frames":n,"turn":"<path>"}.
//   record  checks the agent's annotation (<file>, the 20 fields of hosted's AnnotationSchema) and stores
//           `judgment: {overall, why, annotation}` in clip <n>'s row of <run>/clips.json (a rendered clip only), `overall` from
//           overall_quality_judgment (1..5) and `why` from one_line_why, as hosted's order reads them. Prints
//           {"ok":true,"n":n,"overall":o}, or {"ok":false,"errors":[...]} (exit 1) and changes nothing.
// Exit 1 with {"error":"..."} (frames) or {"ok":false,"errors":[...]} (record) on failure.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JOURNAL, writeAtomic } from '../engine/order.mjs';
import { toolEnv } from '../engine/env.mjs';
import { AnnotationSchema } from '../engine/boqo/stranger.mjs';
import { extractFrames, frameLabel } from '../engine/boqo/stranger-frames.mjs';
import { strangerContent, strangerTranscript } from '../engine/boqo/stranger-prompt.mjs';

// The hosted worker's STRANGER_MAX_FRAMES default (apps/worker/src/stranger/config.ts).
const MAX_FRAMES = 12;

const say = (obj, code) => {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
};
const failFrames = (msg) => say({ error: msg }, 1);
const failRecord = (errors) => say({ ok: false, errors }, 1);

// The subprocess seam extractFrames takes: resolves {stdout, stderr}, rejects on a bad exit or a missing binary.
function exec(cmd, args, { timeoutMs } = {}) {
  return new Promise((resolveP, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: toolEnv() });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' ? `${cmd} was not found on PATH (it comes with ffmpeg)` : `${cmd} could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolveP({ stdout, stderr });
      else reject(Object.assign(new Error(`${cmd} failed (exit ${code}): ${stderr.trim().split('\n').slice(-4).join(' | ')}`), { stderr }));
    });
  });
}

// The container's duration, as hosted's probeVideo reads it (format.duration); null when there is none.
function durationOf(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-of', 'json', '-show_entries', 'format=duration', file], { encoding: 'utf8', env: toolEnv() });
  if (r.error || r.status !== 0) return null;
  try {
    const d = Number(JSON.parse(r.stdout).format?.duration);
    return d > 0 ? d : null;
  } catch {
    return null;
  }
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { err: `cannot read ${what} ${path}: ${err.code ?? err.message}` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { err: `${what} ${path} is not valid JSON` };
  }
}

function parse(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--') || !allowed.includes(k.slice(2))) return { err: `unknown argument ${k}` };
    if (i + 1 >= argv.length) return { err: `${k} needs a value` };
    out[k.slice(2)] = argv[++i];
  }
  return { opt: out };
}

const clipNumber = (v) => (/^[1-9][0-9]*$/.test(String(v)) ? Number(v) : null);

async function frames(argv) {
  const { opt, err } = parse(argv, ['clip', 'dir', 'run', 'n']);
  if (err) failFrames(err);
  if (!opt.clip || !opt.dir) failFrames('usage: stranger.mjs frames --clip <clip.mp4> --dir <out dir> [--run <run dir> --n <clip number>]');
  if ((opt.run === undefined) !== (opt.n === undefined)) failFrames('--run and --n go together');
  const clip = resolve(opt.clip);
  const dir = resolve(opt.dir);
  if (!existsSync(clip)) failFrames(`no such clip: ${clip}`);

  // The row's window and the run's segments, for the transcript.
  let transcript = '';
  if (opt.run !== undefined) {
    const n = clipNumber(opt.n);
    if (n === null) failFrames('--n must be a clip number (1, 2, ...)');
    const run = resolve(opt.run);
    const rec = readJson(join(run, 'clips.json'), 'clips.json');
    if (rec.err) failFrames(rec.err);
    const row = Array.isArray(rec.value?.clips) ? rec.value.clips.find((c) => c?.n === n) : undefined;
    if (!row) failFrames(`clips.json has no clip ${n}`);
    const segs = readJson(join(run, 'segments.json'), 'segments.json');
    if (segs.err) failFrames(segs.err);
    if (!Array.isArray(segs.value)) failFrames('segments.json must hold an array');
    // The window as rendered (tools/render.mjs stores it: the settled end, the pause cuts), so each line is stamped on
    // the file's own clock, as hosted's `clipTimelineFromRow` and `renderStartSec ?? startSec` do. The skill
    // renders no hook. A row rendered before the render stored them reads as the window as picked, uncut.
    const window = row.window && Number.isFinite(row.window.start) && Number.isFinite(row.window.end) ? row.window : { start: row.start, end: row.end };
    const cuts = Array.isArray(row.cuts) ? row.cuts : [];
    transcript = strangerTranscript({
      segments: segs.value,
      timeline: { originSec: window.start, cuts, hook: null },
      windowStartSec: window.start,
      windowEndSec: window.end,
    });
  }

  const durationSec = durationOf(clip);
  if (durationSec === null) failFrames('the rendered clip could not be probed');

  mkdirSync(dir, { recursive: true });
  // The extraction's own k001.jpg.. go in a folder of their own; the thinned ones are then named k01.. in dir.
  const work = join(dir, '.stranger-work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work);
  let picked;
  let problem = null;
  try {
    picked = await extractFrames(exec, clip, work, MAX_FRAMES);
    if (picked.files.length === 0) {
      problem = 'no keyframes were extracted from the rendered clip';
    } else {
      for (const name of readdirSync(dir)) if (/^k\d+\.jpg$/.test(name)) rmSync(join(dir, name));
      picked.files.forEach((f, i) => copyFileSync(f, join(dir, `k${String(i + 1).padStart(2, '0')}.jpg`)));
    }
  } catch (e) {
    // A clip too short for one frame at 1 every 5 s writes nothing: ffmpeg 8 then exits 234 (its mjpeg encoder never
    // opens), earlier ones exit 0 with no file. Both are "no frames", as hosted's empty list is.
    problem = /Nothing was written into output file|Output file is empty/.test(e.stderr ?? '')
      ? 'no keyframes were extracted from the rendered clip'
      : e.message;
  }
  if (problem !== null) {
    rmSync(work, { recursive: true, force: true });
    failFrames(problem);
  }
  rmSync(work, { recursive: true, force: true });

  // The user turn, from hosted's strangerContent: the image blocks are named by their file.
  const names = picked.files.map((_, i) => `k${String(i + 1).padStart(2, '0')}.jpg`);
  const blocks = strangerContent(
    picked.files.map((_, i) => ({ label: frameLabel(i, picked.total, picked.files.length), jpeg: Buffer.from(names[i]) })),
    durationSec,
    transcript,
  );
  const turn = blocks
    .map((b) => (b.type === 'text' ? b.text : `[image: ${Buffer.from(b.source.data, 'base64').toString()}]`))
    .join('\n');
  writeFileSync(join(dir, 'transcript.txt'), transcript);
  writeFileSync(join(dir, 'turn.txt'), turn + '\n');
  say({ frames: picked.files.length, turn: join(dir, 'turn.txt') }, 0);
}

function record(argv) {
  const { opt, err } = parse(argv, ['run', 'n', 'file']);
  if (err) failRecord([err]);
  if (!opt.run || !opt.n || !opt.file) failRecord(['usage: stranger.mjs record --run <run dir> --n <clip number> --file <annotation.json>']);
  const n = clipNumber(opt.n);
  if (n === null) failRecord(['--n must be a clip number (1, 2, ...)']);
  const run = resolve(opt.run);

  const ann = readJson(resolve(opt.file), 'annotation file');
  if (ann.err) failRecord([ann.err]);
  const parsed = AnnotationSchema.safeParse(ann.value);
  if (!parsed.success) {
    const pathOf = (p) => (p.length === 0 ? 'annotation' : p.map((x) => (typeof x === 'number' ? `[${x}]` : String(x))).join('.'));
    failRecord(parsed.error.issues.map((i) => `${pathOf(i.path)}: ${i.message}`));
  }

  // A pending order carries the whole of clips.json in its journal and would write it over this judgment.
  if (existsSync(join(run, JOURNAL))) failRecord(['an interrupted order is pending: run clips.mjs order first, then record again']);
  const file = join(run, 'clips.json');
  const rec = readJson(file, 'clips.json');
  if (rec.err) failRecord([rec.err]);
  const row = Array.isArray(rec.value?.clips) ? rec.value.clips.find((c) => c?.n === n) : undefined;
  if (!row) failRecord([`clips.json has no clip ${n}`]);
  // A judgment is of the rendered file: an unrendered clip has none to judge, and the final order ranks rendered clips only.
  if (row.rendered !== true) failRecord([`clip ${n} is not rendered: render it first (render.mjs --run <run> --n ${n})`]);

  row.judgment = {
    overall: parsed.data.overall_quality_judgment,
    why: parsed.data.one_line_why,
    annotation: parsed.data,
  };
  writeAtomic(file, JSON.stringify(rec.value, null, 2) + '\n');
  say({ ok: true, n, overall: row.judgment.overall }, 0);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'frames') await frames(rest);
else if (cmd === 'record') record(rest);
else failFrames('usage: stranger.mjs frames|record ...');
