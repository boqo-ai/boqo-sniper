// boqo's signalLine (apps/web/src/components/next/stream/signal-line.ts): the
// line under a moment's title that says what the detector saw. Synthetic details.
import { readFileSync } from "node:fs";
import { signalLine } from "../../../web/src/components/next/stream/signal-line";

type Case = { signal: string; detail: Parameters<typeof signalLine>[0] };
const cases: Case[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
console.log(JSON.stringify(cases.map((c) => ({ ...c, line: signalLine(c.detail, c.signal) }))));
