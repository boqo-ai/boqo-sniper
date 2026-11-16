#!/usr/bin/env node
// Next moment: block until the watcher has a moment for the agent, then print it.
//
//   next.mjs <channel> [--timeout 170]   wait for the next moment at or above the bar
//   next.mjs <channel> --list            the moments below the bar that are still unclaimed
//   next.mjs <channel> --take [<name>]   "clip it": claim a listed moment (the newest, or the one named)
//
// The bar is the session's autoClipMinScore (settings.json, written by the watcher; the defaults when there is
// none), and with autoClip off nothing detected is at the bar. A hand-made moment (`clip now`) always is.
//
// One JSON line on stdout:
//   {"moment": "<dir>", "meta": {...}}   a moment at the bar, now claimed with `.taken`
//   {"listed": "<dir>", "meta": {...}}   a moment below the bar, told once (`.listed`) and NOT claimed
//   {"stopped": "<state>"}               watcher offline/stopped, or no session
//   {"stopped": "failed", "error": "..."} the watcher ended on an error
//   {"timeout": true, "status": {...}}   nothing came in time
//   {"moments": [...], "dropped": n}    --list: name, moment, score, band, signalLine, title, peakIso; and how many
//                                        older ones the watcher deleted to keep the newest 3
// Never waits past 540 s: Claude Code caps one shell command at 600 s. The default and the skill's value are 170,
// since Claude Code moves a command to the background after about 180 s whatever its timeout.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { currentSession, readSessionSettings, readStatus } from "../lib/session.mjs";
import { isAutoMoment } from "../lib/settings.mjs";
import { scoreBand } from "../engine/boqo/score-grade.mjs";

export const MAX_TIMEOUT_S = 540;
export const DEFAULT_TIMEOUT_S = 170;
const POLL_MS = 1000;

function fail(message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

export function parseArgs(argv) {
  let channel = null;
  let timeout = DEFAULT_TIMEOUT_S;
  let mode = "wait";
  let take = null;
  const setMode = (m) => {
    if (mode !== "wait") throw new Error("use one of --list and --take");
    mode = m;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--timeout") {
      const raw = argv[++i];
      const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`bad --timeout: ${raw}`);
      timeout = Math.min(n, MAX_TIMEOUT_S);
    } else if (argv[i] === "--list") {
      setMode("list");
    } else if (argv[i] === "--take") {
      setMode("take");
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) take = argv[++i];
    } else if (argv[i].startsWith("--")) {
      throw new Error(`unknown option: ${argv[i]}`);
    } else if (channel === null) {
      channel = argv[i];
    } else {
      throw new Error(`unexpected argument: ${argv[i]}`);
    }
  }
  if (!channel) throw new Error("usage: next.mjs <channel> [--timeout 170] | --list | --take [<name>]");
  return { channel, timeout, mode, take };
}

async function readMeta(dir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8"));
  } catch {
    return null; // not ready yet (the watcher writes meta.json last)
  }
}

const exists = (file) => fsp.access(file).then(() => true, () => false);

async function momentNames(momentsDir) {
  try {
    return (await fsp.readdir(momentsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** Create a marker file: true; false when it is already there (another `next` won it); null when its folder is gone (the watcher deleted an old listed moment). */
export async function mark(file) {
  try {
    await (await fsp.open(file, "wx")).close();
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * The oldest ready, unclaimed moment that needs the agent: one at the bar is claimed (`.taken`); one below it is
 * told once (`.listed`) and stays unclaimed, for `--take`. Null when there is none.
 */
async function claimNext(momentsDir, settings) {
  for (const name of await momentNames(momentsDir)) {
    const dir = path.join(momentsDir, name);
    if (await exists(path.join(dir, ".taken"))) continue;
    const meta = await readMeta(dir);
    if (meta === null) continue;
    if (isAutoMoment(meta, settings)) {
      if (!(await mark(path.join(dir, ".taken")))) continue;
      return { moment: dir, meta };
    }
    if (await exists(path.join(dir, ".listed"))) continue;
    if (!(await mark(path.join(dir, ".listed")))) continue;
    return { listed: dir, meta };
  }
  return null;
}

/** The unclaimed moments below the bar, oldest first. */
async function listed(momentsDir, settings) {
  const out = [];
  for (const name of await momentNames(momentsDir)) {
    const dir = path.join(momentsDir, name);
    if (await exists(path.join(dir, ".taken"))) continue;
    const meta = await readMeta(dir);
    if (meta === null || isAutoMoment(meta, settings)) continue;
    out.push({ name, dir, meta });
  }
  return out;
}

const DROPPED_HINT = "it may have been dropped: the watcher keeps only the newest 3 moments below the bar";

async function doList(momentsDir, settings, status) {
  const moments = (await listed(momentsDir, settings)).map(({ name, dir, meta }) => ({
    name,
    moment: dir,
    score: meta.score ?? null,
    band: Number.isFinite(meta.score) ? scoreBand(meta.score) : null,
    signalLine: meta.signalLine ?? null,
    title: meta.title ?? null,
    peakIso: meta.peakIso ?? null,
  }));
  console.log(JSON.stringify({ moments, dropped: status?.dropped ?? 0 }));
}

async function doTake(momentsDir, settings, name) {
  if (name !== null && (name !== path.basename(name) || name === "" || name === "." || name === "..")) fail(`no moment named ${name}`);
  const all = await listed(momentsDir, settings);
  let pick;
  if (name === null) {
    pick = all.at(-1);
    if (!pick) fail("no listed moment");
  } else {
    pick = all.find((m) => m.name === name);
    if (!pick) {
      const known = (await momentNames(momentsDir)).includes(name);
      fail(known ? `moment ${name} is not listed (it is at the bar, or already claimed)` : `no moment named ${name}: ${DROPPED_HINT}`);
    }
  }
  const got = await mark(path.join(pick.dir, ".taken"));
  if (got === null) fail(`no moment named ${pick.name}: ${DROPPED_HINT}`); // deleted between the listing and the claim
  if (!got) fail(`moment ${pick.name} is already claimed`);
  console.log(JSON.stringify({ moment: pick.dir, meta: pick.meta }));
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(err.message);
  }
  const session = await currentSession(args.channel);
  if (!session) {
    console.log(JSON.stringify({ stopped: "no-session" }));
    return;
  }
  const momentsDir = path.join(session, "moments");
  const settings = await readSessionSettings(session);
  if (args.mode === "list") return doList(momentsDir, settings, await readStatus(session));
  if (args.mode === "take") return doTake(momentsDir, settings, args.take);
  const deadline = Date.now() + args.timeout * 1000;

  // fs.watch (recursive, so a late meta.json wakes us too) ends the wait early;
  // the 1 s poll covers platforms where it misses events.
  let wake = () => {};
  let watcher = null;
  try {
    await fsp.mkdir(momentsDir, { recursive: true });
    watcher = fs.watch(momentsDir, { recursive: true }, () => wake());
    watcher.on("error", () => {});
  } catch {}

  try {
    for (;;) {
      const found = await claimNext(momentsDir, settings);
      if (found) {
        console.log(JSON.stringify(found));
        return;
      }
      const status = await readStatus(session);
      if (status && (status.state === "offline" || status.state === "stopped")) {
        console.log(JSON.stringify({ stopped: status.state }));
        return;
      }
      if (status && status.state === "failed") {
        console.log(JSON.stringify({ stopped: "failed", error: String(status.error ?? "unknown error") }));
        return;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        console.log(JSON.stringify({ timeout: true, status }));
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(POLL_MS, left));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    watcher?.close();
  }
}

// Run only as a program: a test imports parseArgs. (Node resolves a symlinked entry point; so does this.)
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) main().catch((err) => fail(err.message));
