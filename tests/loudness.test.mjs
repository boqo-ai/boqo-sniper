import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEbur128, measureLoudness, parseLoudnessLine, createSecondMax, lineReader, LOUDNESS_FLOOR } from "../lib/loudness.mjs";
import { toolEnv } from "../engine/env.mjs";

test("parseEbur128 reads the summary I: LUFS, not a progress line", () => {
  const stderr = [
    "[Parsed_ebur128_0 @ 0x1] t: 0.5  TARGET:-23 LUFS  M: -20.1 S: -23.0  I: -22.0 LUFS  LRA: 0.0 LU",
    "[Parsed_ebur128_0 @ 0x1] Summary:",
    "",
    "  Integrated loudness:",
    "    I:         -18.4 LUFS",
    "    Threshold: -28.4 LUFS",
    "",
    "  Loudness range:",
    "    LRA:         0.0 LU",
  ].join("\n");
  assert.equal(parseEbur128(stderr), -18.4);
});

test("parseEbur128 is null with no summary, and the floor for digital silence", () => {
  assert.equal(parseEbur128(""), null);
  assert.equal(parseEbur128("nothing here"), null);
  assert.equal(parseEbur128("  Integrated loudness:\n    I:         -inf LUFS\n"), LOUDNESS_FLOOR);
});

test("parseEbur128 on a real ebur128 summary from ffmpeg", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-loud-"));
  try {
    const wav = path.join(dir, "tone.wav");
    const gen = spawnSync(
      "ffmpeg",
      ["-nostdin", "-y", "-hide_banner", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", wav],
      { encoding: "utf8", env: toolEnv() },
    );
    assert.equal(gen.status, 0, gen.stderr);
    const r = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-i", wav, "-af", "ebur128", "-f", "null", "-"], {
      encoding: "utf8",
      env: toolEnv(),
    });
    const lufs = parseEbur128(r.stderr);
    assert.equal(typeof lufs, "number");
    assert.ok(lufs < -10 && lufs > -40, `a 440 Hz sine measured ${lufs}`);
    // measureLoudness is the same measurement through the module
    assert.equal(await measureLoudness(wav), lufs);
    assert.equal(await measureLoudness(path.join(dir, "missing.wav")), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A recording of ffmpeg's own stderr for a synthetic 12 s tone that steps between four levels
// (tests/fixtures/ebur128-synthetic.txt: `-af volume=…,ebur128=peak=none -f null -`, -loglevel info): 120
// momentary lines, ten to a wall-clock second, among the banner and the summary.
const FIXTURE = fs.readFile(new URL("./fixtures/ebur128-synthetic.txt", import.meta.url), "utf8");

test("replay: a recorded ebur128 stderr gives the loudest reading of each second", async () => {
  const lines = (await FIXTURE).split("\n");
  const readings = [];
  const feed = lineReader((line) => {
    const parsed = parseLoudnessLine(line);
    if (parsed) readings.push(parsed);
  });
  // ffmpeg's pipe delivers chunks that cut lines anywhere
  const text = lines.join("\n");
  for (let i = 0; i < text.length; i += 37) feed(text.slice(i, i + 37));
  feed("\n");
  assert.equal(readings.length, 120);

  // the oracle reads M straight off the raw lines, a different way than the parser does
  const raw = lines
    .filter((l) => l.includes("Parsed_ebur128") && l.includes("TARGET"))
    .map((l) => Math.max(LOUDNESS_FLOOR, Number(/ M:\s*(-?[\d.]+)/.exec(l)[1])));
  assert.equal(raw.length, 120);

  // the watcher's clock stands at stream second 1000 + t when the line arrives
  const series = createSecondMax();
  for (const r of readings) series.add(1000 + r.t, r.momentary);
  assert.equal(series.size, 12);
  for (let sec = 0; sec < 12; sec++) {
    const want = Math.max(...raw.slice(sec * 10, sec * 10 + 10));
    assert.equal(series.take(1000 + sec), want, `second ${sec}`);
  }
  assert.equal(series.size, 0, "take hands a second out once");
  assert.equal(series.take(1000), null, "a second with no reading is null, not a quiet one");
  // the tone really does step: the series is not constant
  assert.ok(new Set(raw).size > 5);
});

test("createSecondMax: keeps the max, takes once, drops the old", () => {
  const s = createSecondMax();
  s.add(10.1, -30);
  s.add(10.9, -20);
  s.add(10.5, -25);
  s.add(11.0, -50);
  s.add(5.5, -40);
  assert.equal(s.take(10), -20);
  assert.equal(s.take(10), null);
  s.dropBefore(11);
  assert.equal(s.take(5), null);
  assert.equal(s.take(11), -50);
});

test("lineReader: whole lines only, a partial one waits for its end, CRLF is one break", () => {
  const got = [];
  const feed = lineReader((l) => got.push(l));
  feed("a\nb");
  feed("c\r\nd");
  assert.deepEqual(got, ["a", "bc"]);
  feed("\n");
  assert.deepEqual(got, ["a", "bc", "d"]);
});
