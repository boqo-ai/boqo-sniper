#!/usr/bin/env node
// node tools/select-check.mjs --run <run dir> [--length l] [--lang xx]
//   Checks <run>/selection.json, the agent's answer to select-request.md, as
//   hosted's zod schema does (bounds, lengths, at most 12 emphasis words,
//   exactly two title alternatives), then snaps the clips to segment edges,
//   drops what hosted drops and writes <run>/clips.json, the run's record.
//   Reads <run>/segments.json (required), <run>/info.json (optional: duration,
//   title, id, language, most-replayed heatmap, chapters) and
//   <run>/select-options.json (written by select-request.mjs: the length band).
//   --length  overrides the length preset of select-options.json (auto when neither)
//   --lang    the transcript's language code when info.json does not say
//   Prints {"ok":true,"kept":n,"dropped":{reason:count},"dropped_clips":[{clip,start,end,reason}]} and exits 0
//   (clip is the place in selection.json's clips, 1 for the first; dropped_clips is absent when none was dropped), or
//   {"ok":false,"errors":[...]} and exits 1 (a stale clips.json is removed). The
//   agent fixes selection.json and runs it again. Paths in errors are
//   selection.json's: clips[0] is the first clip.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkSelection } from '../engine/clips-record.mjs';
import { durationOf, languageFor, replayCurveOf } from '../engine/select-input.mjs';

const say = (obj, code) => {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
};
const stop = (errors) => say({ ok: false, errors }, 1);

// A missing optional file is null; one that is there and is not JSON is an error.
function readJson(path, what, required) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (!required && err.code === 'ENOENT') return null;
    return stop([`cannot read ${what}: ${err.code ?? err.message}`]);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return stop([`${what} is not valid JSON: ${err.message}`]);
  }
}

const FLAGS = { '--run': 'run', '--length': 'length', '--lang': 'lang' };

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (!key) stop([`unknown argument ${argv[i]}`]);
    if (i + 1 >= argv.length) stop([`${argv[i]} needs a value`]);
    opt[key] = argv[++i];
  }
  if (opt.run === undefined) stop(['usage: select-check.mjs --run <run dir> [--length l] [--lang xx]']);
  const run = resolve(opt.run);
  const clipsFile = join(run, 'clips.json');
  // Never leave a record that does not belong to the selection.json now on disk.
  rmSync(clipsFile, { force: true });

  const selection = readJson(join(run, 'selection.json'), 'selection.json', true);
  const segments = readJson(join(run, 'segments.json'), 'segments.json', true);
  if (!Array.isArray(segments) || segments.length === 0) stop(['segments.json must hold a non-empty array']);
  segments.forEach((s, i) => {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end)) stop([`segment ${i + 1} of segments.json needs numeric start and end`]);
  });
  const info = readJson(join(run, 'info.json'), 'info.json', false);
  const options = readJson(join(run, 'select-options.json'), 'select-options.json', false);

  const result = checkSelection(selection, {
    segments,
    durationSec: durationOf(info, segments),
    heat: replayCurveOf(info),
    length: opt.length ?? options?.length ?? 'auto',
    video: {
      id: typeof info?.id === 'string' ? info.id : null,
      title: typeof info?.title === 'string' ? info.title : null,
      language: languageFor(info, opt.lang ?? options?.language ?? null),
    },
  });
  if (!result.ok) stop(result.errors);

  try {
    writeFileSync(clipsFile, JSON.stringify(result.record, null, 2) + '\n');
  } catch (err) {
    stop([`cannot write clips.json: ${err.code ?? err.message}`]);
  }
  say({ ok: true, kept: result.record.clips.length, dropped: result.dropped, ...(result.droppedClips.length ? { dropped_clips: result.droppedClips } : {}) }, 0);
}

main(process.argv.slice(2));
