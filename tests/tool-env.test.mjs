// boqo-sniper's own processes (the watcher's capture, segmenter and loudness
// probe, the moment tool's ffprobe and stills) run with the vendored engine's
// toolEnv(): on macOS, Homebrew's ffmpeg-full is keg-only and an agent's shell
// has no export PATH from an earlier command.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { durationOf } from "../lib/moment.mjs";
import { measureLoudness } from "../lib/loudness.mjs";
import { toolEnv } from "../engine/env.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendored = new Set(JSON.parse(readFileSync(path.join(root, "engine", "ENGINE.json"), "utf8")).files);
/** Runs only `ps` and PowerShell, to read a pid's command line: no media tool. */
const EXEMPT = new Set(["lib/session.mjs"]);

/** The text of a call from its opening paren to the matching close, string literals skipped. */
function callText(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced call");
}

test("every sniper file that starts a process runs it with toolEnv", () => {
  const files = ["lib", "tools"].flatMap((d) =>
    readdirSync(path.join(root, d))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => `${d}/${f}`)
      .filter((f) => !vendored.has(f)),
  );
  const spawners = [];
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8");
    if (!/from ["']node:child_process["']/.test(src)) continue;
    spawners.push(f);
    if (EXEMPT.has(f)) continue;
    assert.match(src, /import \{[^}]*\btoolEnv\b[^}]*\} from ["']\.\.\/engine\/env\.mjs["']/, `${f} imports toolEnv`);
    const code = src.replace(/^\s*(?:\/\/|\*).*$/gm, "");
    const sites = [...code.matchAll(/(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync)\s*\(/g)];
    assert.ok(sites.length > 0, `${f} has a call site`);
    for (const m of sites) {
      const call = callText(code, m.index + m[0].length - 1);
      assert.match(call, /\benv\b/, `${f}: ${m[0]}${call.slice(1, 80)}`);
    }
  }
  assert.deepEqual(spawners.sort(), ["lib/loudness.mjs", "lib/moment.mjs", "lib/session.mjs", "tools/moment.mjs", "tools/watch.mjs"]);
});

test("durationOf and measureLoudness run ffprobe and ffmpeg with the env they are given", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-env-"));
  try {
    const wav = path.join(dir, "tone.wav");
    const gen = spawnSync("ffmpeg", ["-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=2", wav], {
      encoding: "utf8",
      env: toolEnv(),
    });
    assert.equal(gen.status, 0, gen.stderr);
    // A PATH with no tools in it: both fail as a missing tool, so they used this env and not the parent's.
    const bare = { PATH: path.join(dir, "no-tools-here") };
    assert.throws(() => durationOf(wav, bare), /ffprobe could not run: ENOENT/);
    assert.equal(await measureLoudness(wav, { env: bare }), null);
    // The default env (toolEnv) finds them.
    assert.ok(Math.abs(durationOf(wav) - 2) < 0.1);
    assert.equal(typeof (await measureLoudness(wav)), "number");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
