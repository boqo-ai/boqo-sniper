#!/usr/bin/env node
// node tools/doctor.mjs [--node 20|22] [--whisper required|optional] [--streamlink]
//   Looks at what this machine has and prints one JSON line
//   {"ok":bool,"checks":[...],"hints":[...]}. `ok` is true when every REQUIRED
//   check passed. Exit 0 whenever it ran; exit 1 with {"error":"..."} only for
//   bad flags or a crash. It never installs anything; hints are also on stderr.
import { hintsFor, isOk, runChecks } from '../engine/doctor.mjs';

const fail = (msg) => {
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
};

function parse(argv) {
  const o = { nodeMin: 20, whisper: 'optional', streamlink: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--streamlink') o.streamlink = true;
    else if (a === '--node') {
      const v = argv[++i];
      if (v !== '20' && v !== '22') fail('--node must be 20 or 22');
      o.nodeMin = Number(v);
    } else if (a === '--whisper') {
      const v = argv[++i];
      if (v !== 'required' && v !== 'optional') fail('--whisper must be required or optional');
      o.whisper = v;
    } else fail(`unknown flag ${a}`);
  }
  return o;
}

async function main(argv) {
  const o = parse(argv);
  const checks = await runChecks(o);
  const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
  const hints = hintsFor(checks.filter((c) => !c.ok), platform);
  process.stdout.write(JSON.stringify({ ok: isOk(checks), checks, hints }) + '\n');
  for (const h of hints) process.stderr.write(h + '\n');
}

// A crash after the checks ran ends by itself, with process.exitCode: once onnxruntime-node is loaded, process.exit()
// aborts the process on macOS (tools/render.mjs has the measurement). `fail` above runs before any check, so it may exit.
main(process.argv.slice(2)).catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
  process.exitCode = 1;
});
