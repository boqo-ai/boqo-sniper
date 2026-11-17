#!/usr/bin/env node
// A moment through the Clips path (lib/moment-run.mjs). Not part of the vendored engine.
//
//   moment.mjs start "<moment>" [--brand "<name>"]
//     whisper on the window, its segments, and the selection request (the watch's prompt as the creator's request,
//     the window's minutes as the target). Makes the moment's clips folder, <home>/boqo-sniper/clips/<channel
//     folder>/<moment name>/. Prints {"run", "write": "selection", "request", "answer", "target", "segments"}, or
//     the moment's end ({"done": true, "clips": [], "reason": "no speech", ...}) when whisper heard nothing.
//   moment.mjs step "<clips>"
//     the next step; print and do what it says, then step again:
//       {"write": "selection", "request", "answer", "errors"?}   write the selection (select.md), fix what errors say
//       {"read": "probe"|"panels"|"stranger", "n"?, "turn", "answer", "doc", "errors"?}   look, write the answer
//       {"next": true, "rendered"|"failed": n, "of": k}           a clip rendered (or failed): step again
//       {"done": true, "clips": [{n, title, seconds, file, noRead?}], "summary", "noRead", "failed", "runsLine"}
//     "budgetSpent": true on a step means the hour's image budget refused a read: say so once.
//   moment.mjs posted "<clips>" --n <n> (--project <projectId> | --none)
//     appends this clip's post to <home>/boqo-sniper/posts.md; prints {"line"}.
//
// One JSON line on stdout (exit 0), or {"error": "..."} (exit 1). It ends by itself, never by process.exit: the render
// loads onnxruntime-node, and process.exit() after that aborts the process on macOS (tools/render.mjs says how).

import { postedLine, startMoment, stepMoment } from "../lib/moment-run.mjs";

const USAGE =
  'usage: moment.mjs start "<moment>" [--brand "<name>"] | step "<clips>" | posted "<clips>" --n <n> (--project <id> | --none)';

function parse(argv, valueFlags, boolFlags = []) {
  const opt = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (boolFlags.includes(a)) opt[a.slice(2)] = true;
    else if (valueFlags.includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opt[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  return { opt, target: positional[0] };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "start") {
    const { opt, target } = parse(rest, ["--brand"]);
    return startMoment({ moment: target, brand: opt.brand ?? null });
  }
  if (cmd === "step") {
    const { target } = parse(rest, []);
    return stepMoment({ run: target });
  }
  if (cmd === "posted") {
    const { opt, target } = parse(rest, ["--n", "--project"], ["--none"]);
    if ((opt.project === undefined) === (opt.none === undefined)) throw new Error("give one of --project <projectId> and --none");
    const n = /^[1-9][0-9]*$/.test(String(opt.n ?? "")) ? Number(opt.n) : NaN;
    return { line: postedLine({ run: target, n, projectId: opt.project ?? null }) };
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).then(
  (out) => process.stdout.write(`${JSON.stringify(out)}\n`),
  (err) => {
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exitCode = 1;
  },
);
