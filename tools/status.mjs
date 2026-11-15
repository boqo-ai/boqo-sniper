#!/usr/bin/env node
// What the watcher for a channel is doing.
//
//   status.mjs <channel>
//
// One JSON line: the session's status.json plus its folder, or
// {"state": "no-session"} when the channel was never watched.

import { currentSession, readStatus } from "../lib/session.mjs";

function fail(message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

async function main() {
  const channel = process.argv[2];
  if (!channel || channel.startsWith("--")) fail("usage: status.mjs <channel>");
  const session = await currentSession(channel);
  if (!session) {
    console.log(JSON.stringify({ state: "no-session" }));
    return;
  }
  const status = await readStatus(session);
  console.log(JSON.stringify({ ...(status ?? { state: "waiting" }), session }));
}

main().catch((err) => fail(err.message));
