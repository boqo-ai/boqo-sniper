// expectGolden(name, actual, {tol = 1e-9}): deep-compare `actual` with
// tests/golden/<name>.json (written by scripts/parity/golden.mjs from boqo at
// the pin). Numbers compare within an absolute `tol`; everything else exactly.
// `actual` is first round-tripped through JSON, so it is compared as the golden
// was produced: an undefined key drops, NaN and Infinity become null, key order
// does not matter. A mismatch throws an AssertionError that names the first
// differing paths (`a.b[2]`). `dir` overrides the golden directory (tests of
// this helper only).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden');
const MAX_DIFFS = 5;

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const show = (v) => {
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

function walk(want, got, path, tol, out) {
  if (out.length >= MAX_DIFFS) return;
  const at = path || '(root)';
  const kw = kind(want);
  if (kw !== kind(got)) {
    out.push(`${at}: expected ${show(want)}, got ${show(got)}`);
  } else if (kw === 'number') {
    if (!(Math.abs(want - got) <= tol)) out.push(`${at}: expected ${want}, got ${got} (tol ${tol})`);
  } else if (kw === 'array') {
    if (want.length !== got.length) out.push(`${at}: expected length ${want.length}, got ${got.length}`);
    for (let i = 0; i < Math.min(want.length, got.length); i++) walk(want[i], got[i], `${path}[${i}]`, tol, out);
  } else if (kw === 'object') {
    for (const k of Object.keys(want)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in got)) out.push(`${p}: missing`);
      else walk(want[k], got[k], p, tol, out);
    }
    for (const k of Object.keys(got)) if (!(k in want)) out.push(`${path ? `${path}.${k}` : k}: unexpected`);
  } else if (want !== got) {
    out.push(`${at}: expected ${show(want)}, got ${show(got)}`);
  }
}

export function expectGolden(name, actual, { tol = 1e-9, dir = GOLDEN_DIR } = {}) {
  const file = join(dir, `${name}.json`);
  let want;
  try {
    want = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    assert.fail(`golden "${name}" cannot be read (${file}): ${e.message}`);
  }
  const got = JSON.parse(JSON.stringify(actual === undefined ? null : actual));
  const diffs = [];
  walk(want, got, '', tol, diffs);
  if (diffs.length) assert.fail(`golden "${name}" differs:\n  ${diffs.join('\n  ')}`);
}
