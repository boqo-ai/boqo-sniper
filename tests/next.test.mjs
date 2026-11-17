import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

async function addMoment(session, name, meta = { score: 85 }, { ready = true } = {}) {
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
    const dir = await addMoment(session, "2026-11-15T10-00-00Z", { score: 90, signal: "chat" });
    const r = await runNext(["chan", "--timeout", "30"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { moment: dir, meta: { score: 90, signal: "chat" } });
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
    const dir = await addMoment(session, "2026-11-15T10-05-00Z", { score: 84 });
    const r = await pending;
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { moment: dir, meta: { score: 84 } });
  });
});

test("a moment folder is not returned until its meta.json lands", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const dir = await addMoment(session, "m1", {}, { ready: false });
    const pending = runNext(["chan", "--timeout", "30"]);
    await new Promise((r) => setTimeout(r, 400));
    await fs.writeFile(path.join(dir, "meta.json"), '{"score":81}');
    const r = await pending;
    assert.deepEqual(r.json, { moment: dir, meta: { score: 81 } });
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
    const dir = await addMoment(session, "20261115-100000", { score: 87 });
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

// ---- the bar: a moment below autoClipMinScore is listed, not handed out ----

const setSettings = (session, settings) => fs.writeFile(path.join(session, "settings.json"), JSON.stringify(settings));

test("a moment at the bar is handed out; 79 at bar 80 is listed once and not handed out", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    await setSettings(session, { autoClipMinScore: 80 });
    const low = await addMoment(session, "20261116-100000", { score: 79, signal: "chat", title: "chat spike" });
    const r1 = await runNext(["chan", "--timeout", "30"]);
    assert.deepEqual(r1.json, { listed: low, meta: { score: 79, signal: "chat", title: "chat spike" } }, "told once, so the person hears of it");
    await fs.access(path.join(low, ".listed"));
    await assert.rejects(fs.access(path.join(low, ".taken")), "listed is not claimed");
    const r2 = await runNext(["chan", "--timeout", "1"]);
    assert.equal(r2.json.timeout, true, "and never handed out");
    const at = await addMoment(session, "20261116-100500", { score: 80, signal: "chat" });
    const r3 = await runNext(["chan", "--timeout", "30"]);
    assert.equal(r3.json.moment, at);
  });
});

test("autoClip off lists every detected moment; a hand-made one is still handed out", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    await setSettings(session, { autoClip: false });
    const det = await addMoment(session, "20261116-100000", { score: 97, signal: "chat" });
    const hand = await addMoment(session, "20261116-100100", { score: 100, signal: "manual", title: "clipped by hand" });
    const a = await runNext(["chan", "--timeout", "30"]);
    assert.equal(a.json.listed, det);
    const b = await runNext(["chan", "--timeout", "30"]);
    assert.equal(b.json.moment, hand);
  });
});

test("the bar comes from the session's settings.json; a custom bar of 60 hands out a 60", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setSettings(session, { autoClipMinScore: 60 });
    const dir = await addMoment(session, "m1", { score: 60, signal: "audio" });
    assert.equal((await runNext(["chan", "--timeout", "30"])).json.moment, dir);
  });
});

test("--list shows the unclaimed moments below the bar with score, band, signal line and title", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const a = await addMoment(session, "20261116-100000", { score: 79, signal: "chat", title: "chat spike — x", signalLine: "NO WAY ×40 · 9/s", peakIso: "2026-11-16T10:00:00.000Z" });
    const b = await addMoment(session, "20261116-100500", { score: 64, signal: "audio", title: "audio spike", signalLine: "Audio +7 LU" });
    await addMoment(session, "20261116-101000", { score: 90, signal: "chat" }); // at the bar: not listed
    const taken = await addMoment(session, "20261116-101500", { score: 50, signal: "chat" });
    await fs.writeFile(path.join(taken, ".taken"), "");
    const r = await runNext(["chan", "--list"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, {
      moments: [
        { name: "20261116-100000", moment: a, score: 79, band: "strong", signalLine: "NO WAY ×40 · 9/s", title: "chat spike — x", peakIso: "2026-11-16T10:00:00.000Z" },
        { name: "20261116-100500", moment: b, score: 64, band: "decent", signalLine: "Audio +7 LU", title: "audio spike", peakIso: null },
      ],
      dropped: 0,
    });
  });
});

test("--take claims a listed moment by name, or the newest one, and prints it as next does", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const a = await addMoment(session, "20261116-100000", { score: 79 });
    const b = await addMoment(session, "20261116-100500", { score: 64 });
    const r1 = await runNext(["chan", "--take", "20261116-100000"]);
    assert.deepEqual(r1.json, { moment: a, meta: { score: 79 } });
    await fs.access(path.join(a, ".taken"));
    const r2 = await runNext(["chan", "--take"]);
    assert.equal(r2.json.moment, b, "no name: the newest listed one");
    const r3 = await runNext(["chan", "--take"]);
    assert.equal(r3.code, 1);
    assert.match(r3.json.error, /no listed moment/);
    const r4 = await runNext(["chan", "--take", "nope"]);
    assert.equal(r4.code, 1);
    assert.match(r4.json.error, /no moment named nope/);
    const r5 = await runNext(["chan", "--take", "../../x"]);
    assert.equal(r5.code, 1, "a name is a folder name, never a path");
  });
});

test("--take refuses a moment that is not listed: one at the bar waits for next, a claimed one is gone", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await addMoment(session, "m-high", { score: 95 });
    const r = await runNext(["chan", "--take", "m-high"]);
    assert.equal(r.code, 1);
    assert.match(r.json.error, /not listed/);
  });
});

// ---- the timeout ----

test("the timeout: nothing in --timeout 2 comes back as a timeout after about 2 s, not before and not long after", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const r = await runNext(["chan", "--timeout", "2"]);
    assert.equal(r.json.timeout, true);
    assert.ok(r.ms >= 1900 && r.ms < 5000, `took ${r.ms} ms`);
  });
});

test("a moment that lands inside the timeout ends the wait at once", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await setStatus(session, "live");
    const pending = runNext(["chan", "--timeout", "20"]);
    await new Promise((r) => setTimeout(r, 500));
    const dir = await addMoment(session, "m1", { score: 99 });
    const r = await pending;
    assert.equal(r.json.moment, dir);
    assert.ok(r.ms < 6000, `took ${r.ms} ms`);
  });
});

test("--timeout is 170 by default and never more than 540", async () => {
  const { parseArgs, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S } = await import("../tools/next.mjs");
  assert.equal(DEFAULT_TIMEOUT_S, 170);
  assert.equal(MAX_TIMEOUT_S, 540);
  assert.equal(parseArgs(["chan"]).timeout, 170);
  assert.equal(parseArgs(["chan", "--timeout", "170"]).timeout, 170);
  assert.equal(parseArgs(["chan", "--timeout", "9999"]).timeout, 540);
  assert.equal(parseArgs(["chan", "--list"]).mode, "list");
  assert.deepEqual(parseArgs(["chan", "--take", "x"]).take, "x");
  assert.equal(parseArgs(["chan", "--take"]).mode, "take");
  assert.throws(() => parseArgs(["chan", "--list", "--take"]), /one of/);
});

test("a v0.1 session folder (watch/<login>/) is read: its moment is handed out", async () => {
  await withHome(async (home) => {
    const old = path.join(home, "boqo-sniper", "watch", "chan", "20261110-120000");
    await fs.mkdir(path.join(old, "moments", "20261110-120500"), { recursive: true });
    await fs.writeFile(path.join(old, "moments", "20261110-120500", "meta.json"), JSON.stringify({ score: 88, reason: "chat" })); // v0.1 wrote `reason`
    await fs.writeFile(path.join(old, "status.json"), JSON.stringify({ state: "stopped" }));
    const r = await runNext(["chan"]);
    assert.equal(r.json.moment, path.join(old, "moments", "20261110-120500"));
    const s = spawnSync(process.execPath, [fileURLToPath(new URL("../tools/status.mjs", import.meta.url)), "chan"], { env: process.env, encoding: "utf8" });
    assert.equal(JSON.parse(s.stdout).state, "stopped");
  });
});

// ---- dropped listed moments ----

test("--list says how many older listed moments the watcher dropped, from status.json", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await fs.writeFile(path.join(session, "status.json"), JSON.stringify({ state: "live", channel: "chan", dropped: 2 }));
    await addMoment(session, "20261116-100000", { score: 70 });
    const r = await runNext(["chan", "--list"]);
    assert.equal(r.json.dropped, 2);
    assert.equal(r.json.moments.length, 1);
  });
});

test("--take of a name that is gone says it may have been dropped", async () => {
  await withHome(async () => {
    const session = await newSession("chan");
    await addMoment(session, "20261116-100000", { score: 70 });
    const r = await runNext(["chan", "--take", "20261116-090000"]);
    assert.equal(r.code, 1);
    assert.match(r.json.error, /^no moment named 20261116-090000: it may have been dropped: the watcher keeps only the newest 3/);
  });
});

test("claiming a marker in a folder that was deleted meanwhile answers null, not a crash", async () => {
  await withHome(async (home) => {
    const { mark } = await import("../tools/next.mjs");
    const gone = path.join(home, "no-such-moment", ".taken");
    assert.equal(await mark(gone), null, "the folder is gone (ENOENT)");
    await fs.mkdir(path.join(home, "m"));
    assert.equal(await mark(path.join(home, "m", ".taken")), true);
    assert.equal(await mark(path.join(home, "m", ".taken")), false, "already there (EEXIST)");
  });
});
