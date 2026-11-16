#!/usr/bin/env node
// node tools/asr.mjs <file> [--from s --to e] [--lang xx] --out <words.json>
//   Local speech to words with whisper.cpp. With --from/--to only that range
//   is transcribed; times stay on the source timeline. Also writes
//   `segments.json` (sentence segments, source whisper) next to <words.json>.
//   Prints {"words":N,"out":"<path>","model":"<file name>","seconds":<wall time>,
//   "lang":"<language it ran in>","englishOnly":bool}. englishOnly is true for an
//   `.en` model, which hears every video as English.
// Exit 1 with {"error":"..."} on failure (whisper-cli or a model missing too).
import { writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { transcribeDetailed } from '../engine/asr.mjs';
import { segmentsFromWords } from '../engine/segments.mjs';

const fail = (msg) => {
  process.stdout.write(JSON.stringify({ error: msg }) + '\n');
  process.exit(1);
};

const FLAGS = { '--from': 'from', '--to': 'to', '--lang': 'lang', '--out': 'out' };

async function main(argv) {
  const opt = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const key = FLAGS[argv[i]];
    if (key) {
      if (i + 1 >= argv.length) fail(`${argv[i]} needs a value`);
      opt[key] = argv[++i];
    } else if (argv[i].startsWith('--')) fail(`unknown flag ${argv[i]}`);
    else positional.push(argv[i]);
  }
  if (positional.length !== 1) fail('usage: asr.mjs <file> [--from s --to e] [--lang xx] --out <words.json>');
  if (opt.out === undefined) fail('--out is required');
  const num = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (v.trim() === '' || !Number.isFinite(n)) fail(`${name} must be a number of seconds`);
    return n;
  };
  const s = num(opt.from, '--from');
  const e = num(opt.to, '--to');

  const t0 = Date.now();
  const r = await transcribeDetailed(resolve(positional[0]), { s, e, lang: opt.lang });
  const out = resolve(opt.out);
  writeFileSync(out, JSON.stringify(r.words));
  writeFileSync(join(dirname(out), 'segments.json'), JSON.stringify(segmentsFromWords(r.words, { source: 'whisper' })));
  process.stdout.write(
    JSON.stringify({
      words: r.words.length,
      out,
      model: basename(r.model),
      seconds: Math.round((Date.now() - t0) / 100) / 10,
      lang: r.lang,
      englishOnly: r.englishOnly,
    }) + '\n',
  );
}

main(process.argv.slice(2)).catch((err) => fail(err.message));
