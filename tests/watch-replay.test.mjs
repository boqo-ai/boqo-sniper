import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stamp } from "../lib/session.mjs";

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
  const root = path.join(home, "boqo-sniper", channel);
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

    const root = path.join(home, "boqo-sniper", "stopme");
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
