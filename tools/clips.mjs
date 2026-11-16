#!/usr/bin/env node
// node tools/clips.mjs order   --run <run dir>
// node tools/clips.mjs summary --run <run dir>
//   order    puts <run>/clips.json in the final order (hosted's Ranked: rendered clips by pct + judgment, then
//            score, then start, with `fails` last; unrendered ones after, in the pre-render order), rewrites `n`
//            and renames each rendered clip-<nn>.mp4 (and a thumbnail beside it) to match. Prints
//            {"ok":true,"clips":n,"rendered":n,"renamed":n} or {"ok":false,"errors":[...]} (exit 1).
//   summary  prints one line a rendered clip, in order, and `+N not rendered` last when some are not.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reorderRun, summaryLines } from '../engine/order.mjs';

const say = (obj, code) => {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
};
const stop = (errors) => say({ ok: false, errors }, 1);

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'order' && cmd !== 'summary') stop(['usage: clips.mjs order|summary --run <run dir>']);
  let run;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--run') stop([`unknown argument ${rest[i]}`]);
    if (i + 1 >= rest.length) stop(['--run needs a value']);
    run = rest[++i];
  }
  if (run === undefined) stop([`usage: clips.mjs ${cmd} --run <run dir>`]);
  run = resolve(run);

  if (cmd === 'order') {
    let r;
    try {
      r = reorderRun(run);
    } catch (err) {
      stop([`order was interrupted (${err.code ?? err.message}); run it again, it finishes the interrupted order first`]);
    }
    if (!r.ok) stop(r.errors);
    say(r, 0);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(join(run, 'clips.json'), 'utf8'));
  } catch (err) {
    stop([`cannot read clips.json: ${err.code ?? err.message}`]);
  }
  if (!record || !Array.isArray(record.clips)) stop(['clips.json has no clips array']);
  const lines = summaryLines(record);
  if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

main(process.argv.slice(2));
