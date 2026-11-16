#!/usr/bin/env node
// Next moment: block until the watcher has a new moment, then print it.
//
//   next.mjs <channel> [--timeout 540]
//
// One JSON line on stdout:
//   {"moment": "<dir>", "meta": {...}}   a moment, now claimed with `.taken`
//   {"stopped": "<state>"}               watcher offline/stopped, or no session
//   {"stopped": "failed", "error": "..."} the watcher ended on an error
//   {"timeout": true, "status": {...}}   nothing came in time
// Never waits past 540 s: Claude Code caps one shell command at 600 s. The skill
// passes --timeout 170, since Claude Code moves a command to the background
// after about 180 s whatever its timeout.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { currentSession, readStatus } from "../lib/session.mjs";

export const MAX_TIMEOUT_S = 540;
const POLL_MS = 1000;

function fail(message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function parseArgs(argv) {
  let channel = null;
  let timeout = MAX_TIMEOUT_S;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--timeout") {
      const raw = argv[++i];
      const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(n) || n < 0) throw new Error(`bad --timeout: ${raw}`);
      timeout = Math.min(n, MAX_TIMEOUT_S);
    } else if (argv[i].startsWith("--")) {
      throw new Error(`unknown option: ${argv[i]}`);
    } else if (channel === null) {
      channel = argv[i];
    } else {
      throw new Error(`unexpected argument: ${argv[i]}`);
    }
  }
  if (!channel) throw new Error("usage: next.mjs <channel> [--timeout 540]");
  return { channel, timeout };
}

/** Claim the oldest ready, unclaimed moment; null when there is none. */
async function claimNext(momentsDir) {
  let names;
  try {
    names = (await fsp.readdir(momentsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  for (const name of names) {
    const dir = path.join(momentsDir, name);
    let meta;
    try {
      await fsp.access(path.join(dir, ".taken"));
      continue;
    } catch {}
    try {
      meta = JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8"));
    } catch {
      continue; // not ready yet (the watcher writes meta.json last)
    }
    try {
      await (await fsp.open(path.join(dir, ".taken"), "wx")).close();
    } catch (err) {
      if (err.code === "EEXIST") continue; // another `next` won it
      throw err;
    }
    return { moment: dir, meta };
  }
  return null;
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
      const found = await claimNext(momentsDir);
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

main().catch((err) => fail(err.message));
