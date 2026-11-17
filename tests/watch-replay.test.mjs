import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pidAlive, sessionFolder, stamp } from "../lib/session.mjs";
import { segmentName } from "../lib/buffer.mjs";
import { toolEnv } from "../engine/env.mjs";
import { EwmaStat } from "../lib/boqo/moments.mjs";
import { renderClip } from "../engine/render.mjs";
import { segmentsFromWords } from "../engine/segments.mjs";
import { startMoment, stepMoment } from "../lib/moment-run.mjs";

const WATCH = fileURLToPath(new URL("../tools/watch.mjs", import.meta.url));
const STOP = fileURLToPath(new URL("../tools/stop.mjs", import.meta.url));
const STATUS = fileURLToPath(new URL("../tools/status.mjs", import.meta.url));
const NEXT = fileURLToPath(new URL("../tools/next.mjs", import.meta.url));
const MOMENT = fileURLToPath(new URL("../tools/moment.mjs", import.meta.url));

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
    // a small floor: this test is about the status file's keys, not about the machine's free space
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "1000", BOQO_SNIPER_MIN_FREE_MB: "1" };
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
    assert.equal(meta.reason, undefined, "the old name of signal is gone");
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

// SKILL.md's "Another agent" start is `nohup node watch.mjs … > <log> 2>&1 &`. Node resets the SIGHUP that nohup ignores to
// its default (measured 2026-11-17, Node v22.20.0 on Linux: /proc/<pid>/status SigIgn without bit 0 under nohup, and
// the control below exits on the signal), so the watcher's own listener is all that keeps a hangup from ending it.
test(
  "under nohup a hangup does not stop the watcher: it keeps recording until stop.mjs",
  { timeout: 120000, skip: process.platform === "win32" ? "no nohup; Windows' SIGHUP is the console closing" : false },
  async () => {
    const work = await tmp("nohup");
    const home = path.join(work, "home");
    try {
      // the control: under nohup, a Node process with no listener of its own still dies of SIGHUP
      const control = spawn("nohup", [process.execPath, "-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 500));
      control.kill("SIGHUP");
      const [code, signal] = await new Promise((r) => control.on("exit", (c, sig) => r([c, sig])));
      assert.ok(signal === "SIGHUP" || code === 129, `the control should die of the hangup: code ${code}, signal ${signal}`);

      await makeSegments(path.join(work, "segs"), 6);
      await makeChat(path.join(work, "chat.jsonl"), 60, null);
      const log = path.join(work, "watch.log");
      const out = await fs.open(log, "w");
      const env = { ...process.env, BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "1000", BOQO_SNIPER_REPLAY_SPEED: "1" };
      const child = spawn("nohup", [process.execPath, WATCH, "hupchan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], {
        env,
        stdio: ["ignore", out.fd, out.fd],
      });
      const exited = new Promise((r) => child.on("exit", (c, sig) => r({ code: c, signal: sig })));
      const session = await waitForSession(home, "hupchan");
      const pid = Number(await fs.readFile(path.join(session, "watch.pid"), "utf8"));
      assert.equal(pid, child.pid, "nohup ran the watcher in its own process");
      const readStatusFile = async () => JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
      process.kill(pid, "SIGHUP");
      await new Promise((r) => setTimeout(r, 2500));
      assert.ok(pidAlive(pid), "the watcher is still running after the hangup");
      // and still recording: it writes its status again (each replayed 6 s segment is a write), not as stopped
      const afterHangup = await readStatusFile();
      let later = null;
      for (let i = 0; i < 200 && !later; i++) {
        const st = await readStatusFile();
        if (st.updatedAt !== afterHangup.updatedAt || st.segments !== afterHangup.segments) later = st;
        else await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(later, "a status written after the hangup");
      assert.notEqual(later.state, "stopped");
      assert.ok(pidAlive(pid));

      const stopped = await run(STOP, ["hupchan"], env);
      assert.equal(stopped.json.stopped, true, stopped.stdout);
      const end = await exited;
      await out.close();
      assert.equal(end.code, 0);
      const text = await fs.readFile(log, "utf8");
      assert.match(text, /hangup ignored/);
      assert.equal(JSON.parse(text.trim().split("\n").at(-1)).state, "stopped", "the stop is stop.mjs's, not the hangup's");
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  },
);

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

/** A `seconds`-long test pattern and tone as MPEG-TS, a keyframe a second. */
function makeTs(file, seconds) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `testsrc=size=160x90:rate=25:duration=${seconds}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mpegts", file,
    ],
    { encoding: "utf8", env: toolEnv() },
  );
  assert.equal(r.status, 0, r.stderr);
}
const catSource = (file) => JSON.stringify([process.execPath, "-e", 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', file]);
const segFiles = async (bufDir) => (await fs.readdir(bufDir)).filter((f) => /^seg_\d{6}\.ts$/.test(f)).sort();

test("a source that delivers 60 s in one burst: the watcher keeps all ten segments, none overwritten", { timeout: 120000 }, async () => {
  const work = await tmp("burst");
  const home = path.join(work, "home");
  try {
    makeTs(path.join(work, "src.ts"), 60);
    const env = {
      BOQO_HOME: home,
      BOQO_SNIPER_SOURCE: catSource(path.join(work, "src.ts")), // written at once, as a stalled HLS stream catching up is
      BOQO_SNIPER_POLL_MS: "100",
      BOQO_SNIPER_KEEP_BUF: "1",
    };
    const r = await run(WATCH, ["burstchan"], env);
    assert.equal(r.code, 0, r.stderr);
    const session = await onlySession(home, "burstchan");
    const files = await segFiles(path.join(session, "buf"));
    assert.deepEqual(files, Array.from({ length: 10 }, (_, i) => `seg_${String(i).padStart(6, "0")}.ts`));
    const status = JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
    assert.equal(status.segments, 10, "the watcher counted every one");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a capture restart in a session continues the segment counter: no name is reused", { timeout: 120000 }, async () => {
  const work = await tmp("restart");
  const home = path.join(work, "home");
  try {
    makeTs(path.join(work, "src.ts"), 13); // three segments a capture: 6 s, 6 s and a short last one
    const env = {
      BOQO_HOME: home,
      BOQO_SNIPER_SOURCE: catSource(path.join(work, "src.ts")), // the source ends, the channel still says live: the next capture starts
      BOQO_SNIPER_TEST_LIVE: "1",
      BOQO_SNIPER_POLL_MS: "50",
      BOQO_SNIPER_KEEP_BUF: "1",
    };
    const watching = run(WATCH, ["restarty"], env);
    const session = await waitForSession(home, "restarty");
    const bufDir = path.join(session, "buf");
    let files = [];
    for (let i = 0; i < 300 && files.length < 9; i++) {
      files = await segFiles(bufDir);
      if (files.length < 9) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(files.length >= 9, `three captures' segments: ${files}`);
    await fs.writeFile(path.join(session, "stop"), "1");
    const done = await watching;
    assert.equal(done.code, 0, done.stderr);
    files = await segFiles(bufDir);
    assert.deepEqual(files, Array.from({ length: files.length }, (_, i) => `seg_${String(i).padStart(6, "0")}.ts`), "consecutive, from 0, each once");
    assert.ok(files.length >= 9);
    const status = JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
    assert.equal(status.segments, files.length);
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
    await assertFailed(r, await onlySession(home, "kick:x-q_c"), "kick:x-q_c", env, /^kick refused: 403 \(kick\.com, behind Cloudflare, turned this network away; Kick support is experimental\)$/, 2);
    assert.equal(path.basename(path.dirname(await onlySession(home, "kick:x-q_c"))), "kick-x-q_c");
    await assert.rejects(fs.access(path.join(work, "capture-ran")), "the capture never started");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a Kick channel API that never answers: tried 3 times, then kick lookup timed out, exit 2, status failed, no capture", { timeout: 60000 }, async () => {
  const work = await tmp("kickhang");
  const home = path.join(work, "home");
  try {
    const env = {
      BOQO_HOME: home,
      BOQO_SNIPER_SOURCE: JSON.stringify([process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', path.join(work, "capture-ran")]),
      BOQO_SNIPER_TEST_LIVE: "1",
      BOQO_SNIPER_TEST_KICK_HANG: "1",
      BOQO_SNIPER_KICK_LOOKUP_MS: "300",
    };
    const r = await run(WATCH, ["kick:xqc"], env);
    await assertFailed(r, await onlySession(home, "kick:xqc"), "kick:xqc", env, /^kick lookup timed out \(3 tries\)$/, 2);
    await assert.rejects(fs.access(path.join(work, "capture-ran")), "the capture never started");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a Kick capture refused by kick.com (yt-dlp's HTTP Error 403) ends the watch at once, saying so: not offline after 10 silent polls", { timeout: 60000 }, async () => {
  const work = await tmp("kickcap");
  const home = path.join(work, "home");
  try {
    const env = {
      BOQO_HOME: home,
      // what yt-dlp 2026.08.19 prints when kick.com's channel API turns it away (no browser to impersonate, or a refused network)
      BOQO_SNIPER_SOURCE: JSON.stringify([
        process.execPath, "-e",
        'console.error("ERROR: [kick:live] xqc: Unable to download JSON metadata: HTTP Error 403: Forbidden (caused by <HTTPError 403: Forbidden>)"); process.exit(1)',
      ]),
      BOQO_SNIPER_TEST_KICK_STATUS: "200", // the watcher's own channel lookup (its chat) was let in
      BOQO_SNIPER_POLL_MS: "2000", // 10 offline polls would take 20 s
    };
    const t0 = Date.now();
    const r = await run(WATCH, ["kick:xqc"], env);
    await assertFailed(r, await onlySession(home, "kick:xqc"), "kick:xqc", env, /^kick refused the capture: yt-dlp got HTTP Error 403 from kick\.com/, 2);
    assert.ok(Date.now() - t0 < 10000, `ended after the first capture, not after the polls: ${Date.now() - t0} ms`);
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
    assert.match(r.stderr, /skipped: 1 moment waits for the agent/);
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

async function writeConfig(home, config) {
  await fs.mkdir(path.join(home, "boqo-sniper"), { recursive: true });
  await fs.writeFile(path.join(home, "boqo-sniper", "config.json"), JSON.stringify(config));
}

test("config.json's settings reach the session: settings.json, a 120 s window cut, a 180 s buffer", { timeout: 180000 }, async () => {
  const work = await tmp("settings");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 70);
    await makeChat(path.join(work, "chat.jsonl"), 420, 300);
    await writeConfig(home, { sensitivity: 60, windowSec: 120, autoClipMinScore: 55, prompt: "  funny \n fails ", visionPerHour: 90 });
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_KEEP_BUF: "1" };
    const r = await run(WATCH, ["chan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    const session = await onlySession(home, "chan");
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(session, "settings.json"), "utf8")), {
      sensitivity: 60, autoClip: true, autoClipMinScore: 55, windowSec: 120, prompt: "funny fails", visionPerHour: 90,
    });
    const [name] = await fs.readdir(path.join(session, "moments"));
    const dir = path.join(session, "moments", name);
    const d = durationOf(path.join(dir, "video.mp4"));
    assert.ok(d >= 114 && d <= 132, `a 120 s window, got ${d}`);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    assert.ok(meta.peakOffsetSec >= 84 && meta.peakOffsetSec <= 96, `the peak is windowSec - 30 in, got ${meta.peakOffsetSec}`);
    // the buffer keeps windowSec + 60 = 180 s: 30 segments of 6 s, plus the one being written
    const left = (await fs.readdir(path.join(session, "buf"))).filter((n) => n.endsWith(".ts"));
    assert.ok(left.length <= 32 && left.length >= 28, `${left.length} segments left`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("a setting out of its range fails the start with hosted's words, before any session exists", { timeout: 60000 }, async () => {
  const work = await tmp("badsettings");
  const home = path.join(work, "home");
  try {
    await writeConfig(home, { windowSec: 90 });
    const r = await run(WATCH, ["chan", "--replay", work, "--sensitivity", "70"], { BOQO_HOME: home });
    assert.equal(r.code, 1);
    assert.equal(r.json.error, "config.json: windowSec must be a whole number between 120 and 600.");
    await assert.rejects(fs.access(path.join(home, "boqo-sniper", "watch")));
    await writeConfig(home, {});
    const r2 = await run(WATCH, ["chan", "--replay", work, "--sensitivity", "20"], { BOQO_HOME: home });
    assert.equal(r2.json.error, "sensitivity must be a whole number between 30 and 95.");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("autoClip off: the burst's moment is cut and listed, `next` tells of it once and does not claim it, `--take` does", { timeout: 180000 }, async () => {
  const work = await tmp("listed");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 70);
    await makeChat(path.join(work, "chat.jsonl"), 420, 300);
    await writeConfig(home, { autoClip: false });
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100" };
    const r = await run(WATCH, ["chan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    const session = await onlySession(home, "chan");
    const [name] = await fs.readdir(path.join(session, "moments"));
    const dir = path.join(session, "moments", name);
    const first = await run(NEXT, ["chan", "--timeout", "5"], env);
    assert.equal(first.json.listed, dir, "listed, not handed out");
    assert.ok(first.json.meta.score >= 60);
    const again = await run(NEXT, ["chan", "--timeout", "5"], env);
    assert.deepEqual(again.json, { stopped: "offline" }, "the watcher is over and the moment is not at the bar");
    const list = await run(NEXT, ["chan", "--list"], env);
    assert.equal(list.json.moments.length, 1);
    assert.equal(list.json.moments[0].band, "exceptional");
    const take = await run(NEXT, ["chan", "--take"], env);
    assert.equal(take.json.moment, dir);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("`--clip-now` makes a moment with score 100 from a quiet stream, as hosted's Clip now", { timeout: 180000 }, async () => {
  const work = await tmp("clipnow");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 70);
    await makeChat(path.join(work, "chat.jsonl"), 420, null);
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_REPLAY_SPEED: "25" };
    const watcher = run(WATCH, ["chan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    // wait for a minute of buffer, then ask
    let session = null;
    for (let i = 0; i < 200 && !session; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const dirs = await fs.readdir(path.join(home, "boqo-sniper", "watch", sessionFolder("chan")));
        const st = JSON.parse(await fs.readFile(path.join(home, "boqo-sniper", "watch", sessionFolder("chan"), dirs[0], "status.json"), "utf8"));
        if (st.segments >= 20) session = dirs[0];
      } catch {}
    }
    assert.ok(session, "the replay got going");
    const ask = await run(WATCH, ["chan", "--clip-now"], env);
    assert.equal(ask.code, 0, ask.stdout + ask.stderr);
    assert.equal(ask.json.clipNow, true);
    const w = await watcher;
    assert.equal(w.code, 0, w.stderr);
    const sdir = await onlySession(home, "chan");
    const names = await fs.readdir(path.join(sdir, "moments"));
    assert.equal(names.length, 1, `one moment, got ${names}`);
    const meta = JSON.parse(await fs.readFile(path.join(sdir, "moments", names[0], "meta.json"), "utf8"));
    assert.equal(meta.score, 100);
    assert.equal(meta.signal, "manual");
    assert.equal(meta.title, "clipped by hand");
    assert.equal(meta.signalLine, null);
    await assert.rejects(fs.access(path.join(sdir, "clipnow")), "the request is consumed");
    const next = await run(NEXT, ["chan", "--timeout", "5"], { BOQO_HOME: home });
    assert.equal(next.json.moment, path.join(sdir, "moments", names[0]), "a hand-made moment is always handed out");
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("`--clip-now` with no watcher running says so, and writes nothing", { timeout: 60000 }, async () => {
  const work = await tmp("clipnow-none");
  const home = path.join(work, "home");
  try {
    const r = await run(WATCH, ["chan", "--clip-now"], { BOQO_HOME: home });
    assert.equal(r.code, 1);
    assert.match(r.json.error, /no watcher is running for twitch.tv\/chan/);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("sensitivity from config.json sets the detector's bar: a faint chat rise fires at 95 and not at 30", { timeout: 240000 }, async () => {
  const work = await tmp("sens");
  try {
    await makeSegments(path.join(work, "segs"), 70);
    // 1 message a second, and from 300 s to 310 s a second one each second (2 a second: z about 2 at the floor sigma)
    const lines = [];
    for (let t = 0; t < 420; t++) lines.push({ t, user: `reg${t % 7}`, text: "hello", emotes: 0 });
    for (let t = 300; t < 310; t++) lines.push({ t: t + 0.5, user: `fan${t}`, text: "pog", emotes: 0 });
    lines.sort((a, b) => a.t - b.t);
    await fs.writeFile(path.join(work, "chat.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const moments = {};
    for (const sensitivity of [30, 95]) {
      const home = path.join(work, `home${sensitivity}`);
      await writeConfig(home, { sensitivity });
      const r = await run(WATCH, ["chan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100" });
      assert.equal(r.code, 0, r.stderr);
      moments[sensitivity] = (await fs.readdir(path.join(await onlySession(home, "chan"), "moments"))).length;
    }
    assert.deepEqual(moments, { 30: 0, 95: 1 });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("moments below the bar are no queue, and none is dropped before the agent was told of it: at the cap a new one is not cut", { timeout: 240000 }, async () => {
  const work = await tmp("listed-cap");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 200);
    await makeChatBursts(path.join(work, "chat.jsonl"), 1200, [300, 498, 696, 894, 1092]);
    await writeConfig(home, { autoClip: false });
    // a queue of one would skip every moment after the first if they counted; they do not. A cap of 3 below the bar.
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_MAX_QUEUE: "1", BOQO_SNIPER_MAX_LISTED: "3" };
    const r = await run(WATCH, ["chan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    const session = await onlySession(home, "chan");
    const names = (await fs.readdir(path.join(session, "moments"))).sort();
    const status = JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
    assert.equal(names.length, 3, `the first 3 stay, none told yet: ${names}`);
    assert.equal(status.moments, 3);
    assert.deepEqual(status.skipped, { queue: 2, disk: 0 }, "the 4th and 5th were not cut");
    assert.equal(status.dropped, undefined, "nothing was dropped");
    for (const n of names) await fs.access(path.join(session, "moments", n, "video.mp4"));
    assert.equal(r.stderr.match(/skipped: 3 moments below the bar wait to be told, or were told under 15 minutes ago/g)?.length, 2);
    const list = await run(NEXT, ["chan", "--list"], env);
    assert.deepEqual(list.json.moments.map((m) => m.name), names);
    assert.equal(list.json.dropped, 0);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

/** The agent's side of a session: `next --timeout 1` again and again until it says stopped. Every line it printed. */
async function nextLoop(channel, env) {
  const lines = [];
  for (let i = 0; i < 400; i++) {
    const r = await run(NEXT, [channel, "--timeout", "1"], env);
    if (r.json && !r.json.timeout) lines.push(r.json);
    if (r.json?.stopped || r.code !== 0) return lines;
  }
  return lines;
}

for (const blocked of [false, true]) {
  test(
    blocked
      ? "a told moment past its keep that cannot be moved out (a lock) is claimed and its video deleted: the new cut stands, nothing is told twice"
      : "at the cap, a moment told more than its keep ago makes room for a new one: it leaves moments/ whole, and the new cut stands",
    { timeout: 240000 },
    async () => {
      const work = await tmp(blocked ? "listed-blocked" : "listed-drop");
      const home = path.join(work, "home");
      try {
        await makeSegments(path.join(work, "segs"), 100);
        await makeChatBursts(path.join(work, "chat.jsonl"), 600, [300, 498]);
        await writeConfig(home, { autoClip: false });
        // one moment below the bar held, kept 1 ms after it was told; 25 simulated seconds a real one, so the agent's
        // loop tells the first moment (about 13 s in) well before the second is cut (about 21 s in)
        const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_REPLAY_SPEED: "25", BOQO_SNIPER_MAX_LISTED: "1", BOQO_SNIPER_LISTED_KEEP_MS: "1" };
        const watching = run(WATCH, ["chan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
        const session = await waitForSession(home, "chan");
        // a file where the trash folder goes: the drop cannot move the folder out, as a Windows lock would stop it
        if (blocked) await fs.writeFile(path.join(session, "trash"), "in the way");
        const told = await nextLoop("chan", env);
        const r = await watching;
        assert.equal(r.code, 0, r.stderr);
        const status = JSON.parse(await fs.readFile(path.join(session, "status.json"), "utf8"));
        assert.equal(status.moments, 2);
        assert.equal(status.dropped, 1);
        assert.deepEqual(status.skipped, { queue: 0, disk: 0 });
        const names = (await fs.readdir(path.join(session, "moments"))).sort();
        const listedNames = told.filter((j) => j.listed).map((j) => path.basename(j.listed));
        assert.equal(listedNames.length, 2, `each moment told once: ${JSON.stringify(told)}`);
        assert.equal(new Set(listedNames).size, 2, "never the same moment twice");
        assert.deepEqual(told.at(-1), { stopped: "offline" });
        const [first, second] = listedNames;
        assert.match(r.stderr, new RegExp(`listed moment ${first} dropped: told 0 minutes ago or more, and 1 moment below the bar is held`));
        assert.doesNotMatch(r.stderr, /cut failed/);
        // the new cut stands, whole
        assert.deepEqual((await fs.readdir(path.join(session, "moments", second))).sort(), [".listed", "chat.json", "meta.json", "video.mp4"]);
        if (blocked) {
          assert.deepEqual(names, [first, second]);
          assert.deepEqual((await fs.readdir(path.join(session, "moments", first))).sort(), [".listed", ".taken", "chat.json", "meta.json"], "claimed, its video gone");
          assert.match(r.stderr, /could not be moved out/);
        } else {
          assert.deepEqual(names, [second], "the dropped one left moments/ whole");
          await assert.rejects(fs.access(path.join(session, "trash")), "the watcher empties trash/ when it ends");
        }
        const list = await run(NEXT, ["chan", "--list"], env);
        assert.deepEqual(list.json.moments.map((m) => m.name), [second]);
        assert.equal(list.json.dropped, 1);
        const gone = await run(NEXT, ["chan", "--take", first], env);
        assert.equal(gone.code, 1);
        assert.match(gone.json.error, blocked ? /is not listed/ : /may have been dropped/);
      } finally {
        await fs.rm(work, { recursive: true, force: true });
      }
    },
  );
}

test("a disk under the floor at start: one stderr line, lowDisk in status and in the end line, and the status stays accurate", { timeout: 180000 }, async () => {
  const work = await tmp("lowdisk");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 20);
    await makeChat(path.join(work, "chat.jsonl"), 120, null);
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_MIN_FREE_MB: "1000000000000" }; // an exabyte
    const r = await run(WATCH, ["chan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr.split("\n").filter((l) => l.startsWith("low disk:")).length, 1, "said once");
    assert.match(r.stderr, /low disk: [\d.]+ GB free, under the 1000000000\.0 GB floor/);
    assert.equal(r.json.lowDisk.minFreeBytes, 1e18);
    assert.ok(r.json.lowDisk.freeBytes > 0);
    const status = JSON.parse(await fs.readFile(path.join(await onlySession(home, "chan"), "status.json"), "utf8"));
    assert.deepEqual(Object.keys(status.lowDisk).sort(), ["freeBytes", "minFreeBytes"]);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

test("`--clip-now` says why nothing will be cut: low disk, an empty buffer, a stream that is not live", { timeout: 60000 }, async () => {
  const work = await tmp("clipnow-refuse");
  const home = path.join(work, "home");
  try {
    const { newSession } = await import("../lib/session.mjs");
    const old = process.env.BOQO_HOME;
    process.env.BOQO_HOME = home;
    let dir;
    try {
      dir = await newSession("chan");
    } finally {
      if (old === undefined) delete process.env.BOQO_HOME;
      else process.env.BOQO_HOME = old;
    }
    // a sleeping process named like the watcher, so watcherPid sees a live watcher
    const fake = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)", "watch.mjs"], { stdio: "ignore" });
    try {
      await fs.writeFile(path.join(dir, "watch.pid"), String(fake.pid));
      const ask = async (status) => {
        await fs.writeFile(path.join(dir, "status.json"), JSON.stringify({ ...status, updatedAt: new Date().toISOString(), channel: "chan" }));
        const r = await run(WATCH, ["chan", "--clip-now"], { BOQO_HOME: home });
        assert.equal(r.code, 0, r.stdout + r.stderr);
        return r.json;
      };
      let j = await ask({ state: "waiting", segments: 0 });
      assert.deepEqual([j.clipNow, j.reason], [false, "buffer empty"]);
      j = await ask({ state: "waiting", segments: 12 });
      assert.deepEqual([j.clipNow, j.reason], [false, "stream waiting"]);
      const low = { freeBytes: 1e9, minFreeBytes: 5e9 };
      j = await ask({ state: "live", segments: 12, lowDisk: low });
      assert.deepEqual([j.clipNow, j.reason, j.lowDisk], [false, "disk", low]);
      await assert.rejects(fs.access(path.join(dir, "clipnow")), "nothing was asked of the watcher");
      j = await ask({ state: "live", segments: 12 });
      assert.equal(j.clipNow, true);
      await fs.access(path.join(dir, "clipnow"));
    } finally {
      fake.kill("SIGKILL");
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
});

// ---- the whole path, offline: a 10-minute stream to the kept clips ----------------------------------------------------

/** `count` six-second 640x360 .ts segments of lavfi video and a tone (a stream's picture is below the 480 lines the panels read needs). */
async function makeStreamSegments(dir, count) {
  await fs.mkdir(dir, { recursive: true });
  const first = path.join(dir, "000.ts");
  const r = spawnSync(
    "ffmpeg",
    [
      "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-f", "mpegts", first,
    ],
    { encoding: "utf8", env: toolEnv() },
  );
  assert.equal(r.status, 0, r.stderr);
  for (let i = 1; i < count; i++) await fs.copyFile(first, path.join(dir, `${String(i).padStart(3, "0")}.ts`));
}

/** whisper's output, injected: a 10-word sentence every 4 s, a word every 0.4 s, over the window. */
async function injectedWords({ run }) {
  const words = [];
  for (let i = 0; i * 0.4 < 299.6; i++) {
    const t = Math.round(i * 0.4 * 100) / 100;
    words.push({ w: i % 10 === 9 ? `word${i}.` : `word${i}`, s: t, e: Math.round((t + 0.3) * 100) / 100 });
  }
  await fs.writeFile(path.join(run, "words.json"), JSON.stringify(words));
  await fs.writeFile(path.join(run, "segments.json"), JSON.stringify(segmentsFromWords(words, { source: "whisper" })));
}

const wireClip = (start, end, i) => ({
  start_sec: start, end_sec: end, title: `Clip ${i}`, hook: `Hook ${i}`, score: 90 - i * 5, hook_score: 80, flow_score: 80,
  standalone_score: 80, value_score: 80, emphasis_words: ["word"], stands_alone: true, claim: "A claim.", bridge_from_sec: null,
  context_line: null, title_alternatives: [`First ${i}`, `Second ${i}`],
});

const STRANGER_ANSWER = {
  hook_type: "visual_action", hook_text: "word word", hook_promises_payoff: true, time_to_payoff_s: 5,
  narrative_arc: "setup_tension_payoff", ends_with: "punchline_or_payoff", comprehensible_without_context: 4,
  share_trigger: "awe_or_surprise", comment_bait: false, caption_style: "word_by_word_highlight",
  caption_position: "lower_third", title_card_or_headline: true, on_screen_text_other: false, broll_or_cutaways: "none",
  layout: "gameplay_plus_cam", visible_zoom_punches_or_jumpcuts: "none", music_present_guess: "unknown",
  emotional_peak: "awe", overall_quality_judgment: 4, one_line_why: "The play lands.",
};

test(
  "offline end to end: a 10-minute stream, one chat burst, one moment, one request with target 5, two kept clips rendered with the presence rule",
  { timeout: 900000 },
  async () => {
    const work = await tmp("e2e");
    const home = path.join(work, "home");
    const oldHome = process.env.BOQO_HOME;
    process.env.BOQO_HOME = home;
    try {
      // 1. the replay: 100 six-second segments (600 s), chat that is ordinary but for one burst at 300 s
      await makeStreamSegments(path.join(work, "segs"), 100);
      await makeChat(path.join(work, "chat.jsonl"), 600, 300);
      const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "1000", BOQO_SNIPER_MIN_FREE_MB: "1" };
      const watch = await run(WATCH, ["e2echan", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
      assert.equal(watch.code, 0, watch.stderr);

      // 2. exactly one moment, a window of about 300 s
      const session = await onlySession(home, "e2echan");
      const momentNames = await fs.readdir(path.join(session, "moments"));
      assert.equal(momentNames.length, 1, `exactly one moment, got ${momentNames}`);
      const moment = path.join(session, "moments", momentNames[0]);
      const meta = JSON.parse(await fs.readFile(path.join(moment, "meta.json"), "utf8"));
      assert.equal(meta.signal, "chat");
      assert.equal(meta.title, 'chat spike — "POGGERS" ×35');
      const dur = durationOf(path.join(moment, "video.mp4"));
      assert.ok(dur > 290 && dur < 320, `window is ${dur} s`);

      // 3. start: whisper (its words injected), then exactly one select-request.md, its target 5
      const start = await startMoment({ moment, asr: injectedWords });
      assert.equal(start.write, "selection");
      assert.equal(start.target, 5, "a 300 s window is a target of 5");
      assert.equal(path.basename(start.request), "select-request.md");
      const clipsRoot = path.dirname(start.run);
      assert.equal(path.dirname(clipsRoot), path.join(home, "boqo-sniper", "clips"));
      const requests = (await fs.readdir(start.run)).filter((f) => f === "select-request.md");
      assert.equal(requests.length, 1);
      assert.match(await fs.readFile(start.request, "utf8"), /word\d/, "the request holds the injected transcript");

      // 4. the agent's selection, from a fixture
      await fs.writeFile(start.answer, JSON.stringify({ clips: [wireClip(20, 40, 1), wireClip(200, 220, 2)] }));

      // 5. step. The first render is in this process, through the real render and onnxruntime, its subject rule seen;
      //    every other step is the CLI as the skill runs it, which must end by returning (exit 0, one JSON line).
      const rules = [];
      const render = async (args) => {
        rules.push(args.subjectRule);
        return renderClip(args);
      };
      const asked = [];
      let last;
      let viaCli = 0;
      for (let i = 0; i < 20 && !last?.done; i++) {
        let r;
        if (rules.length === 0) r = await stepMoment({ run: start.run, render });
        else {
          const c = await run(MOMENT, ["step", start.run], env);
          assert.equal(c.code, 0, `${c.stdout}${c.stderr}`);
          assert.equal(c.stdout.trim().split("\n").length, 1, "one JSON line on stdout");
          r = c.json;
          viaCli++;
        }
        assert.equal(r.errors, undefined, JSON.stringify(r));
        if (!r.done) assert.equal(r.failed, undefined, JSON.stringify(r));
        if (r.read) {
          asked.push(`${r.read}${r.n ?? ""}`);
          assert.equal(r.read, "stranger", "the probe and the panels read are asked of a stream's 480 lines or more, not of this one");
          await fs.writeFile(r.answer, JSON.stringify(STRANGER_ANSWER));
        }
        last = r;
      }
      assert.ok(last?.done, "the moment ended");
      assert.ok(viaCli >= 2, `the CLI took ${viaCli} steps`);
      assert.deepEqual(asked, ["stranger1", "stranger2"]);
      assert.deepEqual(rules, ["presence"], "the render the test watched used the presence rule");

      // 6. the kept clips are real files, rendered 9:16, and the moment is closed
      assert.equal(last.clips.length, 2);
      assert.deepEqual(last.failed, []);
      for (const c of last.clips) {
        assert.match(path.basename(c.file), /^clip-0[12]\.mp4$/);
        assert.ok((await fs.stat(c.file)).size > 1000, c.file);
      }
      const probe = spawnSync("ffmpeg", ["-hide_banner", "-i", last.clips[0].file], { encoding: "utf8", env: toolEnv() });
      assert.match(probe.stderr, /Video: h264.*1080x1920/, "a 9:16 clip");
      const record = JSON.parse(await fs.readFile(path.join(start.run, "clips.json"), "utf8"));
      assert.deepEqual(record.clips.map((c) => c.rendered), [true, true]);
      assert.deepEqual(record.clips.map((c) => c.judgment.overall), [4, 4]);
      await assert.rejects(fs.access(path.join(moment, "video.mp4")), "the window's video goes once its clips are made");
      assert.match(last.runsLine, / · 2 clips$/);
      const runsMd = (await fs.readFile(path.join(home, "boqo-sniper", "runs.md"), "utf8")).trim().split("\n");
      assert.deepEqual(runsMd, [last.runsLine]);
    } finally {
      if (oldHome === undefined) delete process.env.BOQO_HOME;
      else process.env.BOQO_HOME = oldHome;
      await fs.rm(work, { recursive: true, force: true });
    }
  },
);
