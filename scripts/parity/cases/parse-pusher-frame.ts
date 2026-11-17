// boqo's Pusher frame reader (apps/watcher/src/chat/kick.ts parsePusherFrame): what each raw frame
// from Kick's chat socket is (a message with its text and author, a ping, a subscription, other).
// Input: { frames: string[] }. Synthetic frames only.
import { readFileSync } from "node:fs";
import { parsePusherFrame } from "../../../watcher/src/chat/kick";

const input: { frames: string[] } = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
console.log(JSON.stringify(input.frames.map((raw) => ({ raw, event: parsePusherFrame(raw) }))));
