// The environment the tools run ffmpeg, ffprobe, yt-dlp and whisper-cli with.
// On macOS, Homebrew's ffmpeg-full (the build with libass) is keg-only: it is
// not linked onto PATH, and every agent command runs in a new shell, so an
// `export PATH=...` hint is gone by the next command. The tools find it here.
// Also the boqo home folder. This file imports only Node's own modules, so the doctor, which reads both, runs before
// the skill's npm packages are installed.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';

/** `$BOQO_HOME`, or `~/.boqo` when it is unset: brand kits, models and every skill's own files live under it. */
export const boqoHome = () => process.env.BOQO_HOME || join(homedir(), '.boqo');

/** ffmpeg-full's bin folder, Apple silicon first, then Intel. */
export const MAC_FFMPEG_DIRS = ['/opt/homebrew/opt/ffmpeg-full/bin', '/usr/local/opt/ffmpeg-full/bin'];

/**
 * `baseEnv` with, on macOS only, every ffmpeg-full bin folder that exists put
 * first on PATH. Any other OS gets `baseEnv` as it is. Never changes `baseEnv`.
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {string} [platform]
 * @param {(path: string) => boolean} [exists]
 * @returns {NodeJS.ProcessEnv}
 */
export function toolEnv(baseEnv = process.env, platform = process.platform, exists = existsSync) {
  if (platform !== 'darwin') return baseEnv;
  const front = MAC_FFMPEG_DIRS.filter((d) => exists(d));
  if (front.length === 0) return baseEnv;
  const sep = posix.delimiter;
  const rest = String(baseEnv.PATH ?? '').split(sep).filter((p) => p && !front.includes(p));
  return { ...baseEnv, PATH: [...front, ...rest].join(sep) };
}
