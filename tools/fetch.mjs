#!/usr/bin/env node
// node tools/fetch.mjs info <url> --dir <d>
//   Reads the video info and ONE caption track, no video download. Writes
//   <d>/info.json, and with captions <d>/words.json, <d>/segments.json, <d>/transcript.md and
//   <d>/transcript-language.txt (the chosen track's language). Only a track of the video's own speech is taken,
//   never a translation (engine/fetch.mjs `captionPlan`).
//   Prints {"id","title","duration","captions":"manual|auto|partial|none","chunks":N}. "partial": the track has a
//   stretch of 40 s or more with no word; the files are written as usual and "source" ("manual"|"auto") and
//   "gaps" ([{"start","end"}], seconds) are added (engine/fetch.mjs `captionGaps`).
//   With no captions: captions "none", chunks 0, exit 0 (offer local whisper); a "note" says so when the video has
//   caption tracks and none was its speech.
// node tools/fetch.mjs comments <url> --dir <d>
//   Best effort: the top-level viewer comments (at most 200, top order) into
//   <d>/comments.json for the selection request. Prints {"comments":N}, or
//   {"comments":null} when they could not be read (comments off, a slow or
//   refused connection); exit 0 either way.
// node tools/fetch.mjs sections <url> --run <run> [--first K | --n 1,2,3 | --all]
// node tools/fetch.mjs sections <url> --picks <picks.json> --dir <d>
//   Downloads only the seconds of the clips about to be rendered (1 s padding), one fallback to a whole
//   download plus local cuts. With --run the clips are rows of <run>/clips.json chosen as `render.mjs` chooses them
//   (the default is --first 10, so the fetch and the render cover the same rows) and the files go to <run>; with
//   --picks they are a file of [{s, e}]. Prints {"files":[{"pick","file","offset","s","e"}]}: offset is the pick's
//   start inside its file, s and e the video seconds the file holds. The render and the panels read find a clip's
//   file by those seconds (<run>/sections.json, the line this prints), so a later fetch replaces the earlier one.
// Exit 1 with {"error":"..."} on failure.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectRows } from '../engine/order.mjs';
import { fetchComments, fetchInfo, fetchSections, realRun, infoArgs } from '../engine/fetch.mjs';

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

const FLAGS = { '--dir': 'dir', '--picks': 'picks', '--run': 'run', '--n': 'n', '--first': 'first' };

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'info' && cmd !== 'comments' && cmd !== 'sections') fail('usage: fetch.mjs info <url> --dir <d> | fetch.mjs comments <url> --dir <d> | fetch.mjs sections <url> --run <run> [--first K | --n 1,2,3 | --all]');
  const opt = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--all') opt.all = true;
    else if (FLAGS[rest[i]]) {
      const key = FLAGS[rest[i]];
      if (i + 1 >= rest.length) fail(`${rest[i]} needs a value`);
      opt[key] = rest[++i];
    } else if (rest[i].startsWith('--')) fail(`unknown flag ${rest[i]}`);
    else positional.push(rest[i]);
  }
  if (positional.length !== 1) fail(`${cmd} needs exactly one <url>`);
  const url = positional[0];
  if (!/^https?:\/\//i.test(url)) fail('the url must start with http:// or https://');
  if (cmd !== 'sections' && (opt.run !== undefined || opt.n !== undefined || opt.first !== undefined || opt.all)) fail(`${cmd} takes only <url> and --dir`);
  if (opt.dir === undefined && !(cmd === 'sections' && opt.run !== undefined)) fail('--dir is required');
  const dir = resolve(opt.dir ?? opt.run);

  if (cmd === 'comments') {
    const got = await fetchComments({ url, dir });
    process.stdout.write(JSON.stringify({ comments: got === null ? null : got.count }) + '\n');
    return;
  }

  if (cmd === 'info') {
    process.stdout.write(JSON.stringify(await fetchInfo({ url, dir })) + '\n');
    return;
  }

  let picks;
  if (opt.run !== undefined) {
    if (opt.picks !== undefined) fail('give --run or --picks, not both');
    if (opt.dir !== undefined && resolve(opt.dir) !== dir) fail('--dir and --run must be the same folder');
    const record = readJson(join(dir, 'clips.json'), 'clips.json');
    if (!record || !Array.isArray(record.clips)) fail('clips.json has no clips array');
    try {
      picks = selectRows(record, opt).map((r) => ({ s: r.start, e: r.end }));
    } catch (err) {
      fail(err.message);
    }
    if (picks.length === 0) fail('no clip to fetch');
  } else {
    if (opt.n !== undefined || opt.first !== undefined || opt.all) fail('--n, --first and --all go with --run');
    if (opt.picks === undefined) fail('--run or --picks is required');
    const raw = readJson(opt.picks, 'picks file');
    picks = Array.isArray(raw) ? raw : raw?.picks;
    if (!Array.isArray(picks) || picks.length === 0) fail('picks file must hold a non-empty array, or {"picks": [...]}');
  }
  picks.forEach((p, i) => {
    if (!p || !Number.isFinite(p.s) || !Number.isFinite(p.e) || p.s < 0 || p.e <= p.s) fail(`pick ${i + 1} needs numeric 0 <= s < e in seconds`);
  });

  // The video length clamps the padding; read it from info.json, or ask once.
  let duration;
  try {
    duration = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8')).duration;
  } catch {
    const { stdout } = await realRun.ytdlp(infoArgs(url));
    duration = JSON.parse(stdout).duration;
    writeFileSync(join(dir, 'info.json'), stdout);
  }
  const out = await fetchSections({ url, picks, dir, duration: Number.isFinite(duration) ? duration : undefined });
  process.stdout.write(JSON.stringify(out) + '\n');
}

main(process.argv.slice(2)).catch((err) => fail(err.message));
