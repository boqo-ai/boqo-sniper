import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sessionFolder, stamp } from "../lib/session.mjs";
import { segmentName } from "../lib/buffer.mjs";
import { toolEnv } from "../engine/env.mjs";
import { EwmaStat } from "../lib/boqo/moments.mjs";

const WATCH = fileURLToPath(new URL("../tools/watch.mjs", import.meta.url));
const STOP = fileURLToPath(new URL("../tools/stop.mjs", import.meta.url));
const STATUS = fileURLToPath(new URL("../tools/status.mjs", import.meta.url));
const NEXT = fileURLToPath(new URL("../tools/next.mjs", import.meta.url));

async function tmp(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `sniper-${label}-`));
}

/** `count` six-second .ts segments (the capture's segment length): one tiny testsrc + sine clip, copied. Never committed. */
async function makeSegments(dir, count) {
  await fs.mkdir(dir, { recursive: true });
  const first = path.join(dir, "000.ts");
  const r = spawnSync(
    "ffmpeg",
    [
      "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-f", "mpegts", first,
    ],
    { encoding: "utf8", env: toolEnv() },
  );
  assert.equal(r.status, 0, r.stderr);
  for (let i = 1; i < count; i++) await fs.copyFile(first, path.join(dir, `${String(i).padStart(3, "0")}.ts`));
}

/** Segments named by their start, `starts` seconds after an arbitrary epoch: a replay keeps their spacing, holes and all. */
async function makeStampedSegments(dir, starts) {
  await makeSegments(path.join(dir, "src"), 1);
  const epoch = 1_800_000_000;
  for (const t of starts) await fs.copyFile(path.join(dir, "src", "000.ts"), path.join(dir, segmentName(epoch + t)));
  await fs.rm(path.join(dir, "src"), { recursive: true });
}

const range = (from, to, step = 6) => Array.from({ length: Math.ceil((to - from) / step) }, (_, i) => from + i * step);

/** One message a second from 7 regulars, and a burst of 35 fans in each 6 s from every second in `bursts`. */
async function makeChatBursts(file, seconds, bursts) {
  const lines = [];
  for (let t = 0; t < seconds; t++) lines.push({ t, user: `reg${t % 7}`, text: "hello", emotes: 0 });
  for (const at of bursts) for (let i = 0; i < 35; i++) lines.push({ t: at + i * (6 / 35), user: `fan${at}-${i}`, text: "POGGERS", emotes: 1 });
  lines.sort((a, b) => a.t - b.t);
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** One message a second from 7 regulars, plus a burst of 35 different users in the 6 s from `burstAt`. */
async function makeChat(file, seconds, burstAt) {
  const lines = [];
  for (let t = 0; t < seconds; t++) lines.push({ t, user: `reg${t % 7}`, text: "hello", emotes: 0 });
  if (burstAt !== null) {
    for (let i = 0; i < 35; i++) lines.push({ t: burstAt + i * (6 / 35), user: `fan${i}`, text: "POGGERS", emotes: 1 });
  }
  lines.sort((a, b) => a.t - b.t);
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env } });
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
      resolve({ code, stdout, stderr, json, child });
    });
  });
}

/** Minutes and seconds ffmpeg prints for a file, as seconds. */
function durationOf(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file], { encoding: "utf8", env: toolEnv() });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr);
  assert.ok(m, `no duration in: ${r.stderr}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function onlySession(home, channel) {
  const root = path.join(home, "boqo-sniper", "watch", sessionFolder(channel));
  const names = await fs.readdir(root);
  assert.equal(names.length, 1, `one session folder, got ${names}`);
  return path.join(root, names[0]);
}

test("replay: one burst makes one ~300 s moment, then 10 offline polls end the run", { timeout: 180000 }, async () => {
  const work = await tmp("replay");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 70);
    await makeChat(path.join(work, "chat.jsonl"), 420, 300);
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "1000" };
    const t0 = Date.now();
    const r = await run(WATCH, ["Chan_One", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 < 120000, "the replay runs on a simulated clock, not in real time");
    assert.equal(r.stdout.trim().split("\n").length, 1, "one JSON line on stdout");
    assert.equal(r.json.state, "offline");
    assert.equal(r.json.offlinePolls, 10, "the poller said offline exactly 10 times before the run ended");

    const session = await onlySession(home, "chan_one");
    const status = JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
    assert.deepEqual(Object.keys(status).sort(), ["channel", "chatPerSec", "moments", "platform", "segments", "since", "skipped", "state", "updatedAt"]);
    assert.deepEqual(status.skipped, { queue: 0, disk: 0 });
    assert.equal(status.state, "offline");
    assert.equal(status.channel, "chan_one");
    assert.equal(status.platform, "twitch");
    assert.equal(status.moments, 1);
    await assert.rejects(fs.access(path.join(session, "watch.pid")), "the pid file goes with the process");

    const momentNames = await fs.readdir(path.join(session, "moments"));
    assert.equal(momentNames.length, 1, `exactly one moment, got ${momentNames}`);
    assert.match(momentNames[0], /^\d{8}-\d{6}$/, "UTC stamp, no colons");
    const dir = path.join(session, "moments", momentNames[0]);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["chat.json", "meta.json", "video.mp4"]);

    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    // the hosted detector's candidate: a chat moment, titled by its repeated message
    assert.equal(meta.signal, "chat");
    assert.equal(meta.reason, "chat", "v0.1's name for the signal stays for the moment docs");
    assert.ok(meta.score >= 60 && meta.score <= 100, `score ${meta.score}`);
    assert.equal(meta.title, 'chat spike — "POGGERS" ×35');
    assert.match(meta.signalLine, /^POGGERS ×35 · \d+\/s$/);
    assert.ok(meta.detail.chatPerSec >= 2 && Number.isFinite(meta.detail.chatBaseline));
    assert.equal(typeof meta.detail.loudness, "number", "the replay's loudness is read from its segments");
    assert.ok(Number.isInteger(meta.peakAt), "a peak is a wall-clock second");
    // the burst is the segment at 300-306 s of a replay whose clock starts at launch
    assert.ok(Math.abs(meta.peakAt - (t0 / 1000 + 303)) < 20, `peakAt ${meta.peakAt}`);
    assert.equal(momentNames[0], stamp(new Date(meta.peakAt * 1000)));

    const dur = durationOf(path.join(dir, "video.mp4"));
    assert.ok(dur > 290 && dur < 320, `video is ${dur} s, expected about 300`);

    const chat = JSON.parse(await fs.readFile(path.join(dir, "chat.json"), "utf8"));
    assert.ok(Array.isArray(chat) && chat.length > 100);
    assert.ok(chat.some((c) => c.user.startsWith("fan")));
    assert.ok(chat.every((c) => c.t >= 0 && c.t <= dur + 1));

    // the status tool and next both read what the watcher wrote
    const s = await run(STATUS, ["chan_one"], env);
    assert.equal(s.code, 0);
    assert.equal(s.json.state, "offline");
    const n = await run(NEXT, ["chan_one", "--timeout", "5"], env);
    assert.equal(n.json.moment, dir);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("replay: a 24 s hole in the capture fires no moment on ordinary chat", { timeout: 180000 }, async () => {
  const work = await tmp("hole");
  const home = path.join(work, "home");
  try {
    // 0 .. 192, a hole from 198 to 222, then 222 .. 414 (starts 30 s apart: past GAP_SEC, so a hole)
    await makeStampedSegments(path.join(work, "segs"), [...range(0, 198), ...range(222, 420)]);
    // a message a second from 50 regulars in turn: 6 chatters in every 6 s, 24 in the hole's 24
    const lines = Array.from({ length: 430 }, (_, t) => ({ t, user: `u${t % 50}`, text: "hello", emotes: 0 }));
    await fs.writeFile(path.join(work, "chat.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100" };
    const r = await run(WATCH, ["holey", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    const session = await onlySession(home, "holey");
    assert.deepEqual(await fs.readdir(path.join(session, "moments")), [], "the hole is not a spike");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("replay: a burst after a hole is cut from after the hole, with peak and chat on the video's clock", { timeout: 180000 }, async () => {
  const work = await tmp("hole-burst");
  const home = path.join(work, "home");
  try {
    // 0 .. 294, a hole from 300 to 324, then 324 .. 618; the burst is in 384-390
    await makeStampedSegments(path.join(work, "segs"), [...range(0, 300), ...range(324, 624)]);
    await makeChat(path.join(work, "chat.jsonl"), 630, 384);
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100" };
    const r = await run(WATCH, ["holeburst", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    const session = await onlySession(home, "holeburst");
    const names = await fs.readdir(path.join(session, "moments"));
    assert.equal(names.length, 1, `one moment, got ${names}`);
    const dir = path.join(session, "moments", names[0]);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    assert.equal(meta.peakOffsetSec, meta.peakAt - meta.startAt);
    assert.equal(meta.peakOffsetSec, 64, "the cut starts on the segment at 324; the peak is 388, the first second whose 5 s chat window is all burst");
    const dur = durationOf(path.join(dir, "video.mp4"));
    assert.ok(Math.abs(dur - (meta.endAt - meta.startAt)) < 2, `video ${dur} s, wall clock ${meta.endAt - meta.startAt} s`);
    assert.ok(dur > 91 && dur < 101, `video is ${dur} s, expected 96 (324 to 420)`);
    const fans = JSON.parse(await fs.readFile(path.join(dir, "chat.json"), "utf8")).filter((c) => c.user.startsWith("fan"));
    assert.equal(fans.length, 35);
    assert.ok(fans.every((c) => c.t >= 60 && c.t < 66), "the burst sits 60-66 s into the video, as it does on the wall clock");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

/** One message a second from 7 regulars (none in `silent` [from, to)), 35 fans in the 6 s from each burst's `at` saying its `text`, and the socket `states`. */
async function makeChatWith(file, seconds, { bursts = [], silent = null, states = [] }) {
  const lines = [];
  for (let t = 0; t < seconds; t++) {
    if (silent && t >= silent[0] && t < silent[1]) continue;
    lines.push({ t, user: `reg${t % 7}`, text: "hello", emotes: 0 });
  }
  for (const { at, text } of bursts) for (let i = 0; i < 35; i++) lines.push({ t: at + i * (6 / 35), user: `fan${at}-${i}`, text, emotes: 1 });
  lines.push(...states);
  lines.sort((a, b) => a.t - b.t);
  await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function momentMetas(home, channel) {
  const session = await onlySession(home, channel);
  const names = (await fs.readdir(path.join(session, "moments"))).sort();
  return Promise.all(names.map(async (n) => JSON.parse(await fs.readFile(path.join(session, "moments", n, "meta.json"), "utf8"))));
}

test("replay: while the chat socket is closed nothing it carries counts, and the baseline stays the open chat's", { timeout: 240000 }, async () => {
  const work = await tmp("closed");
  try {
    await makeSegments(path.join(work, "segs"), 80);
    // the socket is down for 100-200 (a silent chat) and 280-330 (with the EARLY burst at 300 in it); LATE at 400 is open
    const bursts = [{ at: 300, text: "EARLY" }, { at: 400, text: "LATE" }];
    const states = [
      { t: 100, chatState: "connecting" },
      { t: 200, chatState: "open" },
      { t: 280, chatState: "connecting" },
      { t: 330, chatState: "open" },
    ];
    await makeChatWith(path.join(work, "closed.jsonl"), 480, { bursts, silent: [100, 200], states });
    await makeChatWith(path.join(work, "open.jsonl"), 480, { bursts, silent: [100, 200] }); // the control: the same chat, never closed
    const watch = async (name, chatFile) => {
      const home = path.join(work, name);
      const r = await run(WATCH, [name, "--replay", path.join(work, "segs"), "--chat", path.join(work, chatFile)], {
        BOQO_HOME: home,
        BOQO_SNIPER_POLL_MS: "100",
      });
      assert.equal(r.code, 0, r.stderr);
      return momentMetas(home, name);
    };
    const [closed, open] = await Promise.all([watch("closed", "closed.jsonl"), watch("open", "open.jsonl")]);

    assert.deepEqual(open.map((m) => m.title), ['chat spike — "EARLY" ×35', 'chat spike — "LATE" ×35'], "the control hears both bursts");
    assert.deepEqual(closed.map((m) => m.title), ['chat spike — "LATE" ×35'], "a burst while the socket is closed is no moment");
    // Every open second carried one message, so the baseline LATE is judged on is the open chat's alone: 249
    // open seconds of 1 a second (1-99, 200-279, 330-399), then the four seconds of the burst's own rise before
    // its peak at 404 (five-second means 2.2, 3.4, 4.6, 5.8). The control, which feeds the same seconds as open
    // ones (the silent hundred pull its baseline down, the EARLY burst up), does not read that.
    const oracle = new EwmaStat(1 - Math.exp(-1 / 300));
    for (const x of [...Array(249).fill(1), 2.2, 3.4, 4.6, 5.8]) oracle.update(x);
    assert.ok(Math.abs(closed[0].detail.chatBaseline - oracle.baseline()) < 0.01, `baseline ${closed[0].detail.chatBaseline}, open chat alone ${oracle.baseline()}`);
    assert.ok(Math.abs(open[1].detail.chatBaseline - oracle.baseline()) > 0.05, `control baseline ${open[1].detail.chatBaseline}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("replay: a quiet stream makes no moment and the buffer stays within its horizon", { timeout: 180000 }, async () => {
  const work = await tmp("quiet");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 40);
    await makeChat(path.join(work, "chat.jsonl"), 400, null);
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "1000", BOQO_SNIPER_HORIZON_SEC: "100", BOQO_SNIPER_KEEP_BUF: "1" };
    const r = await run(WATCH, ["quiet", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    const session = await onlySession(home, "quiet");
    assert.deepEqual(await fs.readdir(path.join(session, "moments")), []);
    const bufFiles = (await fs.readdir(path.join(session, "buf"))).filter((f) => f.endsWith(".ts"));
    assert.ok(bufFiles.length <= 18 && bufFiles.length >= 15, `${bufFiles.length} segments kept for a 100 s horizon`);
    assert.equal(JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8")).moments, 0);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("stop.mjs stops a running watcher; a second watcher on the channel is refused", { timeout: 120000 }, async () => {
  const work = await tmp("stop");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 6);
    await makeChat(path.join(work, "chat.jsonl"), 60, null);
    // 1 simulated second per real second, so the run is still going when we stop it
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "1000", BOQO_SNIPER_REPLAY_SPEED: "1" };
    const args = ["stopme", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")];
    const watching = run(WATCH, args, env);

    const root = path.join(home, "boqo-sniper", "watch", "twitch-stopme");
    let session = null;
    for (let i = 0; i < 100 && !session; i++) {
      try {
        const names = await fs.readdir(root);
        if (names[0]) {
          await fs.access(path.join(root, names[0], "watch.pid"));
          await fs.access(path.join(root, names[0], "status.json"));
          session = path.join(root, names[0]);
        }
      } catch {}
      if (!session) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(session, "the watcher created its session folder");

    const second = await run(WATCH, args, env);
    assert.equal(second.code, 1);
    assert.match(second.json.error, /already/i);

    const stopped = await run(STOP, ["stopme"], env);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(stopped.json.stopped, true);

    const done = await watching;
    assert.equal(done.code, 0, done.stderr);
    assert.equal(done.json.state, "stopped");
    const status = JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
    assert.equal(status.state, "stopped");
    await assert.rejects(fs.access(path.join(session, "watch.pid")));

    const again = await run(STOP, ["stopme"], env);
    assert.equal(again.code, 0);
    assert.equal(again.json.stopped, false);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a capture that stops producing without exiting is killed and the watcher moves on", { timeout: 120000 }, async () => {
  const work = await tmp("stall");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 1);
    // A source that writes one clip, then hangs like a dead connection: no more data, no exit.
    const hang = path.join(work, "hang.mjs");
    await fs.writeFile(
      hang,
      'import fs from "node:fs";\nprocess.stdout.write(fs.readFileSync(process.argv[2]));\nsetInterval(() => {}, 1e6);\n',
    );
    const env = {
      BOQO_HOME: home,
      BOQO_SNIPER_SOURCE: JSON.stringify([process.execPath, hang, path.join(work, "segs", "000.ts")]),
      BOQO_SNIPER_STALL_SEC: "3",
      BOQO_SNIPER_POLL_MS: "200",
    };
    const r = await run(WATCH, ["stuck"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /capture stalled/);
    assert.equal(r.json.state, "offline", "after the stall it waited, polled, and ended");
    assert.equal(r.json.offlinePolls, 10);
    assert.equal(r.json.moments, 0);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a channel that is offline from the start also ends after 10 offline polls", { timeout: 60000 }, async () => {
  const work = await tmp("offline");
  try {
    // The source dies at once: nothing to record.
    const env = {
      BOQO_HOME: path.join(work, "home"),
      BOQO_SNIPER_SOURCE: JSON.stringify([process.execPath, "-e", "process.exit(1)"]),
      BOQO_SNIPER_POLL_MS: "100",
    };
    const r = await run(WATCH, ["nobody"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.state, "offline");
    assert.equal(r.json.offlinePolls, 10);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

/** Wait until the watcher's session folder has its pid file and status; returns the folder. */
async function waitForSession(home, channel) {
  const root = path.join(home, "boqo-sniper", "watch", sessionFolder(channel));
  for (let i = 0; i < 100; i++) {
    try {
      const names = await fs.readdir(root);
      if (names[0]) {
        await fs.access(path.join(root, names[0], "watch.pid"));
        await fs.access(path.join(root, names[0], "status.json"));
        return path.join(root, names[0]);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("the watcher never created its session folder");
}

/** What a failed run must leave: exit 1 (or `exitCode`), one {"error"} line, status "failed" with that error, no pid, and next/status saying so. */
async function assertFailed(r, session, channel, env, pattern, exitCode = 1) {
  assert.equal(r.code, exitCode, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 1, "one JSON line on stdout");
  assert.match(r.json.error, pattern);
  const status = JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
  assert.equal(status.state, "failed");
  assert.equal(status.error, r.json.error, "status.json carries the same error");
  await assert.rejects(fs.access(path.join(session, "watch.pid")), "the pid file goes with the process");
  const n = await run(NEXT, [channel, "--timeout", "5"], env);
  assert.equal(n.code, 0);
  assert.deepEqual(n.json, { stopped: "failed", error: r.json.error });
  const s = await run(STATUS, [channel], env);
  assert.equal(s.json.state, "failed");
  assert.equal(s.json.error, r.json.error);
}

test("a replay source that cannot be read fails, and status.json says why", { timeout: 60000 }, async () => {
  const work = await tmp("badsrc");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 2);
    await fs.writeFile(path.join(work, "chat.jsonl"), "this is not json\n");
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100" };
    const r = await run(WATCH, ["badsrc", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    await assertFailed(r, await onlySession(home, "badsrc"), "badsrc", env, /^replay: /);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a source that errors mid-run fails the watcher: status.json and next say failed, with the error", { timeout: 120000 }, async () => {
  const work = await tmp("midfail");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 8);
    await makeChat(path.join(work, "chat.jsonl"), 80, null);
    // 5 simulated seconds per real second: segment 6 is read about 7 s after the start
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_REPLAY_SPEED: "5" };
    const watching = run(WATCH, ["midfail", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    const session = await waitForSession(home, "midfail");
    await fs.rm(path.join(work, "segs", "006.ts"));
    const r = await watching;
    await assertFailed(r, session, "midfail", env, /ENOENT|no such file/i);
    const buf = (await fs.readdir(path.join(session, "buf"))).filter((f) => f.endsWith(".ts"));
    assert.deepEqual(buf, [], "a failed run still empties its buffer");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a capture that keeps failing while the channel is live ends failed, with what the capture said", { timeout: 120000 }, async () => {
  const work = await tmp("capfail");
  const home = path.join(work, "home");
  try {
    const env = {
      BOQO_HOME: home,
      // the source dies at once, every time, with a reason on stderr; the poller says the channel is live
      BOQO_SNIPER_SOURCE: JSON.stringify([process.execPath, "-e", 'console.error("ERROR: HTTP Error 403: Forbidden"); process.exit(1)']),
      BOQO_SNIPER_TEST_LIVE: "1",
      BOQO_SNIPER_POLL_MS: "50",
    };
    const r = await run(WATCH, ["capfail"], env);
    await assertFailed(r, await onlySession(home, "capfail"), "capfail", env, /403: Forbidden/);
    assert.match(r.json.error, /10 times/);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a Kick channel whose API answers 403 stops the start: kick refused: 403, exit 2, status failed, no capture", { timeout: 60000 }, async () => {
  const work = await tmp("kick403");
  const home = path.join(work, "home");
  try {
    const env = {
      BOQO_HOME: home,
      // a source that would record, if the watch got that far: it must not be started
      BOQO_SNIPER_SOURCE: JSON.stringify([process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', path.join(work, "capture-ran")]),
      BOQO_SNIPER_TEST_LIVE: "1",
      BOQO_SNIPER_TEST_KICK_STATUS: "403",
    };
    const r = await run(WATCH, ["kick:x-q_c"], env);
    await assertFailed(r, await onlySession(home, "kick:x-q_c"), "kick:x-q_c", env, /^kick refused: 403$/, 2);
    assert.equal(path.basename(path.dirname(await onlySession(home, "kick:x-q_c"))), "kick-x-q_c");
    await assert.rejects(fs.access(path.join(work, "capture-ran")), "the capture never started");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test(
  "a stalled source that ignores SIGTERM is killed hard and the watcher moves on",
  { timeout: 90000, skip: process.platform === "win32" ? "taskkill /F is already a hard kill" : false },
  async () => {
    const work = await tmp("stubborn");
    const home = path.join(work, "home");
    try {
      await makeSegments(path.join(work, "segs"), 1);
      const hang = path.join(work, "hang.mjs");
      await fs.writeFile(
        hang,
        'import fs from "node:fs";\nprocess.on("SIGTERM", () => {});\nprocess.stdout.write(fs.readFileSync(process.argv[2]));\nsetInterval(() => {}, 1e6);\n',
      );
      const env = {
        BOQO_HOME: home,
        BOQO_SNIPER_SOURCE: JSON.stringify([process.execPath, hang, path.join(work, "segs", "000.ts")]),
        BOQO_SNIPER_STALL_SEC: "3",
        BOQO_SNIPER_POLL_MS: "100",
      };
      const t0 = Date.now();
      const r = await run(WATCH, ["stubborn"], env);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, /capture stalled/);
      assert.equal(r.json.state, "offline");
      assert.ok(Date.now() - t0 < 60000, "SIGKILL followed within seconds");
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  },
);

test("an uncaught exception or an unhandled rejection fails the watcher, and status.json says why", { timeout: 120000 }, async () => {
  for (const kind of ["throw", "reject"]) {
    const work = await tmp(`crash-${kind}`);
    const home = path.join(work, "home");
    try {
      await makeSegments(path.join(work, "segs"), 6);
      await makeChat(path.join(work, "chat.jsonl"), 60, null);
      const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_REPLAY_SPEED: "1", BOQO_SNIPER_TEST_CRASH: kind };
      const r = await run(WATCH, ["crashy", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
      const session = await onlySession(home, "crashy");
      await assertFailed(r, session, "crashy", env, new RegExp(`test crash \\(${kind}\\)`));
      const buf = (await fs.readdir(path.join(session, "buf"))).filter((f) => f.endsWith(".ts"));
      assert.deepEqual(buf, [], `${kind}: a crashed run empties its buffer`);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }
});

test("a full queue skips a new moment, and status.json counts it", { timeout: 180000 }, async () => {
  const work = await tmp("queue");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 100);
    await makeChatBursts(path.join(work, "chat.jsonl"), 600, [300, 498]);
    // a queue of one: the first moment waits unclaimed, so the second is skipped
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_MAX_QUEUE: "1" };
    const r = await run(WATCH, ["queued", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /skipped: 1 moment waits to be judged/);
    const session = await onlySession(home, "queued");
    assert.equal((await fs.readdir(path.join(session, "moments"))).length, 1);
    const status = JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
    assert.equal(status.moments, 1);
    assert.deepEqual(status.skipped, { queue: 1, disk: 0 });

    // the same stream with both moments in the queue's room: two moments
    const home2 = path.join(work, "home2");
    const r2 = await run(WATCH, ["queued", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], {
      ...env,
      BOQO_HOME: home2,
      BOQO_SNIPER_MAX_QUEUE: "10",
    });
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal((await fs.readdir(path.join(await onlySession(home2, "queued"), "moments"))).length, 2);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("too little free disk skips a moment, and status.json counts it", { timeout: 180000 }, async () => {
  const work = await tmp("disk");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 70);
    await makeChat(path.join(work, "chat.jsonl"), 420, 300);
    // ask for an exabyte free
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_MIN_FREE_MB: "1000000000000" };
    const r = await run(WATCH, ["diskful", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /skipped: only .* free/);
    const session = await onlySession(home, "diskful");
    assert.deepEqual(await fs.readdir(path.join(session, "moments")), []);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8")).skipped, { queue: 0, disk: 1 });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test(
  "after a stop nothing the capture started still runs, even a grandchild that ignores SIGTERM",
  { timeout: 90000, skip: process.platform === "win32" ? "taskkill /T /F ends the tree at once" : false },
  async () => {
    const work = await tmp("tree");
    const home = path.join(work, "home");
    try {
      await makeSegments(path.join(work, "segs"), 1);
      // like yt-dlp: the source runs a helper (here one that shrugs off SIGTERM), then streams
      const helper = path.join(work, "helper.mjs");
      await fs.writeFile(helper, 'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1e6);\n');
      const pidFile = path.join(work, "helper.pid");
      const source = path.join(work, "source.mjs");
      await fs.writeFile(
        source,
        [
          'import fs from "node:fs";',
          'import { spawn } from "node:child_process";',
          `const h = spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: "ignore" });`,
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(h.pid));`,
          "process.stdout.write(fs.readFileSync(process.argv[2]));",
          "setInterval(() => {}, 1e6);",
          "",
        ].join("\n"),
      );
      const env = {
        BOQO_HOME: home,
        BOQO_SNIPER_SOURCE: JSON.stringify([process.execPath, source, path.join(work, "segs", "000.ts")]),
        BOQO_SNIPER_POLL_MS: "200",
      };
      const watching = run(WATCH, ["tree"], env);
      await waitForSession(home, "tree");
      let helperPid = null;
      for (let i = 0; i < 100 && !helperPid; i++) {
        helperPid = Number(await fs.readFile(pidFile, "utf8").catch(() => "")) || null;
        if (!helperPid) await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(helperPid, "the source started its helper");
      const stopped = await run(STOP, ["tree"], env);
      assert.equal(stopped.json.stopped, true, stopped.stdout);
      const done = await watching;
      assert.equal(done.json.state, "stopped", done.stderr);
      let alive = true;
      try {
        process.kill(helperPid, 0);
      } catch {
        alive = false;
      }
      if (alive) process.kill(helperPid, "SIGKILL");
      assert.equal(alive, false, "the helper was still running when stop.mjs returned");
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  },
);
