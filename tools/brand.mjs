#!/usr/bin/env node
// node tools/brand.mjs list
//                      show [name]                       (no name: the default kit)
//                      save <brand.json> [--logo <file-or-url>]
//                      default <name>
// Brand kits live in $BOQO_HOME/brands/<name>/ (BOQO_HOME defaults to ~/.boqo), as v2 (boqo's template shape).
// `show` of a v1 kit prints it converted, with `migratedFrom: 1` and `notes`, and leaves the file; `save` writes v2.
// Prints one JSON line (exit 0), or {"error":"..."} (exit 1).
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultBrandName,
  listBrands,
  loadBrand,
  saveBrand,
  setDefaultBrand,
} from '../engine/brand.mjs';

const MAX_LOGO_BYTES = 10 * 1024 * 1024;

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const fail = (msg) => {
  out({ error: msg });
  process.exit(1);
};

const isUrl = (s) => /^https?:\/\//i.test(s);

// PNG or JPG by content, so a URL without a useful extension still works
function sniffExt(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  return null;
}

async function download(url, dir) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new Error(`cannot download the logo: ${err.cause?.code ?? err.message}`);
  }
  if (!res.ok) throw new Error(`cannot download the logo: HTTP ${res.status}`);
  const tooBig = () => new Error('logo is over the 10 MB limit');
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_LOGO_BYTES) throw tooBig();
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_LOGO_BYTES) {
      await res.body.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  const ext = sniffExt(buf);
  if (!ext) throw new Error('logo must be a PNG or JPG file (the download is neither)');
  const file = join(dir, `logo${ext}`);
  await writeFile(file, buf);
  return file;
}

async function readBrandFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.code ?? err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const positional = [];
  let logo;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--logo') {
      if (i + 1 >= rest.length) throw new Error('--logo needs a file or URL');
      logo = rest[++i];
    } else if (rest[i].startsWith('--')) {
      throw new Error(`unknown flag ${rest[i]}`);
    } else {
      positional.push(rest[i]);
    }
  }
  const usage = 'usage: brand.mjs list | show [name] | save <brand.json> [--logo <file-or-url>] | default <name>';
  const need = (min, max) => {
    if (positional.length < min || positional.length > max) throw new Error(usage);
  };

  switch (cmd) {
    case 'list':
      need(0, 0);
      return out({ brands: await listBrands(), default: await defaultBrandName() });
    case 'show':
      need(0, 1);
      return out({ brand: await loadBrand(positional[0]) });
    case 'default':
      need(1, 1);
      return out({ default: await setDefaultBrand(positional[0]) });
    case 'save': {
      need(1, 1);
      const raw = await readBrandFile(positional[0]);
      let tmp = null;
      try {
        let logoSrc = logo;
        if (logo !== undefined && isUrl(logo)) {
          tmp = await mkdtemp(join(tmpdir(), 'boqo-logo-'));
          logoSrc = await download(logo, tmp);
        }
        const dir = await saveBrand(raw, logoSrc);
        const brand = await loadBrand(String(raw.name).trim());
        return out({ saved: brand.name, dir, default: (await defaultBrandName()) === brand.name, brand });
      } finally {
        if (tmp) await rm(tmp, { recursive: true, force: true });
      }
    }
    default:
      throw new Error(usage);
  }
}

main(process.argv.slice(2)).catch((err) => fail(err.message));
