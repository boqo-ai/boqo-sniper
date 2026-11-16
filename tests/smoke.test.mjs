import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { toolEnv } from "../engine/env.mjs";

// On macOS CI ffmpeg-full is installed but kept off PATH: toolEnv() must find it.

test("ffmpeg has the ass, subtitles and ebur128 filters", () => {
  const out = execFileSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8", env: toolEnv() });
  for (const name of ["ass", "subtitles", "ebur128"]) {
    assert.match(out, new RegExp(`\\s${name}\\s`), `ffmpeg is missing the ${name} filter`);
  }
});

test("Node has a global WebSocket (the chat client needs it)", () => {
  assert.equal(typeof globalThis.WebSocket, "function");
});
