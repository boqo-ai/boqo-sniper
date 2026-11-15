#!/usr/bin/env node
// node tools/render.mjs --src <file> --picks <picks.json> --words <words.json>
//                       [--brand <name>] [--layout blur|crop] --out <dir>
// node tools/render.mjs --sections <sections.json> --picks <picks.json> --words <words.json> ...
//   sections.json is {"files":[{"pick": i, "file": "<path>", "offset": <seconds>}]}: pick i
//   lives in its own file, starting `offset` seconds in.
// Renders every pick to <dir>/clip-NN.mp4 and prints one JSON line,
// {"clips":[{"file","s","e","title"}]} (exit 0), or {"error":"..."} (exit 1).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBrand } from '../engine/brand.mjs';
import { renderClip } from '../engine/render.mjs';

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
  '--src': 'src',
  '--sections': 'sections',
  '--picks': 'picks',
  '--words': 'words',
  '--brand': 'brand',
  '--layout': 'layout',
  '--out': 'out',
};

async function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (!key) fail(argv[i].startsWith('--') ? `unknown flag ${argv[i]}` : `unexpected argument ${argv[i]}`);
    if (i + 1 >= argv.length) fail(`${argv[i]} needs a value`);
    opt[key] = argv[++i];
  }
  if ((opt.src === undefined) === (opt.sections === undefined)) fail('give exactly one of --src <file> or --sections <sections.json>');
  for (const k of ['picks', 'words', 'out']) if (opt[k] === undefined) fail(`--${k} is required`);
  if (opt.layout !== undefined && !['blur', 'crop'].includes(opt.layout)) fail('--layout must be blur or crop');

  const rawPicks = readJson(opt.picks, 'picks file');
  const picks = Array.isArray(rawPicks) ? rawPicks : rawPicks?.picks;
  if (!Array.isArray(picks)) fail('picks file must hold an array, or {"picks": [...]}');
  picks.forEach((p, i) => {
    if (!p || !Number.isFinite(p.s) || !Number.isFinite(p.e) || p.e <= p.s) fail(`pick ${i + 1} needs numeric s < e in seconds`);
  });
  const words = readJson(opt.words, 'words file');
  if (!Array.isArray(words)) fail('words file must hold an array of {w, s, e}');

  let files = null;
  if (opt.sections !== undefined) {
    const sec = readJson(opt.sections, 'sections file');
    const list = Array.isArray(sec?.files) ? sec.files : null;
    if (!list) fail('sections file must be {"files":[{"pick","file","offset"}]}');
    files = new Map();
    for (const f of list) {
      if (!f || !Number.isInteger(f.pick) || typeof f.file !== 'string' || !Number.isFinite(f.offset) || f.offset < 0) {
        fail('each sections entry needs an integer pick, a file path and a non-negative offset');
      }
      files.set(f.pick, f);
    }
    picks.forEach((_, i) => {
      if (!files.has(i)) fail(`sections file has no entry for pick ${i}`);
    });
  }

  const brand = await loadBrand(opt.brand);
  const outDir = resolve(opt.out);
  const clips = [];
  for (const [i, p] of picks.entries()) {
    const sec = files?.get(i);
    const { out } = await renderClip({
      src: sec ? resolve(sec.file) : resolve(opt.src),
      seek: sec?.offset,
      s: p.s,
      e: p.e,
      words,
      brand,
      layout: opt.layout,
      hook: p.hook ?? p.title,
      outDir,
      name: `clip-${String(i + 1).padStart(2, '0')}`,
    });
    clips.push({ file: out, s: p.s, e: p.e, title: p.title ?? null });
  }
  process.stdout.write(JSON.stringify({ clips }) + '\n');
}

main(process.argv.slice(2)).catch((err) => fail(err.message));
