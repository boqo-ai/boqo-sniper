#!/usr/bin/env node
// node scripts/boqo-drift.mjs <boqo checkout> [--ref <rev>]
//   Run before every skill release. For each boqo source named in a port header
//     // ported from boqo-ai/boqo <path> @ <pin>; ...     (engine/boqo/, lib/boqo/)
//     <!-- ported from boqo-ai/boqo <path> @ <pin>; ... -->   (skills/**/*.md)
//   compares the blob at engine/boqo/PIN with the blob at <rev> (default HEAD)
//   in the checkout, and prints "<path> changed" for each difference.
//   Exit 0: nothing changed. Exit 1: something changed (port it and move the
//   pin, or record the lag in the release notes). Exit 2: it could not decide
//   (bad usage, no git, unknown pin or ref, a header naming a path absent at
//   the pin), so a broken run never reads as a clean one.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = /^(?:\/\/|<!--) ported from boqo-ai\/boqo (\S+) @ [0-9a-f]+;/gm;

const die = (msg) => {
  process.stderr.write(`boqo-drift: ${msg}\n`);
  process.exit(2);
};

function files(dir, keep) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
let ref = 'HEAD';
const i = args.indexOf('--ref');
if (i !== -1) {
  ref = args[i + 1];
  args.splice(i, 2);
}
if (args.length !== 1 || !ref) die('usage: node scripts/boqo-drift.mjs <boqo checkout> [--ref <rev>]');
const checkout = args[0];

const git = (...a) => spawnSync('git', ['-C', checkout, ...a], { encoding: 'utf8' });
const pinFile = join(root, 'engine/boqo/PIN');
if (!existsSync(pinFile)) die('engine/boqo/PIN is missing');
const pin = readFileSync(pinFile, 'utf8').split('\n')[0].trim();
if (!pin) die('engine/boqo/PIN has no sha on its first line');
if (git('rev-parse', '--git-dir').status !== 0) die(`not a git checkout: ${checkout}`);
for (const rev of [pin, ref]) {
  if (git('rev-parse', '--verify', '--quiet', `${rev}^{commit}`).status !== 0) die(`no such commit in ${checkout}: ${rev}`);
}

const sources = new Set();
const scan = [
  ...files(join(root, 'engine/boqo'), (n) => n !== 'PIN'),
  ...files(join(root, 'lib/boqo'), () => true),
  ...files(join(root, 'skills'), (n) => n.endsWith('.md')),
];
for (const f of scan) {
  for (const m of readFileSync(f, 'utf8').matchAll(HEADER)) sources.add(m[1]);
}

const blob = (rev, path) => {
  const r = git('rev-parse', '--verify', '--quiet', `${rev}:${path}`);
  return r.status === 0 ? r.stdout.trim() : null;
};

let changed = 0;
for (const path of [...sources].sort()) {
  const atPin = blob(pin, path);
  if (atPin === null) die(`${path} (named in a port header) does not exist at the pin ${pin}`);
  if (blob(ref, path) !== atPin) {
    process.stdout.write(`${path} changed\n`);
    changed++;
  }
}
process.exit(changed ? 1 : 0);
