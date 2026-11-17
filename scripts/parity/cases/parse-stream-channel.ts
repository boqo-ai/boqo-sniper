// boqo's channel parser (packages/core/src/stream.ts): what each input line parses to, what each
// (platform, name) pair validates to, and the label and URL of every parsed channel.
// Input: { inputs: string[], names: [platform, name][] }. Synthetic strings only.
import { readFileSync } from "node:fs";
import { parseStreamChannel, streamChannel, streamChannelLabel, streamUrl, STREAM_PLATFORMS } from "../../../../packages/core/src/stream";

const input: { inputs: string[]; names: [string, string][] } = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const describe = (c: ReturnType<typeof parseStreamChannel>) =>
  c === null ? null : { ...c, label: streamChannelLabel(c), url: streamUrl(c) };
console.log(
  JSON.stringify({
    platforms: STREAM_PLATFORMS,
    parsed: input.inputs.map((text) => ({ text, channel: describe(parseStreamChannel(text)) })),
    named: input.names.map(([platform, name]) => ({ platform, name, channel: describe(streamChannel(platform as "twitch" | "kick", name)) })),
  }),
);
