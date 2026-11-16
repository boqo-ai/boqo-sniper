#!/usr/bin/env node
// The live watcher: record a Twitch stream into a 12-minute ring buffer, read
// its chat, measure its loudness, and cut a moment folder on every spike.
//
//   watch.mjs <channel> [--sensitivity 70] [--replay <dir-of-ts> --chat <chat.jsonl>]
//
// Runs in the foreground; the agent starts it in the background and reads
// what it writes: $BOQO_HOME/boqo-sniper/watch/<channel>/<YYYYMMDD-HHMMSS>/
//   buf/seg_<UTC stamp>.ts   10 s segments, the newest 720 s
//   moments/<UTC stamp>/     video.mp4 + chat.json + meta.json (meta last)
//   status.json  watch.pid   `stop` is written by stop.mjs
//
// One JSON line on stdout when it ends (exit 0 on a stop or after 10 minutes
// offline), or {"error": "..."} and exit 1. Stderr is for humans. A run that
// fails after its session folder exists also leaves status.json at
// {"state": "failed", "error": "..."}, so `next` and `status` can say why.
//
// Timeline: wall-clock epoch seconds, for chat, buckets, peakAt and every
// segment. A segment's start is read from its own name (ffmpeg's strftime
// segment names, run with TZ=UTC0 so they are UTC); the file's mtime overrules
// a name more than a minute away from it, which is what a build that ignores
// TZ would produce.
//
// Replay (tests, CI): --replay reads pre-made .ts segments in order and
// --chat lines {"t": <seconds offset>, "user", "text", "emotes"} on a simulated
// clock that jumps instead of waiting (BOQO_SNIPER_REPLAY_SPEED=<n> makes it
// n simulated seconds per real second). When the segments end, offline polling
// is stubbed: every poll says offline.
//
// Knobs: BOQO_SNIPER_POLL_MS (offline poll interval, default 60000),
// BOQO_SNIPER_HORIZON_SEC (buffer length, default 720) and BOQO_SNIPER_KEEP_BUF=1
// (leave the segments on disk at exit) exist for tests.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createDetector } from "../lib/detector.mjs";
import { connectChat } from "../lib/twitch-chat.mjs";
import { cleanupSession, newSession, stamp, sweepChannel, watcherPid, writeJsonAtomic, currentSession } from "../lib/session.mjs";
import {
  HORIZON_SEC,
  POST_ROLL_SEC,
  SEGMENT_SEC,
  concatArgs,
  concatList,
  parseSegmentName,
  planCut,
  pruneBefore,
  segmentName,
} from "../lib/buffer.mjs";
import { measureLoudness } from "../lib/loudness.mjs";

export const MAX_OFFLINE_POLLS = 10;
/** No new segment for this long while capturing: the source is stuck, kill it and start over. */
const STALL_SEC = 60;

function fail(message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

/** The session this process owns (its watch.pid is ours), once it has one. */
let owned = null;

/** Fail a run whose session exists: status.json says failed and why, the pid file goes, then {"error"} and exit 1. */
async function failSession(message) {
  if (owned) {
    const now = new Date().toISOString();
    try {
      await writeJsonAtomic(path.join(owned.dir, "status.json"), {
        state: "failed",
        channel: owned.channel,
        since: now,
        segments: 0,
        moments: owned.moments ?? 0,
        chatPerSec: 0,
        updatedAt: now,
        error: message,
      });
    } catch {}
    await fs.rm(path.join(owned.dir, "watch.pid"), { force: true }).catch(() => {});
  }
  fail(message);
}

export function parseArgs(argv) {
  const o = { channel: null, sensitivity: 70, replay: null, chat: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sensitivity") {
      const raw = argv[++i];
      const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`bad --sensitivity: ${raw}`);
      o.sensitivity = n;
    } else if (a === "--replay") {
      o.replay = argv[++i];
      if (!o.replay) throw new Error("--replay needs a folder");
    } else if (a === "--chat") {
      o.chat = argv[++i];
      if (!o.chat) throw new Error("--chat needs a file");
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    } else if (o.channel === null) {
      o.channel = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  if (!o.channel) throw new Error("usage: watch.mjs <channel> [--sensitivity 70] [--replay <dir> --chat <file>]");
  if (o.chat && !o.replay) throw new Error("--chat only goes with --replay");
  return o;
}

const iso = (sec) => new Date(sec * 1000).toISOString();
const envNumber = (name, fallback) => {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
};

// ---- clocks ---------------------------------------------------------------

function liveClock() {
  return {
    virtual: false,
    now: () => Date.now() / 1000,
    sleep: (sec) => new Promise((resolve) => setTimeout(resolve, sec * 1000)),
  };
}

/** A clock that jumps: sleep(s) adds s to the time at once (or after s/speed real seconds). */
function replayClock(start, speed) {
  let t = start;
  return {
    virtual: true,
    now: () => t,
    async sleep(sec) {
      t += sec;
      if (Number.isFinite(speed) && speed > 0) await new Promise((r) => setTimeout(r, (sec * 1000) / speed));
      else await new Promise((r) => setImmediate(r));
    },
  };
}

// ---- small process and file helpers --------------------------------------

/** Is `cmd` runnable? ENOENT is the only "no". */
function hasTool(cmd, arg = "--version") {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [arg], { stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
}

/** Run to completion; {code, stdout, stderr}. A spawn error is code -1. */
function runOnce(cmd, args, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout, stderr: String(err) });
      return;
    }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function unlinkRetry(file) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fs.unlink(file);
      return;
    } catch (err) {
      if (err.code === "ENOENT") return;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/** The channel's current session is still being watched by a live process. */
async function runningWatcher(channel) {
  const dir = await currentSession(channel);
  if (!dir) return null;
  const pid = await watcherPid(dir);
  return pid === null ? null : { dir, pid };
}

// ---- capture --------------------------------------------------------------

/**
 * streamlink when it is installed, else yt-dlp. Both write the stream to
 * stdout; ffmpeg copies it into 10 s segments named by the UTC second they open.
 */
function captureCommand(tool, channel) {
  if (tool === "test-source") {
    const [cmd, ...args] = JSON.parse(process.env.BOQO_SNIPER_SOURCE);
    return { cmd, args };
  }
  if (tool === "streamlink") {
    return { cmd: "streamlink", args: ["--twitch-disable-ads", "--stdout", `twitch.tv/${channel}`, "best"] };
  }
  return {
    cmd: "yt-dlp",
    args: ["-q", "-f", "best[height<=1080]/best", "-o", "-", `https://www.twitch.tv/${channel}`],
  };
}

function segmenterArgs() {
  return [
    "-hide_banner", "-loglevel", "warning",
    "-i", "pipe:0",
    "-c", "copy", "-f", "segment", "-segment_time", String(SEGMENT_SEC), "-reset_timestamps", "1",
    "-strftime", "1", "seg_%Y%m%d%H%M%S.ts",
  ];
}

/**
 * End a child and everything it started. yt-dlp runs its own ffmpeg that
 * outlives it (measured 2026-11-15: after SIGTERM to yt-dlp, that ffmpeg kept
 * running and held the pipe open), so on POSIX the source is its own process
 * group and the whole group gets the signal; on Windows taskkill walks the tree.
 */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

/** Start source | ffmpeg in `bufDir`. `closed` resolves when both are gone; `kill()` ends the pipeline. */
function startCapture(tool, channel, bufDir) {
  const { cmd, args } = captureCommand(tool, channel);
  const tail = [];
  const note = (who) => (d) => {
    tail.push(`${who}: ${String(d).trim()}`);
    if (tail.length > 12) tail.shift();
  };
  const src = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const ff = spawn("ffmpeg", segmenterArgs(), {
    cwd: bufDir,
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, TZ: "UTC0" },
    windowsHide: true,
  });
  src.stderr.on("data", note(cmd));
  ff.stderr.on("data", note("ffmpeg"));
  ff.stdin.on("error", () => {});
  src.stdout.on("error", () => {});
  src.stdout.pipe(ff.stdin);

  // `exit`, not `close`: a grandchild that still holds a pipe must not keep us waiting.
  const exited = (child, who) =>
    new Promise((resolve) => {
      child.on("error", (err) => {
        tail.push(`${who}: ${err.message}`);
        resolve();
      });
      child.on("exit", resolve);
    });
  const srcDone = exited(src, cmd);
  const ffDone = exited(ff, "ffmpeg");
  // The source is gone: end ffmpeg's input so it closes its last segment and
  // exits. If ffmpeg dies first nobody reads the source any more.
  srcDone.then(() => {
    src.stdout.unpipe(ff.stdin);
    src.stdout.destroy();
    ff.stdin.end();
    setTimeout(() => ff.kill(), 8000).unref();
  });
  ffDone.then(() => killTree(src));

  return {
    closed: Promise.all([srcDone, ffDone]).then(() => undefined),
    kill() {
      killTree(src);
    },
    tail: () => tail.join("\n"),
  };
}

async function isLive(tool, channel) {
  if (tool === "test-source") return false;
  if (await hasTool("yt-dlp")) {
    const r = await runOnce("yt-dlp", ["-q", "--no-warnings", "--print", "is_live", `https://www.twitch.tv/${channel}`], {
      timeoutMs: 45000,
    });
    return r.code === 0 && r.stdout.trim().split(/\s+/).pop() === "True";
  }
  if (tool === "streamlink") {
    const r = await runOnce("streamlink", ["--json", `twitch.tv/${channel}`], { timeoutMs: 45000 });
    try {
      return Object.keys(JSON.parse(r.stdout).streams ?? {}).length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

// ---- the watcher ----------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }
  const channel = args.channel.toLowerCase();
  const replay = args.replay !== null;
  const pollSec = envNumber("BOQO_SNIPER_POLL_MS", 60000) / 1000;
  const horizonSec = envNumber("BOQO_SNIPER_HORIZON_SEC", HORIZON_SEC);
  const keepBuf = process.env.BOQO_SNIPER_KEEP_BUF === "1";
  const stallSec = envNumber("BOQO_SNIPER_STALL_SEC", STALL_SEC);

  let tool = null;
  if (!(await hasTool("ffmpeg", "-version"))) fail("ffmpeg is not on PATH");
  if (!replay) {
    if (process.env.BOQO_SNIPER_SOURCE) tool = "test-source";
    else if (await hasTool("streamlink")) tool = "streamlink";
    else if (await hasTool("yt-dlp")) tool = "yt-dlp";
    else fail("neither streamlink nor yt-dlp is on PATH");
  }

  let running = null;
  try {
    running = await runningWatcher(channel);
  } catch (err) {
    fail(err.message);
  }
  if (running) fail(`already watching ${channel} (pid ${running.pid}, ${running.dir})`);

  // A watcher that was hard-killed leaves its buffer, pid and "live" status behind.
  try {
    await sweepChannel(channel);
  } catch (err) {
    console.error(`sweep of old sessions failed: ${err.message}`);
  }
  const dir = await newSession(channel, new Date());
  const bufDir = path.join(dir, "buf");
  const momentsDir = path.join(dir, "moments");
  const stopFile = path.join(dir, "stop");
  try {
    await fs.writeFile(path.join(dir, "watch.pid"), String(process.pid), { flag: "wx" });
  } catch (err) {
    fail(err.code === "EEXIST" ? `already watching ${channel} (${dir})` : err.message);
  }
  owned = { dir, channel, moments: 0 };

  // Replay material is read up front so a bad path fails before anything runs.
  let replayFiles = [];
  let replayChat = [];
  let clock;
  let replayBase = 0;
  if (replay) {
    try {
      replayFiles = (await fs.readdir(args.replay)).filter((f) => f.toLowerCase().endsWith(".ts")).sort();
      if (replayFiles.length === 0) throw new Error(`no .ts files in ${args.replay}`);
      if (args.chat) {
        replayChat = (await fs.readFile(args.chat, "utf8"))
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
          .sort((a, b) => a.t - b.t);
      }
    } catch (err) {
      await failSession(`replay: ${err.message}`);
    }
    // The simulated timeline starts now and runs ahead of the real one.
    replayBase = Math.floor(Date.now() / 1000);
    clock = replayClock(replayBase, envNumber("BOQO_SNIPER_REPLAY_SPEED", Infinity));
  } else {
    clock = liveClock();
  }

  const detector = createDetector({ sensitivity: args.sensitivity });
  const segs = []; // { n, t0, name, done }
  const known = new Set();
  let nextN = 0;
  let totalSegments = 0;
  const chatLog = []; // { t, user, text, emotes }
  const pending = []; // spikes waiting for their post-roll
  let lastDoneEnd = -Infinity;
  let moments = 0;
  let state = "waiting";
  let since = iso(clock.now());
  let stopRequested = false;
  let capture = null;
  let warnedTz = false;
  let failMessage = null;

  const setState = (s) => {
    if (s !== state) {
      state = s;
      since = iso(clock.now());
    }
  };

  async function writeStatus() {
    const now = clock.now();
    let recent = 0;
    for (let i = chatLog.length - 1; i >= 0 && chatLog[i].t >= now - 30; i--) recent++;
    await writeJsonAtomic(
      path.join(dir, "status.json"),
      {
        state,
        channel,
        since,
        segments: segs.length,
        moments,
        chatPerSec: Math.round((recent / 30) * 10) / 10,
        updatedAt: iso(now),
        ...(state === "failed" ? { error: failMessage } : {}),
      },
      { quiet: true },
    );
  }

  async function checkStop() {
    if (stopRequested) return true;
    try {
      await fs.access(stopFile);
      stopRequested = true;
    } catch {}
    return stopRequested;
  }

  const onSignal = () => {
    stopRequested = true;
    capture?.kill();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("SIGHUP", onSignal);

  /** A sleep that wakes for a stop request once a second. */
  async function nap(sec) {
    let left = sec;
    while (left > 0 && !(await checkStop())) {
      const step = Math.min(1, left);
      await clock.sleep(step);
      left -= step;
    }
  }

  // ---- finding and finishing segments ----

  async function scanBuffer() {
    let names;
    try {
      names = await fs.readdir(bufDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (known.has(name)) continue;
      let t0 = parseSegmentName(name);
      if (t0 === null) continue;
      if (!replay) {
        try {
          const mtime = (await fs.stat(path.join(bufDir, name))).mtimeMs / 1000;
          if (Math.abs(mtime - t0) > 60) {
            if (!warnedTz) console.error("segment names are not in UTC here; reading start times from file times");
            warnedTz = true;
            t0 = Math.floor(mtime);
          }
        } catch {
          continue;
        }
      }
      known.add(name);
      segs.push({ n: nextN++, t0, name, done: false });
      totalSegments++;
    }
    segs.sort((a, b) => a.t0 - b.t0);
  }

  function chatWindow(from, to) {
    const users = new Set();
    let count = 0;
    for (const c of chatLog) {
      if (c.t >= to) break;
      if (c.t < from) continue;
      count++;
      users.add(c.user);
    }
    return { count, chatters: users.size };
  }

  async function finishSegment(seg, next) {
    const lufs = await measureLoudness(seg.name, { cwd: bufDir });
    const end = next ? next.t0 : seg.t0 + SEGMENT_SEC;
    const { count, chatters } = chatWindow(seg.t0, end);
    seg.done = true;
    lastDoneEnd = Math.max(lastDoneEnd, seg.t0 + SEGMENT_SEC);
    const spike = detector.push({ t: seg.t0 + SEGMENT_SEC / 2, chat: count, chatters, lufs });
    if (spike) pending.push(spike);
  }

  async function cut(spike) {
    const plan = planCut(segs.filter((s) => s.done), spike.peakAt);
    if (!plan) {
      console.error(`spike at ${iso(spike.peakAt)} fell outside the buffer; no cut`);
      return;
    }
    const base = stamp(new Date(spike.peakAt * 1000));
    let name = base;
    for (let k = 2; ; k++) {
      try {
        await fs.mkdir(path.join(momentsDir, name));
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        name = `${base}-${k}`;
      }
    }
    const momentDir = path.join(momentsDir, name);
    const listName = `cut-${process.pid}.txt`;
    try {
      await fs.writeFile(path.join(bufDir, listName), concatList(plan.segments.map((s) => s.name)));
      const r = await runOnce("ffmpeg", concatArgs(listName, path.join(momentDir, "video.mp4")), {
        cwd: bufDir,
        timeoutMs: 300000,
      });
      if (r.code !== 0) throw new Error(`ffmpeg concat exited ${r.code}: ${r.stderr.trim().slice(-300)}`);
      const first = plan.segments[0].t0;
      const end = plan.segments.at(-1).t0 + SEGMENT_SEC;
      const lines = chatLog
        .filter((c) => c.t >= first && c.t < end)
        .map((c) => ({ t: Math.round((c.t - first) * 100) / 100, user: c.user, text: c.text, emotes: c.emotes }));
      await fs.writeFile(path.join(momentDir, "chat.json"), JSON.stringify(lines));
      await writeJsonAtomic(path.join(momentDir, "meta.json"), {
        peakAt: spike.peakAt,
        score: spike.score,
        reason: spike.reason,
        chatZ: spike.chatZ,
        audioZ: spike.audioZ,
        channel,
        peakIso: iso(spike.peakAt),
        peakOffsetSec: plan.peakOffsetSec,
        startAt: first,
        endAt: end,
      });
      moments++;
      if (owned) owned.moments = moments;
    } catch (err) {
      console.error(`cut failed: ${err.message}`);
      await fs.rm(momentDir, { recursive: true, force: true });
    } finally {
      await unlinkRetry(path.join(bufDir, listName));
    }
  }

  async function prune() {
    const old = pruneBefore(segs, horizonSec);
    if (old.length === 0) return;
    const gone = new Set(old.map((s) => s.n));
    for (const s of old) await unlinkRetry(path.join(bufDir, s.name));
    for (let i = segs.length - 1; i >= 0; i--) if (gone.has(segs[i].n)) segs.splice(i, 1);
  }

  /** One pass: finish segments, cut what is ready, prune, report. `ended`: nothing more will arrive. */
  async function tick(ended) {
    await scanBuffer();
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.done) continue;
      const next = segs[i + 1];
      if (!next && !ended) break; // the newest one is still being written
      await finishSegment(seg, next);
    }
    const flush = ended || stopRequested;
    for (let i = 0; i < pending.length; ) {
      const spike = pending[i];
      if (flush || lastDoneEnd >= spike.peakAt + POST_ROLL_SEC) {
        pending.splice(i, 1);
        await cut(spike);
      } else i++;
    }
    await prune();
    const horizonT = clock.now() - horizonSec - 60;
    while (chatLog.length && chatLog[0].t < horizonT) chatLog.shift();
    await writeStatus();
  }

  // ---- the two capture sources ----

  async function captureLive() {
    const before = totalSegments;
    capture = startCapture(tool, channel, bufDir);
    let over = false;
    capture.closed.then(() => (over = true));
    // A source blocked on a dead connection neither exits nor writes: with no
    // new segment for stallSec, end it and let the caller wait and resume.
    let seen = totalSegments;
    let progressAt = clock.now();
    while (!over && !(await checkStop())) {
      await Promise.race([capture.closed, new Promise((r) => setTimeout(r, 1000))]);
      await tick(false);
      if (totalSegments > before && state !== "live") setState("live");
      if (totalSegments > seen) {
        seen = totalSegments;
        progressAt = clock.now();
      } else if (!over && clock.now() - progressAt >= stallSec) {
        console.error(`capture stalled: no new segment for ${stallSec} s; restarting it`);
        break;
      }
    }
    if (!over) capture.kill();
    await capture.closed;
    if (totalSegments === before) console.error(`capture made no segments:\n${capture.tail()}`);
    capture = null;
  }

  async function captureReplay() {
    let ci = 0;
    const feedChat = (before) => {
      while (ci < replayChat.length && replayBase + replayChat[ci].t < before) {
        const c = replayChat[ci++];
        chatLog.push({ t: replayBase + c.t, user: String(c.user), text: String(c.text ?? ""), emotes: Number(c.emotes) || 0 });
      }
    };
    for (let i = 0; i < replayFiles.length; i++) {
      const at = replayBase + i * SEGMENT_SEC;
      if (at > clock.now()) await nap(at - clock.now());
      if (await checkStop()) return;
      feedChat(at);
      await fs.copyFile(path.join(args.replay, replayFiles[i]), path.join(bufDir, segmentName(at)));
      await tick(false);
      setState("live");
    }
    const endAt = replayBase + replayFiles.length * SEGMENT_SEC;
    if (endAt > clock.now()) await nap(endAt - clock.now());
    feedChat(endAt);
  }

  // ---- run ----

  let chat = null;
  if (replay) {
    // chat comes from the file
  } else {
    chat = connectChat(channel, (m) => chatLog.push({ t: clock.now(), user: m.user, text: m.text, emotes: m.emotes }));
  }

  let exitError = null;
  let offlinePolls = 0; // consecutive polls that said offline
  let failedCaptures = 0; // consecutive captures that made no segment
  try {
    await writeStatus();
    while (!(await checkStop())) {
      const before = totalSegments;
      await (replay ? captureReplay() : captureLive());
      if (await checkStop()) break;
      await tick(true); // the capture is over: its last segment is whole now
      if (totalSegments > before) {
        offlinePolls = 0;
        failedCaptures = 0;
      } else failedCaptures++;
      setState("waiting");
      await writeStatus();

      let live = false;
      // A "live" channel whose capture keeps making nothing also ends, after as many tries.
      while (!live && offlinePolls < MAX_OFFLINE_POLLS && failedCaptures < MAX_OFFLINE_POLLS) {
        await nap(pollSec);
        if (await checkStop()) break;
        live = replay ? false : await isLive(tool, channel);
        if (live) offlinePolls = 0;
        else offlinePolls++;
        await writeStatus();
      }
      if (stopRequested || !live) break;
    }
  } catch (err) {
    exitError = err;
  }

  // ---- shut down ----
  const stopped = stopRequested;
  chat?.close();
  capture?.kill();
  try {
    await tick(true);
  } catch (err) {
    exitError ??= err;
  }
  if (exitError) failMessage = exitError.message || String(exitError);
  setState(exitError ? "failed" : stopped ? "stopped" : "offline");
  if (!keepBuf) {
    for (const s of segs.splice(0)) await unlinkRetry(path.join(bufDir, s.name));
  }
  await writeStatus();
  await fs.rm(path.join(dir, "watch.pid"), { force: true });
  await fs.rm(stopFile, { force: true });

  if (exitError) fail(failMessage);
  process.stdout.write(JSON.stringify({ state, channel, session: dir, moments, offlinePolls }) + "\n", () => process.exit(0));
}

main().catch((err) => failSession(err?.message || String(err)));
