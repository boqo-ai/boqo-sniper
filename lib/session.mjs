// Session folders for the watcher and `next` (shared by both).
//
// Layout: $BOQO_HOME/boqo-sniper/watch/<platform>-<slug>/<YYYYMMDD-HHMMSS>/
//   buf/  moments/  status.json  watch.pid
// (twitch-xqc, kick-x-q_c.) Sessions sit under watch/ so a channel can never be
// named like the skill's other folders beside it (onboarding's samples/, clips/).
// A channel is given as boqo's parser takes it (twitch.tv/xqc, kick.com/x-q_c,
// kick:xqc) or as a bare Twitch login; every function below that takes a
// `channel` takes any of those, or the `{platform, channel}` the parser returns.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { STREAM_PLATFORMS, parseStreamChannel, streamChannel } from "./boqo/stream.mjs";
import { defaultSettings, resolveSettings } from "./settings.mjs";

export function sniperHome() {
  const home = process.env.BOQO_HOME || path.join(os.homedir(), ".boqo");
  return path.join(home, "boqo-sniper");
}

/** Every channel's session folders live in here, one folder per platform and channel. */
export function watchRoot() {
  return path.join(sniperHome(), "watch");
}

/**
 * `{platform, channel}` for what the person typed: boqo's parser (a link, `kick:<slug>`, `twitch:<login>`), or a
 * bare Twitch login. Throws on anything else, so no name can reach a path unchecked: slugs are a-z, 0-9, `_` and
 * (Kick) `-`, so there is no separator in one and no `..`.
 */
export function resolveChannel(input) {
  let c = null;
  if (input && typeof input === "object") {
    const platform = String(input.platform).toLowerCase();
    if (STREAM_PLATFORMS.includes(platform)) c = streamChannel(platform, String(input.channel));
  } else if (typeof input === "string") {
    c = parseStreamChannel(input);
    if (c === null && /^[A-Za-z0-9_]+$/.test(input)) c = streamChannel("twitch", input);
  }
  if (c === null) throw new Error(`bad channel name: ${JSON.stringify(input)}`);
  return c;
}

/** The folder name under watch/: `twitch-xqc`, `kick-x-q_c`. */
export function sessionFolder(channel) {
  const c = resolveChannel(channel);
  return `${c.platform}-${c.channel}`;
}

/** The channel's folder of sessions. */
export function sessionsDir(channel) {
  return path.join(watchRoot(), sessionFolder(channel));
}

const pad = (n) => String(n).padStart(2, "0");

export function stamp(d) {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/** Create a fresh session folder (with buf/ and moments/) and return its path. */
export async function newSession(channel, now = new Date()) {
  const dir = path.join(sessionsDir(channel), stamp(now));
  await fs.mkdir(path.join(dir, "buf"), { recursive: true });
  await fs.mkdir(path.join(dir, "moments"), { recursive: true });
  return dir;
}

async function newestIn(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  const names = entries
    .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
    .map((e) => e.name)
    .sort();
  return names.length ? path.join(root, names[names.length - 1]) : null;
}

/**
 * The newest session folder by name, or null. A Twitch login also looks in v0.1's `watch/<login>/` when
 * `watch/twitch-<login>/` has none, so `status`, `next` and `stop` still find a v0.1 session (read only: a new
 * watcher always writes `twitch-<login>`).
 */
export async function currentSession(channel) {
  const found = await newestIn(sessionsDir(channel));
  if (found) return found;
  const c = resolveChannel(channel);
  return c.platform === "twitch" ? newestIn(path.join(watchRoot(), c.channel)) : null;
}

/** The session's settings.json, or the defaults when it is missing or half written (v0.1's sessions have none). */
export async function readSessionSettings(sessionDir) {
  try {
    return resolveSettings(JSON.parse(await fs.readFile(path.join(sessionDir, "settings.json"), "utf8")));
  } catch {
    return defaultSettings();
  }
}

/** The session's image budget (lib/vision-budget.mjs `file`): one rolling hour for every moment run and every restart. */
export function visionFile(sessionDir) {
  return path.join(sessionDir, "vision.json");
}

/**
 * The moments this session ran through the Clips path and the clips they made: `<session>/clipped.jsonl`, a line
 * `{moment, clips, noRead}` per moment (lib/moment-run.mjs). A line that is not JSON is skipped.
 */
export async function readTally(sessionDir) {
  let text = "";
  try {
    text = await fs.readFile(path.join(sessionDir, "clipped.jsonl"), "utf8");
  } catch {}
  let clipped = 0;
  let clips = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      clipped++;
      if (Number.isInteger(e.clips) && e.clips > 0) clips += e.clips;
    } catch {}
  }
  return { clipped, clips };
}

export async function writeSessionSettings(sessionDir, settings) {
  await writeJsonAtomic(path.join(sessionDir, "settings.json"), settings);
}

/** Parsed status.json; null when missing or half written. */
export async function readStatus(sessionDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(sessionDir, "status.json"), "utf8"));
  } catch {
    return null;
  }
}

// ---- shared by watch, stop and the start-up sweep ----

/** A watcher in one of these states has exited; "failed" carries an `error`. */
const FINAL_STATES = new Set(["offline", "stopped", "failed"]);
/**
 * A status this old means its watcher is gone. A live watcher writes it at
 * least every 2 minutes (a 60 s nap plus a live check of up to 45 s), so 4
 * minutes is dead; the skill's own threshold matches.
 */
export const STALE_STATUS_SEC = 240;
/** stop.mjs waits this long for a watcher to end by itself before a hard kill: its live check alone can take 45 s. */
export const STOP_WAIT_MS = 55000;
/** Moments older than this are deleted when a later watcher starts. */
export const MOMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Temp file then rename: a reader never sees half a file. Windows can refuse a rename onto a file being read; retry, then give up quietly if asked to. */
export async function writeJsonAtomic(file, value, { quiet = false } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      if (attempt < 5 && ["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      await fs.rm(tmp, { force: true });
      if (quiet) return;
      throw err;
    }
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** The pid in a session's watch.pid, or null. */
export async function readPid(sessionDir) {
  try {
    const pid = Number((await fs.readFile(path.join(sessionDir, "watch.pid"), "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({
        spawnError: Boolean(err && typeof err.code === "string"),
        killed: Boolean(err?.killed),
        code: err ? err.code : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      });
    });
  });
}

/**
 * A process's command line: "" only when the lookup ran cleanly and found no
 * process on that pid; null whenever it cannot tell (no tool, a timeout, an
 * error on stderr, an exit code that does not mean "no such pid"), and then
 * the status decides. A wrong "" would make a live watcher look dead, and a
 * sweep would empty its buffer. POSIX: `ps -o args= -p <pid>` (procps and
 * macOS exit 1 and print nothing for a missing pid). Windows: PowerShell's
 * Win32_Process (prints nothing for a missing pid), else wmic ("No
 * Instance(s) Available." on stderr). `exec` and `platform` are for tests.
 */
export async function processCommandLine(pid, { exec = run, platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  const failed = (r) => r.spawnError || r.killed || r.code === null || r.stderr.trim() !== "";
  if (platform !== "win32") {
    const r = await exec("ps", ["-o", "args=", "-p", String(pid)]);
    if (failed(r)) return null;
    if (r.code === 0) return r.stdout.trim();
    return r.code === 1 && r.stdout.trim() === "" ? "" : null;
  }
  const ps = await exec("powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
  ]);
  if (!failed(ps) && ps.code === 0) return ps.stdout.trim();
  const wmic = await exec("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"]);
  const m = /CommandLine=(.*)/.exec(wmic.stdout);
  if (!wmic.spawnError && !wmic.killed && wmic.code === 0) {
    if (m) return m[1].trim();
    if (/No Instance/i.test(wmic.stderr)) return "";
  }
  return null;
}

/** Is this command line a watcher's? */
export function isWatcherCommand(cmd) {
  return /watch\.mjs/.test(cmd);
}

/**
 * A live watcher owns this session: its pid runs, its status is neither final
 * nor stale, and the process on that pid is a watcher (`lookup` gives its
 * command line; one that does not name watch.mjs is another program that got
 * a dead watcher's pid). Returns the pid, or null; a null pid is never signalled.
 */
export async function watcherPid(sessionDir, { lookup = processCommandLine } = {}) {
  const pid = await readPid(sessionDir);
  if (pid === null || pid === process.pid || !pidAlive(pid)) return null;
  const status = await readStatus(sessionDir);
  if (status) {
    if (FINAL_STATES.has(status.state)) return null;
    const age = Date.now() / 1000 - Date.parse(status.updatedAt) / 1000;
    if (Number.isFinite(age) && age > STALE_STATUS_SEC) return null;
  }
  const cmd = await lookup(pid);
  if (cmd !== null && !isWatcherCommand(cmd)) return null;
  return pid;
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

/**
 * What a watcher that died without cleaning up leaves behind: the segment
 * buffer (hundreds of MB), `stop`, `watch.pid` and a status still saying
 * "live". Safe only when no watcher owns the session.
 */
export async function cleanupSession(sessionDir) {
  const buf = path.join(sessionDir, "buf");
  let names = [];
  try {
    names = await fs.readdir(buf);
  } catch {}
  for (const n of names) if (/\.(ts|txt|csv)$/.test(n)) await unlinkRetry(path.join(buf, n));
  await fs.rm(path.join(sessionDir, "stop"), { force: true });
  await fs.rm(path.join(sessionDir, "clipnow"), { force: true });
  await fs.rm(path.join(sessionDir, "watch.pid"), { force: true });
  const status = await readStatus(sessionDir);
  if (status && !FINAL_STATES.has(status.state)) {
    await writeJsonAtomic(
      path.join(sessionDir, "status.json"),
      { ...status, state: "stopped", updatedAt: new Date().toISOString() },
      { quiet: true },
    );
  }
}

/** The epoch ms a moment folder name (`YYYYMMDD-HHMMSS`, maybe `-2`) encodes, or null. */
function momentTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/**
 * Moment folders in `momentsDir` that `next` has not claimed yet (no `.taken`). With `wanted(meta)`, only those it
 * lets through; a folder whose meta.json is not there yet is being cut and counts, so a cut in progress never
 * lets the queue overrun.
 */
export async function countUnclaimed(momentsDir, wanted = null) {
  let names;
  try {
    names = (await fs.readdir(momentsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    try {
      await fs.access(path.join(momentsDir, name, ".taken"));
      continue;
    } catch {}
    if (wanted) {
      let meta = null;
      try {
        meta = JSON.parse(await fs.readFile(path.join(momentsDir, name, "meta.json"), "utf8"));
      } catch {}
      if (meta && !wanted(meta)) continue;
    }
    n++;
  }
  return n;
}

/** Bytes free to this user on the disk that holds `dir`, or null when the OS will not say. */
export async function freeBytes(dir) {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** A session this young may belong to a watcher still starting (no pid or status yet): the sweep leaves it. */
export const SWEEP_MIN_AGE_MS = 2 * 60 * 1000;
/** An ended session is left this long after its last status, so its own chat can read how it ended. */
export const SWEEP_ENDED_GRACE_MS = 10 * 60 * 1000;

/**
 * Called when a watcher starts: every OTHER session of the channel that no
 * live watcher owns is cleaned up, its moments older than 24 h are deleted,
 * and a session left with no moments is removed whole. Left alone: a session
 * whose name is under 2 minutes from now (a watcher on any channel may be
 * starting in it) and an ended one whose status is under 10 minutes old.
 * Returns the folders removed. `lookup` is watcherPid's, for tests.
 */
export async function sweepChannel(channel, keepDir, nowMs = Date.now(), opts = {}) {
  return sweepRoot(sessionsDir(channel), keepDir, nowMs, opts);
}

async function sweepRoot(root, keepDir, nowMs, { lookup } = {}) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d{8}-\d{6}$/.test(e.name)) continue;
    const dir = path.join(root, e.name);
    if (keepDir && path.resolve(dir) === path.resolve(keepDir)) continue;
    const born = momentTime(e.name);
    if (born !== null && Math.abs(nowMs - born) < SWEEP_MIN_AGE_MS) continue;
    const status = await readStatus(dir);
    if (status && FINAL_STATES.has(status.state)) {
      const age = nowMs - Date.parse(status.updatedAt);
      if (!(age >= SWEEP_ENDED_GRACE_MS)) continue; // also a status with no readable time
    }
    if ((await watcherPid(dir, lookup ? { lookup } : {})) !== null) continue;
    await cleanupSession(dir);
    const momentsDir = path.join(dir, "moments");
    let moments = [];
    try {
      moments = await fs.readdir(momentsDir);
    } catch {}
    let left = 0;
    for (const name of moments) {
      const t = momentTime(name);
      if (t !== null && nowMs - t > MOMENT_MAX_AGE_MS) await fs.rm(path.join(momentsDir, name), { recursive: true, force: true });
      else left++;
    }
    if (left === 0) {
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  return removed;
}

/**
 * sweepChannel for every channel folder under watch/: a watcher that died on one
 * channel must not leave its buffer on disk until that channel is watched
 * again. Returns the session folders removed.
 */
export async function sweepAll(keepDir, nowMs = Date.now(), opts = {}) {
  let entries;
  try {
    entries = await fs.readdir(watchRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const e of entries) {
    // `<platform>-<slug>`; or v0.1's `<login>` folder, which a new watcher no longer writes but still sweeps
    if (!e.isDirectory() || !/^(?:(?:twitch|kick)-[a-z0-9_-]{1,50}|[a-z0-9_]+)$/.test(e.name)) continue;
    removed.push(...(await sweepRoot(path.join(watchRoot(), e.name), keepDir, nowMs, opts)));
  }
  return removed;
}
