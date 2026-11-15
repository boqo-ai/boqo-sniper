// The engine here is a byte-for-byte copy from boqo-ai/boqo-clips. A hand edit
// changes the hash and fails this test; edit it in boqo-clips and re-sync.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { engineHash } from '../engine/hash.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = JSON.parse(readFileSync(join(root, 'engine', 'ENGINE.json'), 'utf8'));

test('the vendored engine matches the hash it was synced with', () => {
  assert.equal(engineHash(root), engine.hash);
});

test('every file ENGINE.json lists exists', () => {
  assert.ok(Array.isArray(engine.files) && engine.files.length > 0);
  for (const rel of engine.files) assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
});
