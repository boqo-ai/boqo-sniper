# boqo-sniper

Watch a Twitch stream live on your own PC and clip the moments chat goes wild, with your brand.

You name a Twitch channel and your agent starts a live session. A watcher records the stream in the background,
reads its chat and listens to its sound. When chat explodes, it cuts the last couple of minutes. Your agent then
transcribes the moment, judges whether it works as a clip, and renders a 9:16 short with burned-in captions and your
logo. It posts the clip only by the rule you set. The session runs until you say stop or the stream ends.

<!-- demo GIF -->

## Install

Tell your agent (Claude Code, Cursor, Codex, or any agent that reads skills):

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

Everything runs on your PC: the capture, chat, transcription, judging (by your own agent's model) and render. Your
clips stay on your disk. Posting goes through boqo: autoposting comes with the 7-day trial, or with Starter from $12.
Without boqo you keep the files.

## Hardware

- One watch per agent session. To watch two channels, open two sessions, as many as your PC carries.
- About 1 GB of disk while live: a 12-minute buffer plus the moments waiting to be judged.
- The capture is the stream as Twitch sends it (1080p60 on most channels), copied, never re-encoded. The CPU works
  hard only when a moment comes in: whisper and the render take a minute or two each.

## Beta

Twitch only in this beta. Kick comes next.

## The engine

The engine (`engine/`, shared tools) is vendored from boqo-ai/boqo-clips — edit it there, then run its `scripts/sync-engine.mjs`.

## Licence

MIT, see [LICENSE](LICENSE).
