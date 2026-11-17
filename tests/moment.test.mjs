// The moment flow (lib/moment-run.mjs, tools/moment.mjs) on a synthetic window: whisper's words injected, a
// fixture selection.json, the test standing in as the agent for the reads, and real ffmpeg for the frames and the
// renders. The engine's own parts are tested in boqo-clips; this holds the order, the session's probe and image
// budget, the reused boxes past the budget, and the runs.md and posts.md lines.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toolEnv } from "../engine/env.mjs";
import { renderClip } from "../engine/render.mjs";
import { segmentsFromWords } from "../engine/segments.mjs";
import {
  MAX_CLIP_OVERLAP_RATIO,
  lastBoxesOf,
  momentPaths,
  overlapDrops,
  overlapRatio,
  postedLine,
  reusedDecision,
  sessionClips,
  startMoment,
  stepMoment,
  windowStart,
} from "../lib/moment-run.mjs";
import { defaultSettings } from "../lib/settings.mjs";
import { newSession, readTally, visionFile, writeSessionSettings } from "../lib/session.mjs";

const MOMENT = fileURLToPath(new URL("../tools/moment.mjs", import.meta.url));
const STATUS = fileURLToPath(new URL("../tools/status.mjs", import.meta.url));
const ffmpegHere = spawnSync("ffmpeg", ["-version"], { env: toolEnv() }).status === 0;
const skip = ffmpegHere ? false : "ffmpeg is not on PATH";

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v));

function runCli(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

// BOQO_HOME for the whole file, with a space in it on purpose.
let home;
let oldHome;
let window300;
before(() => {
  oldHome = process.env.BOQO_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sniper moment "));
  process.env.BOQO_HOME = home;
  if (!ffmpegHere) return;
  // A 300 s landscape window (a game stream's shape, 854x480, so the panels read is eligible) with a tone.
  window300 = path.join(home, "window.mp4");
  const r = spawnSync(
    "ffmpeg",
    [
      "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=854x480:rate=10:duration=300",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=300",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", window300,
    ],
    { encoding: "utf8", env: toolEnv() },
  );
  assert.equal(r.status, 0, r.stderr);
});
after(() => {
  if (oldHome === undefined) delete process.env.BOQO_HOME;
  else process.env.BOQO_HOME = oldHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const PEAK_AT = Date.UTC(2026, 10, 16, 21, 4, 30) / 1000;
const DETAIL = { chatPerSec: 30.2, chatBaseline: 2, loudness: null, loudnessBaseline: null, topMessage: "NO WAY", topCount: 168 };

/** A moment folder in `session`, as the watcher leaves it: video.mp4 (the window), chat.json, meta.json. */
function addMoment(session, name, { video = window300, meta = {} } = {}) {
  const dir = path.join(session, "moments", name);
  fs.mkdirSync(dir, { recursive: true });
  if (video) fs.copyFileSync(video, path.join(dir, "video.mp4"));
  writeJson(path.join(dir, "chat.json"), []);
  writeJson(path.join(dir, "meta.json"), {
    peakAt: PEAK_AT, score: 86, signal: "chat", title: 'chat spike — "NO WAY" ×168', detail: DETAIL,
    platform: "twitch", channel: "chan", peakOffsetSec: 270, ...meta,
  });
  fs.writeFileSync(path.join(dir, ".taken"), "");
  return dir;
}

/** whisper's words, injected: a 10-word sentence every 4 s over the window, a word every 0.4 s. */
const fakeAsr = (seconds = 300) => async ({ run }) => {
  const words = [];
  for (let i = 0; i * 0.4 < seconds - 0.4; i++) {
    const t = Math.round(i * 0.4 * 100) / 100;
    words.push({ w: i % 10 === 9 ? `word${i}.` : `word${i}`, s: t, e: Math.round((t + 0.3) * 100) / 100 });
  }
  writeJson(path.join(run, "words.json"), words);
  writeJson(path.join(run, "segments.json"), segmentsFromWords(words, { source: "whisper" }));
};
const silentAsr = async ({ run }) => {
  writeJson(path.join(run, "words.json"), []);
  writeJson(path.join(run, "segments.json"), []);
};

/** The agent's selection: hosted's wire shape, one clip per [start, end]. */
const selection = (spans) => ({
  clips: spans.map(([s, e], i) => ({
    start_sec: s, end_sec: e, title: `Clip ${i + 1}`, hook: `Hook ${i + 1}`, score: 90 - i * 5,
    hook_score: 80, flow_score: 80, standalone_score: 80, value_score: 80, emphasis_words: ["word"],
    stands_alone: true, claim: "A claim.", bridge_from_sec: null, context_line: null,
    title_alternatives: [`First ${i + 1}`, `Second ${i + 1}`],
  })),
});

const ANNOTATION = {
  hook_type: "visual_action", hook_text: "word word", hook_promises_payoff: true, time_to_payoff_s: 5,
  narrative_arc: "setup_tension_payoff", ends_with: "punchline_or_payoff", comprehensible_without_context: 4,
  share_trigger: "awe_or_surprise", comment_bait: false, caption_style: "word_by_word_highlight",
  caption_position: "lower_third", title_card_or_headline: true, on_screen_text_other: false, broll_or_cutaways: "none",
  layout: "gameplay_plus_cam", visible_zoom_punches_or_jumpcuts: "none", music_present_guess: "unknown",
  emotional_peak: "awe", overall_quality_judgment: 4, one_line_why: "The play lands.",
};
// A camera inset over a full-screen game, the shape panels-plan.mjs lays out as panels.
const CAMERA = { x: 0.72, y: 0.05, w: 0.26, h: 0.3 };
const GAME = { x: 0, y: 0, w: 1, h: 1 };
const FOCUS = { x: 0.2, y: 0.5, w: 0.2, h: 0.2 };

/** Answers what a step asks, as the agent would, and steps again until the moment is done. Returns every step. */
async function drive(run, seams, { onAsk = () => {} } = {}) {
  const steps = [];
  for (let i = 0; i < 40; i++) {
    const r = await stepMoment({ run, ...seams });
    steps.push(r);
    await onAsk(r, steps.length);
    if (r.done) return steps;
    if (r.errors) throw new Error(`step refused: ${JSON.stringify(r)}`);
    if (r.read === "probe") writeJson(r.answer, { isStream: true, gameTitle: "Test Game" });
    if (r.read === "panels") {
      const { frames } = readJson(path.join(path.dirname(r.turn), "frames.json"));
      const samples = frames.map((f) => ({ sourceSec: f.sourceSec, mode: "panels", cameras: [CAMERA], game: GAME, focus: FOCUS, why: "the fight" }));
      writeJson(r.answer, { content: "stream_with_game", gameTitle: "Test Game", samples });
    }
    if (r.read === "stranger") writeJson(r.answer, ANNOTATION);
  }
  throw new Error("the moment did not finish in 40 steps");
}

// onnxruntime-node standing in as not loadable: faces are unavailable, every shot without panels is Fit.
const noRuntime = async () => {
  throw new Error("onnxruntime-node is not installed");
};
function renderSeam() {
  const seen = [];
  return {
    seen,
    render: async (args) => {
      const r = await renderClip({ ...args, load: noRuntime });
      seen.push({ n: args.row.n, subjectRule: args.subjectRule, layouts: r.layouts });
      return r;
    },
    loadDetector: async () => undefined,
  };
}

const imagesOf = (session) => readJson(visionFile(session)).reduce((sum, [, n]) => sum + n, 0);

test("two moments of one session: every kept clip rendered with presence, the probe asked once, then the budget spent", { skip, timeout: 900_000 }, async () => {
  const session = await newSession("chan");
  await writeSessionSettings(session, { ...defaultSettings(), prompt: "the clutch plays", visionPerHour: 600 });

  // ---- the first moment: every read paid for ----
  const m1 = addMoment(session, "20261116-210430");
  const start = await startMoment({ moment: m1, asr: fakeAsr() });
  assert.equal(start.write, "selection");
  assert.equal(start.target, 5, "the window's 300 s is a target of 5");
  assert.equal(start.run, path.join(home, "boqo-sniper", "clips", "twitch-chan", "20261116-210430"));
  const request = fs.readFileSync(start.request, "utf8");
  assert.match(request, /the clutch plays/, "the watch's prompt is the creator's request");
  assert.deepEqual(readJson(path.join(start.run, "sections.json")).files.map((f) => [f.s, Math.round(f.e)]), [[0, 300]]);
  // the same start again answers the same and redoes nothing
  assert.deepEqual(await startMoment({ moment: m1, asr: async () => assert.fail("whisper ran twice") }), start);

  // A selection the check refuses comes back with its errors; a fixed one goes on.
  writeJson(start.answer, { clips: [{ start_sec: 20 }] });
  const refused = await stepMoment({ run: start.run });
  assert.equal(refused.write, "selection");
  assert.ok(refused.errors.length > 0);
  writeJson(start.answer, selection([[20, 40], [200, 220]]));

  const seam1 = renderSeam();
  const steps1 = await drive(start.run, seam1);
  const asked1 = steps1.filter((s) => s.read).map((s) => `${s.read}${s.n ?? ""}`);
  assert.deepEqual(asked1, ["probe", "panels1", "panels2", "stranger1", "stranger2"]);
  assert.equal(steps1.filter((s) => s.rendered).length, 2);
  assert.deepEqual(seam1.seen.map((s) => s.subjectRule), ["presence", "presence"]);
  for (const s of seam1.seen) assert.ok(s.layouts.includes("panels"), `clip ${s.n} rendered in panels: ${s.layouts}`);

  const done1 = steps1.at(-1);
  assert.equal(done1.clips.length, 2);
  for (const c of done1.clips) {
    assert.ok(fs.existsSync(c.file), c.file);
    assert.match(path.basename(c.file), /^clip-0[12]\.mp4$/);
    assert.equal(c.noRead, undefined);
  }
  assert.equal(done1.noRead, 0);
  assert.equal(done1.runsLine.replace(/^\d\d:\d\d/, "HH:MM"), 'HH:MM · 86 exceptional · NO WAY ×168 · 30/s · chat spike — "NO WAY" ×168 · 2 clips');
  assert.ok(!steps1.some((s) => s.budgetSpent));
  const record1 = readJson(path.join(start.run, "clips.json"));
  assert.deepEqual(record1.clips.map((c) => c.judgment.overall), [4, 4]);
  assert.ok(!fs.existsSync(path.join(m1, "video.mp4")), "the window's video is deleted once its clips are made");
  assert.ok(!fs.existsSync(path.join(start.run, "panels")) && !fs.existsSync(path.join(start.run, "stranger")), "the frames read are deleted");
  assert.deepEqual(readJson(path.join(session, "panels-probe.json")), { eligible: true, isStream: true, gameTitle: "Test Game" });
  assert.deepEqual(readJson(path.join(session, "panels-last.json")), { cameras: [CAMERA], game: GAME, focus: FOCUS, gameTitle: "Test Game" });
  const used1 = imagesOf(session);
  assert.ok(used1 > 6 + 2 * 2 && used1 <= 6 + 4 * 12, `images spent: ${used1}`);
  // stepping a finished moment answers its end again
  assert.deepEqual(await stepMoment({ run: start.run }), done1);

  // ---- the second moment: the probe comes from the session; the hour is spent after its first read ----
  const m2 = addMoment(session, "20261116-211500", { meta: { signal: "manual", score: 100, title: "clipped by hand", detail: null } });
  const start2 = await startMoment({ moment: m2, asr: fakeAsr() });
  writeJson(start2.answer, selection([[60, 80], [240, 260]]));
  const seam2 = renderSeam();
  const steps2 = await drive(start2.run, seam2, {
    onAsk: async (r) => {
      // The first read asked is clip 1's panels read, already paid for; then the hour is spent.
      if (r.read === "panels" && r.n === 1) await writeSessionSettings(session, { ...defaultSettings(), visionPerHour: imagesOf(session) });
    },
  });
  const asked2 = steps2.filter((s) => s.read).map((s) => `${s.read}${s.n ?? ""}`);
  assert.deepEqual(asked2, ["panels1"], "no probe: once a session; nothing past the budget");
  assert.ok(!fs.existsSync(path.join(start2.run, "panels", "probe")));
  assert.equal(steps2.filter((s) => s.budgetSpent).length, 1, "one line for the chat when the budget runs out");
  assert.deepEqual(seam2.seen.map((s) => s.subjectRule), ["presence", "presence"]);
  for (const s of seam2.seen) assert.ok(s.layouts.includes("panels"), `clip ${s.n} rendered in panels: ${s.layouts}`);

  const done2 = steps2.at(-1);
  assert.equal(done2.clips.length, 2);
  assert.equal(done2.noRead, 2);
  assert.equal(done2.runsLine.replace(/^\d\d:\d\d/, "HH:MM"), "HH:MM · 100 exceptional · clipped by hand · 2 clips · no read");
  const record2 = readJson(path.join(start2.run, "clips.json"));
  for (const c of record2.clips) assert.equal(c.judgment.overall, 3, "a clip past the budget takes the neutral judgment");
  const reused = record2.clips.find((c) => c.panels?.model === "reused");
  assert.ok(reused, "the clip past the budget reuses the session's boxes");
  const g = reused.panels.samples[0];
  assert.deepEqual(g.cameras, [CAMERA]);
  assert.deepEqual(g.game, GAME);
  assert.ok(Math.abs(g.focus.x + g.focus.w / 2 - (GAME.x + GAME.w / 2)) < 1e-9 && Math.abs(g.focus.y + g.focus.h / 2 - (GAME.y + GAME.h / 2)) < 1e-9, "focus on the game panel's centre");
  assert.equal(record2.panelProbe.isStream, true);

  const runs = fs.readFileSync(path.join(home, "boqo-sniper", "runs.md"), "utf8").trim().split("\n");
  assert.deepEqual(runs.slice(-2), [done1.runsLine, done2.runsLine]);
  assert.deepEqual(await readTally(session), { clipped: 2, clips: 4 });
  const status = await runCli(STATUS, ["chan"], process.env);
  assert.equal(status.json.clipped, 2);
  assert.equal(status.json.clips, 4);
});

test("a window with no speech ends with no clips and its runs.md line", { skip }, async () => {
  const session = await newSession("quiet");
  const m = addMoment(session, "20261116-220000", { video: window300 });
  const r = await startMoment({ moment: m, asr: silentAsr });
  assert.equal(r.done, true);
  assert.deepEqual(r.clips, []);
  assert.equal(r.reason, "no speech");
  assert.match(r.runsLine, / · 0 clips$/);
  assert.match(fs.readFileSync(path.join(home, "boqo-sniper", "runs.md"), "utf8"), / · 0 clips\n$/);
});

// ---- clips an earlier moment of the session already made (a deviation from hosted, which clips both) ----

test("overlap: hosted's rule (more than 25% of the shorter, strictly), on the wall clock, against the session's made clips", () => {
  const snap = fs.readFileSync(fileURLToPath(new URL("../engine/boqo/snap.mjs", import.meta.url)), "utf8");
  assert.match(snap, /^const MAX_CLIP_OVERLAP_RATIO = 0\.25;$/m, "the engine's (hosted's) ratio, which snap.mjs does not export");
  assert.equal(MAX_CLIP_OVERLAP_RATIO, 0.25);
  assert.equal(overlapRatio({ startSec: 0, endSec: 40 }, { startSec: 30, endSec: 70 }), 0.25);
  assert.equal(overlapRatio({ startSec: 0, endSec: 10 }, { startSec: 10, endSec: 20 }), 0);
  assert.equal(overlapRatio({ startSec: 0, endSec: 100 }, { startSec: 20, endSec: 30 }), 1, "a clip inside another");

  assert.equal(windowStart({ startAt: 1000, peakAt: 1270, peakOffsetSec: 270 }), 1000);
  assert.equal(windowStart({ peakAt: 1270, peakOffsetSec: 270 }), 1000, "a meta with no startAt: the peak less its offset");
  assert.equal(windowStart({ peakAt: 1270 }), null);

  // an earlier moment's clip made 1100-1140 on the wall clock; this window starts at 1060, so it is 40-80 here
  const made = [{ moment: "20261116-100000", n: 1, title: "Earlier", startAt: 1100, endAt: 1140 }];
  const rows = [
    { n: 1, start: 50, end: 70, title: "Inside it" },
    { n: 2, start: 70, end: 110, title: "A quarter of it" }, // 10 s of 40: exactly 25%, kept
    { n: 3, start: 69.9, end: 109.9, title: "Just over" }, // 10.1 s of 40: dropped
    { n: 4, start: 200, end: 230, title: "Clear" },
    { n: 5, start: 40, end: 80, title: "Rendered already", rendered: true }, // a row already rendered is never dropped
  ];
  const drops = overlapDrops(rows, made, 1060);
  assert.deepEqual(drops.map((d) => d.row.n), [1, 3]);
  assert.deepEqual(drops[0].overlaps, { moment: "20261116-100000", clip: 1, title: "Earlier" });
  assert.deepEqual(overlapDrops(rows, made, null), [], "a window with no start on the clock is compared with nothing");
});

test("a moment's clips that an earlier moment of the session already made are dropped before render, and the request says where they are", { skip, timeout: 300_000 }, async () => {
  const session = await newSession("ovl");
  const other = await newSession("ovl", new Date(Date.UTC(2026, 10, 15, 9)));
  // no frames read: the probe is the session's, already made
  writeJson(path.join(session, "panels-probe.json"), { eligible: false });
  const T0 = 1_800_000_000;
  const madeRun = (sess, name, clips) => {
    const run = path.join(home, "boqo-sniper", "clips", "twitch-ovl", name);
    fs.mkdirSync(run, { recursive: true });
    writeJson(path.join(run, "moment.json"), { moment: path.join(sess, "moments", name), session: sess, channelFolder: "twitch-ovl", name, meta: { startAt: T0 } });
    writeJson(path.join(run, "clips.json"), { clips });
  };
  // the earlier moment of this session: clip 1 made at T0+100..T0+140; clip 2 never rendered
  madeRun(session, "20261116-100000", [
    { n: 1, start: 100, end: 140, title: "The stealth potion", rendered: true },
    { n: 2, start: 200, end: 240, title: "Not rendered", rendered: false },
  ]);
  // another session's moment over the same seconds: not this session's, so not compared
  madeRun(other, "20261115-090500", [{ n: 1, start: 160, end: 300, title: "Yesterday", rendered: true }]);
  assert.deepEqual(sessionClips({ session, channelFolder: "twitch-ovl", exclude: "20261116-100400" }), [
    { moment: "20261116-100000", n: 1, title: "The stealth potion", startAt: T0 + 100, endAt: T0 + 140 },
  ]);

  // this moment's window starts 60 s later: the made clip is 40-80 s of it
  const m = addMoment(session, "20261116-100400", { meta: { startAt: T0 + 60, peakAt: T0 + 330, peakOffsetSec: 270 } });
  const start = await startMoment({ moment: m, asr: fakeAsr() });
  const request = fs.readFileSync(start.request, "utf8");
  assert.match(request, /\nAlready clipped in this session, from an earlier moment: 40\.0–80\.0 s of this video\. A clip that overlaps one of these by more than 25% of the shorter is dropped before render\.\n$/);
  writeJson(start.answer, selection([[48, 72], [200, 224]]));

  const rendered = [];
  const render = async ({ run, row }) => {
    rendered.push(row.title);
    const file = path.join(run, "out", `clip-${String(row.n).padStart(2, "0")}.mp4`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not a video");
    fs.writeFileSync(file.replace(/\.mp4$/, ".jpg"), "not a picture");
    return { file, thumb: file.replace(/\.mp4$/, ".jpg"), seconds: row.end - row.start, notes: [], window: null, cuts: [] };
  };
  const steps = await drive(start.run, { render, loadDetector: async () => undefined });
  const done = steps.at(-1);
  assert.deepEqual(rendered, ["Clip 2"], "the overlapping clip was never rendered");
  assert.equal(done.clips.length, 1);
  assert.equal(done.overlapped.length, 1);
  const [o] = done.overlapped;
  assert.equal(o.title, "Clip 1");
  assert.deepEqual(o.overlaps, { moment: "20261116-100000", clip: 1, title: "The stealth potion" });
  assert.ok(o.start >= 44 && o.end <= 76, `the dropped clip's span: ${o.start}-${o.end}`);
  assert.deepEqual(readJson(path.join(start.run, "clips.json")).clips.map((c) => c.title), ["Clip 2"]);
});

test("reused boxes: the last read's camera and game, the focus centred on the game, sized as its focus", () => {
  const decision = {
    status: "ok",
    gameTitle: "G",
    samples: [
      { sourceSec: 1, mode: "panels", cameras: [CAMERA], game: GAME, focus: FOCUS, why: "" },
      { sourceSec: 4, mode: "people", cameras: [CAMERA], game: null, focus: null, why: "" },
    ],
  };
  const boxes = lastBoxesOf(decision);
  assert.deepEqual(boxes, { cameras: [CAMERA], game: GAME, focus: FOCUS, gameTitle: "G" }, "the last sample WITH a game");
  const d = reusedDecision(boxes, { start: 10, end: 16 });
  assert.equal(d.model, "reused");
  assert.equal(d.content, "stream_with_game");
  assert.deepEqual(d.samples.map((s) => s.sourceSec), [10, 11.5, 13, 14.5]);
  assert.deepEqual(d.samples[0].focus, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 });
  assert.equal(d.samples[0].mode, "panels");
  // no focus in the last read: half the panel, centred; no camera: the game alone
  const bare = reusedDecision({ cameras: [], game: GAME, focus: null, gameTitle: null }, { start: 0, end: 1 });
  assert.deepEqual(bare.samples[0].focus, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert.equal(bare.samples[0].mode, "game");
  assert.equal(lastBoxesOf({ status: "ok", samples: [{ game: null }] }), null);
  assert.equal(lastBoxesOf(undefined), null);
});

test("posted: one posts.md line a clip, today's date first, which the SKILL greps", async () => {
  const session = await newSession("poster");
  const m = addMoment(session, "20261116-230000", { video: null });
  const { run } = momentPaths(m);
  fs.mkdirSync(run, { recursive: true });
  writeJson(path.join(run, "moment.json"), { moment: m, session, channelFolder: "twitch-poster", name: "20261116-230000" });
  const at = new Date(2026, 10, 16, 23, 5);
  const line = postedLine({ run, n: 1, projectId: "p-123", at });
  assert.equal(line, `2026-11-16 23:05 | twitch-poster ${path.basename(session)} | 20261116-230000 clip-01 | posted 1 p-123`);
  const cli = await runCli(MOMENT, ["posted", run, "--n", "2", "--none"], process.env);
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.match(cli.json.line, /\| 20261116-230000 clip-02 \| posted 0$/);
  const posts = fs.readFileSync(path.join(home, "boqo-sniper", "posts.md"), "utf8").trim().split("\n");
  assert.equal(posts.length, 2);
  assert.equal(posts.filter((l) => l.startsWith("2026-11-16 ") && l.includes("| posted 1 ")).length, 1);
  const bad = await runCli(MOMENT, ["posted", run, "--n", "1"], process.env);
  assert.equal(bad.code, 1);
  assert.match(bad.json.error, /--project/);
});

test("the CLI: step before the selection asks for it; a folder that is no moment run is an error, exit 1", async () => {
  const session = await newSession("cli");
  const m = addMoment(session, "20261116-230500", { video: null });
  const { run } = momentPaths(m);
  fs.mkdirSync(run, { recursive: true });
  writeJson(path.join(run, "moment.json"), { moment: m, session, channelFolder: "twitch-cli", name: "20261116-230500", meta: {} });
  const r = await runCli(MOMENT, ["step", run], process.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(r.json, { write: "selection", request: path.join(run, "select-request.md"), answer: path.join(run, "selection.json") });
  const nope = await runCli(MOMENT, ["step", path.join(home, "nowhere")], process.env);
  assert.equal(nope.code, 1);
  assert.match(nope.json.error, /no moment\.json/);
  const notMoment = await runCli(MOMENT, ["start", home], process.env);
  assert.equal(notMoment.code, 1);
  assert.match(notMoment.json.error, /not a moment folder/);
  const usage = await runCli(MOMENT, ["frames"], process.env);
  assert.equal(usage.code, 1);
  assert.match(usage.json.error, /^usage:/);
});
