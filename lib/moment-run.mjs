// A moment through the Clips path (spec §7.7), as hosted runs a stream moment: the window the watcher cut (the
// `windowSec` ending at peak + 30 s) is an ordinary Clips run, its video the whole source. Not part of the vendored
// engine: every rule here is the engine's (tools/asr.mjs, select-request, select-check, clips order, the panels read,
// renderClip, the stranger judgment); this file only puts them in the moment's order and spends the session's image
// budget (lib/vision-budget.mjs). tools/moment.mjs is its CLI.
//
// The run is `<home>/boqo-sniper/clips/<channel folder>/<moment name>/` (`<clips>` in SKILL.md):
//   moment.json      where the moment and its session are, the brand, the moment's meta
//   info.json        {duration, title}: the window's length gives the target (clipTargetFor: 300 s is 5)
//   sections.json    one section, the window itself, `s` 0 to `e` its length
//   words.json, segments.json, select-request.md, select-options.json, selection.json (the agent's), clips.json
//   state.json       what the flow has done, and the read it waits for
//   out/clip-<nn>.mp4 and .jpg; done.json, the moment's result once it is over
//   overlapped.json  the clips dropped before render because an earlier moment of the session already made them
//
// startMoment: whisper, segments, the request. stepMoment, called again and again: the check and the pre-render
// order, the stream probe (once a session: `<session>/panels-probe.json`), each clip's panels read, the renders (one a
// call, at most 10, the `presence` subject rule), each clip's stranger judgment, the final order, the summary and the
// runs.md line. A step that needs the agent's eyes says so and waits for the answer file; the next step records it.
// A read the hour's budget cannot pay for is not asked: the clip reuses the session's last panels boxes
// (`<session>/panels-last.json`) with the focus on the game panel's centre, takes the neutral judgment 3, and the
// moment's runs.md line ends `· no read`.
//
// One deviation from hosted, named: hosted makes each moment its own project and clips both of two moments whose
// windows overlap (two moments under 270 s apart share footage), so the same few seconds can come out, and under an
// `auto` rule be posted, twice. Here a clip that overlaps a clip the session already made from an earlier moment by
// more than hosted's MAX_CLIP_OVERLAP_RATIO is dropped before render (stepMoment, overlapped.json), and the request
// says where those clips are, so the agent selects around them.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBlazeFace } from "../engine/blazeface.mjs";
import { defaultBrand, defaultBrandName, loadBrand } from "../engine/brand.mjs";
import { toolEnv } from "../engine/env.mjs";
import { NEUTRAL_JUDGMENT, reorderRun, summaryLines, writeAtomic } from "../engine/order.mjs";
import { loadRecord, probeFrames, readFrames, recordProbe, recordRead, renderRows, sourceOf } from "../engine/panels-read.mjs";
import { renderClip } from "../engine/render.mjs";
import { PanelDecision } from "../engine/boqo/panels.mjs";
import { PANELS_PROMPT_VERSION } from "../engine/boqo/panels-prompt.mjs";
import { durationOf } from "./moment.mjs";
import { runsLine } from "./runs-line.mjs";
import { readSessionSettings, sniperHome, visionFile } from "./session.mjs";
import { visionBudget } from "./vision-budget.mjs";

const TOOLS = fileURLToPath(new URL("../tools/", import.meta.url));

/** Every clip of the window is rendered, at most 10 (spec §7.7): the render set, n 1 to 10 after the pre-render order. */
export const MOMENT_RENDER_MAX = 10;
/** A reused read's samples, every 1.5 s across the clip (hosted's PANELS_STEP_SEC), so every shot finds one. */
const REUSE_STEP_SEC = 1.5;
/** Marks a reused read in clips.json: the model field of a PanelDecision. */
export const REUSED_MODEL = "reused";

export class MomentError extends Error {}

const two = (n) => String(n).padStart(2, "0");

function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new MomentError(`cannot read ${file}: ${err.code ?? err.message}`);
  }
}

const writeJson = (file, value) => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

/** Where a moment's folder sits: `<session>/moments/<name>`; its clips go to `<home>/boqo-sniper/clips/<channel folder>/<name>`. */
export function momentPaths(momentDir) {
  const moment = path.resolve(momentDir);
  const moments = path.dirname(moment);
  if (path.basename(moments) !== "moments") throw new MomentError(`not a moment folder (it sits in no moments/ folder): ${moment}`);
  const session = path.dirname(moments);
  const channelFolder = path.basename(path.dirname(session));
  const name = path.basename(moment);
  return { moment, session, channelFolder, name, run: path.join(sniperHome(), "clips", channelFolder, name) };
}

/**
 * The default way to run one of the shared tools: `node tools/<name> ...args`, one JSON line back. Resolves
 * `{code, out}`, `out` the parsed last line of stdout (null when it is not JSON). Its stderr passes through.
 */
export function runTool(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(TOOLS, name), ...args], {
      env: toolEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (err) => reject(new MomentError(`${name} could not start: ${err.message}`)));
    child.on("close", (code) => {
      const last = stdout.trim().split("\n").at(-1) ?? "";
      let out = null;
      try {
        out = JSON.parse(last);
      } catch {}
      resolve({ code, out });
    });
  });
}

/** whisper on the window, by the shared tools/asr.mjs: words.json and segments.json in the run. */
async function whisper({ video, run, tool }) {
  const r = await tool("asr.mjs", [video, "--out", path.join(run, "words.json")]);
  if (r.code !== 0 || !r.out || r.out.error) throw new MomentError(r.out?.error ?? `asr.mjs exited ${r.code}`);
  return r.out;
}

// ---- start ------------------------------------------------------------------------------------------------------

/**
 * The moment's run up to the selection request. Returns `{run, write: "selection", request, answer, target,
 * segments}`, or, when whisper heard nothing to select from, the moment's end (`{done: true, clips: [], ...}`).
 * Run again on a started moment, it answers the same without redoing the work.
 * `asr({video, run})` replaces whisper (tests); `tool` replaces the tool runner.
 */
export async function startMoment({ moment: momentDir, brand = null, asr, tool = runTool }) {
  const p = momentPaths(momentDir);
  const video = path.join(p.moment, "video.mp4");
  const meta = readJson(path.join(p.moment, "meta.json"));
  const done = readJson(path.join(p.run, "done.json"), null);
  if (done) return done;
  const request = path.join(p.run, "select-request.md");
  const answer = path.join(p.run, "selection.json");
  const started = readJson(path.join(p.run, "moment.json"), null);
  if (started && fs.existsSync(request)) {
    return { run: p.run, write: "selection", request, answer, target: started.target, segments: started.segments };
  }
  if (!fs.existsSync(video)) throw new MomentError(`the moment has no video.mp4: ${p.moment}`);
  fs.mkdirSync(p.run, { recursive: true });

  const duration = durationOf(video);
  // A stream project has no video context in hosted's request (videoContextOf: youtube only); the title is the
  // record's, as hosted titles a moment's project `<channel> — <moment title>`.
  writeJson(path.join(p.run, "info.json"), { duration: Math.round(duration), title: `${meta.channel ?? p.channelFolder} — ${meta.title ?? ""}` });
  writeJson(path.join(p.run, "sections.json"), { files: [{ pick: null, file: video, offset: 0, s: 0, e: Math.round(duration * 1000) / 1000 }] });

  if (asr) await asr({ video, run: p.run });
  else await whisper({ video, run: p.run, tool });
  const segments = readJson(path.join(p.run, "segments.json"), []);
  const settings = await readSessionSettings(p.session);
  const base = { moment: p.moment, session: p.session, channelFolder: p.channelFolder, name: p.name, brand, meta };
  if (!Array.isArray(segments) || segments.length === 0) {
    writeJson(path.join(p.run, "moment.json"), { ...base, target: 0, segments: 0 });
    return finish(p.run, { reason: "no speech" });
  }

  const args = ["--run", p.run];
  if (settings.prompt) args.push("--prompt", settings.prompt);
  const r = await tool("select-request.mjs", args);
  if (r.code !== 0 || !r.out || r.out.error) throw new MomentError(r.out?.error ?? `select-request.mjs exited ${r.code}`);
  // The deviation from hosted (the file's head): one line after hosted's request, where this session's clips already are.
  const spans = madeSpansIn(sessionClips({ session: p.session, channelFolder: p.channelFolder, exclude: p.name }), windowStart(meta), duration);
  if (spans.length > 0) {
    const where = spans.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}`).join(", ");
    fs.appendFileSync(
      request,
      `\nAlready clipped in this session, from an earlier moment: ${where} s of this video. A clip that overlaps one of these by more than ${MAX_CLIP_OVERLAP_RATIO * 100}% of the shorter is dropped before render.\n`,
    );
  }
  writeJson(path.join(p.run, "moment.json"), { ...base, target: r.out.target, segments: r.out.segments });
  return { run: p.run, write: "selection", request, answer, target: r.out.target, segments: r.out.segments };
}

// ---- clips an earlier moment of the session already made ----------------------------------------------------------

/**
 * Hosted's MAX_CLIP_OVERLAP_RATIO: a clip overlapping a kept one by more than this share of the shorter is dropped.
 * 0.25 at the pin, as engine/boqo/snap.mjs carries it (packages/core/src/constants.ts, cut from the port) without
 * exporting it; tests/moment.test.mjs reads that line of snap.mjs, so the two cannot drift apart unseen.
 */
export const MAX_CLIP_OVERLAP_RATIO = 0.25;

/** Overlap between two spans `{startSec, endSec}` as a fraction of the shorter one: snap.mjs's overlapRatio, not exported there. */
export function overlapRatio(a, b) {
  const overlap = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  if (overlap <= 0) return 0;
  const shorter = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
  return shorter <= 0 ? 1 : overlap / shorter;
}

/** The epoch second a moment's window starts (its video's 0): meta.startAt, or the peak less its offset; null when neither. */
export function windowStart(meta) {
  if (Number.isFinite(meta?.startAt)) return meta.startAt;
  if (Number.isFinite(meta?.peakAt) && Number.isFinite(meta?.peakOffsetSec)) return meta.peakAt - meta.peakOffsetSec;
  return null;
}

/**
 * The clips this session already made from its other moments, on the wall clock: every rendered row of every moment
 * run of the channel whose moment.json names this session, `exclude` (this moment's name) left out.
 * `[{moment, n, title, startAt, endAt}]`, epoch seconds.
 */
export function sessionClips({ session, channelFolder, exclude = null }) {
  const root = path.join(sniperHome(), "clips", channelFolder);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name === exclude) continue;
    const run = path.join(root, name);
    const m = readJson(path.join(run, "moment.json"), null);
    if (!m || typeof m.session !== "string" || path.resolve(m.session) !== path.resolve(session)) continue;
    const t0 = windowStart(m.meta);
    const record = readJson(path.join(run, "clips.json"), null);
    if (t0 === null || !Array.isArray(record?.clips)) continue;
    for (const row of record.clips) {
      if (row?.rendered !== true || !Number.isFinite(row.start) || !Number.isFinite(row.end)) continue;
      out.push({ moment: name, n: row.n, title: row.title ?? null, startAt: t0 + row.start, endAt: t0 + row.end });
    }
  }
  return out;
}

/** The made clips inside a window starting at `t0` and `duration` long, in its own seconds, by start: `[[a, b]]`. */
function madeSpansIn(made, t0, duration) {
  if (t0 === null) return [];
  return made
    .map((c) => [Math.max(0, c.startAt - t0), Math.min(duration, c.endAt - t0)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
}

/**
 * The rows (not yet rendered) that overlap a made clip by more than MAX_CLIP_OVERLAP_RATIO of the shorter, on the
 * wall clock (`startAt` is the window's start): `[{row, overlaps: {moment, clip, title}}]`, the first made clip each hits.
 */
export function overlapDrops(rows, made, startAt) {
  if (!Number.isFinite(startAt)) return [];
  const out = [];
  for (const row of rows) {
    if (row.rendered === true) continue;
    const span = { startSec: startAt + row.start, endSec: startAt + row.end };
    const hit = made.find((c) => overlapRatio(span, { startSec: c.startAt, endSec: c.endAt }) > MAX_CLIP_OVERLAP_RATIO);
    if (hit) out.push({ row, overlaps: { moment: hit.moment, clip: hit.n, title: hit.title } });
  }
  return out;
}

// ---- step -------------------------------------------------------------------------------------------------------

const NEW_STATE = () => ({ probe: null, panels: {}, renders: {}, stranger: {}, pending: null });

function readState(run) {
  const s = readJson(path.join(run, "state.json"), null);
  return s && typeof s === "object" ? { ...NEW_STATE(), ...s } : NEW_STATE();
}

const answerOf = {
  probe: (run) => path.join(run, "panels", "probe.json"),
  panels: (run, n) => path.join(run, "panels", `clip-${two(n)}`, "read.json"),
  stranger: (run, n) => path.join(run, "stranger", two(n), "annotation.json"),
};
const turnOf = {
  probe: (run) => path.join(run, "panels", "probe", "turn.txt"),
  panels: (run, n) => path.join(run, "panels", `clip-${two(n)}`, "turn.txt"),
  stranger: (run, n) => path.join(run, "stranger", two(n), "turn.txt"),
};
const DOC = { probe: "panels.md", panels: "panels.md", stranger: "stranger.md" };

/** What the agent is asked to look at: the turn to read, the file to write, the doc that holds the prompt. */
function readAsk(run, pending, errors) {
  const { kind, n } = pending;
  const ask = { read: kind };
  if (n !== undefined) ask.n = n;
  Object.assign(ask, { turn: turnOf[kind](run, n), answer: answerOf[kind](run, n), doc: DOC[kind] });
  if (errors) ask.errors = errors;
  return ask;
}

/** A clip's row in clips.json, saved back with `change` applied (clips.json is re-read: the engine writes it too). */
function updateRow(run, n, change) {
  const record = loadRecord(run);
  const row = record.clips.find((r) => r.n === n);
  if (!row) throw new MomentError(`clips.json has no clip ${n}`);
  change(row);
  writeJson(path.join(run, "clips.json"), record);
  return row;
}

/** The boxes a clip without its own read reuses: the last sample of the session's last read that has a game panel. */
export function lastBoxesOf(decision) {
  if (!decision || decision.status !== "ok" || !Array.isArray(decision.samples)) return null;
  const s = [...decision.samples].reverse().find((x) => x && x.game);
  return s ? { cameras: s.cameras, game: s.game, focus: s.focus, gameTitle: decision.gameTitle ?? null } : null;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * The read a clip past the budget renders with (spec §7.7): the session's last camera and game boxes for the whole
 * clip, the focus on the game panel's centre, sized as the last read's focus was (half the panel when it had none).
 */
export function reusedDecision(boxes, row) {
  const g = boxes.game;
  const fw = Math.min(g.w, boxes.focus ? boxes.focus.w : g.w / 2);
  const fh = Math.min(g.h, boxes.focus ? boxes.focus.h : g.h / 2);
  const focus = { x: clamp01(g.x + (g.w - fw) / 2), y: clamp01(g.y + (g.h - fh) / 2), w: fw, h: fh };
  const mode = boxes.cameras.length > 0 ? "panels" : "game";
  const samples = [];
  for (let t = row.start; t < row.end; t += REUSE_STEP_SEC) {
    samples.push({ sourceSec: Math.round(t * 1000) / 1000, mode, cameras: boxes.cameras, game: g, focus, why: "the session's last read, no new read" });
  }
  return PanelDecision.parse({
    version: 1,
    status: "ok",
    promptVersion: PANELS_PROMPT_VERSION,
    model: REUSED_MODEL,
    content: "stream_with_game",
    gameTitle: boxes.gameTitle,
    samples,
    trigger: "first",
  });
}

async function brandFor(name) {
  if (name) return loadBrand(name, { missingLogo: "keep" });
  if (await defaultBrandName()) return loadBrand(undefined, { missingLogo: "keep" });
  return defaultBrand("default");
}

const stored = (run, abs) => path.relative(run, abs).split(path.sep).join("/");

/**
 * One step of a started moment's run; see the file's head. Returns one of:
 *   {write: "selection", request, answer, errors?}  selection.json is missing, or the check refused it
 *   {read: "probe"|"panels"|"stranger", n?, turn, answer, doc, errors?}  look, write `answer`, step again
 *   {next: true, rendered: n, of: k} | {next: true, failed: n, error, of: k}  one render done: step again
 *   {done: true, clips, summary, noRead, failed, runsLine, budgetSpent?}  the moment is over
 * `budgetSpent: true` rides on the step where a read was first refused since the session's last paid one.
 * Seams for tests: `tool` (the shared tools), `render` (renderClip), `loadDetector`, `exec` (the panels read's
 * ffmpeg), `now` (the budget's clock, seconds).
 */
export async function stepMoment({ run: runDir, tool = runTool, render = renderClip, loadDetector = loadBlazeFace, exec, now }) {
  const run = path.resolve(runDir);
  const done = readJson(path.join(run, "done.json"), null);
  if (done) return done;
  const m = readJson(path.join(run, "moment.json"), null);
  if (!m) throw new MomentError(`not a started moment run (no moment.json): ${run}`);
  const request = path.join(run, "select-request.md");
  const selection = path.join(run, "selection.json");

  // 6, 7. The check and the pre-render order, once: clips.json is the record from here on.
  if (!fs.existsSync(path.join(run, "clips.json"))) {
    if (!fs.existsSync(selection)) return { write: "selection", request, answer: selection };
    const c = await tool("select-check.mjs", ["--run", run]);
    if (c.code !== 0 || !c.out?.ok) return { write: "selection", request, answer: selection, errors: c.out?.errors ?? [`select-check.mjs exited ${c.code}`] };
    const o = await tool("clips.mjs", ["order", "--run", run]);
    if (o.code !== 0 || !o.out?.ok) throw new MomentError((o.out?.errors ?? [`clips.mjs order exited ${o.code}`]).join("; "));
  }

  // 7b. Once, before any render: the clips an earlier moment of this session already made are dropped (the file's
  // head: a deviation from hosted, which clips both), and the rest put in order again.
  const overlappedFile = path.join(run, "overlapped.json");
  if (!fs.existsSync(overlappedFile)) {
    const record = loadRecord(run);
    const drops = overlapDrops(record.clips, sessionClips({ session: m.session, channelFolder: m.channelFolder, exclude: m.name }), windowStart(m.meta));
    if (drops.length > 0) {
      const gone = new Set(drops.map((d) => d.row));
      record.clips = record.clips.filter((r) => !gone.has(r));
      writeJson(path.join(run, "clips.json"), record);
      const o = await tool("clips.mjs", ["order", "--run", run]);
      if (o.code !== 0 || !o.out?.ok) throw new MomentError((o.out?.errors ?? [`clips.mjs order exited ${o.code}`]).join("; "));
      process.stderr.write(`${drops.length} of the selection's clips left out: an earlier moment of this session already made that footage\n`);
    }
    writeJson(overlappedFile, drops.map(({ row, overlaps }) => ({ title: row.title ?? null, start: row.start, end: row.end, overlaps })));
  }

  const settings = await readSessionSettings(m.session);
  const budget = visionBudget({ perHour: settings.visionPerHour, file: visionFile(m.session), ...(now ? { now } : {}) });
  const toldFile = path.join(m.session, "vision-spent");
  let budgetSpent = false;
  const take = (k) => {
    if (budget.take(k)) {
      fs.rmSync(toldFile, { force: true });
      return true;
    }
    if (!fs.existsSync(toldFile)) {
      fs.writeFileSync(toldFile, "");
      budgetSpent = true;
    }
    return false;
  };
  const say = (obj) => (budgetSpent ? { ...obj, budgetSpent: true } : obj);

  const state = readState(run);
  const save = () => writeJson(path.join(run, "state.json"), state);
  const probeCache = path.join(m.session, "panels-probe.json");
  const lastFile = path.join(m.session, "panels-last.json");
  const rows = () => renderRows(loadRecord(run)).filter((r) => r.n <= MOMENT_RENDER_MAX);

  // The answer the last step asked for.
  if (state.pending) {
    const pending = state.pending;
    const answer = answerOf[pending.kind](run, pending.n);
    if (!fs.existsSync(answer)) return say(readAsk(run, pending, [`write ${answer}, then step again`]));
    try {
      if (pending.kind === "probe") {
        const r = recordProbe({ run, file: answer });
        state.probe = { eligible: true, isStream: r.isStream, gameTitle: r.gameTitle };
        writeJson(probeCache, state.probe);
      } else if (pending.kind === "panels") {
        recordRead({ run, n: pending.n, file: answer });
        const boxes = lastBoxesOf(loadRecord(run).clips.find((r) => r.n === pending.n)?.panels);
        if (boxes) writeJson(lastFile, boxes);
        state.panels[pending.n] = "read";
      } else {
        const r = await tool("stranger.mjs", ["record", "--run", run, "--n", String(pending.n), "--file", answer]);
        if (r.code !== 0 || !r.out?.ok) return say(readAsk(run, pending, r.out?.errors ?? [`stranger.mjs record exited ${r.code}`]));
        state.stranger[pending.n] = "read";
      }
    } catch (err) {
      return say(readAsk(run, pending, [err.message]));
    }
    state.pending = null;
    save();
  }

  if (rows().length > 0) {
    // 8. The stream probe, once a session.
    if (state.probe === null) {
      const cached = readJson(probeCache, null);
      if (cached) {
        if (cached.eligible !== false) {
          const file = answerOf.probe(run);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          writeJson(file, { isStream: cached.isStream, gameTitle: cached.gameTitle ?? null });
          recordProbe({ run, file });
        }
        state.probe = cached;
      } else {
        let r;
        try {
          r = await probeFrames({ run, ...(exec ? { exec } : {}) });
        } catch (err) {
          // A probe that could not be made (no frame read) is this moment's, not the session's: the next one tries.
          r = { eligible: false, failed: err.message };
        }
        if (!r.eligible) {
          state.probe = { eligible: false };
          if (!r.failed) writeJson(probeCache, state.probe);
        } else if (r.recorded) {
          state.probe = { eligible: true, isStream: r.isStream, gameTitle: r.gameTitle };
          writeJson(probeCache, state.probe);
        } else if (take(r.frames)) {
          state.pending = { kind: "probe" };
          save();
          return say(readAsk(run, state.pending));
        } else {
          state.probe = { skipped: "budget" };
        }
      }
      save();
    }

    // 8. Each clip's panels read, while the budget allows.
    for (const row of rows()) {
      if (state.panels[row.n] !== undefined) continue;
      const probe = state.probe;
      if (probe.skipped) {
        state.panels[row.n] = reuse(run, row.n, lastFile) ? "reused" : "noread";
      } else if (!probe.eligible || !probe.isStream) {
        state.panels[row.n] = "none";
      } else {
        let r;
        try {
          r = await readFrames({ run, n: row.n, ...(exec ? { exec } : {}) });
        } catch (err) {
          r = { asked: false, reason: err.message };
        }
        if (!r.asked) {
          state.panels[row.n] = "none";
        } else if (take(r.frames)) {
          state.pending = { kind: "panels", n: row.n };
          save();
          return say(readAsk(run, state.pending));
        } else {
          fs.rmSync(r.dir, { recursive: true, force: true });
          state.panels[row.n] = reuse(run, row.n, lastFile) ? "reused" : "noread";
        }
      }
      save();
    }

    // 9. The renders, one a step.
    const all = rows();
    const next = all.find((r) => r.rendered !== true && state.renders[r.n] === undefined);
    if (next) {
      const record = loadRecord(run);
      const words = readJson(path.join(run, "words.json"));
      let result;
      let detector;
      try {
        const brand = await brandFor(m.brand);
        const at = sourceOf(run, record, next);
        try {
          detector = await loadDetector();
        } catch {
          detector = undefined;
        }
        const r = await render({ run, row: next, brand, sourceFile: at.file, offset: at.offset, words, subjectRule: "presence", detector });
        updateRow(run, next.n, (row) =>
          Object.assign(row, { rendered: true, file: stored(run, r.file), thumb: stored(run, r.thumb), seconds: r.seconds, notes: r.notes, window: r.window, cuts: r.cuts }),
        );
        state.renders[next.n] = "ok";
        result = { next: true, rendered: next.n, of: all.length };
      } catch (err) {
        state.renders[next.n] = `failed: ${err.message}`;
        result = { next: true, failed: next.n, error: err.message, of: all.length };
      } finally {
        await detector?.release?.();
      }
      save();
      return say(result);
    }

    // 10. Each rendered clip's stranger judgment, while the budget allows.
    for (const row of rows()) {
      if (row.rendered !== true || state.stranger[row.n] !== undefined) continue;
      const dir = path.join(run, "stranger", two(row.n));
      const r = await tool("stranger.mjs", ["frames", "--clip", path.resolve(run, row.file), "--dir", dir, "--run", run, "--n", String(row.n)]);
      if (r.code !== 0 || !Number.isInteger(r.out?.frames)) {
        // No frames to judge (a clip too short for one): no judgment, as hosted's empty list gives none.
        state.stranger[row.n] = "none";
      } else if (take(r.out.frames)) {
        state.pending = { kind: "stranger", n: row.n };
        save();
        return say(readAsk(run, state.pending));
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
        updateRow(run, row.n, (x) => {
          x.judgment = { overall: NEUTRAL_JUDGMENT, why: "", annotation: null };
          x.noRead = true;
        });
        state.stranger[row.n] = "neutral";
      }
      save();
    }
  }

  const failed = Object.entries(state.renders)
    .filter(([, v]) => v !== "ok")
    .map(([n, v]) => ({ n: Number(n), error: v.replace(/^failed: /, "") }));
  return say(await finish(run, { failed }));
}

/** Gives clip `n` the session's last boxes (spec §7.7) and marks it unread; false when the session has none. */
function reuse(run, n, lastFile) {
  const boxes = readJson(lastFile, null);
  updateRow(run, n, (row) => {
    if (boxes?.game) row.panels = reusedDecision(boxes, row);
    row.noRead = true;
  });
  return Boolean(boxes?.game);
}

/** 11 to 13: the final order, the summary, the runs.md line; the window's video goes, with the frames read. */
async function finish(run, { failed = [], reason } = {}) {
  const m = readJson(path.join(run, "moment.json"));
  let clips = [];
  let summary = [];
  if (fs.existsSync(path.join(run, "clips.json"))) {
    const o = reorderRun(run);
    if (!o.ok) throw new MomentError(o.errors.join("; "));
    const record = loadRecord(run);
    summary = summaryLines(record);
    clips = record.clips
      .filter((r) => r.rendered === true)
      .map((r) => ({ n: r.n, title: r.title, seconds: r.seconds, file: path.resolve(run, r.file), ...(r.noRead ? { noRead: true } : {}) }));
  }
  const noRead = clips.filter((c) => c.noRead).length;
  const overlapped = readJson(path.join(run, "overlapped.json"), []);
  const meta = m.meta ?? {};
  const line = runsLine({ peakAt: meta.peakAt, score: meta.score, signal: meta.signal, detail: meta.detail ?? null, title: meta.title, clips: clips.length, noRead: noRead > 0 });
  const done = {
    done: true, run, clips, summary, noRead, failed, runsLine: line,
    ...(Array.isArray(overlapped) && overlapped.length > 0 ? { overlapped } : {}),
    ...(reason ? { reason } : {}),
  };
  writeJson(path.join(run, "done.json"), done);
  fs.mkdirSync(sniperHome(), { recursive: true });
  fs.appendFileSync(path.join(sniperHome(), "runs.md"), `${line}\n`);
  fs.appendFileSync(path.join(m.session, "clipped.jsonl"), `${JSON.stringify({ moment: m.name, clips: clips.length, noRead })}\n`);
  fs.rmSync(path.join(m.moment, "video.mp4"), { force: true });
  fs.rmSync(path.join(run, "panels"), { recursive: true, force: true });
  fs.rmSync(path.join(run, "stranger"), { recursive: true, force: true });
  return done;
}

// ---- posted -----------------------------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");

/**
 * One line of `<home>/boqo-sniper/posts.md` per post tried (SKILL.md → Posting):
 *   `2026-11-16 21:05 | twitch-somechannel 20261116-200102 | 20261116-210431 clip-01 | posted 1 <projectId>`
 *   `... | posted 0` when `list_schedule` found no post of it after an unclear reply.
 * The date and time are local, so `grep "^$(date +%F) "` finds today's.
 */
export function postedLine({ run: runDir, n, projectId = null, at = new Date() }) {
  const run = path.resolve(runDir);
  const m = readJson(path.join(run, "moment.json"), null);
  if (!m) throw new MomentError(`not a moment run (no moment.json): ${run}`);
  if (!Number.isInteger(n) || n < 1) throw new MomentError("--n must be a clip number (1, 2, ...)");
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const posted = projectId ? `posted 1 ${projectId}` : "posted 0";
  const line = `${day} ${time} | ${m.channelFolder} ${path.basename(m.session)} | ${m.name} clip-${two(n)} | ${posted}`;
  fs.mkdirSync(sniperHome(), { recursive: true });
  fs.appendFileSync(path.join(sniperHome(), "posts.md"), `${line}\n`);
  return line;
}
