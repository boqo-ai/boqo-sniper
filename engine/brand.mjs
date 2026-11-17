// The brand kit: boqo's brand-template shape (captions, headline, logo, ratio), saved once under
// $BOQO_HOME/brands/<name>/ and shared by every boqo skill.
//   brand.json         the kit, "version": 2 (logo.file is the bare file name)
//   logo.png|logo.jpg  at most one logo
//   ../default.txt     the name of the default kit
// A v1 kit (preset, colors, font, hook) is converted in memory on load (`migrateV1`) and is written back as v2 only
// when the person next saves it with brand.mjs.
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { BrandCaptions } from './boqo/caption-overrides.mjs';
import { GALLERY_CAPTION_STYLES, GALLERY_CAPTION_STYLE_KEYS } from './boqo/caption-styles.mjs';
import { BrandHeadline, DEFAULT_HEADLINE } from './boqo/headline.mjs';
import { HEADLINE_STYLE_KEYS } from './boqo/headline-styles.mjs';
import { DEFAULT_TEMPLATE_CAPTIONS } from './captions.mjs';
import { DEFAULT_TEMPLATE_HEADLINE, DEFAULT_TEMPLATE_LOGO, logoProblems } from './headline.mjs';
import { boqoHome } from './env.mjs';

export const BRAND_VERSION = 2;
export const RATIOS = ['9:16'];
// the v1 vocabulary, read by `migrateV1`
export const FONTS = ['Inter', 'Anton'];
export const PRESETS = ['karaoke', 'punch', 'clean', 'highlight'];
export const CORNERS = ['tl', 'tr', 'bl', 'br'];
const NAME_RE = /^[A-Za-z0-9 _-]{1,40}$/;
const V2_KEYS = ['version', 'name', 'ratio', 'captions', 'headline', 'logo'];
const LOGO_KEYS = ['file', 'anchor', 'width', 'marginX', 'marginY', 'opacity', 'timing'];
const V1_SECTION_KEYS = {
  colors: ['text', 'accent'],
  captions: ['preset', 'position', 'size'],
  logo: ['file', 'corner', 'scale'],
};
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const LOGO_NAMES = ['logo.png', 'logo.jpg'];

// engine/env.mjs holds it, so the tools that need no npm package (the doctor, whisper) do not load this file's zod.
export { boqoHome };
export const brandsDir = () => join(boqoHome(), 'brands');
const kitDir = (name) => join(brandsDir(), name);
const defaultFile = () => join(brandsDir(), 'default.txt');

const copy = (x) => structuredClone(x);
const defaultLogo = () => {
  const { key, ...values } = DEFAULT_TEMPLATE_LOGO;
  return { file: null, ...copy(values) };
};

/**
 * boqo's Default brand template (spec §6) with the person's logo, or none: punch captions in #E900FA at 0.7, the lime
 * title plate for 12 s, the logo bottom-left at a tenth of the frame's width and 35% opacity, 9:16.
 */
export function defaultBrand(name) {
  return {
    version: BRAND_VERSION,
    name,
    ratio: '9:16',
    captions: copy(DEFAULT_TEMPLATE_CAPTIONS),
    headline: copy(DEFAULT_TEMPLATE_HEADLINE),
    logo: defaultLogo(),
  };
}

/** The v1 kit's own default (before 2026-11-16): lime Inter karaoke captions and a top-right logo. Migration input. */
export function defaultBrandV1(name) {
  return {
    name,
    colors: { text: '#FFFFFF', accent: '#C8FF4D' },
    font: 'Inter',
    captions: { preset: 'karaoke', position: 0.72, size: 1.0 },
    logo: { file: null, corner: 'tr', scale: 0.16 },
    hook: true,
  };
}

// the closest known key, for "did you mean"
function nearest(key, known) {
  const dist = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  };
  const k = key.toLowerCase();
  let best = null;
  for (const c of known) {
    const d = dist(k, c.toLowerCase());
    if (d <= 2 && (best === null || d < best.d)) best = { c, d };
  }
  return best?.c ?? null;
}

function unknownKeys(obj, known, where, errors) {
  for (const key of Object.keys(obj)) {
    if (known.includes(key)) continue;
    const hint = nearest(key, known);
    errors.push(
      `unknown key "${key}"${where ? ` in ${where}` : ''}` +
        (hint ? ` - did you mean "${hint}"?` : ` - allowed: ${known.join(', ')}`),
    );
  }
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const inRange = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

// A v1 kit: missing sections and fields fall back to defaultBrandV1; wrong values are errors. Every error is collected.
function validateBrandV1(b) {
  if (!isObj(b)) return { ok: false, errors: ['brand must be an object'] };
  const errors = [];
  unknownKeys(b, ['name', 'colors', 'font', 'captions', 'logo', 'hook'], '', errors);
  const name = typeof b.name === 'string' ? b.name.trim() : b.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    errors.push('name must be 1-40 characters: letters, digits, space, _ or -');
  }
  const d = defaultBrandV1(typeof name === 'string' ? name : '');
  const section = (key) => {
    if (b[key] === undefined) return {};
    if (!isObj(b[key])) {
      errors.push(`${key} must be an object`);
      return {};
    }
    unknownKeys(b[key], V1_SECTION_KEYS[key], key, errors);
    return b[key];
  };
  const colors = { ...d.colors, ...section('colors') };
  for (const k of ['text', 'accent']) {
    if (typeof colors[k] !== 'string' || !HEX_RE.test(colors[k])) errors.push(`colors.${k} must be a hex colour like #C8FF4D`);
    else colors[k] = colors[k].toUpperCase();
  }
  const font = b.font === undefined ? d.font : b.font;
  if (!FONTS.includes(font)) errors.push(`font must be one of ${FONTS.join(', ')}`);
  const captions = { ...d.captions, ...section('captions') };
  if (!PRESETS.includes(captions.preset)) errors.push(`captions.preset must be one of ${PRESETS.join(', ')}`);
  if (!inRange(captions.position, 0.1, 0.9)) errors.push('captions.position must be a number from 0.1 to 0.9');
  if (!inRange(captions.size, 0.7, 1.4)) errors.push('captions.size must be a number from 0.7 to 1.4');
  const logo = { ...d.logo, ...section('logo') };
  if (logo.file !== null && (typeof logo.file !== 'string' || logo.file === '')) errors.push('logo.file must be a file name or null');
  if (!CORNERS.includes(logo.corner)) errors.push(`logo.corner must be one of ${CORNERS.join(', ')}`);
  if (!inRange(logo.scale, 0.08, 0.3)) errors.push('logo.scale must be a number from 0.08 to 0.3');
  const hook = b.hook === undefined ? d.hook : b.hook;
  if (typeof hook !== 'boolean') errors.push('hook must be true or false');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    brand: {
      name,
      colors: { text: colors.text, accent: colors.accent },
      font,
      captions: { preset: captions.preset, position: captions.position, size: captions.size },
      logo: { file: logo.file, corner: logo.corner, scale: logo.scale },
      hook,
    },
  };
}


const ANTON_STYLE = GALLERY_CAPTION_STYLES.find((s) => s.fontName === 'Anton' || s.keyFont === 'Anton')?.key;
const CORNER_ANCHOR = { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' };

function v1ToV2(v) {
  const captions = {
    style: v.font === 'Anton' && ANTON_STYLE ? ANTON_STYLE : v.captions.preset,
    accentColours: [v.colors.accent],
    positionFraction: v.captions.position,
  };
  if (v.colors.text !== '#FFFFFF') captions.baseColour = v.colors.text;
  if (v.captions.size !== 1) captions.sizeScale = v.captions.size;
  return {
    version: BRAND_VERSION,
    name: v.name,
    ratio: '9:16',
    captions,
    headline: v.hook ? { ...copy(DEFAULT_HEADLINE), source: 'title' } : null,
    logo: {
      file: v.logo.file,
      anchor: CORNER_ANCHOR[v.logo.corner],
      width: v.logo.scale,
      // v1 drew the logo 48 px in from the edges of the 1080x1920 frame
      marginX: Math.round((48 / 1080) * 1e4) / 1e4,
      marginY: Math.round((48 / 1920) * 1e4) / 1e4,
      opacity: 1,
      timing: { kind: 'whole' },
    },
  };
}

/**
 * A v1 kit as a v2 kit: `captions.preset` -> `captions.style` (a v1 `font: Anton` -> the hosted style that uses Anton),
 * `colors.accent` -> `captions.accentColours[0]`, `captions.position` -> `positionFraction`, `colors.text` ->
 * `baseColour` and `captions.size` -> `sizeScale` when they are not the preset's own, `logo.corner` -> `anchor`,
 * `logo.scale` -> `width` (the margins v1 drew with, full opacity, the whole clip), `hook: true` -> the Default
 * headline block with source `title` (3 s, as v1 held its hook), `hook: false` -> no headline. Throws on an invalid v1 kit.
 */
export function migrateV1(v1) {
  const r = validateBrandV1(v1);
  if (!r.ok) throw new Error(`invalid v1 brand: ${r.errors.join('; ')}`);
  return v1ToV2(r.brand);
}

// What a v1 kit's conversion changed that the person would see: an Anton kit now draws as a hosted style, a hook is a
// 3 s title plate.
function migrationNotes(v1) {
  const notes = [];
  if (v1.font === 'Anton' && ANTON_STYLE) notes.push(`font Anton → ${ANTON_STYLE}`);
  if (v1.hook !== false) notes.push('hook → 3 s title plate'); // v1's hook defaults to on
  return notes;
}

// A kit file with no "version" is v1 when it has any v1-only key.
function isV1(b) {
  if (b.version === 1) return true;
  if (b.version !== undefined) return false;
  const has = (o, keys) => isObj(o) && keys.some((k) => k in o);
  return 'colors' in b || 'font' in b || 'hook' in b || has(b.captions, ['preset', 'position', 'size']) || has(b.logo, ['corner', 'scale']);
}

const HEADLINE_REQUIRED = [
  'source', 'font', 'capHeightFraction', 'plateColour', 'plateOpacity', 'cornerRadiusFraction', 'boxWidthFraction', 'positionFraction', 'timing',
];
const issuesOf = (where, error) => error.issues.map((i) => `${where}${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`);
const dropUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function validateCaptions(value, errors) {
  if (value === undefined) return copy(DEFAULT_TEMPLATE_CAPTIONS);
  if (!isObj(value)) {
    errors.push('captions must be an object');
    return null;
  }
  const before = errors.length;
  unknownKeys(value, Object.keys(BrandCaptions.shape), 'captions', errors);
  // the schema reads an unknown style as absent (boqo's own leniency); a kit that names one is wrong
  if (value.style !== undefined && !GALLERY_CAPTION_STYLE_KEYS.includes(value.style)) {
    errors.push(`captions.style must be one of ${GALLERY_CAPTION_STYLE_KEYS.join(', ')}`);
  }
  const parsed = BrandCaptions.safeParse(value);
  if (!parsed.success) errors.push(...issuesOf('captions', parsed.error));
  if (errors.length > before) return null;
  return dropUndefined(parsed.data);
}

function validateHeadline(value, errors) {
  if (value === undefined) return copy(DEFAULT_TEMPLATE_HEADLINE);
  if (value === null) return null;
  if (!isObj(value)) {
    errors.push('headline must be an object or null');
    return null;
  }
  const before = errors.length;
  unknownKeys(value, Object.keys(BrandHeadline.shape), 'headline', errors);
  if (value.style !== undefined && !HEADLINE_STYLE_KEYS.includes(value.style)) {
    errors.push(`headline.style must be one of ${HEADLINE_STYLE_KEYS.join(', ')}`);
  }
  // the required fields the kit leaves out come from the Default template's headline; the optional ones (style,
  // textCase, entrance, ...) are only ever the kit's own, so a saved block reads back as it was written
  const required = Object.fromEntries(HEADLINE_REQUIRED.map((k) => [k, copy(DEFAULT_TEMPLATE_HEADLINE[k])]));
  const parsed = BrandHeadline.safeParse({ ...required, ...value });
  if (!parsed.success) errors.push(...issuesOf('headline', parsed.error));
  if (errors.length > before) return null;
  return dropUndefined(parsed.data);
}

function validateLogo(value, errors) {
  if (value === null) return null;
  if (value !== undefined && !isObj(value)) {
    errors.push('logo must be an object or null');
    return null;
  }
  const given = value ?? {};
  const before = errors.length;
  unknownKeys(given, LOGO_KEYS, 'logo', errors);
  const logo = { ...defaultLogo(), ...given };
  if (logo.file !== null && (typeof logo.file !== 'string' || logo.file === '')) errors.push('logo.file must be a file name or null');
  for (const problem of logoProblems(logo)) errors.push(`logo.${problem}`);
  if (errors.length > before) return null;
  return {
    file: logo.file,
    anchor: logo.anchor,
    width: logo.width,
    marginX: logo.marginX,
    marginY: logo.marginY,
    opacity: logo.opacity,
    timing: logo.timing.kind === 'whole' ? { kind: 'whole' } : { kind: 'window', startSec: logo.timing.startSec, holdSec: logo.timing.holdSec },
  };
}

function validateBrandV2(b) {
  const errors = [];
  unknownKeys(b, V2_KEYS, '', errors);
  const name = typeof b.name === 'string' ? b.name.trim() : b.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    errors.push('name must be 1-40 characters: letters, digits, space, _ or -');
  }
  if (b.version !== undefined && b.version !== BRAND_VERSION) errors.push(`version must be ${BRAND_VERSION}`);
  const ratio = b.ratio === undefined ? '9:16' : b.ratio;
  if (!RATIOS.includes(ratio)) errors.push(`ratio must be ${RATIOS.join(' or ')}`);
  const captions = validateCaptions(b.captions, errors);
  const headline = validateHeadline(b.headline, errors);
  const logo = validateLogo(b.logo, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, brand: { version: BRAND_VERSION, name, ratio, captions, headline, logo } };
}

/**
 * A kit as the v2 brand, or every error. A v1 kit (`"version": 1`, or none with v1 keys) is converted on the way in, so
 * its wrong values are named in v1's words. A v2 kit's missing `captions`, `headline` and `logo` are the Default
 * template's, a partly given `logo` takes its other fields from it, a `headline` its required ones, and `headline: null` / `logo: null`
 * mean none.
 */
export function validateBrand(b) {
  if (!isObj(b)) return { ok: false, errors: ['brand must be an object'] };
  if (isV1(b)) {
    const { version, ...v1 } = b;
    const r = validateBrandV1(v1);
    return r.ok ? { ok: true, brand: v1ToV2(r.brand) } : r;
  }
  return validateBrandV2(b);
}

function checkName(name) {
  const n = typeof name === 'string' ? name.trim() : name;
  if (typeof n !== 'string' || !NAME_RE.test(n)) {
    throw new Error('brand name must be 1-40 characters: letters, digits, space, _ or -');
  }
  return n;
}

const exists = (p) => stat(p).then((s) => s.isFile(), () => false);

function logoFileName(src) {
  const ext = extname(src).toLowerCase();
  if (ext === '.png') return 'logo.png';
  if (ext === '.jpg' || ext === '.jpeg') return 'logo.jpg';
  throw new Error(`logo must be a PNG or JPG file (got ${extname(src) || 'no extension'})`);
}

// Saves the kit and, when logoSrc (a local path) is given, copies the logo in as
// logo.png / logo.jpg. Returns the kit folder. The first kit saved becomes the default.
export async function saveBrand(b, logoSrc) {
  // the marker a load of a converted v1 kit adds is not part of the kit: saving drops it
  const { migratedFrom, notes, ...kit } = isObj(b) ? b : {};
  const v = validateBrand(isObj(b) ? kit : b);
  if (!v.ok) throw new Error(`invalid brand: ${v.errors.join('; ')}`);
  const brand = v.brand;
  const dir = kitDir(brand.name);

  // work out the logo before touching the disk, so a failed save changes nothing
  let copyFrom = null;
  let fileName = null;
  if (logoSrc) {
    if (brand.logo === null) brand.logo = defaultLogo(); // a logo given with the kit's logo off turns it on, at the Default's values
    fileName = logoFileName(logoSrc);
    if (!(await exists(logoSrc))) throw new Error(`logo file not found: ${logoSrc}`);
    copyFrom = logoSrc;
  } else if (brand.logo?.file != null) {
    const given = brand.logo.file;
    if (isAbsolute(given)) {
      fileName = logoFileName(given);
      if (!(await exists(given))) throw new Error(`logo file not found: ${given}`);
      if (given !== join(dir, fileName)) copyFrom = given; // already the kit's own file: keep it
    } else {
      if (!LOGO_NAMES.includes(given) || !(await exists(join(dir, given)))) {
        throw new Error(`logo file not found in the kit: ${given}; pass the image as the logo source`);
      }
      fileName = given;
    }
  }

  await mkdir(dir, { recursive: true });
  if (copyFrom) await copyFile(copyFrom, join(dir, fileName));
  if (brand.logo) brand.logo.file = fileName;
  // brand.json goes in atomically; only then is an old logo of the other type removed
  const tmp = join(dir, `brand.json.${process.pid}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(brand, null, 2) + '\n');
    await rename(tmp, join(dir, 'brand.json'));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  for (const other of LOGO_NAMES) if (other !== fileName) await rm(join(dir, other), { force: true });
  if (!(await exists(defaultFile()))) await writeFile(defaultFile(), brand.name + '\n');
  return dir;
}

export async function defaultBrandName() {
  try {
    return (await readFile(defaultFile(), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

export async function setDefaultBrand(name) {
  const n = checkName(name);
  if (!(await exists(join(kitDir(n), 'brand.json')))) throw new Error(`no brand kit named "${n}"`);
  await mkdir(brandsDir(), { recursive: true });
  await writeFile(defaultFile(), n + '\n');
  return n;
}

// The kit by name, or the default kit, always as a v2 brand (a v1 file is converted in memory and left as it is on
// disk; the next saveBrand writes it as v2). logo.file comes back as an absolute path. A logo file that is missing
// throws, unless `missingLogo` is 'keep': the render passes that, keeps the path, and draws the clip without the logo
// and with a note (a missing logo never fails a render).
export async function loadBrand(name, { missingLogo = 'throw' } = {}) {
  let n;
  if (name === undefined) {
    n = await defaultBrandName();
    if (!n) throw new Error('no brand kit saved yet');
  } else {
    n = checkName(name);
  }
  let text;
  try {
    text = await readFile(join(kitDir(n), 'brand.json'), 'utf8');
  } catch {
    throw new Error(`no brand kit named "${n}"`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`brand kit "${n}" is damaged: brand.json is not valid JSON`);
  }
  if (!isObj(raw)) throw new Error(`brand kit "${n}" is damaged: brand.json is not an object`);
  if (typeof raw.version === 'number' && raw.version > BRAND_VERSION) {
    throw new Error(`brand kit "${n}" was made by a newer boqo skill (version ${raw.version}): update this skill to use it`);
  }
  const v = validateBrand({ ...raw, name: n });
  if (!v.ok) throw new Error(`brand kit "${n}" is damaged: ${v.errors.join('; ')}`);
  const brand = v.brand;
  if (isV1(raw)) {
    // a converted v1 kit says so; nothing is written, and saveBrand drops the marker
    brand.migratedFrom = 1;
    brand.notes = migrationNotes(raw);
  }
  if (brand.logo?.file != null) {
    const abs = join(kitDir(n), basename(brand.logo.file));
    if (missingLogo !== 'keep' && !(await exists(abs))) {
      throw new Error(`brand "${n}": logo file ${basename(brand.logo.file)} is missing - save the kit again with --logo`);
    }
    brand.logo.file = abs;
  }
  return brand;
}

export async function listBrands() {
  let entries;
  try {
    entries = await readdir(brandsDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const e of entries) {
    if (e.isDirectory() && (await exists(join(brandsDir(), e.name, 'brand.json')))) names.push(e.name);
  }
  return names.sort();
}
