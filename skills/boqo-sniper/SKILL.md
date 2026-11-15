---
name: boqo-sniper
description: "Use when the person wants to clip a live Twitch stream as it happens, or runs /boqo-sniper: a live session on their own PC that watches one channel, catches the moments chat goes wild, and turns each into a branded vertical 9:16 clip with captions and their logo (streamlink or yt-dlp, ffmpeg, whisper.cpp), judged by you and posted through boqo only on their rule."
argument-hint: "<twitch channel or link> [brand name]"
---

# /boqo-sniper

## Overview

You watch one live Twitch stream from this machine and clip it while it runs. A watcher in the background records
the stream into a 12-minute buffer, reads its chat and its loudness, and cuts a moment of about 160 s each time chat
(or the sound) spikes. For each moment you transcribe it, judge it (`judge.md`), render the clip in the person's
brand and post it only by their rule (`post.md`). Everything runs on this PC; boqo's servers are touched only to
post.

**This is a live session, not a run.** It lasts until the person says stop, the stream has been offline for 10
minutes, or this chat closes. Starting `/boqo-sniper` again starts a new watch. One watch per chat; two channels are
two chats, as many as the PC carries.

- **Tools:** `node "$HOME/.boqo-sniper/tools/<tool>.mjs"`, always by that path. Commands are for a POSIX shell (macOS,
  Linux, and on Windows Git Bash or WSL).
- **`<home>`:** `$BOQO_HOME`, or `~/.boqo` when it is unset; `echo "${BOQO_HOME:-$HOME/.boqo}"` prints it. Brand kits
  live in `<home>/brands/` and are shared by every boqo skill. This skill's own files: `<home>/boqo-sniper/config.json`
  (the posting rule and the sensitivity) and `<home>/boqo-sniper/runs.md` (one line per moment).
- **`<channel>`:** the Twitch login, in lower case (`twitch.tv/<login>`).
- **`<session>`:** the folder the watcher records into, `<home>/boqo-sniper/<channel>/<YYYYMMDD-HHMMSS>/`. Its
  name, `<session name>`, is its UTC start. `status.mjs` prints it as `session`.
- **`<moment>`:** a folder `next.mjs` hands you, inside `<session>/moments/`. Its name, `<moment name>`, is the
  peak's UTC second. It holds `video.mp4` (about 160 s at the stream's quality, about 140 MB, the peak about 125 s
  in), `chat.json` (every chat line) and `meta.json` (`peakOffsetSec`, `score`, `reason`).
- **`<clips>`:** `<home>/boqo-sniper/clips/<channel>/<moment name>/`, where the clip lands as `clip-01.mp4`. It sits
  outside `<session>` because the next watch of the channel deletes moments older than a day.
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
  for the person's yes.
- **Twitch only in this beta.** A Kick link: say Kick comes next, and stop. Any other link: say this beta watches
  Twitch only, and stop.
- **Quiet while waiting.** A `timeout` from `next.mjs` is not news: call it again and say nothing. The person hears
  about clips, the status line, and the end.
- **The watcher ending is news.** In Claude Code, when the background task running `watch.mjs` completes, run
  `status.mjs "<channel>"` at once: its `state` (`stopped`, `offline` or `failed`, with `error`) goes to The end.
- **The person's language.** Answer in the language the person writes in. Titles are in the stream's language.
  Files stay in English.
- **Short messages:** what happened, what comes next. No tour of the tools unless asked.
- **Long commands:** `next.mjs` waits up to 540 s, and whisper and render take a minute or two each on a CPU. Give
  every command in the loop up to 10 minutes (Claude Code: the shell tool's `timeout` of 600000).
- **Disk:** the watcher keeps about 700 MB of buffer while it runs, and every moment adds about 140 MB until you
  delete its `video.mp4` (The loop, steps 4 and 6).
- **The person can talk to you between tool calls.** Answer them, then go back to the loop where you left it.
- Install nothing without the person's yes; never run `npm install`. An error naming ffmpeg, ffprobe, yt-dlp,
  streamlink or whisper-cli: run `node "$HOME/.boqo-sniper/tools/doctor.mjs" --node 22 --whisper required --streamlink`
  and give the person its `hints`.

## Starting

`/boqo-sniper <channel or link> [brand]`. With neither, ask which Twitch channel.

1. **The channel.** `twitch.tv/<login>` (with or without `https://www.`) or a bare login gives `<channel>`: letters,
   digits and `_` only, in lower case. `kick.com/…`, YouTube or any other link: Rules → Twitch only.
2. **Brand and config.** `node "$HOME/.boqo-sniper/tools/brand.mjs" show ["<brand>"]` (no name: the default kit).
   - `no brand kit saved yet`, or no `<home>/boqo-sniper/config.json`: run `onboarding.md` (it skips what is done),
     then come back here.
   - `no brand kit named …`: `brand.mjs list`, and ask which.

   Keep the kit's `name` for `--brand`. Read `config.json`: `posting` (`"ask"`, or `{"auto": N}` with `accounts`)
   and `sensitivity` (70 when it is missing).
3. **Live?**
   ```sh
   yt-dlp -q --no-warnings --print is_live "https://www.twitch.tv/<channel>"
   ```
   `True` is live. `… does not exist`: say so, and stop. `… is not currently live`: say the channel is offline, and
   offer to start anyway (the watch waits for it, and ends after 10 minutes offline). On a no, stop.
4. **Start the watcher in the background,** so this chat stays free:
   - Claude Code: the shell tool with `run_in_background: true`, and the command
     ```sh
     node "$HOME/.boqo-sniper/tools/watch.mjs" "<channel>" --sensitivity <n>
     ```
   - Another agent (macOS, Linux, or Windows in Git Bash or WSL), detached:
     ```sh
     mkdir -p "<home>/boqo-sniper"
     nohup node "$HOME/.boqo-sniper/tools/watch.mjs" "<channel>" --sensitivity <n> \
       > "<home>/boqo-sniper/<channel>.log" 2>&1 &
     ```
5. **Check it runs.** `node "$HOME/.boqo-sniper/tools/status.mjs" "<channel>"` about every 10 s, for up to a minute,
   until `state` is `live` (recording) or `waiting` (no picture yet) with `updatedAt` in the last minute. Keep its
   `session`. When the watcher ends instead, its one line (Claude Code: the background task's output; elsewhere the
   `.log` file) says why:
   - `already watching <channel> …`: another chat, or an earlier one, is watching this channel. Ask whether to stop
     that watch and watch here instead; on a yes, `stop.mjs "<channel>"` (The end → Stop), then step 4 again.
   - any other error: say it (Rules).
6. **Tell the person,** in two or three lines: you are watching `<channel>` and clip the moments chat goes wild,
   until they say stop or the stream ends. In Claude Code, closing this chat stops the watch too. Elsewhere, ask
   them to say stop before closing the agent: a watch left running ends by itself only 10 minutes after the stream
   goes offline. With the `ask` rule, each clip waits for their yes to post (Posting).

Note the time you started: the session's watched time is counted from it.

## The loop

Repeat until The end.

1. **Wait for a moment.**
   ```sh
   node "$HOME/.boqo-sniper/tools/next.mjs" "<channel>"
   ```
   - `{"moment": "<moment>", "meta": {…}}`: go on with step 2.
   - `{"timeout": true, "status": {…}}`: run step 1 again, silently. When `status.updatedAt` is more than 3 minutes
     old, the watcher died without a word: run `stop.mjs "<channel>"` (it cleans up), tell the person, offer to start
     again (Starting, step 3), and go to The end.
   - `{"stopped": "<state>"}`, or `{"stopped": "failed", "error": "…"}`: The end.
2. **Transcribe.**
   ```sh
   node "$HOME/.boqo-sniper/tools/asr.mjs" "<moment>/video.mp4" --out "<moment>/words.json"
   ```
   `{"words": 0, …}` is a moment with no speech, gameplay or music only: judge it on chat and the frames.
3. **Read it**, with the moment tool. Never read `chat.json` or `words.json` whole: a busy chat writes hundreds of KB.
   ```sh
   node "$HOME/.boqo-sniper/tools/moment.mjs" read "<moment>"
   node "$HOME/.boqo-sniper/tools/moment.mjs" words "<moment>/words.json"
   node "$HOME/.boqo-sniper/tools/moment.mjs" frames "<moment>/video.mp4" --at <peakOffsetSec> --out "<moment>"
   ```
   - `read` gives `meta`, `topChat` (the 8 messages chat repeated most, from 15 s before the peak to 25 s after it,
     with their counts), `chatPerSec` (messages a second in each 10 s of the file, from its start) and
     `durationSec` (the file's length).
   - `words` gives the transcript as `lines`, each `[m:ss] text (start-end)`: where it starts, and its first and
     last word's exact times in seconds.
   - `frames` writes two stills, 6 s before the peak and 2 s after it: look at both `frames[].file` when you can
     read images.
4. **Judge** by `judge.md`, and write `<moment>/judge.json`. A `skip`: `rm -f "<moment>/video.mp4"`, log it (step 9),
   and go back to step 1.
5. **Check the edges.** Write `<moment>/pick.json`, `[{"s": …, "e": …, "title": "…"}]` (with `"hook"` when the
   verdict has one). Then, with `<length>` the `durationSec` from step 3:
   ```sh
   node "$HOME/.boqo-sniper/tools/picks-check.mjs" "<moment>/pick.json" --duration <length> \
     --words "<moment>/words.json" --min 15 --max 60 --count-min 1 --count-max 1 > "<moment>/checked.json"
   ```
   Read `<moment>/checked.json`.
   - `"ok": false`: fix what its `errors` name in `pick.json`, and check again.
   - `"ok": true`: the pick carries `moved: {s, e}`, how far each edge moved to a word boundary. An edge that moved
     1 s or more landed somewhere you did not choose: read the words there (`moment.mjs words
     "<moment>/words.json" --around <sec>`), set that edge in `pick.json` yourself, and check again, once.
6. **Render**, then free the disk:
   ```sh
   node "$HOME/.boqo-sniper/tools/render.mjs" --src "<moment>/video.mp4" --picks "<moment>/checked.json" \
     --words "<moment>/words.json" --brand "<name>" --out "<clips>"
   ```
   It gives `{"clips": [{file, s, e, title}]}`. Then `rm -f "<moment>/video.mp4"`; the small files stay. The layout is
   `blur` (the whole picture over a blurred fill of itself), which keeps a streamer's facecam in frame; `--layout crop`
   (a centre crop) only when the person asks.
7. **Show it.** One line: the title, the length (`e - s`, in whole seconds) and `<clips>/clip-01.mp4`.
8. **Post** by the rule (Posting).
9. **Log.** Append one line to `<home>/boqo-sniper/runs.md`, starting with the local date and time
   (`date "+%F %H:%M"`):
   - a clip: `<YYYY-MM-DD HH:MM> | <channel> <session name> | <moment name> | clip <n> s | <title> | <clip file> | posted 0`,
     or, once posted, `… | posted 1 <projectId>`;
   - a skip: `<YYYY-MM-DD HH:MM> | <channel> <session name> | <moment name> | skip | <reason>`.

**The status line.** Every 10 moments, or every 30 minutes since the last thing you told the person, whichever comes
first, one line: `Watching <channel>: <watched time>, <moments> moments, <kept> clips.` Nothing else while it is
quiet.

## Posting

`post.md` has the steps. Here there is one clip per moment, so its batch wording ("best first", telling what went
after a batch) does not apply. Its steps run once per session, then once per clip:
- **Once, before the first clip is offered or posted,** post.md → Before the first clip, steps 1, 2 and 4: the boqo
  tools, the plan and the accounts. Its step 3, the rule, runs for each clip as below. Posting is off for the rest of
  the session, and no clip waits for an answer, when:
  - there are no boqo tools;
  - the plan has no publishing: say once, "Autoposting comes with the 7-day trial or Starter from $12";
  - no account is active: say once that they connect or reconnect one in boqo, under Accounts. When they say it is
    connected, run steps 2 and 4 again.
- **`ask`:** after showing a clip, ask "Post it? Where?" and wait. The first time, say that while you wait the loop
  is paused: the watch keeps recording and moments queue up for when they answer. Offer the hands-free rule once:
  post automatically, up to N a day, to the accounts they name (onboarding.md → The posting rule writes it). A no,
  or "later": the clip stays on disk; back to the loop.
- **`{"auto": N}`:** today's posts so far are
  ```sh
  grep "^$(date +%F) " "<home>/boqo-sniper/runs.md" | grep -cF "| posted 1"
  ```
  (it prints `0`, and exits 1, when there are none). Fewer than N: post the clip with no question to the config's
  `accounts`, then one line saying where it went. N reached: keep clipping, and say once that today's posts are
  done. No `accounts` in the config: ask once which accounts, and save them into `config.json`; until they answer,
  this clip goes by `ask`.
- Each post: post.md → Each clip, with `<clips>` as its folder (the reply file goes there and is deleted after the
  upload). Keep the `projectId` from its step 4: it goes into the clip's line in `runs.md` (The loop, step 9).
- **A plan refusal in the middle of a session** ("Accounts and scheduling are on paid plans." from `create_upload`,
  or "Publishing needs a paid plan." from `post_video`): posting is off for the rest of the session. Say the plan
  line once; the watch and the loop go on clipping, and no clip waits for an answer. post.md's "stops them all" means
  the posts, never the watch. Any other refusal stops only that clip's post (post.md → Refusals).

## The end

**Stop.** When the person says stop (or end, enough, that's it): finish the moment in hand, if any, then
```sh
node "$HOME/.boqo-sniper/tools/stop.mjs" "<channel>"
```
`{"stopped": true, …}` returns once the watcher is gone; `{"stopped": false, …}` means nothing was running. Then the
report. Moments the watcher had cut and you had not judged yet stay where they are (the next watch of the channel
deletes them after a day); the report says how many. When the person says to finish them, run `next.mjs` and the
loop on each, until it says `stopped`.

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
2. **Report** in a few lines: watched time, moments, clips kept, skipped, posted, moments left unjudged, any post
   that failed (step 1), and the folder `<home>/boqo-sniper/clips/<channel>/`. Count this session's lines in
   `runs.md` with `grep -F "<channel> <session name> |" "<home>/boqo-sniper/runs.md" | grep -cF "<what>"`, `<what>`
   being `| clip `, `| skip |` and `| posted 1`. The moments are `status.mjs`'s `moments`; those left are the moments
   minus the clip and skip lines.
3. **Log** one line: `<YYYY-MM-DD HH:MM> | <channel> <session name> | end <state> | watched <h:mm> | <m> moments | <k> clips | <s> skipped | <p> posted`.
4. `offline`: offer to start again when the channel is back live.

**Changing the sensitivity.** "More moments" or "fewer": the `sensitivity` in `config.json`, 30 to 95 (70 by
default; higher catches more, and sound alone counts only from 70 up), in steps of 10. It applies to a new watch: say
so, and offer to restart now (Stop, then Starting, step 4), which starts a fresh buffer.

## Red flags

| Thought | Reality |
|---|---|
| "Chat exploded, so it's a clip" | A spike is a question, not an answer. No cause on stream, no clip (`judge.md`) |
| "Nine minutes and nothing: I'll tell them it's quiet" | A `timeout` is silent. The status line comes every 10 moments or 30 minutes |
| "The person said 'nice', so I'll post it" | Only the rule posts. With `ask`, a post needs a yes to posting |
| "I'll keep the moment's video in case they want a redo" | Delete `video.mp4` once judged: 140 MB a moment fills a disk in an evening |
| "I'll read chat.json to see what happened" | `moment.mjs read`. The whole file is hundreds of KB |
| "They said stop, but three moments are queued: I'll finish them" | Stop is quick. The queue waits unless they ask to finish it |
| "Publishing needs a paid plan, so the session is over" | Posting is off; the watch and the clipping go on |
| "`{"stopped": …}`, so all went well" | `failed` carries an `error`: say it, and offer to start again |
| "A YouTube or Kick stream is close enough" | Twitch only in this beta |
| "The watcher failed, I'll capture it myself with yt-dlp" | Say the error. The watcher is the only capture |
| "`M=…` once, then `$M` in every command" | The variable is gone in the next command. Write the path out |
