#!/usr/bin/env node
// node tools/panels.mjs probe-frames  --run <run dir> [--src <file>]
// node tools/panels.mjs probe-record  --run <run dir> --file <probe.json>
// node tools/panels.mjs read-frames   --run <run dir> --n <clip> [--src <file>] [--words <words.json>]
// node tools/panels.mjs read-record   --run <run dir> --n <clip> --file <read.json>
//   The stream panels read (skills/boqo-clips/panels.md). Frames and answers only: the agent does the reading.
//   probe-frames   writes 6 frames at 640 px from the render set's midpoints into <run>/panels/probe/ and prints
//                  {"eligible":true,"frames":6,"width":640,"dir":…,"turn":…}; or {"eligible":false} when the source is
//                  portrait or under 480 lines (the reason goes to stderr); or {"eligible":true,"recorded":true,…} when a
//                  probe is already recorded (once a run).
//   probe-record   validates {"isStream":bool,"gameTitle":string|null} and stores it in clips.json.
//   read-frames    writes 1 frame every 3 s, at most 12, 640 px wide, into <run>/panels/clip-NN/, with turn.txt (the user
//                  turn, frames labelled "Frame at <t> s:") and frames.json; prints {"asked":true,…}, or {"asked":false,
//                  "reason":…} when the probe is missing or says no, or the source is not eligible.
//   read-record    validates the answer {"content","gameTitle","samples"} the way boqo does and stores it as the clip's
//                  `panels` in clips.json; prints {"ok":true,…}.
//   --src          the whole video, for a run with no sections.json (a local file); words default to <run>/words.json.
//   Errors: {"ok":false,"errors":[…]} and exit 1.
import { resolve } from 'node:path';
import { needPackages } from '../engine/packages.mjs';

const { PanelsError, probeFrames, readFrames, recordProbe, recordRead } = await needPackages(() => import('../engine/panels-read.mjs'));

const say = (obj, code = 0) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(code);
};
const stop = (errors) => say({ ok: false, errors }, 1);

const FLAGS = { '--run': 'run', '--n': 'n', '--file': 'file', '--src': 'src', '--words': 'words' };
const COMMANDS = { 'probe-frames': ['run'], 'probe-record': ['run', 'file'], 'read-frames': ['run', 'n'], 'read-record': ['run', 'n', 'file'] };

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!(cmd in COMMANDS)) stop(['usage: panels.mjs probe-frames|probe-record|read-frames|read-record --run <run dir> …']);
  const opt = {};
  for (let i = 0; i < rest.length; i++) {
    const key = FLAGS[rest[i]];
    if (!key) stop([`unknown argument ${rest[i]}`]);
    if (i + 1 >= rest.length) stop([`${rest[i]} needs a value`]);
    opt[key] = rest[++i];
  }
  for (const k of COMMANDS[cmd]) if (opt[k] === undefined) stop([`${cmd} needs --${k}`]);
  const run = resolve(opt.run);
  let n;
  if (opt.n !== undefined) {
    n = Number(opt.n);
    if (!Number.isInteger(n) || n < 1) stop(['--n must be a clip number, 1 or more']);
  }
  const src = opt.src;
  try {
    if (cmd === 'probe-frames') {
      const r = await probeFrames({ run, src });
      if (r.eligible === false) {
        process.stderr.write(`not eligible for the panel layout: ${r.why}\n`);
        say({ eligible: false });
      }
      say(r);
    }
    if (cmd === 'probe-record') say(recordProbe({ run, file: resolve(opt.file) }));
    if (cmd === 'read-frames') say(await readFrames({ run, n, src, wordsFile: opt.words }));
    say(recordRead({ run, n, file: resolve(opt.file) }));
  } catch (err) {
    stop([err instanceof PanelsError ? err.message : `${cmd} failed: ${err.code ?? err.message}`]);
  }
}

main(process.argv.slice(2));
