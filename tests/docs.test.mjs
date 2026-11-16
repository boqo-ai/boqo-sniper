// The commands the skill's docs give are the tools' own: every tool a command names exists, and every flag it
// passes is one that tool's source reads. A doc copied from boqo-clips that still names a renamed or removed flag
// (a stale copy) fails here.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOOLS = join(ROOT, 'tools');
const SKILL_DIR = join(ROOT, 'skills', 'boqo-sniper');
// A checkout on Windows may carry CRLF line ends.
const readDoc = (f) => readFileSync(join(SKILL_DIR, f), 'utf8').replace(/\r\n/g, '\n');
const docs = readdirSync(SKILL_DIR).filter((f) => f.endsWith('.md'));

// A tool's flags may be read in its own file or in the engine module it delegates to.
const ENGINE_FOR = { 'boqo-upload': 'boqo-upload-lib.mjs' };
const sourceOf = (name) => {
  const code = readFileSync(join(TOOLS, `${name}.mjs`), 'utf8');
  const lib = ENGINE_FOR[name] ? readFileSync(join(ROOT, 'engine', ENGINE_FOR[name]), 'utf8') : '';
  return code + lib;
};

test('every skill doc is checked, and the engine copies carry their header', () => {
  assert.deepEqual(docs.sort(), ['SKILL.md', 'onboarding.md', 'panels.md', 'post.md', 'select.md', 'stranger.md']);
  const engine = JSON.parse(readFileSync(join(ROOT, 'engine', 'ENGINE.json'), 'utf8'));
  const sha = engine.commit.slice(0, 7);
  for (const f of ['onboarding.md', 'panels.md', 'post.md', 'select.md', 'stranger.md']) {
    const head = readDoc(f).split('\n', 1)[0];
    assert.equal(head, `<!-- copied from boqo-ai/boqo-clips skills/boqo-clips/${f} @ ${sha}; keep in step -->`, `${f} is not the copy of the synced boqo-clips`);
  }
});

// The problems in one doc's text: a tool a command names that does not exist, a flag its source never reads.
const COMMAND = /node "\$HOME\/\.boqo-sniper\/tools\/([a-z-]+)\.mjs"([^\n`]*)/g;
function problems(text, read = sourceOf) {
  const joined = text.replace(/\\\n\s*/g, ' ');
  const found = [];
  let flags = 0;
  for (const m of joined.matchAll(/\.boqo-sniper\/tools\/([a-z-]+)\.mjs/g)) if (!existsSync(join(TOOLS, `${m[1]}.mjs`))) found.push(`no tool ${m[1]}`);
  for (const m of joined.matchAll(COMMAND)) {
    if (!existsSync(join(TOOLS, `${m[1]}.mjs`))) continue;
    const code = read(m[1]);
    for (const flag of m[2].match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []) {
      flags++;
      if (!(code.includes(`'${flag}'`) || code.includes(`"${flag}"`) || code.includes(`${flag} `) || code.includes(`${flag}=`))) found.push(`${m[1]} does not read ${flag}`);
    }
  }
  return { found, flags };
}

test('the commands in the skill docs name tools and flags that exist', () => {
  let checked = 0;
  for (const f of docs) {
    const r = problems(readDoc(f));
    assert.deepEqual(r.found, [], f);
    checked += r.flags;
  }
  assert.ok(checked > 15, `only ${checked} flags checked`);
});

test('the check catches a stale copy: a removed flag and a removed tool', () => {
  const v01 = 'node "$HOME/.boqo-sniper/tools/render.mjs" --src "a.mp4" \\\n  --picks "p.json" --words "w.json" --out "o"';
  assert.deepEqual(problems(v01).found, ['render does not read --picks', 'render does not read --out']);
  assert.deepEqual(problems('node "$HOME/.boqo-sniper/tools/gone.mjs" --x').found, ['no tool gone']);
  assert.deepEqual(problems('node "$HOME/.boqo-sniper/tools/render.mjs" --run "r" --first 1').found, []);
});
