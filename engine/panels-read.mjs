// The stream panels read, on the person's machine (spec §7.5 step 6): the frames the agent looks at, and the store
// for what it answers. The skill's own file: every rule it calls is a copy of boqo's, held by a golden
// (engine/boqo/panels-*.mjs, probe.mjs); this file holds none of its own.
//
// Hosted reads a stream in two steps, and so does the skill:
//   1. the select-time probe: on a landscape source of at least 480 lines, 6 frames at the top clips' midpoints
//      answer one question (is this a game stream?). `probeFrames` writes the frames, `recordProbe` stores the answer
//      as `panelProbe` in clips.json;
//   2. when the probe says yes, each rendered clip gets a panels read: `readFrames` writes the frames and the user turn,
//      `recordRead` validates the answer the way hosted's `parseReadChunk` and `mergeReadChunks` do and stores it as
//      the clip's `panels` (a hosted `PanelDecision`), which engine/boqo/plan-shots.mjs plans from at render.
//
// Density, the one deliberate difference from hosted (spec §7.5 step 6; R2, the body's 12 and not C4's 20): hosted
// samples every 1.5 s up to 40 frames at 960 px; the skill samples every 3 s up to 12 frames at 640 px, so a run's
// images stay bounded. The evaluation measures the effect.
//
// `exec(command, args, { timeoutMs }) -> Promise<{ stdout, stderr }>` is injected (rejecting when the command fails),
// as engine/window.mjs does; the default runs the real ffmpeg and ffprobe.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { toolEnv } from './env.mjs';
import { JOURNAL, writeAtomic } from './order.mjs';
import { clipToWindowSec, cutsDurationSec } from './boqo/cut-map.mjs';
import { PanelDecision, PanelProbe, PanelSample } from './boqo/panels.mjs';
import { enoughFrames, frameArgs, readFrameFile, sampleTimes } from './boqo/panels-frames.mjs';
import { panelsEligible, panelsSourceEligible } from './boqo/panels-plan.mjs';
import { PANELS_PROMPT_VERSION, probeTurn, readTurn, wordsText } from './boqo/panels-prompt.mjs';
import { PANEL_PROBE_FRAMES, PANEL_PROBE_FRAME_WIDTH, parseProbeSize, probeSizeArgs, probeTimes } from './boqo/probe.mjs';
import { detectShots } from './shots.mjs';
import { prepareWindow } from './window.mjs';

/** 1 frame every 3 s inside each shot (hosted: PANELS_STEP_SEC 1.5). */
export const PANELS_READ_EVERY_SEC = 3;
/** At most 12 frames a clip, in one read (hosted: RENDER_PANELS_MAX_FRAMES 40; 12 is hosted's own frames-per-request). */
export const PANELS_READ_MAX = 12;
/** 640 px wide, the height following the source's aspect (hosted: 960). */
export const PANELS_FRAME_WIDTH = 640;
/** The skill renders 1080x1920: the output half of `panelsEligible` (portrait). */
export const PANELS_OUTPUT = { width: 1080, height: 1920 };
/** The render set (R13): the rows with `n` 1 to 10, which after `clips order` is `renderSet(clips, 10)`. */
export const RENDER_FIRST = 10;
/** Recorded as the decision's `model`: the person's agent, not a model name the skill can know. */
export const PANELS_MODEL = 'agent';
/** parseReadChunk's: a returned time further than this from every time sent is not one of ours. Labels print to 0.01 s. */
export const TIME_TOLERANCE_SEC = 0.05;
/** Seconds one ffmpeg frame grab may take. */
const GRAB_TIMEOUT_MS = 60_000;

const defaultExec = (command, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = execFile(command, args, { env: toolEnv(), maxBuffer: 64 << 20, windowsHide: true, timeout: options.timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolvePromise({ stdout, stderr });
    });
    // stdin closed, as every other ffmpeg call of the skill: a prompt (an output that exists, without -y) ends at EOF
    // instead of waiting.
    child.stdin?.end();
  });

/** A message for the person, thrown by this file and printed by tools/panels.mjs. */
export class PanelsError extends Error {}

const two = (n) => String(n).padStart(2, '0');

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PanelsError(`cannot read ${what}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PanelsError(`${what} is not valid JSON`);
  }
}

/** <run>/clips.json: the run's record, one row for each clip (§7.3). */
export function loadRecord(run) {
  const record = readJson(join(run, 'clips.json'), 'clips.json');
  if (record === null || typeof record !== 'object' || !Array.isArray(record.clips)) throw new PanelsError('clips.json has no clips array');
  return record;
}

const saveRecord = (run, record) => writeAtomic(join(run, 'clips.json'), `${JSON.stringify(record, null, 2)}\n`);

// An interrupted `clips order` writes its stored record over clips.json when it is finished (engine/order.mjs
// finishJournal), and renumbers the clips: a probe or read recorded before that would be lost, and frames read now
// would carry an old number. render and stranger refuse the same way.
function refusePending(run) {
  if (existsSync(join(run, JOURNAL))) throw new PanelsError('an interrupted order is pending: run clips.mjs order first, then run this again');
}

/** The rows of the render set, by `n`. */
export function renderRows(record) {
  return record.clips.filter((r) => Number.isInteger(r.n) && r.n >= 1 && r.n <= RENDER_FIRST).sort((a, b) => a.n - b.n);
}

/** Seconds a section's recorded bounds may miss a clip's edges by: `fetch.mjs` rounds them to the millisecond. */
export const SECTION_TOLERANCE_SEC = 0.01;

/**
 * Where a clip lives on disk: the file holding it and where the clip starts inside that file. A downloaded section
 * (`<run>/sections.json`, `{files:[{pick, file, offset, s, e}]}` from `fetch.mjs sections`, `s`..`e` the video
 * seconds the file holds, its 0 at `s`) is found by TIME: the first entry whose `s`..`e` covers the row's
 * `start`..`end`, the clip starting `start - s` seconds into it. Never by the pick's number: `clips order`
 * re-sorts clips.json, and a fetch may hold any subset of the rows, so a place would name another clip's video.
 * The render reads nothing past `end` (settle-end only looks back from it, `SETTLE_LOOK_SEC` before; the extract
 * stops at the settled end), so covering `start`..`end` is enough. A whole file given as `src` starts the clip at
 * its own start. `record` is unused and kept for the callers' shape.
 */
export function sourceOf(run, record, row, src) {
  if (src !== undefined) return { file: resolve(src), offset: row.start };
  const sectionsPath = join(run, 'sections.json');
  if (!existsSync(sectionsPath)) throw new PanelsError('the run has no sections.json and no --src was given: there is no video to read frames from');
  const sections = readJson(sectionsPath, 'sections.json');
  const entries = (Array.isArray(sections?.files) ? sections.files : []).filter((f) => f && typeof f.file === 'string');
  const timed = entries.filter((f) => Number.isFinite(f.s) && Number.isFinite(f.e));
  if (timed.length === 0) {
    throw new PanelsError('sections.json does not say which seconds each file holds (an older fetch): re-fetch sections');
  }
  const entry = timed.find((f) => f.s <= row.start + SECTION_TOLERANCE_SEC && f.e >= row.end - SECTION_TOLERANCE_SEC);
  if (!entry) throw new PanelsError(`no section in sections.json holds clip ${row.n} (${row.start}-${row.end} s): fetch its section`);
  return { file: resolve(run, entry.file), offset: Math.max(0, Math.round((row.start - entry.s) * 1000) / 1000) };
}

/** The source's frame size as displayed, by ffprobe, or throws. */
async function frameSize(file, exec) {
  const { stdout } = await exec('ffprobe', probeSizeArgs(file), { timeoutMs: GRAB_TIMEOUT_MS });
  const size = parseProbeSize(stdout);
  if (size === null) throw new PanelsError(`the video size of ${file} could not be read`);
  return size;
}

const emptyDir = (dir) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
};

async function grabFrame(exec, file, atSec, width, outPath) {
  await exec('ffmpeg', frameArgs({ path: file, atSec, width, outPath }), { timeoutMs: GRAB_TIMEOUT_MS });
  return readFrameFile(outPath);
}

// ---- the probe --------------------------------------------------------------------------------------------------

/**
 * Writes the probe's frames, or says the source is not eligible, or says a probe is already recorded (once a run).
 * Returns `{ eligible: false, why }`, `{ eligible: true, recorded: true, isStream, gameTitle }` or
 * `{ eligible: true, frames, width, dir, turn }`.
 */
export async function probeFrames({ run, src, exec = defaultExec }) {
  const record = loadRecord(run);
  const stored = PanelProbe.safeParse(record.panelProbe);
  if (stored.success) return { eligible: true, recorded: true, isStream: stored.data.isStream, gameTitle: stored.data.gameTitle };

  const rows = renderRows(record);
  if (rows.length === 0) throw new PanelsError('clips.json has no clip with n 1 to 10');
  const first = sourceOf(run, record, rows[0], src);
  const size = await frameSize(first.file, exec);
  if (!panelsSourceEligible(size)) {
    return { eligible: false, why: size.width > size.height ? `the source is ${size.height} lines, under 480` : 'the source is not landscape' };
  }

  // probeTimes filters clips with no length; the same rows, in the same order, own the midpoints.
  const clips = rows.map((r) => ({ startSec: r.start, endSec: r.end }));
  const owners = rows.filter((r) => r.end > r.start).slice(0, PANEL_PROBE_FRAMES);
  const times = probeTimes(clips, PANEL_PROBE_FRAMES);
  if (times.length === 0 || times.length !== owners.length) throw new PanelsError('no clip has a length to read a frame from');

  const dir = join(run, 'panels', 'probe');
  emptyDir(dir);
  const frames = [];
  for (const [i, mid] of times.entries()) {
    const at = sourceOf(run, record, owners[i], src);
    const file = join(dir, `probe-${i + 1}.jpg`);
    if ((await grabFrame(exec, at.file, at.offset + (mid - owners[i].start), PANEL_PROBE_FRAME_WIDTH, file)) === null) {
      throw new PanelsError(`no frame could be read at ${mid.toFixed(2)} s`);
    }
    frames.push({ file });
  }
  const turn = join(dir, 'turn.txt');
  writeFileSync(turn, `${probeTurn({ frames })}\n`);
  return { eligible: true, frames: frames.length, width: PANEL_PROBE_FRAME_WIDTH, dir, turn };
}

const ProbeWire = z.object({ isStream: z.boolean(), gameTitle: z.string().nullable().optional() });

/** Stores the agent's probe answer, `{isStream, gameTitle}`, as `panelProbe` in clips.json. */
export function recordProbe({ run, file }) {
  refusePending(run);
  const answer = ProbeWire.safeParse(readJson(file, 'the probe file'));
  if (!answer.success) {
    throw new PanelsError(`the probe file must be {"isStream": true|false, "gameTitle": "<name>"|null}: ${answer.error.issues[0]?.message ?? ''}`.trim());
  }
  const probe = PanelProbe.parse({ version: 1, isStream: answer.data.isStream, gameTitle: answer.data.gameTitle ?? null });
  const record = loadRecord(run);
  record.panelProbe = probe;
  saveRecord(run, record);
  return { ok: true, isStream: probe.isStream, gameTitle: probe.gameTitle };
}

// ---- a clip's read ----------------------------------------------------------------------------------------------

/** The skill's `{ w, s, e }` words as the `{ word, start, end }` hosted's functions read. */
const hostedWords = (words) => words.map((x) => ({ word: x.w, start: x.s, end: x.e }));

/**
 * Writes clip `n`'s frames and the user turn (frames labelled `Frame at {t:.2f} s:`, with what the author says), or
 * says why it asks nothing. The clip's window is made the way the render makes it (prepareWindow, then the shots),
 * and frames are taken from that window, so a frame's time is a time in the clip as rendered. Each frame's label is
 * its SOURCE second (`row.start` plus the window time behind the clip time), which is what hosted stores, so the read
 * outlives a later trim or cut.
 * Returns `{ asked: false, reason }` or `{ asked: true, n, frames, shots, width, dir, turn }`.
 */
export async function readFrames({ run, n, src, wordsFile, exec = defaultExec }) {
  refusePending(run);
  const record = loadRecord(run);
  const row = record.clips.find((r) => r.n === n);
  if (row === undefined) throw new PanelsError(`clips.json has no clip ${n}`);
  const probe = PanelProbe.safeParse(record.panelProbe);
  // Hosted asks only when the stored probe says stream; no probe means every clip renders as today.
  if (!probe.success) return { asked: false, reason: 'no stream probe is recorded; run probe-frames and probe-record first' };
  if (!probe.data.isStream) return { asked: false, reason: 'the probe says this is not a game stream' };

  const at = sourceOf(run, record, row, src);
  const size = await frameSize(at.file, exec);
  if (!panelsEligible(size, PANELS_OUTPUT)) {
    return { asked: false, reason: `the source is ${size.width}x${size.height}: panels need a landscape source of at least 480 lines` };
  }

  const words = readJson(wordsFile ?? join(run, 'words.json'), 'the words file');
  if (!Array.isArray(words)) throw new PanelsError('the words file must hold an array of {w, s, e}');
  // The window is prepared in the clock of its file; the words are in the source's, so they move by the same offset.
  const shift = at.offset - row.start;
  const inFile = words.map((x) => ({ w: x.w, s: x.s + shift, e: x.e + shift }));

  const dir = join(run, 'panels', `clip-${two(n)}`);
  emptyDir(dir);
  const length = row.end - row.start;
  const win = await prepareWindow({ source: at.file, startSec: at.offset, endSec: at.offset + length, words: inFile, dir, exec });
  const { shots } = await detectShots({ exec }, { windowPath: win.file, dir, durationSec: win.endSec - win.startSec - cutsDurationSec(win.cuts) });

  const times = sampleTimes(shots, PANELS_READ_EVERY_SEC, PANELS_READ_MAX);
  if (times.length === 0) throw new PanelsError('the clip has no frames to read');
  const frames = [];
  for (const [i, t] of times.entries()) {
    const file = join(dir, `frame-${two(i + 1)}.jpg`);
    // A frame ffmpeg wrote nothing for is skipped (a seek at the very end does it, exiting 0).
    if ((await grabFrame(exec, win.file, t, PANELS_FRAME_WIDTH, file)) === null) continue;
    frames.push({ file, sourceSec: row.start + clipToWindowSec(t, win.cuts) });
  }
  if (!enoughFrames(frames.length, times.length)) throw new PanelsError(`only ${frames.length} of ${times.length} frames could be extracted`);

  const text = wordsText(hostedWords(words), { startSec: row.start, cuts: win.cuts, shots });
  const turn = join(dir, 'turn.txt');
  writeFileSync(turn, `${readTurn({ frames, words: text })}\n`);
  writeFileSync(join(dir, 'frames.json'), `${JSON.stringify({ n, startSec: row.start, frames }, null, 2)}\n`);
  return { asked: true, n, frames: frames.length, shots: shots.length, width: PANELS_FRAME_WIDTH, dir, turn };
}

const ReadWire = z.object({
  content: z.enum(['stream_with_game', 'screen_no_game', 'other']),
  gameTitle: z.string().nullable(),
  samples: z.array(z.unknown()),
});

/**
 * Validates the agent's read of clip `n` and stores it as the row's `panels`, a hosted `PanelDecision`
 * (`{version: 1, status: 'ok', promptVersion, model: 'agent', content, gameTitle, samples, trigger: 'first'}`).
 * The rules are hosted's `parseReadChunk` and `mergeReadChunks` (panels/anthropic.ts) for one request:
 * - the envelope is `{content, gameTitle, samples}`, or the whole read is refused;
 * - a sample that breaks `PanelSample` (a box outside 0..1, more than three cameras) is dropped;
 * - a sample's time is set to the nearest frame label when it is within 0.05 s of one, else dropped; a second answer
 *   for a frame already answered is dropped; samples are kept in time order;
 * - the read is refused when fewer than half of the frames sent were answered.
 * Returns `{ ok: true, n, content, gameTitle, samples, frames, dropped }`.
 */
export function recordRead({ run, n, file }) {
  refusePending(run);
  const record = loadRecord(run);
  const row = record.clips.find((r) => r.n === n);
  if (row === undefined) throw new PanelsError(`clips.json has no clip ${n}`);
  const framesPath = join(run, 'panels', `clip-${two(n)}`, 'frames.json');
  if (!existsSync(framesPath)) throw new PanelsError(`clip ${n} has no frames: run read-frames first`);
  const sent = readJson(framesPath, 'frames.json').frames.map((f) => f.sourceSec);

  const envelope = ReadWire.safeParse(readJson(file, 'the read file'));
  if (!envelope.success) {
    throw new PanelsError(`the read file must be {"content", "gameTitle", "samples"}: ${envelope.error.issues[0]?.message ?? ''}`.trim());
  }
  const used = new Set();
  const samples = [];
  for (const raw of envelope.data.samples) {
    const sample = PanelSample.safeParse(raw);
    if (!sample.success) continue;
    const s = sample.data;
    let nearest = -1;
    for (const [i, t] of sent.entries()) {
      if (nearest === -1 || Math.abs(t - s.sourceSec) < Math.abs(sent[nearest] - s.sourceSec)) nearest = i;
    }
    if (nearest === -1 || Math.abs(sent[nearest] - s.sourceSec) > TIME_TOLERANCE_SEC || used.has(nearest)) continue;
    used.add(nearest);
    samples.push({ ...s, sourceSec: sent[nearest] });
  }
  samples.sort((a, b) => a.sourceSec - b.sourceSec);
  if (samples.length * 2 < sent.length) {
    throw new PanelsError(`the panel read answered for ${samples.length} of ${sent.length} frames; answer once for every frame, giving its time as its label states it`);
  }
  const decision = PanelDecision.parse({
    version: 1,
    status: 'ok',
    promptVersion: PANELS_PROMPT_VERSION,
    model: PANELS_MODEL,
    content: envelope.data.content,
    gameTitle: envelope.data.gameTitle,
    samples,
    trigger: 'first',
  });
  row.panels = decision;
  saveRecord(run, record);
  return {
    ok: true,
    n,
    content: decision.content,
    gameTitle: decision.gameTitle,
    samples: samples.length,
    frames: sent.length,
    dropped: envelope.data.samples.length - samples.length,
  };
}

/** The frame files of a folder, for tests and cleanups. */
export const framesIn = (dir) => readdirSync(dir).filter((f) => /^(frame|probe)-\d+\.jpg$/.test(f)).sort();
