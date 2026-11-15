// Session folders for the watcher and `next` (shared by both).
//
// Layout: $BOQO_HOME/boqo-sniper/<channel>/<YYYYMMDD-HHMMSS>/
//   buf/  moments/  status.json  watch.pid

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function sniperHome() {
  const home = process.env.BOQO_HOME || path.join(os.homedir(), ".boqo");
  return path.join(home, "boqo-sniper");
}

/** Twitch logins are letters, digits and underscore; anything else is refused. */
export function sessionsDir(channel) {
  if (typeof channel !== "string" || !/^[A-Za-z0-9_]+$/.test(channel)) {
    throw new Error(`bad channel name: ${JSON.stringify(channel)}`);
  }
  return path.join(sniperHome(), channel.toLowerCase());
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

/** The newest session folder by name, or null. */
export async function currentSession(channel) {
  const root = sessionsDir(channel);
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
/** A status this old means the pid file's process is not our watcher (a recycled pid). */
export const STALE_STATUS_SEC = 10 * 60;
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

/** A live watcher owns this session: its pid runs and its status is neither final nor stale. Returns the pid, or null. */
export async function watcherPid(sessionDir) {
  const pid = await readPid(sessionDir);
  if (pid === null || pid === process.pid || !pidAlive(pid)) return null;
  const status = await readStatus(sessionDir);
  if (status) {
    if (FINAL_STATES.has(status.state)) return null;
    const age = Date.now() / 1000 - Date.parse(status.updatedAt) / 1000;
    if (Number.isFinite(age) && age > STALE_STATUS_SEC) return null;
  }
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
  for (const n of names) if (/\.(ts|txt)$/.test(n)) await unlinkRetry(path.join(buf, n));
  await fs.rm(path.join(sessionDir, "stop"), { force: true });
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
 * Called when a watcher starts: every OTHER session of the channel that no
 * live watcher owns is cleaned up, its moments older than 24 h are deleted,
 * and a session left with no moments is removed whole. Returns the folders removed.
 */
export async function sweepChannel(channel, keepDir, nowMs = Date.now()) {
  const root = sessionsDir(channel);
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
    if ((await watcherPid(dir)) !== null) continue;
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
