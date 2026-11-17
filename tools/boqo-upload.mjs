#!/usr/bin/env node
// The mechanical parts of publishing through boqo's MCP (copied from boqo-ai/boqount, MIT).
//
//   node <skill>/tools/boqo-upload.mjs probe <file>                  size, container, codecs, fps, and whether boqo takes it as it is
//   node <skill>/tools/boqo-upload.mjs probe-audio <file>            an audio file for boqo's transcribe: size, content type, length, minutes and credits
//   node <skill>/tools/boqo-upload.mjs name --run <run> --n <k>      the upload file name for a Post captioned with clip k's title
//   node <skill>/tools/boqo-upload.mjs name <caption…>               the same for a caption given as words
//   node <skill>/tools/boqo-upload.mjs caption --run <run> --n <k> [--tags a,b]   the post's words per platform from clip k's
//                                                                    title and hook in <run>/clips.json, as hosted writes them
//   node <skill>/tools/boqo-upload.mjs caption --title <t> [--hook <h>] [--tags a,b]   the same from words
//   (The skill's docs use the --run forms only: a title on a shell line is the shell's to rewrite, `$100k` and all.)
//   node <skill>/tools/boqo-upload.mjs put <file> --reply <reply.json>   PUT the parts of a create_upload reply (a Post's projectId or a transcribe upload's upload_id) saved to <reply.json>
//
// Prints one JSON line and exits 0, or exits 1 with {"error": …} / {"ok": false, …}. No signed URL is ever printed.
// The logic and why a PUT carries no content-type: engine/boqo-upload-lib.mjs.
//
// One line differs from boqount: ffprobe runs with toolEnv() (engine/env.mjs, macOS
// ffmpeg-full first), not with ":/opt/homebrew/bin:/usr/local/bin" appended to PATH on every OS.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { run } from "../engine/boqo-upload-lib.mjs";
import { toolEnv } from "../engine/env.mjs";

const execFileAsync = promisify(execFile);
// On a Mac, ffprobe often lives in keg-only ffmpeg-full, which an agent shell does not have on PATH.
const env = toolEnv();
const exec = (file, args) => execFileAsync(file, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { code, line } = await run(process.argv.slice(2), { exec, fetch, sleep, readFile, stat, now: () => new Date() });
console.log(line);
process.exit(code);
