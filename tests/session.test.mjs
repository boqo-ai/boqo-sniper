import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sniperHome, sessionsDir, newSession, currentSession, readStatus, resolveChannel } from "../lib/session.mjs";

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

test("sessionsDir is watch/<platform>-<slug>, lowercased, takes every way to name a channel, and refuses path tricks", async () => {
  await withHome((home) => {
    const watch = path.join(home, "boqo-sniper", "watch");
    assert.equal(sessionsDir("ShroudTV"), path.join(watch, "twitch-shroudtv"));
    assert.equal(sessionsDir("twitch.tv/shroudtv"), path.join(watch, "twitch-shroudtv"));
    assert.equal(sessionsDir({ platform: "twitch", channel: "shroudtv" }), path.join(watch, "twitch-shroudtv"));
    assert.equal(sessionsDir("kick:xqc"), path.join(watch, "kick-xqc"));
    assert.equal(sessionsDir("https://kick.com/X-Q_C/"), path.join(watch, "kick-x-q_c"));
    assert.notEqual(sessionsDir("kick:xqc"), sessionsDir("twitch:xqc"), "the same slug on two platforms is two channels");
    // onboarding's samples/ and the clips/ folder sit beside watch/, so no channel name can land on them
    assert.equal(path.dirname(sessionsDir("clips")), watch);
    assert.equal(path.dirname(sessionsDir("samples")), watch);
    assert.equal(path.dirname(sessionsDir("kick:clips")), watch);
    for (const bad of ["", "../x", "a/b", "a\\b", "a b", "kick:../x", "kick:a/b", "kick.com/xqc/videos", "kick.com/xqc?clip=clip_1", "x-y", {}, null, 7]) {
      assert.throws(() => sessionsDir(bad), /channel/i, String(JSON.stringify(bad)));
    }
  });
});

test("resolveChannel: a bare name is a Twitch login; links and kick: say the platform", () => {
  assert.deepEqual(resolveChannel("xqc"), { platform: "twitch", channel: "xqc" });
  assert.deepEqual(resolveChannel("Twitch:XQC"), { platform: "twitch", channel: "xqc" });
  assert.deepEqual(resolveChannel("kick:x-q_c"), { platform: "kick", channel: "x-q_c" });
  assert.deepEqual(resolveChannel({ platform: "Kick", channel: "X-Q_C" }), { platform: "kick", channel: "x-q_c" });
  assert.throws(() => resolveChannel("x-q_c"), /bad channel/, "a hyphen is not a Twitch login, and a bare name is Twitch");
});

test("the session folder for kick:x-q_c is created, as watch/kick-x-q_c/<stamp>/ with buf and moments", async () => {
  await withHome(async (home) => {
    const dir = await newSession("kick:x-q_c", new Date("2026-11-16T09:08:07Z"));
    assert.equal(dir, path.join(home, "boqo-sniper", "watch", "kick-x-q_c", "20261116-090807"));
    for (const sub of ["buf", "moments"]) assert.ok((await fs.stat(path.join(dir, sub))).isDirectory());
    assert.equal(await currentSession("kick:x-q_c"), dir);
    assert.equal(await currentSession("kick.com/x-q_c"), dir, "found again from any spelling of the channel");
    assert.equal(await currentSession("twitch:x_q_c"), null);
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

test("v0.1's watch/<login>/ folder is found for a Twitch login, as a read fallback", async () => {
  await withHome(async (home) => {
    const old = path.join(home, "boqo-sniper", "watch", "somechan", "20261110-120000");
    await fs.mkdir(path.join(old, "moments"), { recursive: true });
    assert.equal(await currentSession("somechan"), old);
    assert.equal(await currentSession("twitch.tv/SomeChan"), old);
    assert.equal(await currentSession("kick:somechan"), null, "Kick has no v0.1 folder");
    // a v0.2 session for the channel wins as soon as there is one
    const fresh = await newSession("somechan", new Date(Date.UTC(2026, 10, 1)));
    assert.equal(await currentSession("somechan"), fresh);
  });
});

test("settings.json is read from a session, and its absence is the defaults", async () => {
  await withHome(async () => {
    const { readSessionSettings, writeSessionSettings } = await import("../lib/session.mjs");
    const dir = await newSession("chan");
    assert.deepEqual(await readSessionSettings(dir), { sensitivity: 70, autoClip: true, autoClipMinScore: 80, windowSec: 300, prompt: null, visionPerHour: 600 });
    await writeSessionSettings(dir, { sensitivity: 90, autoClip: false, autoClipMinScore: 60, windowSec: 200, prompt: "fails", visionPerHour: 100 });
    assert.equal((await readSessionSettings(dir)).autoClipMinScore, 60);
    await fs.writeFile(path.join(dir, "settings.json"), "{half");
    assert.equal((await readSessionSettings(dir)).autoClipMinScore, 80, "a half-written file reads as the defaults");
  });
});

test("countUnclaimed counts only what a predicate on the meta lets through", async () => {
  await withHome(async () => {
    const { countUnclaimed } = await import("../lib/session.mjs");
    const dir = await newSession("chan");
    const mk = async (name, meta, taken = false) => {
      const d = path.join(dir, "moments", name);
      await fs.mkdir(d);
      if (meta) await fs.writeFile(path.join(d, "meta.json"), JSON.stringify(meta));
      if (taken) await fs.writeFile(path.join(d, ".taken"), "");
    };
    await mk("a", { score: 90 });
    await mk("b", { score: 70 });
    await mk("c", { score: 95 }, true);
    await mk("d", null); // being cut: no meta yet
    const m = path.join(dir, "moments");
    assert.equal(await countUnclaimed(m), 3, "no predicate: every unclaimed one");
    assert.equal(await countUnclaimed(m, (meta) => meta.score >= 80), 2, "a, and d which has no meta yet");
  });
});
