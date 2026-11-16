import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stamp } from "../lib/session.mjs";
import { segmentName } from "../lib/buffer.mjs";

const WATCH = fileURLToPath(new URL("../tools/watch.mjs", import.meta.url));
const STOP = fileURLToPath(new URL("../tools/stop.mjs", import.meta.url));
const STATUS = fileURLToPath(new URL("../tools/status.mjs", import.meta.url));
const NEXT = fileURLToPath(new URL("../tools/next.mjs", import.meta.url));

async function tmp(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `sniper-${label}-`));
}

/** `count` ten-second .ts segments: one tiny testsrc + sine clip, copied. Never committed. */
async function makeSegments(dir, count) {
  await fs.mkdir(dir, { recursive: true });
  const first = path.join(dir, "000.ts");
  const r = spawnSync(
    "ffmpeg",
    [
      "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-f", "mpegts", first,
    ],
    { encoding: "utf8" },
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

const range = (from, to, step = 10) => Array.from({ length: Math.ceil((to - from) / step) }, (_, i) => from + i * step);

/** One message a second from 7 regulars, plus a burst of 35 different users in 300-310 s. */
async function makeChat(file, seconds, burstAt) {
  const lines = [];
  for (let t = 0; t < seconds; t++) lines.push({ t, user: `reg${t % 7}`, text: "hello", emotes: 0 });
  if (burstAt !== null) {
    for (let i = 0; i < 35; i++) lines.push({ t: burstAt + i * (10 / 35), user: `fan${i}`, text: "POGGERS", emotes: 1 });
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
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file], { encoding: "utf8" });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr);
  assert.ok(m, `no duration in: ${r.stderr}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function onlySession(home, channel) {
  const root = path.join(home, "boqo-sniper", "watch", channel);
  const names = await fs.readdir(root);
  assert.equal(names.length, 1, `one session folder, got ${names}`);
  return path.join(root, names[0]);
}

test("replay: one burst makes one ~150 s moment, then 10 offline polls end the run", { timeout: 180000 }, async () => {
  const work = await tmp("replay");
  const home = path.join(work, "home");
  try {
    await makeSegments(path.join(work, "segs"), 40);
    await makeChat(path.join(work, "chat.jsonl"), 400, 300);
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
    assert.deepEqual(Object.keys(status).sort(), ["channel", "chatPerSec", "moments", "segments", "since", "state", "updatedAt"]);
    assert.equal(status.state, "offline");
    assert.equal(status.channel, "chan_one");
    assert.equal(status.moments, 1);
    await assert.rejects(fs.access(path.join(session, "watch.pid")), "the pid file goes with the process");

    const momentNames = await fs.readdir(path.join(session, "moments"));
    assert.equal(momentNames.length, 1, `exactly one moment, got ${momentNames}`);
    assert.match(momentNames[0], /^\d{8}-\d{6}$/, "UTC stamp, no colons");
    const dir = path.join(session, "moments", momentNames[0]);
    assert.deepEqual((await fs.readdir(dir)).sort(), ["chat.json", "meta.json", "video.mp4"]);

    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    assert.equal(meta.reason === "chat" || meta.reason === "both", true);
    assert.ok(meta.score >= 60 && meta.score <= 100, `score ${meta.score}`);
    assert.equal(typeof meta.chatZ, "number");
    assert.ok("audioZ" in meta);
    assert.ok(Number.isFinite(meta.peakAt));
    // the burst is the bucket at 300-310 s of a replay whose clock starts at launch
    assert.ok(Math.abs(meta.peakAt - (t0 / 1000 + 305)) < 20, `peakAt ${meta.peakAt}`);
    assert.equal(momentNames[0], stamp(new Date(meta.peakAt * 1000)));

    const dur = durationOf(path.join(dir, "video.mp4"));
    assert.ok(dur > 140 && dur < 170, `video is ${dur} s, expected about 150`);

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

test("replay: a 20 s hole in the capture fires no moment on ordinary chat", { timeout: 180000 }, async () => {
  const work = await tmp("hole");
  const home = path.join(work, "home");
  try {
    // 0 .. 190, a hole from 200 to 220, then 220 .. 410
    await makeStampedSegments(path.join(work, "segs"), [...range(0, 200), ...range(220, 420)]);
    // a message a second from 50 regulars in turn: 10 chatters in every 10 s, 30 in the hole's 30
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
    // 0 .. 290, a hole from 300 to 320, then 320 .. 610; the burst is in 380-390
    await makeStampedSegments(path.join(work, "segs"), [...range(0, 300), ...range(320, 620)]);
    await makeChat(path.join(work, "chat.jsonl"), 620, 380);
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100" };
    const r = await run(WATCH, ["holeburst", "--replay", path.join(work, "segs"), "--chat", path.join(work, "chat.jsonl")], env);
    assert.equal(r.code, 0, r.stderr);
    const session = await onlySession(home, "holeburst");
    const names = await fs.readdir(path.join(session, "moments"));
    assert.equal(names.length, 1, `one moment, got ${names}`);
    const dir = path.join(session, "moments", names[0]);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8"));
    assert.equal(meta.peakOffsetSec, meta.peakAt - meta.startAt);
    assert.equal(meta.peakOffsetSec, 65, "the cut starts on the segment at 320, the peak bucket is 380-390");
    const dur = durationOf(path.join(dir, "video.mp4"));
    assert.ok(Math.abs(dur - (meta.endAt - meta.startAt)) < 2, `video ${dur} s, wall clock ${meta.endAt - meta.startAt} s`);
    assert.ok(dur > 95 && dur < 105, `video is ${dur} s, expected 100 (320 to 420)`);
    const fans = JSON.parse(await fs.readFile(path.join(dir, "chat.json"), "utf8")).filter((c) => c.user.startsWith("fan"));
    assert.equal(fans.length, 35);
    assert.ok(fans.every((c) => c.t >= 60 && c.t < 70), "the burst sits 60-70 s into the video, as it does on the wall clock");
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
    assert.ok(bufFiles.length <= 11 && bufFiles.length >= 9, `${bufFiles.length} segments kept for a 100 s horizon`);
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

    const root = path.join(home, "boqo-sniper", "watch", "stopme");
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
  const root = path.join(home, "boqo-sniper", "watch", channel);
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

/** What a failed run must leave: exit 1, one {"error"} line, status "failed" with that error, no pid, and next/status saying so. */
async function assertFailed(r, session, channel, env, pattern) {
  assert.equal(r.code, 1, r.stderr);
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
    // 10 simulated seconds per real second: segment 6 is read about 6 s after the start
    const env = { BOQO_HOME: home, BOQO_SNIPER_POLL_MS: "100", BOQO_SNIPER_REPLAY_SPEED: "10" };
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
