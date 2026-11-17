// The render (spec §7.5): one clip of a run, from the source file to `<run>/out/clip-<nn>.mp4` and its thumbnail
// `clip-<nn>.jpg`, the way boqo's worker renders it (render/pipeline.ts `renderClip` at the pin), with the hosted
// defaults. The skill's own orchestrator over the stages already ported, in hosted's order:
//   1. window     engine/window.mjs `prepareWindow`: settle the end, extract, tighten the pauses (A7);
//   2. scenes     engine/shots.mjs `detectShots` on the window (A8);
//   3. faces      engine/faces.mjs `detectShotFaces` (A9); unavailable faces (onnxruntime-node or the model not
//                 loading, the disk refusing frames) never fail the render: every shot is Fit, with one note;
//   4. framing    engine/boqo/plan-shots.mjs `planShots` with the `speaker` rule (Sniper passes `presence`), and the
//                 clip's stream panels read from clips.json when one is stored and usable (A10, A11);
//   5. captions   engine/captions.mjs `captionsTrack` in the brand's style, moved below the cameras on a panels clip
//                 (`panelsCaptionStyle`), on the window's cut timeline (A12);
//   6. headline   engine/headline.mjs `headlineElement`, placed per run of shots (`panelsTextElements`) and written
//                 by `buildTextAss`; the logo by `logoStage` (A13);
//   7. encode     engine/boqo/compose.mjs `buildFilterGraph` and `composeArgs`: libx264 fast CRF 18 yuv420p at most
//                 60 fps, AAC, +faststart, 1080x1920; hard cuts (R3); the blur behind a Fit shot at sigma 40;
//   8. loudness   engine/boqo/loudness.mjs `applyLoudness`: two-pass linear loudnorm to I -14, TP -1, LRA 7, AAC 192k
//                 at 48 kHz, video copied; a pass that fails leaves the composed audio, with one note;
//   9. thumbnail  engine/boqo/thumbnail.mjs `thumbnailArgs` at `min(1, dur / 2)` s.
// Hosted's filmstrip, waveform peaks and sidecar (the clip editor's) have no counterpart in the skill.
//
// Every optional stage degrades to a note, never a failed render: faces (above), the panels read (used only when
// its status is `ok` and its content is not `other`), the logo (a missing, unreadable or not-PNG/JPEG file, a
// windowed logo the clip is too short for, a file ffmpeg cannot draw: the clip renders without it), loudness.
//
// `exec(command, args, { timeoutMs }) -> Promise<{ stdout, stderr }>` is injected, rejecting when the command fails;
// the default runs the real ffmpeg and ffprobe with stdin closed (a reused output path can never wait on ffmpeg's
// overwrite prompt) and no output-size ceiling (the scene pass prints about 75 bytes a frame).
import { spawn } from 'node:child_process';
import { copyFile, mkdir, open, rename, rmdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_OUTPUT, brandCaptionPreset, captionsTrack, textPassFilter } from './captions.mjs';
import { toolEnv } from './env.mjs';
import { detectShotFaces } from './faces.mjs';
import { headlineElement, logoStage } from './headline.mjs';
import { routeScriptFaces } from './script-faces.mjs';
import { detectShots } from './shots.mjs';
import { ENCODE_THREADS, FILTER_THREADS, STEP_TIMEOUT_MS, prepareWindow } from './window.mjs';
import { cutSecFromShots } from './boqo/caption-cuts.mjs';
import { FALLBACK_BLUR_SIGMA, buildFilterGraph, composeArgs } from './boqo/compose.mjs';
import { cutsDurationSec } from './boqo/cut-map.mjs';
import { buildTextAss } from './boqo/headline-ass.mjs';
import { CLIP_LOUDNESS, applyLoudness } from './boqo/loudness.mjs';
import { panelsCaptionStyle, panelsTextElements } from './boqo/panels-text.mjs';
import { planShots } from './boqo/plan-shots.mjs';
import { parseProbeSize, probeSizeArgs } from './boqo/probe.mjs';
import { thumbnailArgs } from './boqo/thumbnail.mjs';

/** The frame every clip is rendered at: 9:16, the only ratio a brand kit has (engine/brand.mjs `RATIOS`). */
export const OUTPUT = DEFAULT_OUTPUT;

/** Where a run's clips go, and the work folders while they render (removed once the clip is in place). */
export const OUT_DIR = 'out';
export const WORK_DIR = 'render';

/** A kit with no logo: the run's note, which tools/render.mjs gives once for the batch (a clip's notes do not carry it). */
export const NO_LOGO_NOTE = 'No logo: the kit has none.';

/** How long decoding the logo's one frame may take before the clip renders without it. */
const LOGO_CHECK_TIMEOUT_MS = 30_000;

const nn = (n) => String(n).padStart(2, '0');
const oneLine = (e) => String(e?.message ?? e).split('\n')[0].trim();

/**
 * The default `exec`: spawns `command` with stdin closed, collects stdout whole and the last 4 MB of stderr, and kills
 * it after `timeoutMs`. Rejects with `stderr` on the error when it exits non-zero, and names a missing binary.
 */
export function realExec(command, args, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: toolEnv() });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 8 << 20) err = err.slice(-(4 << 20));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `${command} was not found on PATH (it comes with ffmpeg)` : `${command} could not start: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      if (code === 0) resolve({ stdout, stderr: err });
      else {
        const why = killed ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit ${code}`;
        const tail = err.trim().split('\n').slice(-4).join(' | ');
        reject(Object.assign(new Error(`${command} failed (${why}): ${tail}`), { stdout, stderr: err }));
      }
    });
  });
}

// A logo file the render can draw: PNG or JPEG by its first bytes (the extension can lie). Returns the extension to
// copy it under, or the reason it cannot be drawn.
async function logoKind(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(8), 0, 8, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.length >= 8 && head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png' };
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { ext: '.jpg' };
    return { why: 'it is not a PNG or JPEG image' };
  } catch (e) {
    return { why: e.code === 'ENOENT' ? 'the file is missing' : `it cannot be read (${e.code ?? oneLine(e)})` };
  } finally {
    await handle?.close();
  }
}

/**
 * Whether an encode's stderr points at the logo. Only its message lines are read (a `[component @ …]` line, or one
 * saying error, invalid, failed or no such file), never the input listing ffmpeg prints on every run, which names the
 * logo's file and `Input #1` whether or not anything went wrong. A message line points at the logo when it names the
 * logo's file, ffmpeg's stream #1 (the looped still), an image decoder or demuxer (`[png @`, `[mjpeg @`, `[image2 @`;
 * the window is never an image), or the logo stage's own label or filter (`blogo`, `colorchannelmixer`, which only the
 * logo chain uses).
 */
export function logoFailure(stderr, logoPath) {
  const messages = String(stderr)
    .split(/\r?\n/)
    .filter((l) => /^\s*\[[^\]]+ @ /.test(l) || /error|invalid|failed|no such file/i.test(l));
  const paths = logoPath ? [logoPath, logoPath.replace(/\\/g, '/')] : [];
  return messages.some(
    (l) =>
      paths.some((p) => l.includes(p)) ||
      /[Ss]tream #1:|\[(?:png|mjpeg|jpeg|image2|png_pipe|jpeg_pipe) @|blogo|colorchannelmixer/.test(l),
  );
}

async function moveFile(from, to) {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to); // another drive: copy instead
    await rm(from, { force: true });
  }
}

const isRow = (row) =>
  row && Number.isInteger(row.n) && row.n >= 1 && Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start;

/**
 * Renders one clip of a run.
 *
 * - `run`: the run folder; the clip goes to `<run>/out/clip-<nn>.mp4` and `<run>/out/clip-<nn>.jpg`, `nn` the row's
 *   `n` with two digits (the names `clips order` keeps paired), and the work to `<run>/render/clip-<nn>/`, removed
 *   once the clip is in place and kept (named in the error) when the render fails.
 * - `row`: the clip's row of clips.json (`n`, `start`, `end` in the video's seconds, `title`, `hook`,
 *   `emphasis_words`, `panels`).
 * - `brand`: a brand kit v2 (engine/brand.mjs), its `logo.file` an absolute path or null.
 * - `sourceFile`, `offset`: the file holding the clip and the second the clip starts in it: a downloaded section and
 *   its `offset`, or the whole video with `offset` = `row.start` (the default).
 * - `words`: the transcript, `{ w, s, e }` on the video's clock, ascending.
 * - `segments`: accepted and not read: hosted's render reads the segments only for the uniqueizer's window shift,
 *   which the skill's one copy never makes.
 * - `sceneCutsCache`: optional, a `Map` (or anything with `get` and `set`) of scene passes by window, so a second
 *   render of the same window skips the pass.
 * - `subjectRule`: `speaker` (Clips, the default) or `presence` (a stream moment, Sniper).
 * - `detector`, `load`: engine/faces.mjs's, to reuse one loaded face model across clips or to stand one in.
 *
 * Returns `{ file, thumb, seconds, notes, window: { start, end }, cuts, layouts }`: the absolute paths, the clip's
 * measured length, the note lines, the window as rendered in the video's seconds (`end` the settled one), its pause
 * cuts in window seconds (what `tools/stranger.mjs` maps the transcript through) and each shot's layout.
 */
export async function renderClip({
  run,
  row,
  brand,
  sourceFile,
  offset,
  words,
  sceneCutsCache,
  exec = realExec,
  subjectRule = 'speaker',
  detector,
  load,
}) {
  if (typeof run !== 'string' || run === '') throw new TypeError('renderClip: run must be the run folder');
  if (!isRow(row)) throw new TypeError(`renderClip: a row needs a whole n and start < end in seconds, got ${JSON.stringify({ n: row?.n, start: row?.start, end: row?.end })}`);
  if (typeof sourceFile !== 'string' || sourceFile === '') throw new TypeError('renderClip: sourceFile must be a path');
  if (!Array.isArray(words)) throw new TypeError('renderClip: words must be an array of { w, s, e }');
  const at = offset ?? row.start;
  if (!Number.isFinite(at) || at < 0) throw new TypeError(`renderClip: offset must be a second in the file, got ${offset}`);

  const name = `clip-${nn(row.n)}`;
  const work = join(run, WORK_DIR, name);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const notes = [];

  try {
    // 1. The window, on the file's own clock: the words move by the same shift as the clip.
    const shift = at - row.start;
    const fileWords = shift === 0 ? words : words.map((x) => ({ w: x.w, s: x.s + shift, e: x.e + shift }));
    const win = await prepareWindow({ source: sourceFile, startSec: at, endSec: at + (row.end - row.start), words: fileWords, dir: work, exec });
    const durationSec = win.endSec - win.startSec - cutsDurationSec(win.cuts);

    // 2. Scenes.
    const key = JSON.stringify([sourceFile, win.startSec, win.endSec, win.cuts]);
    let scenes = sceneCutsCache?.get(key);
    if (!scenes) {
      scenes = await detectShots({ exec }, { windowPath: win.file, dir: work, durationSec });
      sceneCutsCache?.set(key, scenes);
    }
    const { shots } = scenes;

    // 3. Faces. The frame size, when the detector gives none, from the window itself.
    const faces = await detectShotFaces({ file: win.file, shots, exec, dir: work, detector, load });
    let frame;
    if (faces.unavailable === true) {
      const { stdout } = await exec('ffprobe', probeSizeArgs(win.file), { timeoutMs: STEP_TIMEOUT_MS });
      frame = parseProbeSize(stdout);
      if (frame === null) throw new Error(`the video size of ${win.file} could not be read`);
    }

    // 4. Framing, with the stream panels read when one is stored and usable.
    const read = row.panels;
    const panels =
      read && read.status === 'ok' && read.content !== 'other' && Array.isArray(read.samples)
        ? { samples: read.samples, startSec: row.start, cuts: win.cuts }
        : null;
    const plan = planShots({ shots, faces, frame, output: OUTPUT, subjectRule, layout: 'auto', panels });
    notes.push(...plan.notes);
    const placed = plan.placed;

    // 5 and 6. The headline first, placed per run of shots, so the captions can sit below any plate moved onto a seam.
    const head = headlineElement({ title: String(row.title ?? ''), hook: row.hook ?? null, headline: brand.headline, durationSec });
    const textAbove = panelsTextElements(head === null ? [] : [head], placed, OUTPUT, durationSec);
    const captionStyle = panelsCaptionStyle(brandCaptionPreset(brand.captions), placed, OUTPUT, textAbove);
    const captions = captionsTrack({
      words: fileWords,
      clipStart: win.startSec,
      clipEnd: win.endSec,
      cuts: win.cuts,
      sceneCuts: cutSecFromShots(shots),
      emphasis: row.emphasis_words ?? null,
      output: OUTPUT,
      preset: captionStyle,
    });
    // Each text pass's filter, by its path: complex shaping for a file in a script that needs it (engine/script-faces.mjs).
    const passFilters = new Map();
    let assPath = null;
    if (captions.ass !== '') {
      assPath = join(work, 'captions.ass');
      await writeFile(assPath, captions.ass);
      passFilters.set(assPath, textPassFilter(assPath, captions.ass));
    }
    let headlineAssPath = null;
    if (textAbove.length > 0) {
      headlineAssPath = join(work, 'headline.ass');
      // A Devanagari run in the headline is drawn in the bundled Devanagari face, as the captions' are.
      const headlineAss = routeScriptFaces(buildTextAss(textAbove, durationSec, OUTPUT, 0).ass);
      await writeFile(headlineAssPath, headlineAss);
      passFilters.set(headlineAssPath, textPassFilter(headlineAssPath, headlineAss));
    }

    let logo = null;
    // A kit with no logo is a fact about the run, not the clip: tools/render.mjs says NO_LOGO_NOTE once.
    if (brand.logo && brand.logo.file) {
      const kind = await logoKind(brand.logo.file);
      // A file that starts like a PNG and is damaged after: decoded once here, because looped as input #1 of the
      // encode (`-loop 1`) it kept the encode from ending (measured 2026-11-16, BtbN ffmpeg 8.1, a PNG signature then
      // junk: the encode still ran minutes later and ignored SIGTERM; one decode of the same file exits 69 in 28 ms).
      if (!kind.why) {
        try {
          await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', brand.logo.file, '-frames:v', '1', '-f', 'null', '-'], { timeoutMs: LOGO_CHECK_TIMEOUT_MS });
        } catch (e) {
          kind.why = `ffmpeg cannot read it: ${oneLine(String(e?.stderr ?? '').trim().split('\n').at(-1) || e?.message)}`;
        }
      }
      if (kind.why) notes.push(`No logo: ${kind.why} (${brand.logo.file}).`);
      else {
        const stage = logoStage({ logo: brand.logo, durationSec, output: OUTPUT });
        if (stage === null) notes.push('No logo: the clip is shorter than the logo\'s window.');
        else {
          const path = join(work, `logo${kind.ext}`);
          await copyFile(brand.logo.file, path);
          logo = { stage, path };
        }
      }
    }

    // 7. Compose and encode. A logo ffmpeg cannot draw costs the logo, not the clip.
    const clipPath = join(work, 'clip.mp4');
    const encode = (withLogo) =>
      exec(
        'ffmpeg',
        composeArgs({
          videoPath: win.file,
          filterGraph: buildFilterGraph({
            shots: placed.map((p) => ({ shot: p.shot, placement: p.placement })),
            output: OUTPUT,
            assPath,
            headlineAssPath,
            blurSigma: FALLBACK_BLUR_SIGMA,
            brandLogo: withLogo ? logo.stage : null,
            subtitles: (p) => passFilters.get(p),
          }),
          outPath: clipPath,
          filterThreads: FILTER_THREADS,
          encodeThreads: ENCODE_THREADS,
          brandingMark: withLogo ? { path: logo.path, durationSec } : null,
        }),
        { timeoutMs: STEP_TIMEOUT_MS },
      );
    if (logo === null) await encode(false);
    else {
      try {
        await encode(true);
      } catch (e) {
        // Only a failure ffmpeg puts on the logo (its file, input #1, the image decoder, the `[blogo]` stage) costs
        // the logo; any other encode failure is the clip's and fails as itself.
        if (!logoFailure(String(e?.stderr ?? e?.message ?? ''), logo.path)) throw e;
        await encode(false);
        notes.push(`No logo: ffmpeg could not draw it (${oneLine(e)}).`);
      }
    }

    // 8. Loudness.
    const loud = await applyLoudness({ exec }, { path: clipPath, dir: work, target: CLIP_LOUDNESS, timeoutMs: () => STEP_TIMEOUT_MS });
    if (loud.status === 'skipped') notes.push(`Loudness not normalised (${loud.reason}): the audio is as composed.`);

    // 9. The thumbnail, and the clip's measured length.
    const thumbPath = join(work, 'clip.jpg');
    await exec('ffmpeg', thumbnailArgs({ videoPath: clipPath, atSec: Math.min(1, durationSec / 2), outPath: thumbPath }), { timeoutMs: STEP_TIMEOUT_MS });
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipPath], { timeoutMs: STEP_TIMEOUT_MS });
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('the rendered clip has no duration');

    const outDir = join(run, OUT_DIR);
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `${name}.mp4`);
    const thumb = join(outDir, `${name}.jpg`);
    await moveFile(clipPath, file);
    await moveFile(thumbPath, thumb);
    // The clip is in place: a work folder that will not go away (Windows keeps a just-closed file busy, EBUSY) is
    // left behind, and the clip still counts.
    await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
    // rmdir only removes an empty folder: another clip's (a failed one's) work folder keeps `render/`.
    await rmdir(join(run, WORK_DIR)).catch(() => {});
    const round = (x) => Math.round(x * 1000) / 1000;
    return {
      file,
      thumb,
      seconds: round(seconds),
      notes,
      window: { start: round(row.start), end: round(row.start + (win.endSec - win.startSec)) },
      cuts: win.cuts,
      layouts: placed.map((p) => p.layout),
    };
  } catch (err) {
    err.message = `${err.message} (work folder kept at ${work})`;
    throw err;
  }
}
