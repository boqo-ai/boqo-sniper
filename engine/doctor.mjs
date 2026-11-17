// Doctor: looks at what this machine has (Node, ffmpeg 5.1 or newer with libass/ebur128 and
// working HTTPS, its ffprobe, yt-dlp, whisper.cpp and a model, the skill's npm packages (zod, and onnxruntime-node
// running the face model), the bundled caption fonts, optionally streamlink) and
// says exactly how to install what is missing, per OS. It only looks; it never
// installs anything. Nothing it imports needs an npm package, so it runs, and says so, when they are not installed.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_URL, findModel } from './asr.mjs';
import { FaceModelError, loadBlazeFace } from './blazeface.mjs';
import { boqoHome, toolEnv } from './env.mjs';
import { SKILL, missingPackage, npmCi } from './packages.mjs';

/**
 * @typedef {{ name: 'node'|'ffmpeg'|'ffprobe'|'ffmpeg-filters'|'ffmpeg-https'|'yt-dlp'|'whisper'|'whisper-model'|'zod'|'onnxruntime'|'fonts'|'streamlink',
 *             ok: boolean, detail: string, required: boolean, cause?: 'not-installed'|'model'|'runtime'|'old' }} Check
 * (`cause` only on a failed zod or onnxruntime check, and `old` on an ffmpeg that runs and is older than MIN_FFMPEG.)
 */

export const MIN_YTDLP = '2026.10.26';
// The render's scene pass and the face sampler pass `-fps_mode passthrough` (engine/boqo/scenes.mjs,
// engine/boqo/detect-faces.mjs), an option of ffmpeg 5.1 on. Measured 2026-11-17 in docker with each image's apt
// ffmpeg: ubuntu:22.04's `4.4.2-0ubuntu0.22.04.1` exits 1 on `-fps_mode passthrough` (`Unrecognized option
// 'fps_mode'`), so every clip would fail, though it has libass and ebur128 and passes every other check;
// debian:bookworm's `5.1.9-0+deb12u1` and ubuntu:24.04's `6.1.1-3ubuntu5` run it and pass this check.
export const MIN_FFMPEG = '5.1';
export const PROBE_URL = 'https://raw.githubusercontent.com/boqo-ai/boqo-clips/main/engine/fixtures/probe.mp4';

const QUICK_MS = 15_000;
const HTTPS_MS = 20_000;
const NO_NETWORK = 'no network or blocked';
const NO_HTTPS_BUILD = 'ffmpeg has no HTTPS support';
const CRASH = 'ffmpeg crashed on HTTPS input';

// ---- running things

/** Run a command with `env`, never throw. `code` is null when it died on a signal. */
function run(env, cmd, args, timeoutMs = QUICK_MS) {
  return new Promise((resolve) => {
    let child;
    let out = '';
    let err = '';
    let timedOut = false;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, timedOut, code: null, signal: null, missing: false, ...r });
    };
    let timer;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    } catch (e) {
      finish({ missing: e.code === 'ENOENT', error: e.message });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out = (out + d).slice(-400_000);
    });
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    child.on('error', (e) => finish({ missing: e.code === 'ENOENT', error: e.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

/** Where `cmd` is on the PATH of `env`, or null. */
function locate(env, cmd) {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  for (const d of dirs) {
    for (const x of exts) {
      const p = join(d, cmd + x);
      try {
        if (!statSync(p).isFile()) continue;
        if (process.platform !== 'win32') accessSync(p, constants.X_OK);
        return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

// ---- versions

const dateParts = (v) => (/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.\d+)?$/.exec(String(v).trim()) ?? []).slice(1, 4).map(Number);

/** @param {string} v a yt-dlp version such as `2026.10.26` or `2026.10.26.232815` */
export function ytDlpAtLeast(v, min = MIN_YTDLP) {
  const a = dateParts(v);
  const b = dateParts(min);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * Whether ffmpeg's version (the banner's `ffmpeg version <v>`, a leading `n` already dropped) is MIN_FFMPEG or newer:
 * true or false for a release (`4.4.2-0ubuntu0.22.04.1`, `7.1-full_build-www.gyan.dev`, `8.0`), null for anything else
 * (a git build such as `N-117000-g…` or `2025-01-02-git-…`), which the caller asks about the option itself.
 */
export function ffmpegAtLeast(v, min = MIN_FFMPEG) {
  const m = /^(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  const [minMajor, minMinor] = min.split('.').map(Number);
  return major !== minMajor ? major > minMajor : minor >= minMinor;
}

const CRASH_CODES = new Set([139, -11, 134, 132, 138, 3221225477, 3221226356]);
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGABRT', 'SIGILL', 'SIGBUS']);

// ---- the checks

function checkNode(nodeMin) {
  const v = process.versions.node;
  const ok = Number(v.split('.')[0]) >= nodeMin;
  return { name: 'node', ok, detail: ok ? `node ${v}` : `node ${v}, need ${nodeMin}+`, required: true };
}

/** The ffmpeg check, and whether that ffmpeg runs at all (an old one does: its filters and HTTPS are still looked at). */
async function checkFfmpeg(env) {
  const path = locate(env, 'ffmpeg');
  if (!path) return { check: { name: 'ffmpeg', ok: false, detail: 'not found on PATH', required: true }, runs: false };
  const r = await run(env, 'ffmpeg', ['-hide_banner', '-version']);
  const m = /ffmpeg version (?:n(?=\d))?(\S+)/i.exec(r.stdout);
  if (r.code !== 0 || !m) {
    return { check: { name: 'ffmpeg', ok: false, detail: `ffmpeg at ${path} did not run (${r.signal ?? `exit ${r.code}`})`, required: true }, runs: false };
  }
  const ver = m[1].replace(/-static$/, '');
  let recent = ffmpegAtLeast(ver);
  if (recent === null) {
    // A git build names no release: its option list says whether it has -fps_mode.
    const h = await run(env, 'ffmpeg', ['-hide_banner', '-h', 'long']);
    recent = h.code === 0 && /^-fps_mode\b/m.test(h.stdout);
  }
  if (!recent) {
    return { check: { name: 'ffmpeg', ok: false, detail: `ffmpeg ${ver} at ${path} is older than ${MIN_FFMPEG}`, required: true, cause: 'old' }, runs: true };
  }
  return { check: { name: 'ffmpeg', ok: true, detail: `ffmpeg ${ver} at ${path}`, required: true }, runs: true };
}

async function checkFfprobe(env) {
  const path = locate(env, 'ffprobe');
  if (!path) return { name: 'ffprobe', ok: false, detail: 'not found on PATH', required: true };
  const r = await run(env, 'ffprobe', ['-hide_banner', '-version']);
  const m = /ffprobe version (?:n(?=\d))?(\S+)/i.exec(r.stdout);
  if (r.code !== 0 || !m) {
    return { name: 'ffprobe', ok: false, detail: `ffprobe at ${path} did not run (${r.signal ?? `exit ${r.code}`})`, required: true };
  }
  return { name: 'ffprobe', ok: true, detail: `ffprobe ${m[1].replace(/-static$/, '')} at ${path}`, required: true };
}

async function checkFilters(env, ffmpegOk) {
  if (!ffmpegOk) return { name: 'ffmpeg-filters', ok: false, detail: 'needs ffmpeg', required: true };
  const r = await run(env, 'ffmpeg', ['-hide_banner', '-filters']);
  const has = (f) => new RegExp(`^\\s*\\S+\\s+${f}\\s`, 'm').test(r.stdout);
  const missing = ['ass', 'ebur128'].filter((f) => !has(f));
  return {
    name: 'ffmpeg-filters',
    ok: r.code === 0 && missing.length === 0,
    detail: r.code !== 0 ? `ffmpeg -filters failed (${r.signal ?? `exit ${r.code}`})` : missing.length ? `missing filters: ${missing.join(', ')}` : 'ass (libass) and ebur128 present',
    required: true,
  };
}

async function checkHttps(env, ffmpegOk) {
  const name = 'ffmpeg-https';
  if (!ffmpegOk) return { name, ok: false, detail: 'needs ffmpeg', required: false };
  const r = await run(env, 'ffmpeg', ['-v', 'error', '-i', PROBE_URL, '-f', 'null', '-'], HTTPS_MS);
  if (r.code === 0) return { name, ok: true, detail: 'ffmpeg read an HTTPS file', required: false };
  if (r.timedOut) return { name, ok: false, detail: NO_NETWORK, required: false };
  if (CRASH_SIGNALS.has(r.signal) || CRASH_CODES.has(r.code)) {
    return { name, ok: false, detail: `${CRASH} (${r.signal ?? `exit ${r.code}`})`, required: false };
  }
  if (/protocol not found|recompile ffmpeg|tls|ssl/i.test(r.stderr) && !/resolve|connection|timed out|network|unreachable|refused/i.test(r.stderr)) {
    return { name, ok: false, detail: NO_HTTPS_BUILD, required: false };
  }
  return { name, ok: false, detail: NO_NETWORK, required: false };
}

async function checkYtDlp(env) {
  const path = locate(env, 'yt-dlp');
  if (!path) return { name: 'yt-dlp', ok: false, detail: 'not found on PATH', required: true };
  const r = await run(env, 'yt-dlp', ['--version']);
  const v = r.stdout.trim().split('\n')[0];
  if (r.code !== 0 || !v) return { name: 'yt-dlp', ok: false, detail: `yt-dlp at ${path} did not run (${r.signal ?? `exit ${r.code}`})`, required: true };
  if (!ytDlpAtLeast(v)) return { name: 'yt-dlp', ok: false, detail: `yt-dlp ${v} is older than ${MIN_YTDLP}`, required: true };
  return { name: 'yt-dlp', ok: true, detail: `yt-dlp ${v} at ${path}`, required: true };
}

async function checkWhisper(env, required) {
  const path = locate(env, 'whisper-cli');
  if (!path) return { name: 'whisper', ok: false, detail: 'whisper-cli not found on PATH', required };
  const r = await run(env, 'whisper-cli', ['-h']);
  if (r.missing || r.error) return { name: 'whisper', ok: false, detail: `whisper-cli at ${path} could not start`, required };
  return { name: 'whisper', ok: true, detail: `whisper-cli at ${path}`, required };
}

function checkModel(required) {
  const m = findModel();
  return m
    ? { name: 'whisper-model', ok: true, detail: `model ${m}`, required }
    : { name: 'whisper-model', ok: false, detail: 'no ggml model found', required };
}

/**
 * zod, the package every tool but this one loads (hosted's schemas, engine/boqo/), loads from the skill's folder.
 * `load` is injectable for tests. A failed check carries `cause`: 'not-installed' (engine/packages.mjs
 * `missingPackage`), else 'runtime'.
 */
async function checkZod(load = () => import('zod')) {
  const name = 'zod';
  try {
    const mod = await load();
    if (typeof mod?.z?.object !== 'function') throw new Error('it has no z.object');
    return { name, ok: true, detail: 'zod loads', required: true };
  } catch (e) {
    if (missingPackage(e) !== null) return { name, ok: false, detail: 'zod is not installed', required: true, cause: 'not-installed' };
    return { name, ok: false, detail: `zod did not load: ${String(e?.message ?? e).split('\n')[0]}`, required: true, cause: 'runtime' };
  }
}

/**
 * onnxruntime-node loads, the face model's checksum matches, and one blank image runs through it (engine/blazeface.mjs
 * `loadBlazeFace`). Without it the render still runs and frames every shot Fit; required all the same, because the
 * framing is the point of a vertical clip. `load` is injectable for tests.
 *
 * A failed check carries `cause`, from loadBlazeFace's own error code (never from onnxruntime's wording), for the
 * hint: 'not-installed' (ORT_NOT_INSTALLED), 'model' (MODEL_MISSING, MODEL_CHECKSUM), else 'runtime'.
 */
async function checkOnnx(load) {
  const name = 'onnxruntime';
  try {
    const detector = await loadBlazeFace(load ? { load } : {});
    await detector.release();
    return { name, ok: true, detail: 'onnxruntime-node runs the face model', required: true };
  } catch (e) {
    const code = e instanceof FaceModelError ? e.code : null;
    const cause = code === 'ORT_NOT_INSTALLED' ? 'not-installed' : code === 'MODEL_MISSING' || code === 'MODEL_CHECKSUM' ? 'model' : 'runtime';
    return { name, ok: false, detail: String(e?.message ?? e).split('\n')[0], required: true, cause };
  }
}

// The faces engine/fonts/ ships (engine/fonts/SOURCES.md), which libass finds by name in `fontsdir`: a missing or empty
// file makes captions fall back to another face without an error.
export const BUNDLED_FONTS = [
  'Anton-Regular.ttf',
  'ArchivoBlack-Regular.ttf',
  'Bangers-Regular.ttf',
  'BebasNeue-Regular.ttf',
  'DejaVuSans-Bold.ttf',
  'Inter-Bold.otf',
  'LuckiestGuy-Regular.ttf',
  'Montserrat-ExtraBold.ttf',
  'NotoSansDevanagari-Bold.ttf',
  'Oswald-Bold.ttf',
  'PermanentMarker-Regular.ttf',
  'Poppins-Black.ttf',
];
const FONTS_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));

function checkFonts(dir = FONTS_DIR) {
  const bad = BUNDLED_FONTS.filter((name) => {
    try {
      return statSync(join(dir, name)).size === 0;
    } catch {
      return true;
    }
  });
  if (bad.length === 0) return { name: 'fonts', ok: true, detail: `${BUNDLED_FONTS.length} bundled fonts`, required: true };
  return { name: 'fonts', ok: false, detail: `missing or empty: ${bad.join(', ')}`, required: true };
}

async function checkStreamlink(env) {
  const path = locate(env, 'streamlink');
  if (!path) return { name: 'streamlink', ok: false, detail: 'not found on PATH', required: false };
  const r = await run(env, 'streamlink', ['--version']);
  const v = r.stdout.trim().split('\n')[0];
  if (r.code !== 0) return { name: 'streamlink', ok: false, detail: `streamlink at ${path} did not run`, required: false };
  return { name: 'streamlink', ok: true, detail: `${v || 'streamlink'} at ${path}`, required: false };
}

/**
 * Look at the machine. Never installs anything. The tools are looked for and
 * run with `o.env` (default `toolEnv()`, which finds macOS ffmpeg-full).
 * `o.loadOnnx` and `o.loadZod` replace the packages' loaders and `o.fontsDir` the bundled fonts' folder (tests).
 * @param {{ nodeMin: 20|22, whisper: 'required'|'optional', streamlink?: boolean, env?: NodeJS.ProcessEnv, loadOnnx?: () => Promise<any>, loadZod?: () => Promise<any>, fontsDir?: string }} o
 * @returns {Promise<Check[]>}
 */
export async function runChecks(o) {
  const env = o.env ?? toolEnv();
  const wr = o.whisper === 'required';
  const [{ check: ffmpeg, runs }, ffprobe] = await Promise.all([checkFfmpeg(env), checkFfprobe(env)]);
  const [filters, https, ytdlp, whisper, zod, onnx, streamlink] = await Promise.all([
    checkFilters(env, runs),
    checkHttps(env, runs),
    checkYtDlp(env),
    checkWhisper(env, wr),
    checkZod(o.loadZod),
    checkOnnx(o.loadOnnx),
    o.streamlink ? checkStreamlink(env) : null,
  ]);
  return [checkNode(o.nodeMin), ffmpeg, ffprobe, filters, https, ytdlp, whisper, checkModel(wr), zod, onnx, checkFonts(o.fontsDir), ...(streamlink ? [streamlink] : [])];
}

/** True when every required check passed. */
export const isOk = (checks) => checks.every((c) => c.ok || !c.required);

// ---- hints

const BTBN = 'https://github.com/BtbN/FFmpeg-Builds/releases';
// The release binary carries yt-dlp-ejs; a bare `pip install` lacks it and hits PEP 668.
const YTDLP_BINARY =
  'mkdir -p ~/.local/bin && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod +x ~/.local/bin/yt-dlp';
const RESTART = 'After installing, restart the agent so it sees the new PATH.';

function modelDir() {
  return process.env.BOQO_HOME ? join(boqoHome(), 'models') : '~/.boqo/models/';
}

const FFMPEG = {
  darwin: '`brew install ffmpeg-full` (the engine finds it by itself; plain `brew install ffmpeg` has no libass)',
  win32: '`winget install Gyan.FFmpeg`',
  linux: `install a full ffmpeg, ${MIN_FFMPEG} or newer: your distro package (\`sudo apt install ffmpeg\`, \`sudo dnf install ffmpeg\`) or the BtbN build ${BTBN}`,
};

// An ffmpeg that runs and is too old. Ubuntu 22.04's apt ffmpeg is 4.4.2 (above), so the Linux hint there is a static
// build, copied where the person's shell finds it first.
const FFMPEG_OLD = {
  darwin: '`brew upgrade ffmpeg-full`, or `brew install ffmpeg-full` when it is not installed (the engine finds it by itself)',
  win32: '`winget upgrade Gyan.FFmpeg`',
  linux: `Ubuntu 24.04 and Debian 12 have one (\`sudo apt install ffmpeg\`); on Ubuntu 22.04, or another distro whose ffmpeg is older, the static BtbN build ${BTBN} (a \`linux64-gpl\` archive): copy its \`bin/ffmpeg\` and \`bin/ffprobe\` into \`~/.local/bin\`, then open a new shell`,
};

/**
 * One short line per failed check for this platform; on Windows, after an
 * install line, one line to restart the agent so it sees the new PATH.
 * @param {Check[]} failed
 * @param {'darwin'|'win32'|'linux'} platform
 * @returns {string[]}
 */
export function hintsFor(failed, platform) {
  const p = platform === 'darwin' || platform === 'win32' ? platform : 'linux';
  const bad = failed.filter((c) => !c.ok);
  const noFfmpeg = bad.some((c) => c.name === 'ffmpeg');
  const lines = [];
  let installs = false;

  for (const c of bad) {
    switch (c.name) {
      case 'node': {
        installs = true;
        const need = /need (\d+)/.exec(c.detail)?.[1] ?? '20';
        lines.push(
          `node: Node ${need}+ is needed: ${p === 'darwin' ? '`brew install node`' : p === 'win32' ? '`winget install OpenJS.NodeJS.LTS`' : 'nvm or your distro'}, or https://nodejs.org`,
        );
        break;
      }
      case 'ffmpeg':
        lines.push(c.cause === 'old' ? `ffmpeg: ${c.detail}, which the renders need (\`-fps_mode\`): ${FFMPEG_OLD[p]}` : `ffmpeg: ${FFMPEG[p]}`);
        installs = true;
        break;
      case 'ffprobe':
        if (noFfmpeg) break;
        lines.push(`ffprobe: ${FFMPEG[p]}`);
        installs = true;
        break;
      case 'ffmpeg-filters':
        if (noFfmpeg) break;
        lines.push(`ffmpeg-filters: this ffmpeg lacks libass or ebur128 (${c.detail}); ${FFMPEG[p]}`);
        installs = true;
        break;
      case 'ffmpeg-https':
        if (noFfmpeg) break;
        if (c.detail.includes(NO_NETWORK)) {
          lines.push(
            'ffmpeg-https: could not reach the internet from ffmpeg (no network or blocked); a ranged download will fall back to a whole download',
          );
        } else {
          const what = c.detail.includes(NO_HTTPS_BUILD) ? 'was built without HTTPS support' : 'crashes on HTTPS input (exit 139 / -11, typical of static builds)';
          lines.push(`ffmpeg-https: this ffmpeg ${what}; ${FFMPEG[p]}`);
          installs = true;
        }
        break;
      case 'yt-dlp': {
        installs = true;
        const old = /older than/.test(c.detail);
        if (p === 'darwin') lines.push(`yt-dlp: ${old ? '`brew upgrade yt-dlp`' : '`brew install yt-dlp`'} (needs ${MIN_YTDLP}+)`);
        else if (p === 'win32') lines.push(`yt-dlp: ${old ? '`winget upgrade yt-dlp.yt-dlp`' : '`winget install yt-dlp.yt-dlp`'} (needs ${MIN_YTDLP}+)`);
        else
          lines.push(
            `yt-dlp: ${old ? '`yt-dlp -U`, or ' : ''}the release binary, \`${YTDLP_BINARY}\`, or \`pipx install "yt-dlp[default]"\` (needs ${MIN_YTDLP}+; distro packages are often older)`,
          );
        break;
      }
      case 'whisper':
        installs = true;
        if (p === 'darwin') lines.push('whisper: `brew install whisper-cpp`');
        else if (p === 'win32')
          lines.push('whisper: unzip a release from https://github.com/ggml-org/whisper.cpp/releases and put whisper-cli.exe on PATH');
        else lines.push('whisper: build whisper.cpp (https://github.com/ggml-org/whisper.cpp) or use your distro package, so `whisper-cli` is on PATH');
        break;
      case 'whisper-model':
        lines.push(`whisper-model: download ${MODEL_URL} into ${modelDir()}`);
        break;
      case 'zod': {
        // One npm command installs both packages: with onnxruntime-node missing too, its line says it.
        if (c.cause === 'not-installed' && bad.some((x) => x.name === 'onnxruntime' && x.cause === 'not-installed')) break;
        const npm = `\`${npmCi(p)}\``;
        if (c.cause === 'not-installed') lines.push(`zod: the skill's packages are not installed: ${npm}`);
        else lines.push(`zod: ${c.detail}; reinstall the skill's packages: ${npm}`);
        break;
      }
      case 'onnxruntime': {
        const npm = `\`${npmCi(p)}\``;
        if (c.cause === 'not-installed') lines.push(`onnxruntime: the skill's packages are not installed: ${npm}`);
        else if (c.cause === 'model') {
          lines.push(`onnxruntime: ${c.detail}; reinstall the skill (https://github.com/boqo-ai/${SKILL}), its copy of the model is damaged`);
        } else if (p === 'win32') {
          lines.push(
            `onnxruntime: ${c.detail}; install the Microsoft Visual C++ 2019 or newer redistributable, https://aka.ms/vs/17/release/vc_redist.x64.exe (Arm: vc_redist.arm64.exe)`,
          );
        } else lines.push(`onnxruntime: ${c.detail}; reinstall the skill's packages: ${npm} (x64 or arm64 only)`);
        break;
      }
      case 'fonts':
        // `git checkout --` puts back what a clone had; `-C` and the quoted $HOME path run in PowerShell 5.1 as in a POSIX shell.
        lines.push(`fonts: ${c.detail}; restore them with \`git -C "$HOME/.${SKILL}" checkout -- engine/fonts\``);
        break;
      case 'streamlink':
        installs = true;
        if (p === 'darwin') lines.push('streamlink: `brew install streamlink`');
        else if (p === 'win32') lines.push('streamlink: `winget install Streamlink.Streamlink`');
        else lines.push('streamlink: `pipx install streamlink` or your distro package');
        break;
    }
  }
  if (installs && p === 'win32') lines.push(RESTART);
  return lines;
}
