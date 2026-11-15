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

- **Tools:** `node ~/.boqo-sniper/tools/<tool>.mjs`, always by that path.
- **`<home>`:** `$BOQO_HOME`, or `~/.boqo` when it is unset (`echo "${BOQO_HOME:-$HOME/.boqo}"`). Brand kits live in
  `<home>/brands/` and are shared by every boqo skill. This skill's own files: `<home>/boqo-sniper/config.json` (the
  posting rule and the sensitivity) and `<home>/boqo-sniper/runs.md` (one line per moment).
- **`<channel>`:** the Twitch login, in lower case (`twitch.tv/<login>`).
- **`<session>`:** the folder the watcher records into, `<home>/boqo-sniper/<channel>/<YYYYMMDD-HHMMSS>/`. Its
  name, `<session name>`, is its UTC start. `status.mjs` prints it as `session`.
- **`<moment>`:** a folder `next.mjs` hands you, inside `<session>/moments/`. Its name, `<moment name>`, is the
  peak's UTC second. It holds `video.mp4` (about 160 s at the stream's quality, about 140 MB, the peak about 125 s
  in), `chat.json` (every chat line, `t` in seconds from the file's start) and `meta.json` (`peakOffsetSec`,
  `score`, `reason`).
- **`<clips>`:** `<home>/boqo-sniper/clips/<channel>/<moment name>/`, where the clip lands as `clip-01.mp4`. It sits
  outside `<session>` because the next watch of the channel deletes moments older than a day.

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
- **The person's language.** Answer in the language the person writes in. Titles are in the stream's language.
  Files stay in English.
- **Short messages:** what happened, what comes next. No tour of the tools unless asked.
- **Long commands:** `next.mjs` waits up to 540 s, and whisper and render take a minute or two each on a CPU. Give
  every command in the loop up to 10 minutes (Claude Code: the shell tool's `timeout` of 600000).
- **Disk:** the watcher keeps about 700 MB of buffer while it runs, and every moment adds about 140 MB until you
  delete its `video.mp4` (The loop, steps 4 and 6).
- **The person can talk to you between tool calls.** Answer them, then go back to the loop where you left it.
- Install nothing without the person's yes; never run `npm install`. An error naming ffmpeg, ffprobe, yt-dlp,
  streamlink or whisper-cli: run `node ~/.boqo-sniper/tools/doctor.mjs --node 22 --whisper required --streamlink` and
  give the person its `hints`.

## Starting

`/boqo-sniper <channel or link> [brand]`. With neither, ask which Twitch channel.

1. **The channel.** `twitch.tv/<login>` (with or without `https://www.`) or a bare login gives `<channel>`: letters,
   digits and `_` only, in lower case. `kick.com/…`, YouTube or any other link: Rules → Twitch only.
2. **Brand and config.** `node ~/.boqo-sniper/tools/brand.mjs show [<brand>]` (no name: the default kit).
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
     node ~/.boqo-sniper/tools/watch.mjs <channel> --sensitivity <n>
     ```
   - Another agent on macOS or Linux, detached:
     ```sh
     mkdir -p <home>/boqo-sniper
     nohup node ~/.boqo-sniper/tools/watch.mjs <channel> --sensitivity <n> > <home>/boqo-sniper/<channel>.log 2>&1 &
     ```
   - Another agent in Windows PowerShell:
     ```powershell
     $h = if ($env:BOQO_HOME) { $env:BOQO_HOME } else { "$HOME\.boqo" }
     New-Item -ItemType Directory -Force "$h\boqo-sniper" | Out-Null
     Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "$HOME\.boqo-sniper\tools\watch.mjs","<channel>","--sensitivity","<n>" -RedirectStandardOutput "$h\boqo-sniper\<channel>.log" -RedirectStandardError "$h\boqo-sniper\<channel>.err.log"
     ```
5. **Check it runs.** `node ~/.boqo-sniper/tools/status.mjs <channel>` about every 10 s, for up to a minute, until
   `state` is `live` (recording) or `waiting` (no picture yet) with `updatedAt` in the last minute. Keep its
   `session`. When the watcher ends instead, its one line (Claude Code: the background task's output; elsewhere the
   `.log` file) says why:
   - `already watching <channel> …`: another chat, or an earlier one, is watching this channel. Ask whether to stop
     that watch and watch here instead; on a yes, `stop.mjs <channel>` (The end → Stop), then step 4 again.
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
   node ~/.boqo-sniper/tools/next.mjs <channel>
   ```
   - `{"moment": "<moment>", "meta": {…}}`: go on with step 2.
   - `{"timeout": true, "status": {…}}`: run step 1 again, silently. When `status.updatedAt` is more than 3 minutes
     old, the watcher died without saying so: run `stop.mjs <channel>` (it cleans up), tell the person, offer to
     start again (Starting, step 3), and go to The end.
   - `{"stopped": "<state>"}`: The end.
2. **Transcribe.**
   ```sh
   node ~/.boqo-sniper/tools/asr.mjs <moment>/video.mp4 --out <moment>/words.json
   ```
   Then Helpers → Drop sound tags on `<moment>/words.json`: whisper writes sounds as words, `(upbeat music)`, and a
   clip would burn them into its captions. `{"words": 0, …}` is a moment with no speech, gameplay or music only:
   judge it on chat and the frames.
3. **Read it.** Helpers → Read a moment, and Helpers → Frames when you can read images. Never read `chat.json` or
   `words.json` whole: a busy chat writes hundreds of KB.
4. **Judge** by `judge.md`, and write `<moment>/judge.json`. A `skip`: delete `<moment>/video.mp4`, log it (step 9),
   and go back to step 1.
5. **Check the edges.** Write `<moment>/pick.json`, `[{"s": …, "e": …, "title": "…"}]` (with `"hook"` when the
   verdict has one). Then the file's length, and the check:
   ```sh
   ffprobe -v error -show_entries format=duration -of csv=p=0 "<moment>/video.mp4"
   node ~/.boqo-sniper/tools/picks-check.mjs <moment>/pick.json --duration <length> --words <moment>/words.json \
     --min 15 --max 60 --count-min 1 --count-max 1 > <moment>/checked.json
   ```
   Read `<moment>/checked.json`.
   - `"ok": false`: fix what its `errors` name in `pick.json`, and check again.
   - `"ok": true`: the pick carries `moved: {s, e}`, how far each edge moved to a word boundary. An edge that moved
     1 s or more landed somewhere you did not choose: look at the words there (Helpers → Words around a time), set
     that edge in `pick.json` yourself, and check again, once.
6. **Render**, then free the disk:
   ```sh
   node ~/.boqo-sniper/tools/render.mjs --src <moment>/video.mp4 --picks <moment>/checked.json \
     --words <moment>/words.json --brand "<name>" --out <clips>
   ```
   It gives `{"clips": [{file, s, e, title}]}`. Then delete `<moment>/video.mp4`; the small files stay. The layout is
   `blur` (the whole picture over a blurred fill of itself), which keeps a streamer's facecam in frame; `--layout
   crop` (a centre crop) only when the person asks.
7. **Show it.** One line: the title, the length (`e - s`, in whole seconds) and `<clips>/clip-01.mp4`.
8. **Post** by the rule (Posting).
9. **Log.** Append one line to `<home>/boqo-sniper/runs.md`:
   - a clip: `<YYYY-MM-DD HH:MM> | <channel> <session name> | <moment name> | clip <n> s | <title> | <clip file> | posted <0 or 1>`;
   - a skip: `<YYYY-MM-DD HH:MM> | <channel> <session name> | <moment name> | skip | <reason>`.

**The status line.** Every 10 moments, or every 30 minutes since the last thing you told the person, whichever comes
first, one line: `Watching <channel>: <watched time>, <moments> moments, <kept> clips.` Nothing else while it is
quiet.

## Posting

`post.md` has the steps. Here they run once per session and then once per clip:
- **Once, before the first clip is offered or posted,** post.md → Before the first clip: the boqo tools, the plan
  and the accounts. No boqo tools, or a plan without publishing (say once: "Autoposting comes with the 7-day trial
  or Starter from $12"): the session goes on without posting, and no clip waits for an answer.
- **`ask`:** after showing a clip, ask "Post it? Where?" and wait. The first time, say that while you wait the loop
  is paused: the watch keeps recording and moments queue up for when they answer. Offer the hands-free rule once:
  post automatically, up to N a day, to the accounts they name (onboarding.md → The posting rule writes it). A no,
  or "later": the clip stays on disk; back to the loop.
- **`{"auto": N}`:** post the clip with no question while today's clips with `posted 1` in `runs.md` are fewer than
  N, to the config's `accounts`; then one line saying where it went. N reached: keep clipping, and say once that
  today's posts are done.
- Each post: post.md → Each clip, with `<clips>` as its folder (the reply file goes there and is deleted after the
  upload).

## The end

**Stop.** When the person says stop (or end, enough, that's it):
```sh
node ~/.boqo-sniper/tools/stop.mjs <channel>
```
`{"stopped": true, …}` returns once the watcher is gone; `{"stopped": false, …}` means nothing was running. Then
`next.mjs` hands out the moments the watcher had already cut, at once: judge and render them as usual, until it
says `stopped`. When the person wants to end right away, delete those moments' `video.mp4` instead.

**`{"stopped": …}`.** The watch is over: `stopped` after a stop, `offline` after 10 minutes with the stream offline.
1. **Report** in a few lines: watched time, moments, clips kept, skipped, posted, and the folder
   `<home>/boqo-sniper/clips/<channel>/`. Count from this session's lines in `runs.md`
   (`grep "<channel> <session name>" <home>/boqo-sniper/runs.md`: `| clip`, `| skip`, `posted 1`).
2. **Log** one line: `<YYYY-MM-DD HH:MM> | <channel> <session name> | end <state> | watched <h:mm> | <m> moments | <k> clips | <s> skipped | <p> posted`.
3. `offline`: offer to start again when the channel is back live.

**Changing the sensitivity.** "More moments" or "fewer": the `sensitivity` in `config.json`, 30 to 95 (70 by
default; higher catches more, and sound alone counts only from 70 up), in steps of 10. It applies to a new watch: say
so, and offer to restart now (Stop, then Starting, step 4), which starts a fresh buffer.

## Helpers

**Read a moment** (`<moment>` as the argument): the peak, chat per 10 s, the lines chat repeated most from 15 s
before the peak to 25 s after it, and the transcript in lines of about 8 s with `◆` where the peak falls.

```sh
node -e "const f=require('fs'),p=require('path'),d=process.argv[1],r=n=>JSON.parse(f.readFileSync(p.join(d,n),'utf8'));const m=r('meta.json'),c=r('chat.json'),w=r('words.json'),k=m.peakOffsetSec,ts=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');console.log('peak at '+ts(k)+' ('+k+' s), '+m.reason+', score '+m.score+', '+c.length+' chat lines');const b=[];c.forEach(x=>{const i=Math.floor(x.t/10);b[i]=(b[i]||0)+1});console.log('chat per 10 s: '+Array.from(b,(n,i)=>ts(i*10)+' '+(n||0)).join(' | '));const t={};c.filter(x=>x.t>=k-15&&x.t<k+25).forEach(x=>{const s=String(x.text||'').toLowerCase().split(/\s+/).filter((y,i,a)=>y&&y!==a[i-1]).join(' ').slice(0,80);if(s){t[s]=t[s]||{s,n:0,at:x.t};t[s].n++}});console.log('top chat around the peak:');Object.values(t).sort((a,z)=>z.n-a.n).slice(0,15).forEach(x=>console.log('  '+x.n+'x '+JSON.stringify(x.s)+' from '+ts(x.at)));console.log('transcript:'+(w.length?'':' (no speech)'));let l=null,pk=false;const out=()=>{if(!pk&&l.s>k){console.log('['+ts(k)+'] ◆ peak');pk=true}console.log('['+ts(l.s)+'] '+l.t.join(' '))};w.forEach(x=>{if(l&&x.s>=l.s+8){out();l=null}if(!l)l={s:x.s,t:[]};l.t.push(x.w)});if(l)out();if(!pk)console.log('['+ts(k)+'] ◆ peak')" "<moment>"
```

**Frames:** four stills, at 30, 12 and 5 s before the peak and 5 s after it, in one picture. `<a>`, `<b>`, `<c>`,
`<d>` are `peakOffsetSec` − 30, − 12, − 5 and + 5 (none below 0). Then read `<moment>/frames.jpg`.

```sh
ffmpeg -v error -y -ss <a> -i "<moment>/video.mp4" -ss <b> -i "<moment>/video.mp4" -ss <c> -i "<moment>/video.mp4" \
  -ss <d> -i "<moment>/video.mp4" -filter_complex \
  "[0:v]scale=640:360[a];[1:v]scale=640:360[b];[2:v]scale=640:360[c];[3:v]scale=640:360[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack" \
  -frames:v 1 "<moment>/frames.jpg"
```

**Drop sound tags** (rewrites the file without whisper's bracketed sounds, `(upbeat music)`, `[Laughter]`; prints
how many it dropped):

```sh
node -e "const f=require('fs'),p=process.argv[1],w=JSON.parse(f.readFileSync(p,'utf8')),t=i=>String(w[i].w).trim(),k=[];for(let i=0;i<w.length;i++){if(/^[(\[]/.test(t(i))){let j=i;while(j<w.length&&j<i+6&&!/[)\]][.,!?]*$/.test(t(j)))j++;if(j<w.length&&j<i+6){i=j;continue}}k.push(w[i])}f.writeFileSync(p,JSON.stringify(k));console.log(JSON.stringify({words:k.length,dropped:w.length-k.length}))" "<moment>/words.json"
```

**Words around a time** (`<sec>` in seconds; each line is `start end word`):

```sh
node -e "const w=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')),t=+process.argv[2];console.log(w.filter(x=>x.s>t-8&&x.s<t+8).map(x=>x.s+' '+x.e+' '+x.w).join('\n'))" "<moment>/words.json" <sec>
```

## Red flags

| Thought | Reality |
|---|---|
| "Chat exploded, so it's a clip" | A spike is a question, not an answer. No cause on stream, no clip (`judge.md`) |
| "Nine minutes and nothing: I'll tell them it's quiet" | A `timeout` is silent. The status line comes every 10 moments or 30 minutes |
| "The person said 'nice', so I'll post it" | Only the rule posts. With `ask`, a post needs a yes to posting |
| "I'll keep the moment's video in case they want a redo" | Delete `video.mp4` once judged: 140 MB a moment fills a disk in an evening |
| "I'll read chat.json to see what happened" | Helpers → Read a moment. The whole file is hundreds of KB |
| "The watcher stopped, so the session is over" | `next.mjs` still hands out the moments already cut; judge them, then report |
| "A YouTube or Kick stream is close enough" | Twitch only in this beta |
| "The watcher failed, I'll capture it myself with yt-dlp" | Say the error. The watcher is the only capture |
