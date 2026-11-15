// The engine's fingerprint. boqo-clips holds the engine; boqo-channel and
// boqo-sniper carry byte-for-byte copies (scripts/sync-engine.mjs). This file
// is part of the copy, so a target repo's CI can run engineHash(its own root)
// and compare it with engine/ENGINE.json to catch a hand-edited copy.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SHARED = [
  'engine/',
  'tools/doctor.mjs',
  'tools/fetch.mjs',
  'tools/render.mjs',
  'tools/picks-check.mjs',
  'tools/brand.mjs',
  'tools/asr.mjs',
  'tools/boqo-upload.mjs',
];

export const ENGINE_JSON = 'engine/ENGINE.json';

// Every file under SHARED as POSIX-style relative paths, sorted by code unit
// (not locale), without engine/ENGINE.json. A listed file that is missing
// throws: a partial copy must never hash clean.
export function sharedFiles(root) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const p = `${rel}/${name}`;
      if (statSync(join(root, p)).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  for (const entry of SHARED) {
    if (entry.endsWith('/')) {
      let ok = false;
      try { ok = statSync(join(root, entry)).isDirectory(); } catch {}
      if (!ok) throw new Error(`missing shared directory: ${entry}`);
      walk(entry.slice(0, -1));
    } else {
      let ok = false;
      try { ok = statSync(join(root, entry)).isFile(); } catch {}
      if (!ok) throw new Error(`missing shared file: ${entry}`);
      out.push(entry);
    }
  }
  return out.filter((p) => p !== ENGINE_JSON).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// sha256 over, per file in sorted order: relpath \0 bytes \0
export function engineHash(root) {
  const h = createHash('sha256');
  for (const rel of sharedFiles(root)) {
    h.update(rel);
    h.update('\0');
    h.update(readFileSync(join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

export const ATTR_BEGIN = '# boqo-engine:begin (written by scripts/sync-engine.mjs; do not edit)';
export const ATTR_END = '# boqo-engine:end';

// The .gitattributes block that keeps these bytes identical on every OS:
// `-text` turns off CRLF conversion on checkout (Windows autocrlf) for exactly
// the hashed files.
export function gitattributes() {
  const lines = SHARED.map((p) => (p.endsWith('/') ? `${p}** -text` : `${p} -text`));
  return [ATTR_BEGIN, ...lines, ATTR_END].join('\n') + '\n';
}
