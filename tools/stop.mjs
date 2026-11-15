#!/usr/bin/env node
// Stop the watcher for a channel.
//
//   stop.mjs <channel>
//
// Writes `stop` into the session folder (the watcher reads it every second)
// and, off Windows, sends SIGTERM to the pid. Waits for the process to go, so
// nothing is still recording when this returns. One JSON line:
//   {"stopped": true, "channel", "pid"}     it was running and is gone now
//   {"stopped": false, "reason": "..."}     nothing was running

import fs from "node:fs/promises";
import path from "node:path";
import { cleanupSession, currentSession, pidAlive, watcherPid } from "../lib/session.mjs";

const WAIT_MS = 20000;

function fail(message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

async function gone(pid, ms) {
  const deadline = Date.now() + ms;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

async function main() {
  const channel = process.argv[2];
  if (!channel || channel.startsWith("--")) fail("usage: stop.mjs <channel>");
  const session = await currentSession(channel);
  if (!session) {
    console.log(JSON.stringify({ stopped: false, reason: "no-session" }));
    return;
  }
  const pid = await watcherPid(session);
  if (pid === null) {
    // No live watcher owns the session. One that died without saying so must
    // not leave its buffer on disk or keep `next` waiting on a "live" status.
    await cleanupSession(session);
    console.log(JSON.stringify({ stopped: false, reason: "not-running" }));
    return;
  }

  await fs.writeFile(path.join(session, "stop"), String(Date.now()));
  // On Windows SIGTERM is a hard kill that skips the watcher's own cleanup,
  // so there the file is the request and the kill only a last resort.
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  if (!(await gone(pid, WAIT_MS))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await gone(pid, 5000);
    // It never got to clean up after itself.
    await cleanupSession(session);
  }
  console.log(JSON.stringify({ stopped: true, channel: channel.toLowerCase(), pid }));
}

main().catch((err) => fail(err.message));
