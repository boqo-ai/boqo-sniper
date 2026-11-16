import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stamp, sweepChannel, cleanupSession, watcherPid } from "../lib/session.mjs";

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

/** A session as a hard-killed watcher leaves it. */
async function leftover(root, name, { pid, moments = [], state = "live" }) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, "buf"), { recursive: true });
  await fs.writeFile(path.join(dir, "buf", "seg_20200101000000.ts"), "x");
  await fs.writeFile(path.join(dir, "buf", "seg_20200101000010.ts"), "x");
  await fs.writeFile(path.join(dir, "stop"), "1");
  await fs.writeFile(path.join(dir, "watch.pid"), String(pid));
  await fs.writeFile(
    path.join(dir, "status.json"),
    JSON.stringify({ state, channel: "c", since: "x", segments: 2, moments: moments.length, chatPerSec: 0, updatedAt: new Date().toISOString() }),
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
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" });
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
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e6)"], { stdio: "ignore" });
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
    const env = { ...process.env, BOQO_HOME: home };
    const seg = path.join(home, "seg.ts");
    const gen = spawnSync(
      "ffmpeg",
      ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=10", "-c:a", "aac", "-f", "mpegts", seg],
      { encoding: "utf8" },
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

    // stop.mjs on a session whose watcher is gone
    const dead = await leftover(root, "29990101-000000", { pid: deadPid() });
    const s = spawnSync(process.execPath, [STOP, "sweepy"], { env, encoding: "utf8" });
    assert.deepEqual(JSON.parse(s.stdout), { stopped: false, reason: "not-running" });
    assert.deepEqual(await fs.readdir(path.join(dead, "buf")), []);
    assert.equal(JSON.parse(await fs.readFile(path.join(dead, "status.json"), "utf8")).state, "stopped");
  });
});
