import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { STALL_SEC, STREAMLINK_STALL_SEC, captureCommand, chooseCapture, readConfig, stallSecFor } from "../lib/capture.mjs";

test("yt-dlp records by default, even with streamlink installed", () => {
  assert.equal(chooseCapture({}, { streamlink: true, ytdlp: true }), "yt-dlp");
  assert.equal(chooseCapture({ capture: "yt-dlp" }, { streamlink: true, ytdlp: true }), "yt-dlp");
  assert.equal(chooseCapture({ posting: "ask" }, { streamlink: true, ytdlp: true }), "yt-dlp");
});

test("streamlink only when config.json opts in, and then it must be there", () => {
  assert.equal(chooseCapture({ capture: "streamlink" }, { streamlink: true, ytdlp: false }), "streamlink");
  assert.throws(() => chooseCapture({ capture: "streamlink" }, { streamlink: false, ytdlp: true }), /streamlink.*not on PATH/);
});

test("no yt-dlp and no opt-in is an error naming yt-dlp", () => {
  assert.throws(() => chooseCapture({}, { streamlink: true, ytdlp: false }), /yt-dlp is not on PATH/);
});

test("both captures stop at 1080p; streamlink keeps 1080p60 and skips ads", () => {
  const y = captureCommand("yt-dlp", "chan");
  assert.equal(y.cmd, "yt-dlp");
  assert.equal(y.args[y.args.indexOf("-f") + 1], "best[height<=1080]/best");
  assert.equal(y.args.at(-1), "https://www.twitch.tv/chan");
  const s = captureCommand("streamlink", "chan");
  assert.equal(s.cmd, "streamlink");
  assert.ok(s.args.includes("--twitch-disable-ads"));
  // streamlink weighs 1080p60 as 1140, so ">1080p" would drop it; ">1080p60" drops only what is above it
  assert.equal(s.args[s.args.indexOf("--stream-sorting-excludes") + 1], ">1080p60");
  assert.deepEqual(s.args.slice(-2), ["twitch.tv/chan", "best"]);
});

test("a stall is 60 s for yt-dlp and 180 s for streamlink, which goes quiet through an ad break", () => {
  assert.equal(STALL_SEC, 60);
  assert.equal(STREAMLINK_STALL_SEC, 180);
  assert.equal(stallSecFor("yt-dlp"), 60);
  assert.equal(stallSecFor("streamlink"), 180);
  assert.equal(stallSecFor("test-source"), 60);
});

test("readConfig: the skill's config.json, {} when it is missing or broken", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-config-"));
  const old = process.env.BOQO_HOME;
  process.env.BOQO_HOME = home;
  try {
    assert.deepEqual(await readConfig(), { config: {}, warning: null });
    await fs.mkdir(path.join(home, "boqo-sniper"));
    const file = path.join(home, "boqo-sniper", "config.json");
    await fs.writeFile(file, JSON.stringify({ posting: "ask", capture: "streamlink" }));
    assert.deepEqual(await readConfig(), { config: { posting: "ask", capture: "streamlink" }, warning: null });
    await fs.writeFile(file, "{not json");
    const broken = await readConfig();
    assert.deepEqual(broken.config, {});
    assert.match(broken.warning, /config\.json/);
    await fs.writeFile(file, "[1]");
    assert.deepEqual((await readConfig()).config, {});
  } finally {
    if (old === undefined) delete process.env.BOQO_HOME;
    else process.env.BOQO_HOME = old;
    await fs.rm(home, { recursive: true, force: true });
  }
});
