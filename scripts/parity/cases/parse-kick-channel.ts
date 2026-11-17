// boqo's Kick channel-object reader (apps/watcher/src/chat/kick.ts): the chatroom id, live flag and
// viewer count it takes from kick.com/api/v2/channels/<slug>'s JSON, and the URL, Pusher URL and
// frames it builds. Input: { channels: unknown[], slugs: string[], chatroomIds: number[] }. Synthetic JSON only.
import { readFileSync } from "node:fs";
import { KICK_PUSHER_URL, kickChannelUrl, parseKickChannel, pingFrame, pongFrame, subscribeFrame } from "../../../watcher/src/chat/kick";

const input: { channels: unknown[]; slugs: string[]; chatroomIds: number[] } = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
console.log(
  JSON.stringify({
    pusherUrl: KICK_PUSHER_URL,
    urls: input.slugs.map((slug) => ({ slug, url: kickChannelUrl(slug) })),
    channels: input.channels.map((json) => ({ json, parsed: parseKickChannel(json) })),
    subscribe: input.chatroomIds.map((id) => ({ id, frame: subscribeFrame(id) })),
    ping: pingFrame(),
    pong: pongFrame(),
  }),
);
