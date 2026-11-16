// Local speech to words: ffmpeg cuts a 16 kHz mono wav, whisper.cpp
// (`whisper-cli`) writes word-level JSON, and `wordsFromWhisper` turns it into
// the same Word[] the captions give. Nothing leaves the machine.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { boqoHome } from './brand.mjs';
import { toolEnv } from './env.mjs';
import { wordsFromWhisper } from './words.mjs';

/** @typedef {import('./words.mjs').Word} Word */

export const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';

// smaller number = preferred; `.en` models sort after multilingual ones
function rank(name) {
  const base = name.replace(/^ggml-/, '');
  const size = base.startsWith('small') ? 0 : base.startsWith('base') ? 1 : 2;
  return size * 2 + (base.endsWith('.en.bin') ? 1 : 0);
}

function pickIn(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const models = names.filter((n) => /^ggml-.*\.bin$/.test(n)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return models.length ? join(dir, models[0]) : null;
}

/**
 * The whisper model to use: `BOQO_WHISPER_MODEL`, then `ggml-*.bin` in
 * `$BOQO_HOME/models`, then in `~/.cache/whisper`. Within a folder `small` wins,
 * then `base`, then any other.
 * @param {string} [home] the home folder (tests pass their own)
 * @returns {string|null}
 */
export function findModel(home = homedir()) {
  const pinned = process.env.BOQO_WHISPER_MODEL;
  if (pinned && existsSync(pinned)) return pinned;
  return pickIn(join(boqoHome(), 'models')) ?? pickIn(join(home, '.cache', 'whisper'));
}

/**
 * The `whisper-cli` arguments (no thread count). English-only models
 * (`*.en.bin`) always run with `-l en`.
 * @param {string} wav 16 kHz mono wav
 * @param {string} model
 * @param {string} base output path without `.json`
 * @param {string} [lang]
 * @returns {string[]}
 */
export function whisperArgs(wav, model, base, lang = 'auto') {
  const l = isEnglishOnly(model) ? 'en' : lang;
  return ['-m', model, '-f', wav, '-ml', '1', '-sow', '-oj', '-of', base, '-np', '-l', l];
}

const isEnglishOnly = (model) => /\.en\.bin$/i.test(String(model));

/**
 * The language a transcription ran in. An English-only model (`*.en.bin`)
 * is always English, whatever the audio: `englishOnly` says so. A
 * multilingual one reports what whisper heard (`result.language` in its
 * JSON), else the language asked for.
 * @param {string} model
 * @param {string} [asked] the `--lang` given, default auto
 * @param {object|null} [json] whisper's `-oj` output
 * @returns {{ lang: string, englishOnly: boolean }}
 */
export function whisperLang(model, asked = 'auto', json = null) {
  if (isEnglishOnly(model)) return { lang: 'en', englishOnly: true };
  const heard = json?.result?.language;
  return { lang: typeof heard === 'string' && heard ? heard : asked, englishOnly: false };
}

const INSTALL_WHISPER =
  'whisper-cli was not found on PATH. Install whisper.cpp: macOS `brew install whisper-cpp`; ' +
  'Windows: unzip a release from https://github.com/ggml-org/whisper.cpp/releases and put whisper-cli.exe on PATH; ' +
  'Linux: build whisper.cpp or use your distro package.';

function noModel() {
  return new Error(
    `no whisper model found. Download one into ${join(boqoHome(), 'models')}: ${MODEL_URL}`,
  );
}

function run(cmd, args, missing) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: toolEnv() });
    } catch (err) {
      reject(new Error(`${cmd} could not start: ${err.message}`));
      return;
    }
    let tail = '';
    child.stderr.on('data', (d) => {
      tail = (tail + d).slice(-2000);
    });
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error(missing) : new Error(`${cmd} could not start: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} failed (exit ${code}): ${tail.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
}

// whisper-cli exists and starts; checked before any audio work
function probeWhisper() {
  return new Promise((resolve, reject) => {
    const child = spawn('whisper-cli', ['-h'], { stdio: 'ignore', windowsHide: true, env: toolEnv() });
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error(INSTALL_WHISPER) : new Error(`whisper-cli could not start: ${err.message}`)));
    child.on('close', () => resolve());
  });
}

/**
 * Speech in `file` as words, on the source timeline. With `s`/`e` only that
 * range is decoded and the words are offset by `s`.
 * @param {string} file audio or video
 * @param {{ s?: number, e?: number, lang?: string }} [o] range in seconds; `lang` a whisper code, default auto
 * @returns {Promise<Word[]>}
 */
export async function transcribe(file, o = {}) {
  return (await transcribeDetailed(file, o)).words;
}

/**
 * `transcribe`, plus the model file used and the language it ran in
 * (`whisperLang`).
 * @param {string} file
 * @param {{ s?: number, e?: number, lang?: string }} [o]
 * @returns {Promise<{ words: Word[], model: string, lang: string, englishOnly: boolean }>}
 */
export async function transcribeDetailed(file, o = {}) {
  const { s, e, lang = 'auto' } = o;
  const hasS = s !== undefined && s !== null;
  const hasE = e !== undefined && e !== null;
  if ((hasS && (!Number.isFinite(s) || s < 0)) || (hasE && !Number.isFinite(e)) || (hasE && e <= (hasS ? s : 0))) {
    throw new Error('range must be numeric seconds with 0 <= s < e');
  }
  const start = hasS ? s : 0;

  const model = findModel();
  if (!model) throw noModel();
  await probeWhisper();

  const dir = await mkdtemp(join(tmpdir(), 'boqo-asr-'));
  try {
    const wav = join(dir, 'audio.wav');
    const ff = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (start > 0) ff.push('-ss', String(start));
    ff.push('-i', file);
    if (hasE) ff.push('-t', String(e - start));
    ff.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav);
    await run('ffmpeg', ff, 'ffmpeg was not found on PATH - install ffmpeg first');

    const base = join(dir, 'out');
    const threads = Math.min(8, availableParallelism());
    await run('whisper-cli', [...whisperArgs(wav, model, base, lang), '-t', String(threads)], INSTALL_WHISPER);
    const json = JSON.parse(await readFile(`${base}.json`, 'utf8'));
    return { words: wordsFromWhisper(json, start), model, ...whisperLang(model, lang, json) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
