#!/usr/bin/env node
// node tools/transcript-boqo.mjs --url "<signed link>" --run <run dir>
// node tools/transcript-boqo.mjs --file <get_transcript.json> --run <run dir>
//   Turns the result of boqo's `get_transcript` (the signed link in its `url`, or the JSON saved to a
//   file) into the run's transcript files:
//     <run>/words.json               [{w, s, e}], what tools/transcript.mjs and the render read
//     <run>/segments.json            [{start, end, text, speaker}], Deepgram's own sentences, the
//                                    speaker a whole number (the request prints `S{n}: `, as hosted does)
//     <run>/transcript-language.txt  the transcript's language tag, which tools/select-request.mjs reads
//   The link must be https and is never printed. The download stops at 64 MB and after 60 s. The JSON
//   is checked field by field first: a malformed one writes nothing.
//   Prints {"words":n,"segments":n,"language":"xx","durationSec":n}. Exit 1 with {"error":"..."} on failure.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { needPackages } from '../engine/packages.mjs';

const { fetchTranscriptJson, parseBoqoTranscript } = await needPackages(() => import('../engine/transcript-boqo.mjs'));

const fail = (msg) => {
  process.stdout.write(JSON.stringify({ error: String(msg).replace(/\s+/g, ' ').replace(/https?:\/\/\S*/gi, '<link>').slice(0, 300) }) + '\n');
  process.exit(1);
};

const FLAGS = { '--url': 'url', '--file': 'file', '--run': 'run' };

async function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (!key) fail(argv[i].startsWith('--') ? `unknown flag ${argv[i]}` : `unexpected argument ${argv[i]}`);
    if (i + 1 >= argv.length) fail(`${argv[i]} needs a value`);
    opt[key] = argv[++i];
  }
  if (opt.run === undefined) fail('--run is required');
  if ((opt.url === undefined) === (opt.file === undefined)) fail('give exactly one of --url and --file');
  const run = resolve(opt.run);
  try {
    if (!statSync(run).isDirectory()) throw new Error('not a directory');
  } catch {
    fail(`the run directory does not exist: ${opt.run}`);
  }

  let raw;
  if (opt.url !== undefined) {
    raw = await fetchTranscriptJson(opt.url);
  } else {
    let text;
    try {
      text = readFileSync(resolve(opt.file), 'utf8');
    } catch (err) {
      return fail(`cannot read ${opt.file}: ${err.code ?? err.message}`);
    }
    try {
      raw = JSON.parse(text);
    } catch {
      return fail(`${opt.file} is not valid JSON`);
    }
  }
  const t = parseBoqoTranscript(raw);
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'words.json'), JSON.stringify(t.words));
  writeFileSync(join(run, 'segments.json'), JSON.stringify(t.segments));
  writeFileSync(join(run, 'transcript-language.txt'), `${t.language}\n`);
  process.stdout.write(JSON.stringify({ words: t.words.length, segments: t.segments.length, language: t.language, durationSec: t.segments.at(-1).end }) + '\n');
}

main(process.argv.slice(2)).catch((err) => fail(err?.message ?? err));
