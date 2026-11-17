#!/usr/bin/env node
// node scripts/parity/strip.mjs <boqo .ts file> <out .mjs> [--pin <sha>]
//   The mechanical first step of a port (§7.1): strip the TypeScript types of
//   one boqo module and prepend the port header
//     // ported from boqo-ai/boqo <path> @ <pin>; keep in step (scripts/boqo-drift.mjs)
//   <path> is the file's path inside the boqo checkout holding it (git
//   toplevel); <pin> is the first line of engine/boqo/PIN unless --pin says so.
//   Imports are NOT cut here: that is the hand edit the port task lists.
//
//   Types come out through node's own strip-only mode (module.stripTypeScriptTypes):
//   it blanks each type with spaces, so every comment survives and the code
//   stays where it was; line positions shift by the one header line. esbuild
//   (format=esm, no bundling) is the fallback for syntax strip-only mode
//   rejects (enum, namespace, parameter properties); esbuild drops ordinary
//   comments, so the fallback warns and the comments must be restored by hand.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const die = (msg) => {
  process.stderr.write(`strip: ${msg}\n`);
  process.exit(2);
};

const { values, positionals } = parseArgs({ allowPositionals: true, options: { pin: { type: 'string' } } });
if (positionals.length !== 2) die('usage: node scripts/parity/strip.mjs <boqo .ts file> <out .mjs> [--pin <sha>]');
// Real paths, so git's toplevel and the file agree under symlinks (/var -> /private/var
// on macOS) and Windows 8.3 short names.
const src = realpathSync.native(resolve(positionals[0]));
const out = resolve(positionals[1]);

const top = spawnSync('git', ['-C', dirname(src), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0) die(`${src} is not inside a git checkout, so its boqo path is unknown`);
const path = relative(realpathSync.native(top.stdout.trim()), src).split('\\').join('/');
const pin = values.pin ?? readFileSync(join(root, 'engine/boqo/PIN'), 'utf8').split('\n')[0].trim();

const text = readFileSync(src, 'utf8');
let code;
try {
  code = stripTypeScriptTypes(text, { mode: 'strip' });
} catch (e) {
  if (e?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw e;
  const { transformSync } = await import('esbuild');
  process.stderr.write(`strip: ${basename(src)}: ${e.message}; using esbuild, which drops comments: restore them from the source\n`);
  code = transformSync(text, {
    loader: 'ts', format: 'esm', target: 'esnext',
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  }).code;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `// ported from boqo-ai/boqo ${path} @ ${pin}; keep in step (scripts/boqo-drift.mjs)\n${code}`);
