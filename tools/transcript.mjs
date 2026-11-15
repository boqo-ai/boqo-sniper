#!/usr/bin/env node
// node tools/transcript.mjs --words <words.json> --out <transcript.md>
//        [--heat <info.json>] [--line-sec 8] [--chunk-sec 900]
//   Turns a words file ([{w,s,e}], from asr.mjs or fetch.mjs) into the
//   timestamped transcript the agent reads, the same text `fetch.mjs info`
//   writes. --heat takes a yt-dlp info JSON and marks its most-replayed lines.
//   Prints {"out":"<path>","chunks":N,"words":N}.
// Exit 1 with {"error":"..."} on failure.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { heatOf } from '../engine/fetch.mjs';
import { transcriptMarkdown } from '../engine/words.mjs';

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

const FLAGS = { '--words': 'words', '--out': 'out', '--heat': 'heat', '--line-sec': 'lineSec', '--chunk-sec': 'chunkSec' };

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (!key) fail(argv[i].startsWith('--') ? `unknown flag ${argv[i]}` : `unexpected argument ${argv[i]}`);
    if (i + 1 >= argv.length) fail(`${argv[i]} needs a value`);
    opt[key] = argv[++i];
  }
  if (opt.words === undefined) fail('--words is required');
  if (opt.out === undefined) fail('--out is required');
  const seconds = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n) || n <= 0) fail(`${name} must be a positive number of seconds`);
    return n;
  };
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
