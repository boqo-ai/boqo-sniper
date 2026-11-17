<!-- copied from boqo-ai/boqo-clips skills/boqo-clips/post.md @ cd91bb8; keep in step -->
# Posting through boqo

Runs after a clip is shown (SKILL.md → The loop, step 3, and Posting). It posts only through boqo's tools, and only by
the rule in `<home>/boqo-sniper/config.json`. Posting the clip as it is costs no credits. Paths go into commands written
out in full, in double quotes (SKILL.md → Overview).

## Before the first clip

1. **No boqo tools** (no `list_accounts`, onboarding.md → 2): stop here. Posting is not offered unless the person
   asks; then give the one line for this agent from onboarding.md → 2.
2. **The plan.** `get_account`. Its `planKey` `none` (the plan "Free"): say "Autoposting comes with the 3-day trial
   or Starter from $12", and stop. Do not call `billing_link`; give a link only when the person asks how to start.
3. **The rule.**
   - `ask`, or no config file: offer it in one line ("Post any of these? Which, and where?") and wait. A no, or no
     answer: stop; the files stay where they are.
   - `{"auto": N}`: the clips go best first (`clip-01` first), up to N minus the posts already made today (today's
     `posted 1` lines in `posts.md`, SKILL.md → Posting), to the config's `accounts`, with no question. The person is
     told what went (step 7). No `accounts` in the config: as `ask`.
4. **The accounts.** `list_accounts`, the ones with status `active`. With `ask`, the person names them; several and
   no name: ask which, never choose for them. None active: say so (they connect or reconnect it in boqo, under
   Accounts), and stop.

## Each clip

One clip at a time. `<file>` is its path, `<k>` its number: its `n` in `<clips>/clips.json`, which holds its title
and hook. Both commands in step 2 read them from there: a title on a command line is the shell's to rewrite (SKILL.md
→ Rules).
1. `node "$HOME/.boqo-sniper/tools/boqo-upload.mjs" probe "<file>"` gives `sizeBytes`, `contentType` and `passthrough`.
   `passthrough: false`: say its `reasons` and skip the clip.
2. `node "$HOME/.boqo-sniper/tools/boqo-upload.mjs" name --run "<clips>" --n <k>` gives `filename`. An error (a `-`,
   `_` or `/`, a single word): reword that row's `title` in `<clips>/clips.json` without it (your file tool, 60
   characters at most), and run `name` again; the new title is the post's from here on.
   `node "$HOME/.boqo-sniper/tools/boqo-upload.mjs" caption --run "<clips>" --n <k>` gives the words boqo's own Clips
   page writes for a post from the clip's title and hook, `{tiktok, instagram, youtube}` (The caption). Add
   `--tags '<a>,<b>'`, in single quotes, only for hashtags the person named.
3. `create_upload {filename, contentType: "video/mp4", sizeBytes, kind: "post"}`. Write its reply, exactly as it came,
   to `<clips>/upload-<k>.json`. It holds signed upload URLs: never print them, quote them or put them in `runs.md`
   or `posts.md`.
4. `node "$HOME/.boqo-sniper/tools/boqo-upload.mjs" put "<file>" --reply "<clips>/upload-<k>.json"` gives
   `{"ok": true, "projectId", …}`: delete `<clips>/upload-<k>.json`. `"ok": false` or an error: say which part failed,
   and offer one retry, `put` again with the same reply file (its URLs live 48 hours). Once the person stops, delete
   `<clips>/upload-<k>.json`: it still holds live signed URLs.
5. `complete_upload {projectId}`. A link in its reply (a daily credit cap on this connection): give it to the person,
   and stop this clip.
6. `post_video {items: [{source: "<projectId>", accountIds: ["<id>", …], when: "queue"}]}`, once for this clip. It
   takes a Post project that is not ready yet, and boqo makes the post once the file is ready, so there is no need
   to wait first. `"queue"` is each account's next free slot; a time the person named is `{date: "YYYY-MM-DD", time:
   "HH:MM"}` on the account's own clock. `caption` only as The caption says, and no `uniqueize`.
   An unclear reply (a timeout, a dropped connection, no answer): never call `post_video` again for this clip; it
   may have gone through. `list_schedule {accountId, to: <35 days from today>}` for each of its accounts: a post of
   this clip there (its title) counts as posted; none: tell the person it may not have gone out.
7. One line: the clip, the accounts, and when it goes out.

**After the last clip,** delete any reply file left, `find "<clips>" -maxdepth 1 -type f -name 'upload-*.json' -delete`,
then `get_project {projectId}` for each one posted. `queued`, `processing` or `ready` is fine.
`failed`: tell the person which clip, with its `error` (the text inside its `<data kind="project_error">` tag); that
clip will not be posted. To look again later without a foreground `sleep` (Claude Code refuses one), run
`sleep 20` in the background and check when it ends.

## The caption

Boqo writes a post's words from the file name: the clip's title, plus the account's default tags. Hosted's own
Clips page writes more: the clip's hook, then its title, then the tags, each after a blank line (the `caption`
command in step 2; YouTube's title is the clip's title, its description the hook and the tags). Those words need
"Captions written by the agent" switched on in boqo (Accounts, the account, Defaults).
- **Not on, or not known:** leave `caption` out. The post says the title and the account's tags. The first time, say
  this one sentence and no more: "These posts carry only each clip's title and the account's tags; switch on
  'Captions written by the agent' in boqo (Accounts, the account, Defaults) and they carry the hook too."
- **On** (the person says so): pass `caption` in step 6, one for the clip: the `text` of `youtube` when every chosen
  account is on YouTube, else the `text` of `instagram` (it fits TikTok and YouTube too). Show the words in the
  one line of step 7. A caption written this way carries only the tags you gave `--tags`: boqo adds none of the
  account's own.
A refusal naming that setting: post again without `caption`.

## Refusals

A refusal from boqo is its own sentence: say it as it came, keep the files, stop that clip. A plan refusal stops them
all, with the plan line, "Autoposting comes with the 3-day trial or Starter from $12": "Accounts and scheduling are
on paid plans." from `create_upload`, or "Publishing needs a paid plan." from `post_video`.

Whether the clip was posted goes into `posts.md` with `moment.mjs posted` (SKILL.md → Posting).
