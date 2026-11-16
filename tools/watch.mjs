#!/usr/bin/env node
// The live watcher: record a Twitch or Kick stream into a 6-minute ring buffer, read
// its chat, measure its loudness, and cut a moment folder on every moment the
// hosted detector finds (lib/boqo/moments.mjs, fed 1 s ticks by lib/ticks.mjs).
//
//   watch.mjs <channel> [--sensitivity 70] [--replay <dir-of-ts> --chat <chat.jsonl>]
//   watch.mjs <channel> --clip-now      ask the running watcher for a hand-made moment, now (score 100, as hosted)
//
// The session's settings are config.json's (lib/settings.mjs: sensitivity, autoClip, autoClipMinScore, windowSec,
// prompt, visionPerHour); the watcher writes them to the session's settings.json. windowSec sets the cut (the peak
// is windowSec - 30 s in) and the buffer (windowSec + 60 s); --sensitivity overrides the file.
//
// <channel>: a Twitch login, twitch.tv/<login>, kick.com/<slug> or kick:<slug>
// (boqo's parser, lib/boqo/stream.mjs; a bare name is Twitch).
//
// Runs in the foreground; the agent starts it in the background and reads
// what it writes: $BOQO_HOME/boqo-sniper/watch/<platform>-<slug>/<YYYYMMDD-HHMMSS>/
//   buf/seg_<counter>.ts     6 s segments, the newest 360 s (a 300 s window and 60 s); capture-<n>.csv is a capture's segment list
//   moments/<UTC stamp>/     video.mp4 + chat.json + meta.json (meta last)
//   status.json  settings.json  watch.pid   `stop` is written by stop.mjs, `clipnow` by --clip-now
//
// One JSON line on stdout when it ends (exit 0 on a stop or after 10 minutes
// offline), or {"error": "..."} and exit 1; {"error": "kick refused: <status>"} or {"error": "kick lookup timed out"} and exit 2 when
// Kick's channel API answers anything but 200, or not within 15 s (its chat cannot start; Kick sits behind Cloudflare). Stderr is for humans. A run that
// fails after its session folder exists also leaves status.json at
// {"state": "failed", "error": "..."}, so `next` and `status` can say why.
//
// Timeline: wall-clock epoch seconds, for chat, loudness, peakAt and every
// segment (the detector's ticks are the same clock in milliseconds). The
// segments are named by a counter (seg_000042.ts, continued across capture
// restarts so no name is ever reused: a name from the clock is, when a stalled
// stream catches up in a burst, and the newer segment overwrites the older). A
// segment's start comes from the capture's segment list (ffmpeg's csv: name,
// stream start, stream end, written as each segment closes) and the capture's
// clock anchor (lib/buffer.mjs createCaptureClock): the first row's read time
// less its end, lowered whenever a later row says the stream was nearer live.
//
// The detector, as hosted's session runs it: a new one for each capture
// phase; every complete second, the raw chat messages that arrived in it, its
// loudest momentary reading (the capture's ebur128 line), and whether the chat
// socket was open for all of it. A second it was not counts no chat and stays
// out of the chat baseline.
//
// Replay (tests, CI): --replay reads pre-made .ts segments in order, 6 s
// apart, or as far apart as their names say when every one is named by its
// start (seg_<UTC stamp>.ts, the form v0.1 wrote), so a test can leave a hole;
// each is copied into the buffer under the next counter name. And
// --chat lines {"t": <seconds offset>, "user", "text", "emotes"} on a simulated
// clock that jumps a second at a time instead of waiting
// (BOQO_SNIPER_REPLAY_SPEED=<n> makes it n simulated seconds per real second).
// A chat line {"t", "chatState": "open" | "connecting"} is the socket opening or
// dropping at t; a replay's chat starts open. Each segment's loudness is read
// from the segment itself (measureMomentary), at its start plus the reading's t.
// When the segments end, offline polling is stubbed: every poll says offline.
//
// Knobs, for tests: BOQO_SNIPER_POLL_MS (offline poll interval, default
// 60000), BOQO_SNIPER_HORIZON_SEC (buffer length, default windowSec + 60),
// BOQO_SNIPER_KEEP_BUF=1 (leave the segments on disk at exit),
// BOQO_SNIPER_STALL_SEC, BOQO_SNIPER_MAX_QUEUE and BOQO_SNIPER_MIN_FREE_MB (when a
// moment is skipped), BOQO_SNIPER_SOURCE (a JSON argv in place of yt-dlp),
// BOQO_SNIPER_TEST_LIVE=1 (that source's channel polls live) and
// BOQO_SNIPER_TEST_CRASH=throw|reject (a crash 300 ms in).
//
// A capture that makes nothing 10 times in a row while the channel says live
// fails the run with what the capture printed; an uncaught exception or an
// unhandled rejection fails it too, so status.json never stays "live" for a
// process that is gone.

import { spawn } from "node:child_process";
// Every process starts with toolEnv(): on macOS it puts keg-only ffmpeg-full first on PATH, for
// the segmenter, the loudness probe and the ffmpeg yt-dlp runs itself.
import { toolEnv } from "../engine/env.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { createMomentDetector } from "../lib/boqo/moments.mjs";
import { signalLine } from "../lib/boqo/signal-line.mjs";
import { createTickFeed } from "../lib/ticks.mjs";
import { KICK_LOOKUP_TIMEOUT_MS, KickLookupTimeout, KickRefused, startChat } from "../lib/chat.mjs";
import { streamChannelLabel, streamUrl } from "../lib/boqo/stream.mjs";
import {
  cleanupSession,
  countUnclaimed,
  currentSession,
  freeBytes,
  newSession,
  readStatus,
  writeSessionSettings,
  stamp,
  sweepAll,
  watcherPid,
  writeJsonAtomic,
  resolveChannel,
} from "../lib/session.mjs";
import {
  POST_ROLL_SEC,
  PRUNE_MARGIN_SEC,
  SEGMENT_SEC,
  concatArgs,
  MAX_QUEUE,
  MAX_LISTED,
  MIN_FREE_BYTES,
  concatList,
  createCaptureClock,
  parseSegmentName,
  parseSegmentNumber,
  planCut,
  skipCut,
  pruneBefore,
  segmentFileName,
} from "../lib/buffer.mjs";
import { resolveSettings, isAutoMoment } from "../lib/settings.mjs";
import { lineReader, measureMomentary, parseLoudnessLine } from "../lib/loudness.mjs";
import {
  captureCommand as sourceCommand,
  captureFfmpegArgs,
  chooseCapture,
  isSegmentOpening,
  readConfig,
  readSegmentRows,
  stallSecFor,
} from "../lib/capture.mjs";

export const MAX_OFFLINE_POLLS = 10;
/** Captures in a row that made nothing while the channel said live: the watcher fails with the capture's last words. */
export const MAX_FAILED_CAPTURES = 10;
/** A source still running this long after SIGTERM gets SIGKILL. */
const KILL_GRACE_MS = 5000;

function fail(message, code = 1) {
  console.log(JSON.stringify({ error: message }));
  process.exit(code);
}

/** The session this process owns (its watch.pid is ours), once it has one. */
let owned = null;
/** The capture running now, so a crash can end it too. */
let capture = null;

/**
 * Fail a run whose session exists: status.json says failed and why, the
 * buffer and the pid file go, then {"error"} and exit 1.
 */
async function failSession(message, code = 1) {
  if (owned) {
    const now = new Date().toISOString();
    try {
      await writeJsonAtomic(path.join(owned.dir, "status.json"), {
        state: "failed",
        platform: owned.platform,
        channel: owned.channel,
        since: now,
        segments: 0,
        moments: owned.moments ?? 0,
        skipped: owned.skipped ?? { queue: 0, disk: 0 },
        chatPerSec: 0,
        updatedAt: now,
        error: message,
      });
    } catch {}
    await cleanupSession(owned.dir).catch(() => {});
  }
  fail(message, code);
}

// A bug must not leave a "live" status nobody updates: say failed and why, and exit 1.
let crashed = false;
function crash(err) {
  if (crashed) return;
  crashed = true;
  try {
    capture?.kill();
  } catch {}
  failSession(`watcher crashed: ${err?.message || String(err)}`);
}
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

export function parseArgs(argv) {
  const o = { channel: null, sensitivity: null, replay: null, chat: null, clipNow: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sensitivity") {
      const raw = argv[++i];
      const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(n)) throw new Error(`bad --sensitivity: ${raw}`);
      o.sensitivity = n;
    } else if (a === "--clip-now") {
      o.clipNow = true;
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
  if (!o.channel) throw new Error("usage: watch.mjs <channel> [--sensitivity 70] [--replay <dir> --chat <file>] | --clip-now");
  if (o.chat && !o.replay) throw new Error("--chat only goes with --replay");
  if (o.clipNow && (o.replay || o.sensitivity !== null)) throw new Error("--clip-now goes with the channel alone");
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
      child = spawn(cmd, [arg], { stdio: "ignore", env: toolEnv(), windowsHide: true });
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
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: toolEnv(), windowsHide: true });
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
async function runningWatcher(target) {
  const dir = await currentSession(target);
  if (!dir) return null;
  const pid = await watcherPid(dir);
  return pid === null ? null : { dir, pid };
}

// ---- capture --------------------------------------------------------------

/**
 * yt-dlp, or streamlink when config.json opts in (lib/capture.mjs). Both write
 * the stream to stdout; ffmpeg copies it into 6 s segments named by the UTC
 * second they open. BOQO_SNIPER_SOURCE (a JSON argv) stands in for them in tests.
 */
function captureCommand(tool, target) {
  if (tool === "test-source") {
    const [cmd, ...args] = JSON.parse(process.env.BOQO_SNIPER_SOURCE);
    return { cmd, args };
  }
  return sourceCommand(tool, target);
}

/**
 * End a child and everything it started. yt-dlp runs its own ffmpeg that
 * outlives it (measured 2026-11-15: after SIGTERM to yt-dlp, that ffmpeg kept
 * running and held the pipe open), so on POSIX the source is its own process
 * group and the whole group gets the signal; on Windows taskkill walks the
 * tree, already a hard kill. On POSIX whatever still runs KILL_GRACE_MS after
 * the SIGTERM gets SIGKILL: a source that ignores SIGTERM would otherwise keep
 * the watcher waiting on it for ever.
 */
const killing = new WeakMap(); // child -> the promise its kill settles
/** Kills under way; the watcher waits for them before it exits, so stop.mjs returns on a dead tree. */
const kills = new Set();
function killTree(child) {
  if (child.pid === undefined) return Promise.resolve();
  if (killing.has(child)) return killing.get(child);
  const done = process.platform === "win32" ? taskkillTree(child) : signalTree(child);
  killing.set(child, done);
  kills.add(done);
  done.then(() => kills.delete(done));
  return done;
}

function taskkillTree(child) {
  return new Promise((resolve) => {
    const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", env: toolEnv(), windowsHide: true });
    tk.on("error", () => resolve());
    tk.on("exit", () => resolve());
  });
}

/** SIGTERM to the group, SIGKILL to whatever of it still runs KILL_GRACE_MS later; resolves once it is all gone. */
function signalTree(child) {
  let group = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    group = false;
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  const running = () => {
    if (!group) return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + KILL_GRACE_MS;
  return new Promise((resolve) => {
    let hard = false;
    const timer = setInterval(() => {
      if (!running()) {
        clearInterval(timer);
        resolve();
      } else if (hard) {
        // SIGKILL cannot be ignored; give the kernel a moment, then stop waiting
        if (Date.now() >= deadline + 2000) {
          clearInterval(timer);
          resolve();
        }
      } else if (Date.now() >= deadline) {
        hard = true;
        try {
          if (group) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }
    }, 100);
  });
}

/**
 * Start source | ffmpeg in `bufDir`. `closed` resolves when both are gone; `kill()` ends the pipeline.
 * `onLoudness(momentary)` gets each of the ffmpeg's ebur128 lines (one per 100 ms) as it arrives.
 */
function startCapture(tool, target, bufDir, onLoudness, { startNumber, listFile }) {
  const { cmd, args } = captureCommand(tool, target);
  const tail = [];
  const note = (who) => (d) => {
    tail.push(`${who}: ${String(d).trim()}`);
    if (tail.length > 12) tail.shift();
  };
  const src = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: toolEnv(),
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const ff = spawn("ffmpeg", captureFfmpegArgs({ startNumber, listFile }), {
    cwd: bufDir,
    stdio: ["pipe", "ignore", "pipe"],
    env: toolEnv(),
    windowsHide: true,
  });
  src.stderr.on("data", note(cmd));
  const noteFfmpeg = note("ffmpeg");
  // a loudness line is a reading and a segment-opening line is routine: neither reaches the tail the failure message quotes
  ff.stderr.on(
    "data",
    lineReader((line) => {
      const parsed = parseLoudnessLine(line);
      if (parsed) onLoudness(parsed.momentary);
      else if (line.trim() !== "" && !isSegmentOpening(line)) noteFfmpeg(line);
    }),
  );
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
      return killTree(src);
    },
    tail: () => tail.join("\n"),
  };
}

async function isLive(tool, target) {
  // tests: BOQO_SNIPER_TEST_LIVE=1 makes the test source's channel say live
  if (tool === "test-source") return process.env.BOQO_SNIPER_TEST_LIVE === "1";
  if (await hasTool("yt-dlp")) {
    const r = await runOnce("yt-dlp", ["-q", "--no-warnings", "--print", "is_live", streamUrl(target)], {
      timeoutMs: 45000,
    });
    return r.code === 0 && r.stdout.trim().split(/\s+/).pop() === "True";
  }
  if (tool === "streamlink") {
    const r = await runOnce("streamlink", ["--json", streamUrl(target)], { timeoutMs: 45000 });
    try {
      return Object.keys(JSON.parse(r.stdout).streams ?? {}).length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

// ---- clip now -------------------------------------------------------------

/**
 * `--clip-now`: not a watcher. It asks the running one for a hand-made moment by writing `clipnow` into the
 * session (the watcher reads it every pass, as it reads `stop`), and prints one JSON line.
 */
async function clipNowRequest(target, label) {
  const dir = await currentSession(target);
  const pid = dir ? await watcherPid(dir) : null;
  if (!dir || pid === null) fail(`no watcher is running for ${label}`);
  const status = await readStatus(dir);
  // The answers that mean nothing will be cut, said here and not only on the watcher's stderr:
  // a cut needs a picture in the buffer, and the disk floor applies to a hand-made moment too.
  const refuse = (reason, extra = {}) => {
    console.log(JSON.stringify({ clipNow: false, reason, session: dir, state: status?.state ?? "waiting", ...extra }));
  };
  if (!status || !(status.segments > 0)) return refuse("buffer empty");
  if (status.state !== "live") return refuse(`stream ${status.state}`);
  if (status.lowDisk) return refuse("disk", { lowDisk: status.lowDisk });
  await fs.writeFile(path.join(dir, "clipnow"), String(Date.now()));
  console.log(JSON.stringify({ clipNow: true, session: dir, state: status.state }));
}

// ---- the watcher ----------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }
  let target;
  try {
    target = resolveChannel(args.channel);
  } catch (err) {
    fail(err.message);
  }
  const { platform, channel } = target;
  const label = streamChannelLabel(target);
  if (args.clipNow) return clipNowRequest(target, label);
  const replay = args.replay !== null;
  const pollSec = envNumber("BOQO_SNIPER_POLL_MS", 60000) / 1000;
  const keepBuf = process.env.BOQO_SNIPER_KEEP_BUF === "1";
  const maxQueue = envNumber("BOQO_SNIPER_MAX_QUEUE", MAX_QUEUE);
  const minFreeBytes = envNumber("BOQO_SNIPER_MIN_FREE_MB", MIN_FREE_BYTES / 1e6) * 1e6;

  const { config, warning } = await readConfig();
  if (warning) console.error(warning);
  let settings;
  try {
    settings = resolveSettings(config, { sensitivity: args.sensitivity });
  } catch (err) {
    fail(err.message);
  }
  const horizonSec = envNumber("BOQO_SNIPER_HORIZON_SEC", settings.windowSec + PRUNE_MARGIN_SEC);

  let tool = null;
  if (!(await hasTool("ffmpeg", "-version"))) fail("ffmpeg is not on PATH");
  if (!replay) {
    if (process.env.BOQO_SNIPER_SOURCE) tool = "test-source";
    else {
      const wantsStreamlink = config.capture === "streamlink";
      try {
        tool = chooseCapture(config, {
          streamlink: wantsStreamlink && (await hasTool("streamlink")),
          ytdlp: !wantsStreamlink && (await hasTool("yt-dlp")),
        });
      } catch (err) {
        fail(err.message);
      }
      if (tool === "streamlink") console.error("recording with streamlink (config.json); this path is untested in the beta");
    }
  }
  const stallSec = envNumber("BOQO_SNIPER_STALL_SEC", stallSecFor(tool));

  let running = null;
  try {
    running = await runningWatcher(target);
  } catch (err) {
    fail(err.message);
  }
  if (running) fail(`already watching ${label} (pid ${running.pid}, ${running.dir})`);

  // A watcher that was hard-killed leaves its buffer, pid and "live" status
  // behind, on this channel or any other.
  try {
    await sweepAll();
  } catch (err) {
    console.error(`sweep of old sessions failed: ${err.message}`);
  }
  const dir = await newSession(target, new Date());
  const bufDir = path.join(dir, "buf");
  const momentsDir = path.join(dir, "moments");
  const stopFile = path.join(dir, "stop");
  try {
    await fs.writeFile(path.join(dir, "watch.pid"), String(process.pid), { flag: "wx" });
  } catch (err) {
    fail(err.code === "EEXIST" ? `already watching ${label} (${dir})` : err.message);
  }
  await writeSessionSettings(dir, settings);
  owned = { dir, platform, channel, moments: 0, skipped: { queue: 0, disk: 0 } };
  // tests: BOQO_SNIPER_TEST_CRASH=throw|reject crashes the run 300 ms after its session exists
  const testCrash = process.env.BOQO_SNIPER_TEST_CRASH;
  if (testCrash === "throw" || testCrash === "reject") {
    setTimeout(() => {
      const err = new Error(`test crash (${testCrash})`);
      if (testCrash === "throw") throw err;
      Promise.reject(err);
    }, 300);
  }

  // Replay material is read up front so a bad path fails before anything runs.
  let replayFiles = [];
  let replayOffsets = []; // seconds after the replay's start that each file opens at
  let replayChat = [];
  let clock;
  let replayBase = 0;
  if (replay) {
    try {
      replayFiles = (await fs.readdir(args.replay)).filter((f) => f.toLowerCase().endsWith(".ts")).sort();
      if (replayFiles.length === 0) throw new Error(`no .ts files in ${args.replay}`);
      const stamps = replayFiles.map(parseSegmentName);
      replayOffsets = stamps.every((t) => t !== null)
        ? stamps.map((t) => t - stamps[0])
        : replayFiles.map((_, i) => i * SEGMENT_SEC);
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

  let feed = null; // this capture phase's detector and its 1 s ticks (lib/ticks.mjs)
  let chatState = replay ? "open" : "connecting"; // the chat socket's, as the client last said
  const segs = []; // { n, t0, s, name, done, cap }
  let captureNo = 0; // which capture a segment came from: a cut never joins two
  const known = new Set(); // every segment name this session has used (they are never reused)
  let nextN = 0;
  let nextSegNo = 0; // the counter in the next capture's first file name; only ever goes up
  // the running (or last) capture's segment list: its file, how far it is read, the clock that stamps its rows
  let list = null; // { file, offset, clock, cap }
  let totalSegments = 0;
  const chatLog = []; // { t, user, text, emotes }
  const pending = []; // moments waiting for their post-roll
  let lastDoneEnd = -Infinity;
  let moments = 0;
  let dropped = 0; // listed moments deleted to keep the newest MAX_LISTED
  let lowDisk = null; // set with every status write
  const skipped = owned.skipped; // moments not cut: { queue, disk }
  let state = "waiting";
  let since = iso(clock.now());
  let stopRequested = false;
  let lastCaptureTail = "";
  let failMessage = null;

  const setState = (s) => {
    if (s !== state) {
      state = s;
      since = iso(clock.now());
    }
  };

  /** `{freeBytes, minFreeBytes}` while the disk is under the floor (lib/buffer.mjs MIN_FREE_BYTES), else null. */
  async function diskLow() {
    const free = await freeBytes(dir);
    return free !== null && free < minFreeBytes ? { freeBytes: free, minFreeBytes } : null;
  }

  async function writeStatus() {
    if (crashed) return; // the crash handler's "failed" is the last word
    lowDisk = await diskLow();
    const now = clock.now();
    let recent = 0;
    for (let i = chatLog.length - 1; i >= 0 && chatLog[i].t >= now - 30; i--) recent++;
    await writeJsonAtomic(
      path.join(dir, "status.json"),
      {
        state,
        platform,
        channel,
        since,
        segments: segs.length,
        moments,
        skipped,
        chatPerSec: Math.round((recent / 30) * 10) / 10,
        updatedAt: iso(now),
        ...(dropped > 0 ? { dropped } : {}),
        ...(lowDisk ? { lowDisk } : {}),
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

  /** Stamp every segment of `list`'s capture from its clock: an epoch's anchor may have moved down. */
  function restamp(capture, clockOf) {
    for (const seg of segs) if (seg.capture === capture && seg.s !== undefined) seg.t0 = clockOf.t0(seg.s, seg.epoch);
    lastDoneEnd = segs.reduce((m, s2) => (s2.done ? Math.max(m, s2.t0 + SEGMENT_SEC) : m), -Infinity);
  }

  /** The rows the capture's segment list gained: each is a closed segment, kept under its own name, read once. */
  async function scanBuffer() {
    if (!list) return;
    const { rows, offset } = await readSegmentRows(bufDir, list.file, list.offset);
    list.offset = offset;
    if (rows.length === 0) return;
    const seenAt = clock.now();
    for (const row of rows) {
      if (known.has(row.name)) continue;
      const r = list.clock.observe(row, seenAt);
      known.add(row.name);
      // `cap` is what a cut never joins across: the capture, and within it the epoch (a hole in the content)
      const seg = { n: nextN++, t0: 0, s: row.start, name: row.name, done: true, capture: list.cap, epoch: r.epoch, cap: `${list.cap}.${r.epoch}` };
      if (r.splitBack && list.last) {
        list.last.epoch = r.epoch;
        list.last.cap = seg.cap;
      }
      if (r.splitBack) console.error(`a hole of about ${Math.round(r.gapSec)} s in the stream at ${row.name}: segments from here are placed after it`);
      segs.push(seg);
      list.last = seg;
      totalSegments++;
    }
    restamp(list.cap, list.clock);
    segs.sort((a, b) => a.t0 - b.t0);
  }

  /**
   * Before a capture: continue the counter past every file the buffer holds (so the new capture cannot open a name an
   * earlier one used), and remove what the last capture left unlisted, a segment it was writing when it was killed.
   */
  async function prepareCapture() {
    let names = [];
    try {
      names = await fs.readdir(bufDir);
    } catch {}
    for (const name of names) {
      const n = parseSegmentNumber(name);
      if (n !== null) {
        nextSegNo = Math.max(nextSegNo, n + 1);
        if (!known.has(name)) await unlinkRetry(path.join(bufDir, name));
      } else if (/^capture-\d+\.csv$/.test(name)) await unlinkRetry(path.join(bufDir, name));
    }
  }

  // ---- the detector ----

  /** A new detector and tick feed for a capture phase, as hosted builds one per phase. */
  function startFeed() {
    feed = createTickFeed({
      detector: createMomentDetector({ windowSec: settings.windowSec, sensitivity: settings.sensitivity }),
      nowMs: clock.now() * 1000,
      chatOpen: chatState === "open",
    });
  }

  /** Feed every complete second since the last drain; each candidate waits for its post-roll. */
  function drainFeed() {
    if (!feed) return;
    for (const c of feed.drain(clock.now() * 1000)) {
      pending.push({
        peakAt: c.peakAt / 1000,
        score: c.score,
        signal: c.signal,
        title: c.title,
        signalLine: signalLine(c.detail, c.signal),
        detail: c.detail,
      });
    }
  }

  function onChat(m) {
    const t = clock.now();
    chatLog.push({ t, user: m.user, text: m.text, emotes: m.emotes });
    feed?.chat(t * 1000, m.text);
  }

  function onChatState(state, t = clock.now()) {
    chatState = state;
    feed?.chatState(state, t * 1000);
  }

  function finishSegment(seg) {
    seg.done = true;
    lastDoneEnd = Math.max(lastDoneEnd, seg.t0 + SEGMENT_SEC);
  }

  async function cut(spike) {
    // About 260 MB a moment at 1080p60 (lib/buffer.mjs MIN_FREE_BYTES): never more than maxQueue waiting for the
    // agent, never under minFreeBytes free. A moment below the bar is no queue, and a hand-made one skips the queue.
    const goes = isAutoMoment(spike, settings);
    const unclaimed = goes && spike.signal !== "manual" ? await countUnclaimed(momentsDir, (m) => isAutoMoment(m, settings)) : 0;
    const free = await freeBytes(dir);
    const why = skipCut({ unclaimed, freeBytes: free }, { maxQueue, minFreeBytes });
    if (why) {
      skipped[why]++;
      console.error(
        why === "queue"
          ? `moment at ${iso(spike.peakAt)} skipped: ${unclaimed} ${unclaimed === 1 ? "moment waits" : "moments wait"} for the agent`
          : `moment at ${iso(spike.peakAt)} skipped: only ${(free / 1e9).toFixed(1)} GB free`,
      );
      return;
    }
    const plan = planCut(segs.filter((s) => s.done), spike.peakAt, settings.windowSec);
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
        signal: spike.signal,
        title: spike.title,
        signalLine: spike.signalLine,
        detail: spike.detail,
        platform,
        channel,
        peakIso: iso(spike.peakAt),
        peakOffsetSec: plan.peakOffsetSec,
        startAt: first,
        endAt: end,
      });
      moments++;
      if (owned) owned.moments = moments;
      if (!goes) await pruneListed();
    } catch (err) {
      console.error(`cut failed: ${err.message}`);
      await fs.rm(momentDir, { recursive: true, force: true });
    } finally {
      await unlinkRetry(path.join(bufDir, listName));
    }
  }

  /** Moments below the bar wait for "clip it" and are no queue: keep the newest MAX_LISTED and delete the rest. */
  async function pruneListed() {
    const listed = [];
    let names = [];
    try {
      names = (await fs.readdir(momentsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {}
    for (const name of names) {
      const d = path.join(momentsDir, name);
      try {
        await fs.access(path.join(d, ".taken"));
        continue;
      } catch {}
      try {
        if (!isAutoMoment(JSON.parse(await fs.readFile(path.join(d, "meta.json"), "utf8")), settings)) listed.push(d);
      } catch {}
    }
    for (const d of listed.slice(0, Math.max(0, listed.length - MAX_LISTED))) {
      console.error(`listed moment ${path.basename(d)} deleted: only the newest ${MAX_LISTED} below the bar are kept`);
      await fs.rm(d, { recursive: true, force: true });
      dropped++;
    }
  }

  /** `--clip-now` leaves `clipnow` in the session: a hand-made moment at this second (hosted's manualCandidate). */
  async function takeClipNow() {
    try {
      await fs.rm(path.join(dir, "clipnow"));
    } catch {
      return;
    }
    pending.push({ peakAt: clock.now(), score: 100, signal: "manual", title: "clipped by hand", signalLine: null, detail: null });
  }

  async function prune() {
    const old = pruneBefore(segs, horizonSec);
    if (old.length === 0) return;
    const gone = new Set(old.map((s) => s.n));
    for (const s of old) await unlinkRetry(path.join(bufDir, s.name));
    for (let i = segs.length - 1; i >= 0; i--) if (gone.has(segs[i].n)) segs.splice(i, 1);
  }

  /** One pass: finish segments, feed the detector, cut what is ready, prune, report. `ended`: nothing more will arrive. */
  async function tick(ended) {
    await scanBuffer();
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.done) continue;
      if (!segs[i + 1] && !ended) break; // the newest one is still being written
      finishSegment(seg);
    }
    drainFeed();
    await takeClipNow();
    const flush = ended || stopRequested;
    for (let i = 0; i < pending.length; ) {
      const spike = pending[i];
      if (flush || lastDoneEnd >= spike.peakAt + POST_ROLL_SEC) {
        pending.splice(i, 1);
        await cut(spike);
      } else i++;
    }
    await prune();
    const horizonT = clock.now() - horizonSec - PRUNE_MARGIN_SEC;
    while (chatLog.length && chatLog[0].t < horizonT) chatLog.shift();
    await writeStatus();
  }

  // ---- the two capture sources ----

  async function captureLive() {
    const before = totalSegments;
    // every segment of the last capture was found by the tick after it ended
    captureNo++;
    startFeed();
    await prepareCapture();
    list = { file: `capture-${captureNo}.csv`, offset: 0, clock: createCaptureClock(), cap: captureNo };
    capture = startCapture(tool, target, bufDir, (momentary) => feed?.loudness(clock.now() * 1000, momentary), {
      startNumber: nextSegNo,
      listFile: list.file,
    });
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
    lastCaptureTail = capture.tail();
    if (totalSegments === before) console.error(`capture made no segments:\n${lastCaptureTail}`);
    capture = null;
  }

  async function captureReplay() {
    startFeed();
    let ci = 0;
    // every chat line before `before`, stamped with its own time as a live one is with its arrival
    const feedChat = (before) => {
      while (ci < replayChat.length && replayBase + replayChat[ci].t < before) {
        const c = replayChat[ci++];
        const t = replayBase + c.t;
        if (typeof c.chatState === "string") {
          onChatState(c.chatState, t);
          continue;
        }
        const text = String(c.text ?? "");
        chatLog.push({ t, user: String(c.user), text, emotes: Number(c.emotes) || 0 });
        feed?.chat(t * 1000, text);
      }
    };
    // the clock moves a second at a time, and every second the detector is fed, as a live capture's loop does
    const replayUntil = async (t) => {
      while (clock.now() < t && !(await checkStop())) {
        await clock.sleep(Math.min(1, t - clock.now()));
        feedChat(clock.now());
        drainFeed();
      }
    };
    for (let i = 0; i < replayFiles.length; i++) {
      const at = replayBase + replayOffsets[i];
      await replayUntil(at);
      if (await checkStop()) return;
      feedChat(at);
      const name = segmentFileName(nextSegNo++);
      const seg = path.join(bufDir, name);
      await fs.copyFile(path.join(args.replay, replayFiles[i]), seg);
      // a replay has no segment list: the file's offset is its start, and it is whole at once
      known.add(name);
      segs.push({ n: nextN++, t0: at, name, done: false, cap: captureNo });
      totalSegments++;
      segs.sort((a, b) => a.t0 - b.t0);
      for (const r of await measureMomentary(seg)) feed.loudness((at + r.t) * 1000, r.momentary);
      await tick(false);
      setState("live");
    }
    const endAt = replayBase + replayOffsets.at(-1) + SEGMENT_SEC;
    await replayUntil(endAt);
    feedChat(endAt);
  }

  // ---- run ----

  let chat = null;
  if (replay) {
    // chat comes from the file
  } else {
    // tests: BOQO_SNIPER_TEST_KICK_STATUS=<n> makes Kick's channel API answer with that status
    const testKick = process.env.BOQO_SNIPER_TEST_KICK_STATUS;
    // BOQO_SNIPER_TEST_KICK_HANG=1: the channel API never answers; BOQO_SNIPER_KICK_LOOKUP_MS shortens the 15 s wait
    const fetchImpl = process.env.BOQO_SNIPER_TEST_KICK_HANG === "1"
      ? () => new Promise(() => {})
      : testKick
      ? async () => ({ status: Number(testKick), ok: Number(testKick) === 200, json: async () => ({ chatroom: { id: 1 } }) })
      : globalThis.fetch;
    try {
      chat = await startChat({
        platform,
        slug: channel,
        onMessage: onChat,
        onOpenChange: (open) => onChatState(open ? "open" : "connecting"),
        fetch: fetchImpl,
        lookupTimeoutMs: envNumber("BOQO_SNIPER_KICK_LOOKUP_MS", KICK_LOOKUP_TIMEOUT_MS),
      });
    } catch (err) {
      // Kick answered the channel lookup with something but 200, or not at all in time: no chatroom to join, so no
      // chat for the whole watch. Say so now, in one line, and stop; the person decides (Kick sits behind Cloudflare).
      if (err instanceof KickRefused || err instanceof KickLookupTimeout) await failSession(err.message, 2);
      throw err;
    }
  }

  let exitError = null;
  let offlinePolls = 0; // consecutive polls that said offline
  let failedCaptures = 0; // consecutive captures that made no segment
  try {
    await writeStatus();
    if (lowDisk) {
      // Said once, here: a start with the disk under the floor looks normal and then cuts nothing (status.lowDisk,
      // and the end line, carry it too). The floor is checked against the free space at each cut, queued cuts
      // already out of it: lib/buffer.mjs says how much that is to reach a full queue.
      console.error(
        `low disk: ${(lowDisk.freeBytes / 1e9).toFixed(1)} GB free, under the ${(lowDisk.minFreeBytes / 1e9).toFixed(1)} GB floor: no moment will be cut until space is freed`,
      );
    }
    while (!(await checkStop())) {
      const before = totalSegments;
      await (replay ? captureReplay() : captureLive());
      if (await checkStop()) break;
      await tick(true); // the capture is over: its last segment is whole now
      feed = null; // the next capture phase starts a new detector
      if (totalSegments > before) {
        offlinePolls = 0;
        failedCaptures = 0;
      } else if (++failedCaptures >= MAX_FAILED_CAPTURES) {
        // Every capture after the first starts only once the channel says live:
        // this is a capture that cannot record a live stream, not an offline one.
        throw new Error(
          `the capture made nothing ${failedCaptures} times in a row while the channel was live: ${lastCaptureTail.trim() || "no output"}`,
        );
      }
      setState("waiting");
      await writeStatus();

      let live = false;
      while (!live && offlinePolls < MAX_OFFLINE_POLLS) {
        await nap(pollSec);
        if (await checkStop()) break;
        live = replay ? false : await isLive(tool, target);
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
  // yt-dlp's own ffmpeg can outlive yt-dlp: wait until the whole capture tree is gone
  await Promise.all([...kills]);
  if (exitError) failMessage = exitError.message || String(exitError);
  setState(exitError ? "failed" : stopped ? "stopped" : "offline");
  if (!keepBuf) {
    for (const s of segs.splice(0)) await unlinkRetry(path.join(bufDir, s.name));
    // and what the last capture left: a segment it was writing when it was killed, and its segment list
    for (const name of await fs.readdir(bufDir).catch(() => [])) {
      if (parseSegmentNumber(name) !== null || /^capture-\d+\.csv$/.test(name)) await unlinkRetry(path.join(bufDir, name));
    }
  }
  await writeStatus();
  await fs.rm(path.join(dir, "watch.pid"), { force: true });
  await fs.rm(stopFile, { force: true });

  if (exitError) fail(failMessage);
  process.stdout.write(JSON.stringify({ state, platform, channel, session: dir, moments, offlinePolls, ...(lowDisk ? { lowDisk } : {}) }) + "\n", () => process.exit(0));
}

main().catch((err) => failSession(err?.message || String(err)));
