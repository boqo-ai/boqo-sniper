# boqo-sniper

Watch a Twitch or Kick stream live on your own PC and clip the moments chat goes wild, with your brand.

You name a Twitch or Kick channel (`kick:<slug>` or `kick.com/<slug>`) and your agent starts a live session. A watcher
records the stream in the background, reads its chat and listens to its sound. When chat explodes, it cuts the last
five minutes, with the peak about 270 s in. Your agent then transcribes the moment, selects the clips in it, and
renders 9:16 shorts with burned-in captions and your logo. It posts a clip only by the rule you set. The session runs
until you say stop or the stream ends.

<!-- demo GIF -->

## Install

Tell your agent (tested with Claude Code; any agent with a terminal, such as Cursor or Codex, can follow the same
steps):

> Read https://raw.githubusercontent.com/boqo-ai/boqo-sniper/main/INSTALL.md and follow it.

It copies the skill to `~/.boqo-sniper`, checks your tools, installs nothing without your yes, and starts with your
brand kit.

## Requirements

- Node 22 or newer
- ffmpeg with libass
- yt-dlp
- whisper.cpp (`whisper-cli`) and a model; it writes every clip's captions

The watcher records with yt-dlp, ads and all. streamlink, which skips Twitch's ads, is opt-in and untested in this
beta: `"capture": "streamlink"` in `~/.boqo/boqo-sniper/config.json` turns it on.

The install's doctor names what is missing and how to get it on macOS, Windows and Linux.

## What runs where

Everything runs on your PC: the capture, chat, transcription, selection (by your own agent's model) and render. Your
clips stay on your disk. Posting goes through boqo: autoposting comes with the 7-day trial, or with Starter from $12.
Without boqo you keep the files.

Want boqo to do the whole job instead? Hand it over at [boqo.ai](https://boqo.ai) — that runs on credits.

## Hardware

- One watch per agent session. To watch two channels, open two sessions, as many as your PC carries.
- Disk while live: about 320 MB for the 6-minute buffer (300 s window plus 60 s) at 1080p60, plus about 260 MB for each
  moment waiting for your agent. At most 10 wait (about 2.6 GB); past that, or with less than 5 GB free, the watcher
  skips new moments. Moments below your bar are listed for "clip it" and the newest 3 are kept.
- The capture is the stream as it is sent (1080p60 on most channels), copied, never re-encoded. The CPU works hard only
  when a moment comes in: whisper and the render take a few minutes.

## Settings

In `~/.boqo/boqo-sniper/config.json`, read when a watch starts: `sensitivity` 30 to 95 (70), `autoClip` (on),
`autoClipMinScore` 50 to 95 (80), `windowSec` 120 to 600 (300), `prompt` (what to watch for, 300 characters),
`visionPerHour` (600 images an hour).

## Beta

Twitch and Kick. Kick's endpoints are undocumented and sit behind Cloudflare: from a network they refuse, the watcher
ends with `kick refused: <status>`.

## The engine

The engine (`engine/`, shared tools) is vendored from boqo-ai/boqo-clips — edit it there, then run its `scripts/sync-engine.mjs`.

## Licence

MIT, see [LICENSE](LICENSE).
