// The render: cut one moment from a source file, reframe it to 1080x1920 (a
// blurred fill behind the picture, or a centre crop), burn the brand's captions,
// overlay the logo, normalise loudness and encode for posting (H.264 yuv420p,
// AAC 128k, faststart).
//
// ffmpeg runs with `cwd` = a per-clip work folder, and the filter string names
// only files in it (captions.ass, logo.png, fonts/): a drive-letter path inside a
// filter breaks ffmpeg on Windows. The source goes in `-i` by its own path.
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { assFor, FONT_FILES } from './captions-ass.mjs';
import { wordsInRange } from './words.mjs';

/** @typedef {import('./words.mjs').Word} Word */
/** @typedef {import('./brand.mjs').Brand} Brand */

const W = 1080;
const H = 1920;
const MARGIN = 48;
const MIN_FPS = 24;
const MAX_FPS = 60;
const LOUDNORM = 'loudnorm=I=-14:TP=-1.5:LRA=11';
const FONTS_SRC = new URL('./fonts/', import.meta.url);

const num = (x) => String(Math.round(x * 1000) / 1000);

/**
 * The ffmpeg arguments for one clip. Every name used inside the filter is
 * relative to the work folder ffmpeg runs in.
 * @param {{ input: string, startSec: number, durSec: number, ass: string,
 *   logo: string|null, brand: Brand, layout: 'blur'|'crop', fps: number,
 *   out: string, fontsDir: string, hasAudio?: boolean, loglevel?: string }} o
 *   `input` is what `-i` gets (a path is fine there); `ass`, `logo`, `fontsDir`
 *   and `out` are relative.
 * @returns {string[]}
 */
export function ffmpegArgs(o) {
  const { input, startSec, durSec, ass, logo, brand, layout, fps, out, fontsDir } = o;
  const hasAudio = o.hasAudio !== false;
  const burn = `ass=${ass}:fontsdir=${fontsDir}`;

  const chains = [];
  const toLogo = logo ? '[v0]' : '[v]';
  if (layout === 'crop') {
    chains.push(`[0:v]crop=ih*9/16:ih,scale=${W}:${H},setsar=1,${burn}${toLogo}`);
  } else {
    chains.push(
      '[0:v]split=2[bg][fg]',
      `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=25:2[bgb]`,
      `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fgs]`,
      `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1,${burn}${toLogo}`,
    );
  }
  if (logo) {
    const x = brand.logo.corner.endsWith('l') ? `${MARGIN}` : `W-w-${MARGIN}`;
    const y = brand.logo.corner.startsWith('t') ? `${MARGIN}` : `H-h-${MARGIN}`;
    chains.push(`[1:v]scale=${Math.round(brand.logo.scale * W)}:-1[lg]`, `[v0][lg]overlay=${x}:${y}[v]`);
  }
  if (hasAudio) chains.push(`[0:a]${LOUDNORM}[a]`);

  const args = ['-hide_banner', '-nostdin', '-loglevel', o.loglevel ?? 'error', '-y'];
  args.push('-ss', num(startSec), '-i', input);
  if (logo) args.push('-i', logo);
  args.push('-filter_complex', chains.join(';'), '-map', '[v]');
  if (hasAudio) args.push('-map', '[a]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', num(fps));
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000');
  args.push('-movflags', '+faststart', '-t', num(durSec), out);
  return args;
}

/**
 * The ASS file text for a clip. The hook is shown only when the brand has
 * `hook` on.
 * @param {Word[]} words on the source timeline
 * @param {number} s clip start on that timeline
 * @param {number} e clip end
 * @param {Brand} brand
 * @param {string} [hook]
 */
export function clipAss(words, s, e, brand, hook) {
  return assFor(wordsInRange(words, s, e), brand, { w: W, h: H }, brand.hook ? hook : undefined);
}

function ffprobeJson(args) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-of', 'json', ...args], { encoding: 'utf8', maxBuffer: 16 << 20 });
  if (r.error) {
    throw new Error(r.error.code === 'ENOENT' ? 'ffprobe was not found on PATH (it comes with ffmpeg)' : `ffprobe failed: ${r.error.message}`);
  }
  if (r.status !== 0) throw new Error(`ffprobe could not read ${args.at(-1)}: ${(r.stderr || '').trim().split('\n').at(-1)}`);
  return JSON.parse(r.stdout);
}

const rate = (txt) => {
  const [a, b = '1'] = String(txt ?? '').split('/');
  const v = Number(a) / Number(b);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/** What the render needs to know about a source: size as displayed, fps, audio. */
function probeSource(src) {
  const j = ffprobeJson(['-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate:stream_tags=rotate:stream_side_data=rotation', src]);
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error(`${src} has no video stream`);
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0));
  const turned = rot % 180 === 90;
  const fps = rate(v.avg_frame_rate) ?? rate(v.r_frame_rate) ?? 30;
  return {
    width: turned ? v.height : v.width,
    height: turned ? v.width : v.height,
    fps: Math.round(Math.min(MAX_FPS, Math.max(MIN_FPS, fps)) * 1000) / 1000,
    hasAudio: (j.streams ?? []).some((s) => s.codec_type === 'audio'),
  };
}

function runFfmpeg(args, cwd, onLog) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('ffmpeg', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let tail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (t) => {
      if (onLog) onLog(t);
      tail = (tail + t).slice(-4000);
    });
    child.on('error', (err) =>
      reject(new Error(err.code === 'ENOENT' ? 'ffmpeg was not found on PATH - install ffmpeg first' : `ffmpeg could not start: ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (exit ${code}): ${tail.trim().split('\n').slice(-6).join(' | ')}`));
    });
  });
}

async function moveFile(from, to) {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to); // another drive: copy instead
    await rm(from, { force: true });
  }
}

/**
 * Renders one clip to `<outDir>/<name>.mp4`.
 * @param {{ src: string, s: number, e: number, words: Word[], brand: Brand,
 *   layout?: 'blur'|'crop', hook?: string, outDir: string, name: string,
 *   seek?: number, tmpRoot?: string, loglevel?: string, onLog?: (text: string) => void }} o
 *   `words` are on the source timeline; the clip runs `s`..`e` on it. `seek` is
 *   where the clip starts inside `src` when that differs from `s` (a downloaded
 *   section starts at its own 0). `tmpRoot` is where the work folder goes (the
 *   OS temp dir by default); `loglevel`/`onLog` expose ffmpeg's log.
 * @returns {Promise<{ out: string, seconds: number }>}
 */
export async function renderClip(o) {
  const { src, s, e, words, brand, outDir, name } = o;
  if (typeof name !== 'string' || !/^[^\\/:*?"<>|\0]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`clip name must be a plain file name, got ${JSON.stringify(name)}`);
  }
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw new Error(`a clip needs s < e, got ${s}..${e}`);
  const dur = e - s;
  const start = o.seek ?? s;

  const info = probeSource(src);
  // a source narrower than 9:16 has nothing to crop to: fill it instead
  const layout = o.layout === 'crop' && info.width * 16 >= info.height * 9 ? 'crop' : 'blur';

  const root = o.tmpRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(join(root, 'boqo-clip-'));
  try {
    await writeFile(join(work, 'captions.ass'), clipAss(words, s, e, brand, o.hook));

    const font = FONT_FILES[brand.font];
    if (!font) throw new Error(`unknown brand font ${JSON.stringify(brand.font)}`);
    await mkdir(join(work, 'fonts'));
    await copyFile(new URL(font.file, FONTS_SRC), join(work, 'fonts', font.file));

    let logo = null;
    if (brand.logo.file) {
      logo = extname(brand.logo.file).toLowerCase() === '.png' ? 'logo.png' : 'logo.jpg';
      await copyFile(brand.logo.file, join(work, logo));
    }

    const args = ffmpegArgs({
      input: src,
      startSec: start,
      durSec: dur,
      ass: 'captions.ass',
      logo,
      brand,
      layout,
      fps: info.fps,
      out: 'out.mp4',
      fontsDir: 'fonts',
      hasAudio: info.hasAudio,
      loglevel: o.loglevel,
    });
    await runFfmpeg(args, work, o.onLog);

    const seconds = Number(ffprobeJson(['-show_entries', 'format=duration', join(work, 'out.mp4')]).format?.duration);
    if (!Number.isFinite(seconds)) throw new Error('the rendered clip has no duration');
    await mkdir(outDir, { recursive: true });
    const out = join(outDir, `${name}.mp4`);
    await moveFile(join(work, 'out.mp4'), out);
    await rm(work, { recursive: true, force: true });
    return { out, seconds: Math.round(seconds * 1000) / 1000 };
  } catch (err) {
    err.message = `${err.message} (work folder kept at ${work})`;
    throw err;
  }
}
