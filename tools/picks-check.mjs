#!/usr/bin/env node
// node tools/picks-check.mjs <picks.json> --duration <sec> [--words <words.json>]
//   [--min 15] [--max 90] [--count-min 1] [--count-max 10]
// Snaps the picks to word boundaries (when --words is given; each snapped pick
// carries `moved: {s, e}`, how far snapping shifted each edge), then checks them.
// Prints one JSON line: {"ok":true,"picks":[...]} (exit 0), {"ok":false,"errors":[...]}
// (exit 1), or {"error":"..."} (exit 1) when it cannot run at all.
import { readFileSync } from 'node:fs';
import { checkPicks, snapPick } from '../engine/picks.mjs';

const fail = (msg) => {
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
};

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${what} ${path}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what} ${path} is not valid JSON`);
  }
}

const FLAGS = {
  '--duration': 'duration',
  '--words': 'words',
  '--min': 'minSec',
  '--max': 'maxSec',
  '--count-min': 'countMin',
  '--count-max': 'countMax',
};

const args = process.argv.slice(2);
const opt = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const key = FLAGS[args[i]];
  if (key) {
    if (i + 1 >= args.length) fail(`${args[i]} needs a value`);
    opt[key] = args[++i];
  } else if (args[i].startsWith('--')) {
    fail(`unknown flag ${args[i]}`);
  } else {
    positional.push(args[i]);
  }
}

if (positional.length !== 1) fail('usage: picks-check.mjs <picks.json> --duration <sec> [--words <words.json>]');
const numbers = {};
for (const k of ['duration', 'minSec', 'maxSec', 'countMin', 'countMax']) {
  if (opt[k] === undefined) continue;
  const n = Number(opt[k]);
  if (!Number.isFinite(n)) fail(`--${k} must be a number`);
  numbers[k] = n;
}
if (numbers.duration === undefined || numbers.duration <= 0) fail('--duration <sec> is required and must be positive');

const raw = readJson(positional[0], 'picks file');
let picks = Array.isArray(raw) ? raw : raw?.picks;
if (!Array.isArray(picks)) fail('picks file must hold an array, or {"picks": [...]}');

if (opt.words !== undefined) {
  const words = readJson(opt.words, 'words file');
  if (!Array.isArray(words)) fail('words file must hold an array of {w, s, e}');
  words.forEach((x, i) => {
    if (!x || typeof x !== 'object' || !Number.isFinite(x.s) || !Number.isFinite(x.e)) {
      fail(`words file item ${i + 1} needs numeric s and e in seconds`);
    }
  });
  const sorted = [...words].sort((a, b) => a.s - b.s);
  // 0.01 s drift per edge, so the agent sees what snapping did
  const drift = (to, from) => Math.round((to - from) * 100) / 100 + 0;
  picks = picks.map((p) => {
    if (!p || typeof p !== 'object' || !Number.isFinite(p.s) || !Number.isFinite(p.e)) return p;
    const q = snapPick(p, sorted);
    return { ...q, moved: { s: drift(q.s, p.s), e: drift(q.e, p.e) } };
  });
}

const { duration, ...rest } = numbers;
const res = checkPicks(picks, { duration, ...rest });
if (res.ok) {
  process.stdout.write(JSON.stringify({ ok: true, picks }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ ok: false, errors: res.errors }) + '\n');
  process.exit(1);
}
