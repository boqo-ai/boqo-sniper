import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newSession } from "../lib/session.mjs";

const NEXT = fileURLToPath(new URL("../tools/next.mjs", import.meta.url));

async function withHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-next-"));
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

/** Run next.mjs; resolves {code, stdout, stderr, json, ms}. */
function runNext(args) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NEXT, ...args], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code, stdout, stderr, json, ms: Date.now() - t0 });
    });
  });
}

async function addMoment(session, name, meta = { score: 5 }, { ready = true } = {}) {
  const dir = path.join(session, "moments", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "video.mp4"), "x");
  if (ready) await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  return dir;
}

const setStatus = (session, state) =>
  fs.writeFile(path.join(session, "status.json"), JSON.stringify({ state, channel: "chan" }));

test("no session at all prints stopped:no-session and exits 0", async () => {
  await withHome(async () => {
    const r = await runNext(["chan"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { stopped: "no-session" });
    assert.equal(r.stdout.trim().split("\n").length, 1);
  });
});

test("a missing channel is an error with exit 1", async () => {
  await withHome(async () => {
    const r = await runNext([]);
    assert.equal(r.code, 1);
    assert.ok(r.json.error);
  });
});

test("an existing untaken moment is returned at once and claimed", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    const dir = await addMoment(session, "2026-11-15T10-00-00Z", { score: 9, reason: "chat" });
    const r = await runNext(["chan", "--timeout", "30"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { moment: dir, meta: { score: 9, reason: "chat" } });
    assert.ok(r.ms < 5000, `took ${r.ms} ms`);
    await fs.access(path.join(dir, ".taken"));
  });
});

test("the oldest unclaimed ready moment goes first; claimed and unfinished ones are skipped", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    const claimed = await addMoment(session, "a-claimed");
    await fs.writeFile(path.join(claimed, ".taken"), "");
    await addMoment(session, "b-unfinished", {}, { ready: false });
    await addMoment(session, "d-later");
    const c = await addMoment(session, "c-oldest-ready");
    const r = await runNext(["chan", "--timeout", "30"]);
    assert.equal(r.json.moment, c);
  });
});

test("a moment created after 200 ms is returned", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const pending = runNext(["chan", "--timeout", "30"]);
    await new Promise((r) => setTimeout(r, 200));
    const dir = await addMoment(session, "2026-11-15T10-05-00Z", { score: 4 });
    const r = await pending;
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { moment: dir, meta: { score: 4 } });
  });
});

test("a moment folder is not returned until its meta.json lands", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const dir = await addMoment(session, "m1", {}, { ready: false });
    const pending = runNext(["chan", "--timeout", "30"]);
    await new Promise((r) => setTimeout(r, 400));
    await fs.writeFile(path.join(dir, "meta.json"), '{"score":1}');
    const r = await pending;
    assert.deepEqual(r.json, { moment: dir, meta: { score: 1 } });
  });
});

test("stopped and offline watchers are reported", async () => {
  for (const state of ["stopped", "offline"]) {
    await withHome(async () => {
      const session = await newSession("chan");
      await setStatus(session, state);
      const r = await runNext(["chan", "--timeout", "30"]);
      assert.equal(r.code, 0);
      assert.deepEqual(r.json, { stopped: state });
    });
  }
});

test("a failed watcher is reported with its error", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await fs.writeFile(path.join(session, "status.json"), JSON.stringify({ state: "failed", channel: "chan", error: "ffmpeg exited 1" }));
    const r = await runNext(["chan", "--timeout", "30"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { stopped: "failed", error: "ffmpeg exited 1" });
    assert.ok(r.ms < 5000, `took ${r.ms} ms`);
  });
});

test("a failed status with no error text still says failed", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "failed");
    const r = await runNext(["chan", "--timeout", "30"]);
    assert.deepEqual(r.json, { stopped: "failed", error: "unknown error" });
  });
});

test("a ready moment is still handed out after the watcher failed", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    const dir = await addMoment(session, "20261115-100000", { score: 7 });
    await fs.writeFile(path.join(session, "status.json"), JSON.stringify({ state: "failed", channel: "chan", error: "boom" }));
    const first = await runNext(["chan", "--timeout", "30"]);
    assert.equal(first.json.moment, dir);
    const again = await runNext(["chan", "--timeout", "30"]);
    assert.deepEqual(again.json, { stopped: "failed", error: "boom" });
  });
});

test("a ready moment is still handed out after the watcher stopped", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "stopped");
    const dir = await addMoment(session, "m1");
    const r = await runNext(["chan"]);
    assert.equal(r.json.moment, dir);
    const again = await runNext(["chan"]);
    assert.deepEqual(again.json, { stopped: "stopped" });
  });
});

test("--timeout 1 prints timeout with the current status", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const r = await runNext(["chan", "--timeout", "1"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { timeout: true, status: { state: "live", channel: "chan" } });
    assert.ok(r.ms >= 900 && r.ms < 6000, `took ${r.ms} ms`);
  });
});

test("timeout with no status.json yet gives status null", async () => {
  await withHome(async () => {
    await newSession("chan");
    const r = await runNext(["chan", "--timeout", "1"]);
    assert.deepEqual(r.json, { timeout: true, status: null });
  });
});

test("a bad --timeout is an error", async () => {
  await withHome(async () => {
    await newSession("chan");
    for (const bad of ["abc", "-5", ""]) {
      const r = await runNext(["chan", "--timeout", bad]);
      assert.equal(r.code, 1, bad);
      assert.ok(r.json.error);
    }
  });
});

test("two concurrent calls never return the same moment", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const m1 = await addMoment(session, "m1");
    const m2 = await addMoment(session, "m2");
    const [a, b] = await Promise.all([
      runNext(["chan", "--timeout", "30"]),
      runNext(["chan", "--timeout", "30"]),
    ]);
    assert.deepEqual([a.json.moment, b.json.moment].sort(), [m1, m2]);
  });
});

test("many callers racing for few moments each get a distinct one, the rest time out", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const dirs = [await addMoment(session, "m1"), await addMoment(session, "m2")];
    const results = await Promise.all(
      Array.from({ length: 5 }, () => runNext(["chan", "--timeout", "2"])),
    );
    const got = results.filter((r) => r.json.moment).map((r) => r.json.moment).sort();
    assert.deepEqual(got, dirs);
    assert.equal(results.filter((r) => r.json.timeout).length, 3);
  });
});
