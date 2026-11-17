#!/usr/bin/env node
// node tools/select-request.mjs --run <run dir> [--genre g] [--length l] [--prompt "<words>"] [--lang xx]
//   Writes <run>/select-request.md: hosted's selection rubric, a line holding
//   only ---, then hosted's user message for this video. The agent reads it
//   and writes <run>/selection.json (tools/select-check.mjs checks it). Reads
//   <run>/segments.json (required), <run>/info.json and <run>/comments.json
//   (optional: a local file has neither).
//   --genre   auto (default), podcast, talk, gaming, vlog or entertainment
//   --length  auto (default), under_30, 30_60, 60_90, 90_120 or 120_180
//   --prompt  the person's own words about what they want, quoted into the request
//   --lang    the transcript's language code when info.json does not say
//             (<run>/transcript-language.txt, written by tools/transcript-boqo.mjs, stands in for it and
//             goes before info.json's: Deepgram heard the audio)
//   Also writes <run>/select-options.json ({genre, length, language}), the choices
//   tools/select-check.mjs reads so the check uses the same length band.
//   Prints {"target":n,"segments":n,"chars":n}. Exit 1 with {"error":"..."} on failure.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SELECTION_RUBRIC, buildUserMessage } from '../engine/boqo/prompt.mjs';
import { buildSelectionInput } from '../engine/select-input.mjs';

const fail = (msg) => {
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
};

// A missing file is null; a file that is there and is not JSON is an error.
function readJson(path, what, required) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (!required && err.code === 'ENOENT') return null;
    return fail(`cannot read ${what} ${path}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${what} ${path} is not valid JSON`);
  }
}

// boqo's transcript names the language it heard; a skill-made one has no such file (null: info.json, then English).
function readLanguage(run) {
  try {
    return readFileSync(join(run, 'transcript-language.txt'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const FLAGS = { '--run': 'run', '--genre': 'genre', '--length': 'length', '--prompt': 'prompt', '--lang': 'lang' };

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (!key) fail(`unknown argument ${argv[i]}`);
    if (i + 1 >= argv.length) fail(`${argv[i]} needs a value`);
    opt[key] = argv[++i];
  }
  if (opt.run === undefined) fail('usage: select-request.mjs --run <run dir> [--genre g] [--length l] [--prompt "<words>"] [--lang xx]');
  const run = resolve(opt.run);

  const segments = readJson(join(run, 'segments.json'), 'segments file', true);
  if (!Array.isArray(segments) || segments.length === 0) fail('segments.json must hold a non-empty array');
  segments.forEach((s, i) => {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end) || typeof s.text !== 'string') fail(`segment ${i + 1} needs numeric start and end and a text`);
  });
  const info = readJson(join(run, 'info.json'), 'info file', false);
  const comments = readJson(join(run, 'comments.json'), 'comments file', false);

  let input;
  try {
    input = buildSelectionInput({
      info,
      segments,
      comments: Array.isArray(comments) ? comments : null,
      genre: opt.genre ?? 'auto',
      length: opt.length ?? 'auto',
      prompt: opt.prompt ?? null,
      language: opt.lang ?? readLanguage(run),
    });
  } catch (err) {
    return fail(err.message);
  }
  const text = `${SELECTION_RUBRIC}\n---\n${buildUserMessage(input)}\n`;
  try {
    writeFileSync(join(run, 'select-request.md'), text);
    writeFileSync(join(run, 'select-options.json'), JSON.stringify({ genre: opt.genre ?? 'auto', length: opt.length ?? 'auto', language: input.language }) + '\n');
  } catch (err) {
    fail(`cannot write the request files: ${err.code ?? err.message}`);
  }
  process.stdout.write(JSON.stringify({ target: input.maxClips, segments: segments.length, chars: text.length }) + '\n');
}

main(process.argv.slice(2));
