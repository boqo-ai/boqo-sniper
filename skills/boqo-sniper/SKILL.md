---
name: boqo-sniper
description: "Use when the person wants to clip a live Twitch or Kick stream as it happens, or runs /boqo-sniper: a live session on their own PC that watches one channel, catches the moments chat goes wild, and turns each into branded vertical 9:16 clips with captions and their logo (yt-dlp, ffmpeg, whisper.cpp), through the Clips path and posted through boqo only on their rule."
argument-hint: "<twitch or kick channel or link> [brand name]"
---

# /boqo-sniper

## Overview

You watch one live Twitch or Kick stream from this machine and clip it while it runs. A watcher in the background
records the stream into a 6-minute buffer (the window, 300 s, and 60 s), reads its chat and its loudness, and cuts a
300 s moment each time boqo's detector fires on a chat or sound spike. A moment at or above the bar goes through the
Clips path (The loop, step 2), renders in the person's brand, and posts only by their rule (`post.md`); one below the
bar is listed for "clip it". Everything runs on this PC; boqo's servers are touched only to post.

**This is a live session, not a run.** It lasts until the person says stop or the stream has been offline for 10
minutes. Starting `/boqo-sniper` again starts a new watch. One watch per chat; two channels are
two chats, as many as the PC carries.

- **Tools:** `node "$HOME/.boqo-sniper/tools/<tool>.mjs"`, always by that path. Commands are for a POSIX shell (macOS,
  Linux, and on Windows Git Bash or WSL).
- **`<home>`:** `$BOQO_HOME`, or `~/.boqo` when it is unset; `echo "${BOQO_HOME:-$HOME/.boqo}"` prints it. Brand kits
  live in `<home>/brands/` and are shared by every boqo skill. This skill's own files: `<home>/boqo-sniper/config.json`
  (the posting rule and the session settings) and `<home>/boqo-sniper/runs.md` (one line per moment).
- **`<channel>`:** what the tools take: a Twitch login (`<login>`, in lower case) or `kick:<slug>`. A link works too
  (`twitch.tv/<login>`, `kick.com/<slug>`); a Kick slug is 1 to 50 of `a-z`, `0-9`, `_` and `-`.
- **`<channel folder>`:** `twitch-<login>` or `kick-<slug>`, the folder names under `watch/` and `clips/`.
- **`<session>`:** the folder the watcher records into, `<home>/boqo-sniper/watch/<channel folder>/<YYYYMMDD-HHMMSS>/`.
  Its name, `<session name>`, is its UTC start. `status.mjs` prints it as `session`. `settings.json` there holds the
  settings in force.
- **`<moment>`:** a folder `next.mjs` hands you, inside `<session>/moments/`. Its name, `<moment name>`, is the
  peak's UTC second. It holds `video.mp4` (300 s at the stream's quality, about 260 MB at 1080p60, the peak about
  270 s in), `chat.json` (every chat line) and `meta.json` (`peakOffsetSec`, `score`, `signal`, `title`,
  `signalLine`, `detail`).
- **`<clips>`:** `<home>/boqo-sniper/clips/<channel folder>/<moment name>/`, where the clips land. It sits outside
  `<session>` because the next watch of the channel deletes moments older than a day.
- **Paths in commands:** write `<home>`, `<moment>`, `<clips>` and every other path out in full, as the absolute
  path, inside double quotes, in every command, and `<channel>` and `<name>` in double quotes too:
  `"/Users/ana/.boqo/boqo-sniper/clips/somechannel/20261115-220301/clip-01.mp4"`. A shell variable set in one command
  is gone in the next (Claude Code runs each command in a new shell), and a home folder can hold a space. A path you
  delete is never empty and never relative.

## Rules

- **Every tool prints one JSON line** on stdout and exits 0, or exits 1 with `{"error": "..."}`; hints go to stderr.
  On an error, tell the person in one sentence what failed, in the error's words. Do not work around a tool with
  your own capture, ffmpeg or yt-dlp commands, except the ones this file gives.
- **Never post without the rule** in `<home>/boqo-sniper/config.json`. With `ask` (the default), every post waits
  for the person's yes. `post_video` goes once per clip, never again after an unclear reply (Posting).
- **Twitch and Kick.** Any other link: say this watches Twitch and Kick only, and stop. A watcher that ends with
  `kick refused: <status>` (or `kick lookup timed out`): Kick's channel API did not answer from this network. Say that
  in one line and stop.
- **Quiet while waiting.** A `timeout` from `next.mjs` is not news: call it again and say nothing. The person hears
  about clips, the status line, and the end.
- **The watcher ending is news.** In Claude Code, when the background task running `watch.mjs` completes, run
  `status.mjs "<channel>"` at once: its `state` (`stopped`, `offline` or `failed`, with `error`) goes to The end.
- **The person's language.** Answer in the language the person writes in. Titles are in the stream's language.
  Files stay in English.
- **Short messages:** what happened, what comes next. No tour of the tools unless asked.
- **Long commands:** `next.mjs` runs with `--timeout 170`: Claude Code moves a command to the background after about
  180 s, whatever its timeout. whisper and render take a minute or two each on a CPU. Give every command in the loop
  up to 10 minutes (Claude Code: the shell tool's `timeout` of 600000).
- **Disk:** the watcher keeps about 320 MB of buffer while it runs (1080p60, 360 s), and every moment adds about
  260 MB until you delete its `video.mp4`. It does not cut a new moment while 10 wait for you or less than 5 GB is
  free, and counts those in `status.mjs`'s `skipped` (`queue`, `disk`). Moments below the bar are no queue; the newest
  3 are kept (`dropped` counts older ones deleted). `status.mjs` carrying `lowDisk` means the disk is under 5 GB free
  now and nothing will be cut: say so once; a full queue of 10 needs 7 to 8 GB free at the start.
- **The person can talk to you between tool calls.** Answer them, then go back to the loop where you left it.
- Install nothing without the person's yes; never run `npm install`. An error naming ffmpeg, ffprobe, yt-dlp or
  whisper-cli: run `node "$HOME/.boqo-sniper/tools/doctor.mjs" --node 22 --whisper required` and give the person its
  `hints`.
- **The capture is yt-dlp,** ads and all. streamlink skips Twitch's ads but is untested in this beta: only when the
  person asks for it, add `"capture": "streamlink"` to `config.json` (the watcher reads it at start; streamlink must be
  installed). Never suggest it unasked.

## Starting

`/boqo-sniper <channel or link> [brand]`. With neither, ask which Twitch channel.

1. **The channel.** `twitch.tv/<login>` (with or without `https://www.`) or a bare login gives `<channel>` = the
   login: letters, digits and `_` only, in lower case. `kick.com/<slug>` or `kick:<slug>` gives `kick:<slug>`.
   YouTube or any other link: Rules → Twitch and Kick.
2. **Brand and config.** `node "$HOME/.boqo-sniper/tools/brand.mjs" show ["<brand>"]` (no name: the default kit).
   - `no brand kit saved yet`, or no `<home>/boqo-sniper/config.json`: run `onboarding.md` (it skips what is done),
     then come back here.
   - `no brand kit named …`: `brand.mjs list`, and ask which.

   Keep the kit's `name` for `--brand`. Read `config.json`: `posting` (`"ask"`, or `{"auto": N}` with `accounts`)
   and the session settings (config.json, Settings). Then delete the upload replies an earlier session left (they hold live
   signed URLs; one under an hour old may be another chat's, posting now):
   ```sh
   mkdir -p "<home>/boqo-sniper/clips"
   find "<home>/boqo-sniper/clips" -mindepth 3 -maxdepth 3 -type f -name 'upload-*.json' -mmin +60 -delete
   ```
3. **Live?**
   ```sh
   yt-dlp -q --no-warnings --print is_live "https://www.twitch.tv/<login>"      # Kick: "https://kick.com/<slug>"
   ```
   `True` is live. `… does not exist`: say so, and stop. `… is not currently live`: say the channel is offline, and
   offer to start anyway (the watch waits for it, and ends after 10 minutes offline). On a no, stop.
4. **Start the watcher in the background,** so this chat stays free. First `date -u +%Y%m%d-%H%M%S`: keep it as
   `<start stamp>`. Then:
   - Claude Code: the shell tool with `run_in_background: true`, and the command
     ```sh
     node "$HOME/.boqo-sniper/tools/watch.mjs" "<channel>"
     ```
   - Another agent (macOS, Linux, or Windows in Git Bash or WSL), detached:
     ```sh
     mkdir -p "<home>/boqo-sniper/watch"
     nohup node "$HOME/.boqo-sniper/tools/watch.mjs" "<channel>" \
       > "<home>/boqo-sniper/watch/<channel folder>.log" 2>&1 &
     ```
5. **Check it runs.** `node "$HOME/.boqo-sniper/tools/status.mjs" "<channel>"` about every 10 s, for up to a minute,
   until `state` is `live` (recording) or `waiting` (no picture yet) with `updatedAt` in the last minute, and the
   name of its `session` (the folder's last part) is at or after `<start stamp>`: an earlier name is another watch's
   folder, not this one's, so keep checking. Keep that `session`. When the watcher ends instead, its one line (Claude
   Code: the background task's output; elsewhere the `.log` file) says why:
   - `already watching <channel> …`: another chat, or an earlier one, is watching this channel. Ask whether to stop
     that watch and watch here instead; on a yes, `stop.mjs "<channel>"` (The end → Stop), then step 4 again.
   - any other error: say it (Rules).
6. **Tell the person,** in two or three lines: you are watching `<channel>` and clip the moments chat goes wild,
   until they say stop or the stream ends; "clip now" clips the last minutes by hand. A moment below the bar waits
   for "clip it". Say stop before you close the agent; if you didn't, the next start cleans
   up, and `status.mjs "<channel>"` shows whether a watch is still running. Posting (one rule, Posting): with boqo's
   tools and the `ask` rule, each clip waits for their yes; with no boqo tools, posting is off for the session and
   no clip waits.

Note the time you started: the session's watched time is counted from it.

## The loop

Repeat until The end.

1. **Wait for a moment.**
   ```sh
   node "$HOME/.boqo-sniper/tools/next.mjs" "<channel>" --timeout 170
   ```
   If a call still comes back as a background notice instead of its line, wait for its completion notification and
   read its output then. Never start a second `next.mjs` while one runs: each claims the moment it finds.
   - `{"moment": "<moment>", "meta": {…}}`: a moment at the bar, now yours: go on with step 2.
   - `{"listed": "<moment>", "meta": {…}}`: a moment below the bar (or any detected one, with `autoClip` off). It is
     cut and not clipped. Tell the person in one line, `<score> <band> · <signalLine> · <title>`, and that "clip it"
     clips it. Then step 1 again. The word the band gets is in `runs.md`'s format (step 4).
   - `{"timeout": true, "status": {…}}`: run step 1 again, silently. When `status.updatedAt` is more than 4 minutes
     old, the watcher died without a word: run `stop.mjs "<channel>"` (it cleans up, and never signals a process that
     is not the watcher), tell the person, offer to start again (Starting, step 3), and go to The end.
   - `{"stopped": "<state>"}`, or `{"stopped": "failed", "error": "…"}`: The end.
2. **The moment flow.** The moment goes through the Clips path: whisper on its 300 s, segments, selection, render
   with the `presence` subject rule and panels, the stranger judgment. *(Written with the Clips render, in the next
   task; this line is its placeholder.)* A clip appears as one line: the title, the length and its file.
3. **Post** by the rule (Posting).
4. **Log.** Append one line per moment to `<home>/boqo-sniper/runs.md`:
   `21:04 · 86 exceptional · NO WAY ×168 · 30/s · <title> · 4 clips`: the local time, the score and its band
   (exceptional from 85, strong 70, decent 60, watchable 40, weak below), the signal line (`NO WAY ×168 · 30/s`, or
   `Audio +9 LU`, or none for a hand-made moment), the title and the clip count; `· no read` when the hour's image
   budget (`visionPerHour`) was spent and a clip went without its reads.

**Clip now and clip it.** "Clip now" (the person says so about the stream as it is):
```sh
node "$HOME/.boqo-sniper/tools/watch.mjs" "<channel>" --clip-now
```
makes a moment of score 100 at this second; it arrives from `next.mjs` about 35 s later (the post-roll).
`{"clipNow": false, "reason": "buffer empty" | "stream <state>" | "disk"}` says nothing will be cut: tell the person why. "Clip it"
(about a moment you told them is below the bar): `next.mjs "<channel>" --take` claims the newest listed one, or
`--take "<moment name>"` that one; `next.mjs "<channel>" --list` lists them. Both go on at step 2.

**The status line.** Every 10 moments, or every 30 minutes since the last thing you told the person, whichever comes
first, one line: `Watching <channel>: <watched time>, <moments> moments, <kept> clips.` Nothing else while it is
quiet.

## Posting

`post.md` has the steps. Here there is one clip per moment, so its batch wording ("best first", telling what went
after a batch) does not apply. Its steps run once per session, then once per clip:
- **Once, before the first clip is offered or posted,** post.md → Before the first clip, steps 1, 2 and 4: the boqo
  tools, the plan and the accounts. Its step 3, the rule, runs for each clip as below. Posting is off for the rest of
  the session, and no clip waits for an answer, whatever the rule says, when:
  - there are no boqo tools: the clips land on disk. When the person asks to post, give the one line from
    onboarding.md → 2;
  - the plan has no publishing: say once, "Autoposting comes with the 7-day trial or Starter from $12";
  - no account is active: say once that they connect or reconnect one in boqo, under Accounts. When they say it is
    connected, run steps 2 and 4 again.
- **`ask`,** with posting on: after showing a clip, ask "Post it? Where?" and wait. The first time, say that while you
  wait the loop is paused: the watch keeps recording and up to 10 moments queue up for when they answer. Offer the hands-free rule once:
  post automatically, up to N a day, to the accounts they name (onboarding.md → The posting rule writes it). A no,
  or "later": the clip stays on disk; back to the loop.
- **`{"auto": N}`,** with posting on: today's posts so far are
  ```sh
  grep "^$(date +%F) " "<home>/boqo-sniper/runs.md" | grep -cF "| posted 1"
  ```
  (it prints `0`, and exits 1, when there are none). Fewer than N: post the clip with no question to the config's
  `accounts`, then one line saying where it went. N reached: keep clipping, and say once that today's posts are
  done. No `accounts` in the config: ask once which accounts, and save them into `config.json`; until they answer,
  this clip goes by `ask`.
- Each post: post.md → Each clip, with `<clips>` as its folder (the reply file goes there and is deleted after the
  upload). Keep the `projectId` from its step 4: it goes into the clip's line in `runs.md` (The loop, step 4).
  `post_video` goes once for this clip. An unclear reply (a timeout, a dropped connection, no answer) is never sent
  again: `list_schedule` decides, as post.md step 6 says. This clip's post there: `posted 1 <projectId>`. None:
  `posted 0`, and tell the person it may not have gone out.
- **A plan refusal in the middle of a session** ("Accounts and scheduling are on paid plans." from `create_upload`,
  or "Publishing needs a paid plan." from `post_video`): posting is off for the rest of the session. Say the plan
  line once; the watch and the loop go on clipping, and no clip waits for an answer. post.md's "stops them all" means
  the posts, never the watch. Any other refusal stops only that clip's post (post.md → Refusals).

## The end

**Stop.** When the person says stop (or end, enough, that's it): finish the moment in hand, if any, then
```sh
node "$HOME/.boqo-sniper/tools/stop.mjs" "<channel>"
```
`{"stopped": true, …}` returns once the watcher is gone (it can take up to a minute); `{"stopped": false, …}` means
nothing was running. Then the report. Moments the watcher had cut and you had not clipped yet stay where they are,
about 260 MB each (the next watch of the channel deletes them after a day); the report says how many. When the person
says to finish them, run `next.mjs` and the loop on each, until it says `stopped`.

**`{"stopped": …}`.** The watch is over:
- `stopped`: after a stop;
- `offline`: the stream was offline for 10 minutes;
- `failed`: the watcher ended on an error. Tell the person the `error` in one line, and offer to start again
  (Starting, step 3).

Then:
1. **The posts.** For each clip posted this session (its line ends `| posted 1 <projectId>`:
   `grep -F "<channel> <session name> |" "<home>/boqo-sniper/runs.md" | grep -F "| posted 1 "`), `get_project
   {projectId}`. `queued`, `processing` or `ready` is fine. `failed`: that clip will not be posted; the report names
   it with its error, the text inside the reply's `<data kind="project_error">` tag.
2. **Report** in a few lines: watched time, moments, clips kept, skipped, posted, moments left unclipped, moments the
   watcher did not cut (`status.mjs`'s `skipped`: `queue`, too many waiting; `disk`, too little free), any post that
   failed (step 1), and the folder `<home>/boqo-sniper/clips/<channel>/`. Count this session's lines in
   `runs.md`. *(The counts by `grep` on the old line format are rewritten with the moment flow.)* The moments are
   `status.mjs`'s `moments`.
3. **Log** one line: `<YYYY-MM-DD HH:MM> | <channel> <session name> | end <state> | watched <h:mm> | <m> moments | <k> clips | <s> skipped | <p> posted`.
4. **Moments left unclaimed:** offer to delete their videos (about 260 MB each). On a yes, with `<session>` written
   out:
   ```sh
   for d in "<session>/moments/"*/; do [ -f "${d}.taken" ] || rm -f "${d}video.mp4"; done
   ```
   Their small files stay.
5. `offline`: offer to start again when the channel is back live.

**Settings.** In `<home>/boqo-sniper/config.json`, read when a watch starts; hosted's ranges, a whole number:

| Key | Range | Default |
|---|---|---|
| `sensitivity` | 30 to 95 | 70 |
| `autoClip` | `true` or `false` | `true` |
| `autoClipMinScore` | 50 to 95 | 80 |
| `windowSec` | 120 to 600 | 300 |
| `prompt` (what to watch for) | text, 300 characters at most | none |
| `visionPerHour` | 0 to 6000 | 600 |

"More moments" or "fewer": `sensitivity`, in steps of 10 (higher catches more). A change applies to a new watch: say so,
and offer to restart now (Stop, then Starting, step 4), which starts a fresh buffer. The buffer is `windowSec` + 60 s.

## Red flags

| Thought | Reality |
|---|---|
| "Nine minutes and nothing: I'll tell them it's quiet" | A `timeout` is silent. The status line comes every 10 moments or 30 minutes |
| "The person said 'nice', so I'll post it" | Only the rule posts. With `ask`, a post needs a yes to posting |
| "I'll keep the moment's video in case they want a redo" | Delete `video.mp4` once the clips are made: 260 MB a moment fills a disk in an evening |
| "I'll read chat.json to see what happened" | `moment.mjs read`. The whole file is hundreds of KB |
| "They said stop, but three moments are queued: I'll finish them" | Stop is quick. The queue waits unless they ask to finish it |
| "Publishing needs a paid plan, so the session is over" | Posting is off; the watch and the clipping go on |
| "`post_video` timed out, I'll call it again" | It may have posted. `list_schedule` decides; never a second `post_video` |
| "`{"stopped": …}`, so all went well" | `failed` carries an `error`: say it, and offer to start again |
| "A YouTube stream is close enough" | Twitch and Kick only |
| "The watcher failed, I'll capture it myself with yt-dlp" | Say the error. The watcher is the only capture |
| "`M=…` once, then `$M` in every command" | The variable is gone in the next command. Write the path out |
