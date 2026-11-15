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
