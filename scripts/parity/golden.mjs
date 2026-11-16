#!/usr/bin/env node
// node scripts/parity/golden.mjs --boqo <boqo checkout at the pin> --case <name> [--input <abs path>]
//   Runs boqo's own TypeScript for one parity case and writes its stdout JSON
//   to tests/golden/<name>.json (committed; CI compares from it and never needs
//   boqo). Steps: copy scripts/parity/cases/<name>.ts into
//   <boqo>/apps/worker/src/.parity/ (untracked there; removed again after the
//   run), then run, from the checkout,
//     pnpm --filter @boqo/worker exec tsx src/.parity/<name>.ts <abs input path>
//   The input defaults to tests/fixtures/parity/<name>.input.json.
//
//   Needs `tsx` on PATH (npm i -g tsx): boqo does not depend on it.
//
//   Import convention for a case file. It runs from apps/worker/src/.parity/, so
//   boqo sources are relative to that directory:
//     ../../../../packages/core/src/<module>     (packages/core/src)
//     ../../../web/src/<module>                  (apps/web/src)
//     ../<module>                                (apps/worker/src)
//   with no file extension. Read the input from process.argv[2], print exactly
//   one JSON document to stdout (console.log(JSON.stringify(result))), and
//   nothing else on stdout. Only derived numbers go into a case's input and
//   output: never a real video's media, transcript text or frames.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const die = (msg) => {
  process.stderr.write(`golden: ${msg}\n`);
  process.exit(2);
};

const { values } = parseArgs({ options: { boqo: { type: 'string' }, case: { type: 'string' }, input: { type: 'string' } } });
if (!values.boqo || !values.case) die('usage: node scripts/parity/golden.mjs --boqo <dir> --case <name> [--input <path>]');
const name = values.case;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) die(`bad case name: ${name}`);
const boqo = resolve(values.boqo);
const worker = join(boqo, 'apps/worker');
if (!existsSync(join(worker, 'package.json'))) die(`${boqo} has no apps/worker: pass a boqo checkout (the parity worktree at the pin)`);
// A golden is only ever the pinned boqo's: refuse a checkout that has drifted.
const pin = readFileSync(join(root, 'engine/boqo/PIN'), 'utf8').split('\n')[0].trim();
const head = spawnSync('git', ['-C', boqo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
const headSha = head.status === 0 ? head.stdout.trim() : '';
if (!pin || !headSha.startsWith(pin)) {
  die(`${boqo} is at ${headSha ? headSha.slice(0, 9) : 'no commit'}, PIN is ${pin || 'empty'}: check out the pin (the parity worktree) first`);
}
const caseFile = join(root, 'scripts/parity/cases', `${name}.ts`);
if (!existsSync(caseFile)) die(`no case file: ${caseFile}`);
const input = resolve(values.input ?? join(root, 'tests/fixtures/parity', `${name}.input.json`));
if (!existsSync(input)) die(`no input file: ${input}`);

const dir = join(worker, 'src/.parity');
const copy = join(dir, `${name}.ts`);
mkdirSync(dir, { recursive: true });
copyFileSync(caseFile, copy);
let run;
try {
  run = spawnSync('pnpm', ['--filter', '@boqo/worker', 'exec', 'tsx', `src/.parity/${name}.ts`, input], {
    cwd: boqo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32',
  });
} finally {
  rmSync(copy, { force: true });
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}
if (run.error) die(`could not run pnpm: ${run.error.message}`);
if (run.status !== 0) {
  process.stderr.write(run.stderr);
  die(`the case exited ${run.status}`);
}
let json;
try {
  json = JSON.parse(run.stdout);
} catch (e) {
  die(`stdout is not one JSON document (${e.message}):\n${run.stdout.slice(0, 500)}`);
}
const out = join(root, 'tests/golden', `${name}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
process.stdout.write(`${out}\n`);
