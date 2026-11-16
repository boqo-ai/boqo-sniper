#!/usr/bin/env node
// node tools/transcript.mjs --words <words.json> --out <transcript.md>
//        [--heat <info.json>] [--line-sec 8] [--chunk-sec 900]
// node tools/transcript.mjs --words <words.json> --around <sec> [--span 30]
// node tools/transcript.mjs --words <words.json> --find "<phrase>" --near <sec> [--span 60]
//   Turns a words file ([{w,s,e}], from asr.mjs or fetch.mjs) into the
//   timestamped transcript the agent reads, the same text `fetch.mjs info`
//   writes. --heat takes a yt-dlp info JSON and marks its most-replayed lines.
//   Prints {"out":"<path>","chunks":N,"words":N}.
//   --around instead prints the words within --span seconds (default 30) of a
//   time, to read near a clip edge:
//   {"lines":["[m:ss] text (s-e)",...],"from":<sec>,"to":<sec>}.
//   --find instead prints where a quoted phrase is spoken within --span
//   seconds (default 60) of --near, to set a clip edge on a word:
//   {"s":<its first word's start>,"e":<its last word's end>,"match":"<those
//   words as written>","score":<0..1>}; exit 1 with
//   {"error":"phrase not found near <sec>"} when nothing scores 0.6.
//   Give exactly one of --out, --around and --find.
// Exit 1 with {"error":"..."} on failure.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { heatOf } from '../engine/fetch.mjs';
import { findPhrase, transcriptMarkdown, wordsAround } from '../engine/words.mjs';

const fail = (msg) => {
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
};

const readJson = (path, what) => {
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
};

const FLAGS = {
  '--words': 'words',
  '--out': 'out',
  '--heat': 'heat',
  '--line-sec': 'lineSec',
  '--chunk-sec': 'chunkSec',
  '--around': 'around',
  '--find': 'find',
  '--near': 'near',
  '--span': 'span',
};
const flagOf = (k) => Object.keys(FLAGS).find((f) => FLAGS[f] === k);
// the flags each mode takes besides --words and its own
const MODE_FLAGS = { out: ['heat', 'lineSec', 'chunkSec'], around: ['span'], find: ['near', 'span'] };

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (!key) fail(argv[i].startsWith('--') ? `unknown flag ${argv[i]}` : `unexpected argument ${argv[i]}`);
    if (i + 1 >= argv.length) fail(`${argv[i]} needs a value`);
    opt[key] = argv[++i];
  }
  if (opt.words === undefined) fail('--words is required');
  const modes = Object.keys(MODE_FLAGS).filter((k) => opt[k] !== undefined);
  if (modes.length > 1) {
    const flags = modes.map(flagOf);
    fail(`${flags.slice(0, -1).join(', ')} and ${flags.at(-1)} are mutually exclusive: give only one`);
  }
  if (modes.length === 0) {
    fail(opt.near !== undefined ? '--near needs --find' : 'give one of --out, --around or --find');
  }
  const mode = modes[0];
  for (const k of ['heat', 'lineSec', 'chunkSec', 'near', 'span']) {
    if (opt[k] === undefined || MODE_FLAGS[mode].includes(k)) continue;
    const owners = Object.keys(MODE_FLAGS).filter((m) => MODE_FLAGS[m].includes(k));
    fail(`${flagOf(k)} goes with ${owners.map(flagOf).join(' or ')}, not ${flagOf(mode)}`);
  }
  const seconds = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n <= 0) fail(`${name} must be a positive number of seconds`);
    return n;
  };
  const time = (v, name) => {
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n < 0) fail(`${name} must be a time in seconds, 0 or more`);
    return n;
  };
  const around = mode === 'around' ? time(opt.around, '--around') : undefined;
  if (mode === 'find') {
    if (opt.near === undefined) fail('--find needs --near <seconds>, the time to look around');
    if (!/[\p{L}\p{N}]/u.test(opt.find)) fail('--find needs words to look for');
  }
  const near = mode === 'find' ? time(opt.near, '--near') : undefined;
  const span = seconds(opt.span, '--span');
  const lineSec = seconds(opt.lineSec, '--line-sec');
  const chunkSec = seconds(opt.chunkSec, '--chunk-sec');

  const words = readJson(opt.words, 'words file');
  if (!Array.isArray(words)) fail('the words file must hold an array of words [{"w","s","e"}]');
  words.forEach((x, i) => {
    if (!x || typeof x.w !== 'string' || !Number.isFinite(x.s) || !Number.isFinite(x.e)) {
      fail(`word ${i + 1} must be {"w": text, "s": seconds, "e": seconds}`);
    }
  });
  if (words.length === 0) fail('the words file has no words');

  if (mode === 'around') {
    process.stdout.write(JSON.stringify(wordsAround(words, around, span)) + '\n');
    return;
  }
  if (mode === 'find') {
    const hit = findPhrase(words, opt.find, near, span);
    if (!hit) fail(`phrase not found near ${near}`);
    process.stdout.write(JSON.stringify(hit) + '\n');
    return;
  }

  const heat = opt.heat === undefined ? [] : heatOf(readJson(opt.heat, 'info file'));
  const md = transcriptMarkdown(words, { heat, lineSec, chunkSec });
  const out = resolve(opt.out);
  writeFileSync(out, md.text);
  process.stdout.write(JSON.stringify({ out, chunks: md.chunks, words: words.length }) + '\n');
}

try {
  main(process.argv.slice(2));
} catch (err) {
  fail(err.message);
}
