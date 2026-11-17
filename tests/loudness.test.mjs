import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { measureMomentary, parseLoudnessLine, lineReader, LOUDNESS_FLOOR } from "../lib/loudness.mjs";
import { createTickFeed } from "../lib/ticks.mjs";
import { toolEnv } from "../engine/env.mjs";

test("measureMomentary: a file's readings through the capture's own filter, ten a second", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-loud-"));
  try {
    const wav = path.join(dir, "tone.wav");
    const gen = spawnSync(
      "ffmpeg",
      ["-nostdin", "-y", "-hide_banner", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", wav],
      { encoding: "utf8", env: toolEnv() },
    );
    assert.equal(gen.status, 0, gen.stderr);
    const readings = await measureMomentary(wav);
    assert.ok(readings.length >= 29 && readings.length <= 31, `${readings.length} readings for 3 s`);
    for (let i = 1; i < readings.length; i++) assert.ok(readings[i].t > readings[i - 1].t, "in order");
    // past the first 400 ms the momentary window is full: a steady sine reads steady
    const full = readings.filter((r) => r.t > 0.5).map((r) => r.momentary);
    assert.ok(full.every((m) => m < -10 && m > -40), `a 440 Hz sine read ${full}`);
    assert.ok(Math.max(...full) - Math.min(...full) < 0.5);
    assert.deepEqual(await measureMomentary(path.join(dir, "missing.wav")), []);
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

  // the watcher's clock stands at stream second 1000 + t when the line arrives; the
  // tick feed hands the detector each second's loudest reading, and null for a
  // second with none (13, after the tone ends), not a quiet one
  const ticks = [];
  const ticker = createTickFeed({ detector: { tick: (t) => (ticks.push(t), null) }, nowMs: 999_500 });
  for (const r of readings) ticker.loudness((1000 + r.t) * 1000, r.momentary);
  ticker.drain(1_014_200);
  assert.deepEqual(ticks.map((t) => t.at / 1000), Array.from({ length: 14 }, (_, i) => 1000 + i));
  for (let sec = 0; sec < 12; sec++) {
    const want = Math.max(...raw.slice(sec * 10, sec * 10 + 10));
    assert.equal(ticks[sec].loudness, want, `second ${sec}`);
  }
  assert.equal(ticks[13].loudness, null);
  // the tone really does step: the series is not constant
  assert.ok(new Set(raw).size > 5);
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
