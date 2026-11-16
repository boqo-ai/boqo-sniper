import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CAPTURE_THREADS,
  STALL_SEC,
  STREAMLINK_STALL_SEC,
  captureCommand,
  captureFfmpegArgs,
  chooseCapture,
  isSegmentOpening,
  readConfig,
  stallSecFor,
} from "../lib/capture.mjs";
import { spawn } from "node:child_process";
import { toolEnv } from "../engine/env.mjs";
import { lineReader, parseLoudnessLine } from "../lib/loudness.mjs";
import { durationOf } from "../lib/moment.mjs";
import { SecondBuckets } from "../lib/boqo/buckets.mjs";
import { CAPTURE_STALL_SEC } from "../lib/boqo/watch-constants.mjs";

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
  assert.deepEqual(s.args.slice(-2), ["https://www.twitch.tv/chan", "best"]);
});

test("a Kick channel is captured from its channel URL; Twitch's ad skipping is left off for it", () => {
  const k = { platform: "kick", channel: "x-q_c" };
  const y = captureCommand("yt-dlp", k);
  assert.equal(y.args.at(-1), "https://kick.com/x-q_c");
  assert.equal(captureCommand("yt-dlp", "kick:x-q_c").args.at(-1), "https://kick.com/x-q_c", "the person's own input too");
  const s = captureCommand("streamlink", k);
  assert.ok(!s.args.includes("--twitch-disable-ads"));
  assert.deepEqual(s.args.slice(-2), ["https://kick.com/x-q_c", "best"]);
  assert.equal(s.args[s.args.indexOf("--stream-sorting-excludes") + 1], ">1080p60");
  assert.throws(() => captureCommand("yt-dlp", "kick.com/xqc/videos"), /bad channel/);
});

test("a stall is boqo's 45 s for yt-dlp and 180 s for streamlink, which goes quiet through an ad break", () => {
  assert.equal(CAPTURE_STALL_SEC, 45);
  assert.equal(STALL_SEC, 45);
  assert.equal(STREAMLINK_STALL_SEC, 180);
  assert.equal(stallSecFor("yt-dlp"), 45);
  assert.equal(stallSecFor("streamlink"), 180);
  assert.equal(stallSecFor("test-source"), 45);
});

test("captureFfmpegArgs: stdin in, 6 s segments out, and a null output with ebur128 beside it", () => {
  const a = captureFfmpegArgs();
  const at = (flag, from = 0) => a.indexOf(flag, from);
  assert.equal(a[at("-i") + 1], "pipe:0");
  assert.equal(a[at("-loglevel") + 1], "info", "the ebur128 lines come out at info");
  assert.ok(a.includes("-nostats"));
  // the buffer: a stream copy, segmented
  assert.deepEqual(a.slice(at("-map"), at("-map") + 6), ["-map", "0:v:0", "-map", "0:a:0", "-c", "copy"]);
  assert.equal(a[at("-segment_time") + 1], "6");
  assert.equal(a[at("-f") + 1], "segment");
  assert.equal(a[at("-segment_format") + 1], "mpegts");
  assert.equal(a[at("-strftime") + 1], "1");
  assert.equal(a[at("-strftime") + 2], "seg_%Y%m%d%H%M%S.ts");
  // the loudness output: the audio again, ebur128 with no peak measurement, nothing written
  assert.deepEqual(a.slice(-7), ["-map", "0:a:0", "-af", "ebur128=peak=none", "-f", "null", "-"]);
  // the thread caps are global options, so before -i
  for (const flag of ["-threads", "-filter_threads", "-filter_complex_threads"]) {
    assert.ok(at(flag) !== -1 && at(flag) < at("-i"), flag);
    assert.equal(a[at(flag) + 1], String(CAPTURE_THREADS));
  }
  assert.equal(captureFfmpegArgs({ segmentSec: 10 })[captureFfmpegArgs({ segmentSec: 10 }).indexOf("-segment_time") + 1], "10");
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

async function captureOnce() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-capture-"));
  try {
    // a synthetic 15 s test pattern and tone, as the source command would write it to stdout, at the speed a live
    // stream arrives (-re): segment names are the wall-clock second they open, so a faster feed would reuse a name
    const source = spawn(
      "ffmpeg",
      [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-re",
        "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=15",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=15",
        "-c:v", "libx264", "-preset", "ultrafast", "-g", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mpegts", "pipe:1",
      ],
      { env: toolEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const ff = spawn("ffmpeg", captureFfmpegArgs(), { cwd: dir, env: { ...toolEnv(), TZ: "UTC0" }, stdio: ["pipe", "ignore", "pipe"] });
    source.stdout.pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    const readings = [];
    let other = "";
    ff.stderr.on(
      "data",
      lineReader((line) => {
        const parsed = parseLoudnessLine(line);
        if (parsed) readings.push(parsed);
        else other += line + "\n";
      }),
    );
    const code = await new Promise((resolve) => ff.on("close", resolve));
    assert.equal(code, 0, other.slice(-500));
    const segments = (await fs.readdir(dir)).filter((f) => /^seg_\d{14}\.ts$/.test(f)).sort();
    // Cuts fall at stream 6 s and 12 s and the feed ends at 15 s with a keyframe every second, so no cut can land at
    // 18 s: exactly three segments, and the first one is the segment length itself (a `segment_time` of 3 or 7 fails here).
    assert.equal(segments.length, 3, `15 s in 6 s segments: ${segments}`);
    const first = durationOf(path.join(dir, segments[0]));
    assert.ok(Math.abs(first - 6) <= 0.5, `the first segment is ${first} s, not 6`);
    assert.ok(readings.length >= 140 && readings.length <= 155, `${readings.length} loudness lines for 15 s`);
    // keyed by second as the tick feed keys them (stream time here, the clock live)
    const series = new SecondBuckets();
    for (const r of readings) series.add(r.t * 1000, r.momentary);
    const seconds = new Set(readings.map((r) => Math.floor(r.t)));
    assert.ok(seconds.size >= 14 && seconds.size <= 16);
    const steady = Math.max(...series.take(8)); // past the 400 ms warm-up, in the middle of a steady tone
    assert.ok(steady > -40 && steady < 0, `momentary loudness ${steady}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// One run is a real-time (-re) feed whose segments are named by the wall-clock second they open, so a runner that
// stalls for seconds can open two within one second and overwrite a name. A real regression (the segment length, the
// stream copy, the loudness line) fails the same way twice; a stall passes the second time. Both failures are shown.
test("the capture's ffmpeg, fed a 15 s stream on stdin, writes 6 s segments and prints a momentary loudness every 100 ms", { timeout: 120000 }, async (t) => {
  try {
    await captureOnce();
  } catch (first) {
    t.diagnostic(`first run failed, trying once more: ${first.message}`);
    await captureOnce();
  }
});

test("isSegmentOpening: only the routine segment lines, so a dying capture's real error stays in the failure tail", () => {
  assert.equal(isSegmentOpening("[segment @ 0x5e8ae1db7180] Opening 'seg_20261116054528.ts' for writing"), true);
  assert.equal(isSegmentOpening("[segment @ 0x1] Opening 'seg_20261116054534.ts' for writing\r"), true);
  assert.equal(isSegmentOpening("[segment @ 0x1] Failed to open segment 'seg_20261116054540.ts'"), false);
  assert.equal(isSegmentOpening("[out#0/segment @ 0x1] Error opening output seg_x.ts: Permission denied"), false);
  assert.equal(isSegmentOpening("[vist#0:0/h264 @ 0x1] Error submitting packet to decoder"), false);
  assert.equal(isSegmentOpening("pipe:0: Invalid data found when processing input"), false);
});
