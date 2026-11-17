// boqo's parseLoudnessLine (apps/watcher/src/audio/loudness.ts) over synthetic
// ffmpeg ebur128 stderr lines: [{ line, parsed }] with null for a line it ignores.
import { readFileSync } from "node:fs";
import { parseLoudnessLine } from "../../../watcher/src/audio/loudness";

const lines: string[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
console.log(JSON.stringify(lines.map((line) => ({ line, parsed: parseLoudnessLine(line) }))));
