import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  stamp,
  sweepAll,
  sweepChannel,
  cleanupSession,
  watcherPid,
  processCommandLine,
  pidAlive,
  STALE_STATUS_SEC,
  STOP_WAIT_MS,
} from "../lib/session.mjs";
import { toolEnv } from "../engine/env.mjs";

const WATCH = fileURLToPath(new URL("../tools/watch.mjs", import.meta.url));
const STOP = fileURLToPath(new URL("../tools/stop.mjs", import.meta.url));

async function withHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-clean-"));
  const old = process.env.BOQO_HOME;
  process.env.BOQO_HOME = home;
  try {
    await fn(home);
  } finally {
    if (old === undefined) delete process.env.BOQO_HOME;
    else process.env.BOQO_HOME = old;
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** A pid that has just exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(r.stdout);
}

/** A process whose command line names watch.mjs, as a real watcher's does. `ignoreTerm`: it shrugs off SIGTERM. */
async function fakeWatcher(dir, { ignoreTerm = false } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "watch.mjs");
  await fs.writeFile(file, `${ignoreTerm ? 'process.on("SIGTERM", () => {});\n' : ""}setInterval(() => {}, 1e6);\n`);
  const child = spawn(process.execPath, [file], { stdio: "ignore" });
  await new Promise((r) => child.once("spawn", r));
  return child;
}

/** Some other program that happens to hold a pid a watcher once had. */
async function otherProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" });
  await new Promise((r) => child.once("spawn", r));
  return child;
}

/** A session as a hard-killed watcher leaves it. */
async function leftover(root, name, { pid, moments = [], state = "live", updatedAt = new Date().toISOString() }) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, "buf"), { recursive: true });
  await fs.writeFile(path.join(dir, "buf", "seg_20200101000000.ts"), "x");
  await fs.writeFile(path.join(dir, "buf", "seg_20200101000010.ts"), "x");
  await fs.writeFile(path.join(dir, "stop"), "1");
  await fs.writeFile(path.join(dir, "watch.pid"), String(pid));
  await fs.writeFile(
    path.join(dir, "status.json"),
    JSON.stringify({ state, channel: "c", since: "x", segments: 2, moments: moments.length, chatPerSec: 0, updatedAt }),
  );
  for (const m of moments) {
    await fs.mkdir(path.join(dir, "moments", m), { recursive: true });
    await fs.writeFile(path.join(dir, "moments", m, "video.mp4"), "x");
  }
  return dir;
}

const exists = (p) => fs.access(p).then(() => true, () => false);

test("cleanupSession empties the buffer, drops stop and pid, and marks a live status stopped", async () => {
  await withHome(async (home) => {
    const dir = await leftover(path.join(home, "s"), "20200101-000000", { pid: deadPid() });
    await cleanupSession(dir);
    assert.deepEqual(await fs.readdir(path.join(dir, "buf")), []);
    assert.equal(await exists(path.join(dir, "stop")), false);
    assert.equal(await exists(path.join(dir, "watch.pid")), false);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "status.json"), "utf8")).state, "stopped");
  });
});

test("watcherPid: a dead pid and a final status are not a watcher; a live pid with a live status is", async () => {
  await withHome(async (home) => {
    const root = path.join(home, "s");
    const dead = await leftover(root, "20200101-000000", { pid: deadPid() });
    assert.equal(await watcherPid(dead), null);
    const child = await fakeWatcher(path.join(home, "bin"));
    try {
      const alive = await leftover(root, "20200102-000000", { pid: child.pid });
      assert.equal(await watcherPid(alive), child.pid);
      const done = await leftover(root, "20200103-000000", { pid: child.pid, state: "stopped" });
      assert.equal(await watcherPid(done), null);
    } finally {
      child.kill();
    }
  });
});

test("sweepChannel: dead sessions are cleaned, old moments and empty sessions go, a live one is left alone", async () => {
  await withHome(async (home) => {
    const root = path.join(home, "boqo-sniper", "watch", "sweepy");
    const recent = stamp(new Date(Date.now() - 3600 * 1000));
    const child = await fakeWatcher(path.join(home, "bin"));
    try {
      const live = await leftover(root, "20200101-000000", { pid: child.pid });
      const onlyOld = await leftover(root, "20200102-000000", { pid: deadPid(), moments: ["20200102-000500", "20200102-000700-2"] });
      const mixed = await leftover(root, "20200103-000000", { pid: deadPid(), moments: ["20200103-000500", recent] });
      const removed = await sweepChannel("sweepy", null);
      assert.deepEqual(removed, [onlyOld]);
      assert.equal(await exists(onlyOld), false, "a session whose moments were all old is gone whole");
      assert.deepEqual(await fs.readdir(path.join(mixed, "buf")), []);
      assert.deepEqual(await fs.readdir(path.join(mixed, "moments")), [recent], "the recent moment stays, the old one goes");
      assert.equal(JSON.parse(await fs.readFile(path.join(mixed, "status.json"), "utf8")).state, "stopped");
      assert.equal((await fs.readdir(path.join(live, "buf"))).length, 2, "a session with a live watcher is not touched");
      assert.equal(await exists(path.join(live, "stop")), true);
    } finally {
      child.kill();
    }
  });
});

test("a new watcher sweeps what a hard-killed one left, and stop.mjs does the same for a dead pid", { timeout: 60000 }, async () => {
  await withHome(async (home) => {
    const root = path.join(home, "boqo-sniper", "watch", "sweepy");
    const old = await leftover(root, "20200101-000000", { pid: deadPid(), moments: ["20200101-000500"] });
    const otherChannel = await leftover(path.join(home, "boqo-sniper", "watch", "elsewhere"), "20200101-000000", {
      pid: deadPid(),
      moments: [stamp(new Date())],
    });
    const env = { ...process.env, BOQO_HOME: home };
    const seg = path.join(home, "seg.ts");
    const gen = spawnSync(
      "ffmpeg",
      ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=10", "-c:a", "aac", "-f", "mpegts", seg],
      { encoding: "utf8", env: toolEnv() },
    );
    assert.equal(gen.status, 0, gen.stderr);
    await fs.mkdir(path.join(home, "replay"));
    await fs.copyFile(seg, path.join(home, "replay", "000.ts"));
    const r = spawnSync(process.execPath, [WATCH, "sweepy", "--replay", path.join(home, "replay")], {
      env: { ...env, BOQO_SNIPER_POLL_MS: "100" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(await exists(old), false, "the old session, with only an old moment, was swept away");
    assert.deepEqual(await fs.readdir(path.join(otherChannel, "buf")), [], "another channel's dead session is swept too");
    assert.equal(JSON.parse(await fs.readFile(path.join(otherChannel, "status.json"), "utf8")).state, "stopped");

    // stop.mjs on a session whose watcher is gone
    const dead = await leftover(root, "29990101-000000", { pid: deadPid() });
    const s = spawnSync(process.execPath, [STOP, "sweepy"], { env, encoding: "utf8" });
    assert.deepEqual(JSON.parse(s.stdout), { stopped: false, reason: "not-running" });
    assert.deepEqual(await fs.readdir(path.join(dead, "buf")), []);
    assert.equal(JSON.parse(await fs.readFile(path.join(dead, "status.json"), "utf8")).state, "stopped");
  });
});

test("a status older than 4 minutes is a dead watcher's", async () => {
  assert.equal(STALE_STATUS_SEC, 240);
  await withHome(async (home) => {
    const root = path.join(home, "s");
    const child = await fakeWatcher(path.join(home, "bin"));
    try {
      const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString();
      const fresh = await leftover(root, "20200101-000000", { pid: child.pid, updatedAt: ago(180) });
      assert.equal(await watcherPid(fresh), child.pid, "3 minutes old: still running");
      const stale = await leftover(root, "20200102-000000", { pid: child.pid, updatedAt: ago(300) });
      assert.equal(await watcherPid(stale), null, "5 minutes old: dead");
    } finally {
      child.kill();
    }
  });
});

test("watcherPid: a live pid is ours only when its command line names watch.mjs", async () => {
  await withHome(async (home) => {
    const child = await otherProcess();
    try {
      const dir = await leftover(path.join(home, "s"), "20200101-000000", { pid: child.pid });
      const seen = [];
      const lookup = (cmd) => async (pid) => (seen.push(pid), cmd);
      assert.equal(await watcherPid(dir, { lookup: lookup("node /home/a b/.boqo-sniper/tools/watch.mjs chan") }), child.pid);
      assert.equal(await watcherPid(dir, { lookup: lookup("/usr/bin/bash") }), null, "a reused pid");
      assert.equal(await watcherPid(dir, { lookup: lookup("") }), null, "a pid the lookup cannot find");
      assert.equal(await watcherPid(dir, { lookup: lookup(null) }), child.pid, "no way to look: the status decides");
      assert.ok(seen.every((p) => p === child.pid));
    } finally {
      child.kill();
    }
  });
});

test("processCommandLine reads a real process's command line, on every OS", { timeout: 60000 }, async () => {
  await withHome(async (home) => {
    const w = await fakeWatcher(path.join(home, "bin dir"));
    const o = await otherProcess();
    try {
      assert.match(await processCommandLine(w.pid), /watch\.mjs/);
      const other = await processCommandLine(o.pid);
      assert.equal(typeof other, "string");
      assert.doesNotMatch(other, /watch\.mjs/);
      assert.equal(await processCommandLine(deadPid()), "", "a pid that is gone has no command line");
      // the real lookup, end to end: another program on the pid is not a watcher
      const dir = await leftover(path.join(home, "s"), "20200101-000000", { pid: o.pid });
      assert.equal(await watcherPid(dir), null);
      const mine = await leftover(path.join(home, "s"), "20200102-000000", { pid: w.pid });
      assert.equal(await watcherPid(mine), w.pid);
    } finally {
      w.kill();
      o.kill();
    }
  });
});

test("stop.mjs never signals a pid that is not a watcher; it cleans up as for a dead one", { timeout: 60000 }, async () => {
  await withHome(async (home) => {
    const o = await otherProcess();
    try {
      const dir = await leftover(path.join(home, "boqo-sniper", "watch", "reused"), "20200101-000000", { pid: o.pid });
      const s = spawnSync(process.execPath, [STOP, "reused"], { env: { ...process.env, BOQO_HOME: home }, encoding: "utf8" });
      assert.deepEqual(JSON.parse(s.stdout), { stopped: false, reason: "not-running" });
      assert.ok(pidAlive(o.pid), "the other program still runs");
      assert.deepEqual(await fs.readdir(path.join(dir, "buf")), []);
      assert.equal(JSON.parse(await fs.readFile(path.join(dir, "status.json"), "utf8")).state, "stopped");
    } finally {
      o.kill();
    }
  });
});

test("stop.mjs waits long enough for a watcher in a 45 s live check, then kills hard and cleans up", { timeout: 60000 }, async () => {
  assert.ok(STOP_WAIT_MS >= 50000, `stop waits ${STOP_WAIT_MS} ms; the watcher's live check alone can take 45 s`);
  await withHome(async (home) => {
    const w = await fakeWatcher(path.join(home, "bin"), { ignoreTerm: true });
    const exited = new Promise((r) => w.once("exit", r));
    try {
      const dir = await leftover(path.join(home, "boqo-sniper", "watch", "stubborn"), "20200101-000000", { pid: w.pid });
      const s = spawnSync(process.execPath, [STOP, "stubborn"], {
        env: { ...process.env, BOQO_HOME: home, BOQO_SNIPER_STOP_WAIT_MS: "1000" },
        encoding: "utf8",
      });
      assert.deepEqual(JSON.parse(s.stdout), { stopped: true, channel: "stubborn", pid: w.pid });
      await exited;
      assert.deepEqual(await fs.readdir(path.join(dir, "buf")), [], "the hard kill skipped the watcher's own cleanup, so stop did it");
      assert.equal(JSON.parse(await fs.readFile(path.join(dir, "status.json"), "utf8")).state, "stopped");
    } finally {
      w.kill("SIGKILL");
    }
  });
});

test("sweepAll sweeps every channel's dead sessions and leaves a live watcher's alone", async () => {
  await withHome(async (home) => {
    const watch = path.join(home, "boqo-sniper", "watch");
    const recent = stamp(new Date(Date.now() - 3600 * 1000));
    const child = await fakeWatcher(path.join(home, "bin"));
    try {
      const a = await leftover(path.join(watch, "alpha"), "20200101-000000", { pid: deadPid(), moments: [recent] });
      const b = await leftover(path.join(watch, "beta"), "20200101-000000", { pid: deadPid() });
      const live = await leftover(path.join(watch, "gamma"), "20200101-000000", { pid: child.pid });
      await fs.writeFile(path.join(watch, "gamma.log"), "a log beside the channel folders");
      await fs.mkdir(path.join(watch, "not a channel"));
      const removed = await sweepAll();
      assert.deepEqual(removed, [b], "beta's session had no moments left and went whole");
      assert.deepEqual(await fs.readdir(path.join(a, "buf")), []);
      assert.deepEqual(await fs.readdir(path.join(a, "moments")), [recent]);
      assert.equal((await fs.readdir(path.join(live, "buf"))).length, 2, "a live watcher's session is not touched");
      assert.equal(await exists(path.join(watch, "gamma.log")), true);
      assert.deepEqual(await sweepAll(), [], "nothing left to sweep");
    } finally {
      child.kill();
    }
  });
  await withHome(async () => assert.deepEqual(await sweepAll(), [], "no watch folder yet"));
});
