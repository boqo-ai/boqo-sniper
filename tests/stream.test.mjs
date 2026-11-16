// The ported channel parser (lib/boqo/stream.mjs) against the golden boqo's own TypeScript wrote at the pin
// (scripts/parity/golden.mjs), then the inputs the skill is documented to take.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STREAM_PLATFORMS, parseStreamChannel, streamChannel, streamChannelLabel, streamUrl } from "../lib/boqo/stream.mjs";
import { expectGolden } from "./helpers/golden.mjs";

const input = (name) =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "parity", `${name}.input.json`), "utf8"));

const describe = (c) => (c === null ? null : { ...c, label: streamChannelLabel(c), url: streamUrl(c) });

test("parse-stream-channel: the ported parser matches boqo's on every input, name, label and URL", () => {
  const i = input("parse-stream-channel");
  expectGolden("parse-stream-channel", {
    platforms: STREAM_PLATFORMS,
    parsed: i.inputs.map((text) => ({ text, channel: describe(parseStreamChannel(text)) })),
    named: i.names.map(([platform, name]) => ({ platform, name, channel: describe(streamChannel(platform, name)) })),
  });
});

test("the inputs the skill takes: twitch.tv/xqc, kick.com/x-q_c, kick:xqc, uppercase, a clip link is not a channel", () => {
  assert.deepEqual(parseStreamChannel("twitch.tv/xqc"), { platform: "twitch", channel: "xqc" });
  assert.deepEqual(parseStreamChannel("kick.com/x-q_c"), { platform: "kick", channel: "x-q_c" });
  assert.deepEqual(parseStreamChannel("kick:xqc"), { platform: "kick", channel: "xqc" });
  assert.deepEqual(parseStreamChannel("HTTPS://WWW.KICK.COM/XQC/"), { platform: "kick", channel: "xqc" });
  assert.equal(parseStreamChannel("kick.com/xqc?clip=clip_01"), null);
  assert.equal(parseStreamChannel("twitch.tv/xqc?clip=Foo"), null);
  assert.equal(streamUrl({ platform: "kick", channel: "x-q_c" }), "https://kick.com/x-q_c");
  assert.equal(streamChannelLabel({ platform: "twitch", channel: "xqc" }), "twitch.tv/xqc");
});

test("slugs: Kick takes 1 to 50 of a-z 0-9 _ -, Twitch 3 to 25 of a-z 0-9 _", () => {
  assert.ok(parseStreamChannel("kick:a"));
  assert.ok(parseStreamChannel(`kick:${"a".repeat(50)}`));
  assert.equal(parseStreamChannel(`kick:${"a".repeat(51)}`), null);
  assert.equal(parseStreamChannel("kick:x.y"), null);
  assert.equal(parseStreamChannel("twitch:ab"), null);
  assert.equal(parseStreamChannel("twitch:x-y"), null);
});
