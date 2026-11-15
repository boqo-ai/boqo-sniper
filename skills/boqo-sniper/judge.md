# Judging a moment

The watcher cut this moment because chat, or the stream's sound, spiked. Chat spikes for many reasons, and most are
not clips. You decide whether this one is, and where it starts and ends. The person sees only the clips you keep:
a weak clip costs their account more than a skipped moment costs them.

## What you read

- **The summary** (SKILL.md → Helpers → Read a moment):
  - where the peak sits in the file;
  - chat per 10 s across the whole file;
  - the lines chat repeated most around the peak;
  - the transcript, with a `◆ peak` line where the peak falls.
- **The frames** (SKILL.md → Helpers → Frames), when you can read images: four stills from before the peak to
  after it.

Times are seconds in the moment's file, about 160 s long, with the peak about 125 s in. Chat reacts 2 to 10 s after
what caused it, so the cause sits before the peak.

## Clip it when

All three hold:
- **The spike has a cause you can point to:** something said or heard in the transcript, or seen in the frames, just
  before chat goes off. Chat often names it ("CLIP IT", "NO SHOT", "he really said that", the player's name). The
  cause has to happen on the stream.
- **It stands alone in 15 to 60 s.** A stranger scrolling past, who never saw this stream, gets it without the
  last hour.
- **It opens near the setup, not on the payoff:** a few seconds before the thing that set chat off, so the viewer
  sees it coming. Examples: the question before the answer, the clutch before the win, the line before the
  punchline. Never a minute of lead-in, and never the reaction alone.

## Skip it when

- **An ad:** an ad break, a "commercial break" screen, a sponsor read.
- **Chat talking to itself:** a raid ("raiding with …", a wall of the raider's emote), a host, a sub train or gifted
  subs ("thanks for the 50 gifted"), bits, a hype train, a poll or prediction result, or an emote war or copypasta.
- **Chat answering the streamer:** a question ("is it even $100?") or a show of hands, and chat types numbers, yes
  or no. That is chat talking, not something happening.
- **Chat reacting to something off-stream:** another stream, a tweet, a message in chat, a mod or a ban.
- **Someone else's video:** the streamer plays a clip, a post or another stream (a reaction stream), and chat reacts
  to that video while the streamer barely does. The clip would be that video, not this stream. When the streamer's
  own reaction is the funny part (a line, a face, a rant), it is theirs: clip it, with only as much of the video as
  the reaction needs.
- **Nothing on stream explains it:** no line in the transcript, nothing in the frames.
- **The cause is cut off:** it happened before the file starts, or it needs context a clip cannot carry (a running
  joke, an inside reference).
- **A screen with no stream on it:** "starting soon", "be right back", the ending screen.
- **Harm, not humour:** a slur, real injury or distress, a private address or a phone number on screen.

When in doubt, skip.

## Edges

- `s` and `e` are seconds in the moment's file: `0 <= s < e <=` its length, and `e - s` is 15 to 60 s. 20 to 40 s
  suits most stream moments.
- `s`: the start of the setup. When it starts with speech, put `s` a little inside its first word (the word's
  start plus 0.05), not between words.
- `e`: after the payoff and the streamer's first reaction to it, before the next topic. When the last thing is
  speech, put `e` a little inside its last word (the word's end minus 0.05).
- `picks-check.mjs` moves an edge out to the nearest word's boundary when one is within 1.5 s; an edge in gameplay
  or music with no words near it stays where you put it.

## Title

- Under 60 characters, in the stream's language. Say what happens, not that something does: "Clutches a 1v4
  with only a pistol", not "You won't believe this".
- The streamer's name helps when people search for it.
- At least two words. No `-`, `_` or `/`: the title becomes the post's file name, where boqo reads `-` and `_` as
  spaces. No hashtags, no emoji, no sentence in all caps.
- Optional `hook`: at most 6 words, shown at the top for the clip's first 3 s when the brand has hooks on. Without
  one, the title is shown there.

## The verdict

Write it to `<moment>/judge.json`:

```json
{"decision": "clip", "s": 98.4, "e": 131.2, "title": "Clutches a 1v4 with only a pistol", "reason": "the 1v4 at 1:52; chat 'NO SHOT' x40"}
```

```json
{"decision": "skip", "reason": "raid: chat is the raiders' emote, nothing happens on stream"}
```

`reason` is one line, the evidence for the decision; it goes into `runs.md`. A `clip` verdict may carry `"hook"`
too.
