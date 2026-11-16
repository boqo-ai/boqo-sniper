import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEbur128, measureLoudness, LOUDNESS_FLOOR } from "../lib/loudness.mjs";
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
