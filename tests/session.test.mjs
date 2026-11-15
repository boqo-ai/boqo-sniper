import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sniperHome, sessionsDir, newSession, currentSession, readStatus } from "../lib/session.mjs";

async function withHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-session-"));
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

test("sniperHome follows BOQO_HOME and falls back to ~/.boqo", async () => {
  await withHome((home) => {
    assert.equal(sniperHome(), path.join(home, "boqo-sniper"));
    delete process.env.BOQO_HOME;
    assert.equal(sniperHome(), path.join(os.homedir(), ".boqo", "boqo-sniper"));
  });
});

test("sessionsDir lowercases the channel and refuses path tricks", async () => {
  await withHome((home) => {
    assert.equal(sessionsDir("ShroudTV"), path.join(home, "boqo-sniper", "shroudtv"));
    for (const bad of ["", "../x", "a/b", "a\\b", "a b"]) {
      assert.throws(() => sessionsDir(bad), /channel/i, bad);
    }
  });
});

test("newSession makes a UTC-stamped folder with buf and moments", async () => {
  await withHome(async () => {
    const dir = await newSession("Chan", new Date("2026-11-15T09:08:07.999Z"));
    assert.equal(path.basename(dir), "20261115-090807");
    assert.equal(path.dirname(dir), sessionsDir("chan"));
    for (const sub of ["buf", "moments"]) {
      assert.ok((await fs.stat(path.join(dir, sub))).isDirectory());
    }
  });
});

test("currentSession is the newest folder by name, or null", async () => {
  await withHome(async () => {
    assert.equal(await currentSession("chan"), null);
    await newSession("chan", new Date("2026-11-15T09:00:00Z"));
    const newest = await newSession("chan", new Date("2026-11-15T10:00:00Z"));
    await newSession("chan", new Date("2026-11-14T23:00:00Z"));
    assert.equal(await currentSession("CHAN"), newest);
  });
});

test("readStatus returns the parsed file, or null when missing or half written", async () => {
  await withHome(async () => {
    const dir = await newSession("chan");
    assert.equal(await readStatus(dir), null);
    await fs.writeFile(path.join(dir, "status.json"), '{"state":"li');
    assert.equal(await readStatus(dir), null);
    await fs.writeFile(path.join(dir, "status.json"), '{"state":"live","segments":3}');
    assert.deepEqual(await readStatus(dir), { state: "live", segments: 3 });
  });
});
