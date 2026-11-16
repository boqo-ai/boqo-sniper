<!-- copied from boqo-ai/boqo-clips skills/boqo-clips/onboarding.md @ 416d3ce; keep in step -->
# Onboarding

Runs from INSTALL.md step 6, and from a start that finds no brand kit or no `<home>/boqo-sniper/config.json` (SKILL.md →
Starting, step 2). Three parts, in order: the brand kit, the boqo connection, the posting rule and the sensitivity. Skip
a part that is done: a kit `node "$HOME/.boqo-sniper/tools/brand.mjs" list` already shows (kits are shared by every boqo
skill, so another one may have made it), the rule already in `config.json`.

Open with two sentences: in about two minutes you set up their brand kit (a name, a logo, two colours, and a caption
style they pick by looking at it), then start watching their Twitch or Kick channel. When they already named a channel, say
its watch starts right after.

## 1. The brand kit

`<samples>` is `<home>/boqo-sniper/samples`, written out in full in every command, in double quotes (SKILL.md →
Overview, Paths in commands). `mkdir -p "<samples>"` first.

Four questions. Ask the first two in one message.
1. **Name:** the brand's name, 1 to 40 letters, digits, spaces, `-` or `_`.
2. **Logo:** a PNG or JPG, as a file path or a URL. A PNG with a transparent background looks best. No logo is fine:
   the clips then carry none. A URL is fetched once into a scratch home, which also checks it is a PNG or JPG under
   10 MB:
   ```sh
   echo '{"name": "logo"}' > "<samples>/logo.json"
   BOQO_HOME="<samples>/home" node "$HOME/.boqo-sniper/tools/brand.mjs" save "<samples>/logo.json" --logo "<url>"
   ```
   From then on `<logo>` is the file its reply names in `brand.logo.file`.
3. **Two colours:** the caption text (usually white) and the accent, which marks the spoken word in the karaoke and
   highlight styles. Open the logo image and offer its strongest colour as the accent, in hex: "#E63946 from your
   logo, with white text?".
4. **Caption style,** by sight: render the four samples below, show them, and ask which one they want.

**The samples.** The sample kits are saved into a scratch home inside `<samples>`, so nothing real is saved before
the person chooses.
1. A 5 s source:
   ```sh
   ffmpeg -v error -y -f lavfi -i color=c=0x24242C:s=1920x1080:r=30:d=5 -c:v libx264 -pix_fmt yuv420p \
     "<samples>/src.mp4"
   ```
2. `<samples>/words.json`, the sample line (in the person's language when it is not English: keep the times, change
   the words):
   ```json
   [{"w":"Every","s":0.2,"e":0.55},{"w":"clip","s":0.55,"e":0.9},{"w":"gets","s":0.9,"e":1.25},
    {"w":"your","s":1.25,"e":1.5},{"w":"captions,","s":1.5,"e":2.1},{"w":"your","s":2.3,"e":2.55},
    {"w":"colours","s":2.55,"e":3.05},{"w":"and","s":3.05,"e":3.25},{"w":"your","s":3.25,"e":3.5},
    {"w":"logo.","s":3.5,"e":4.2}]
   ```
3. `<samples>/pick.json`: `[{"s": 0, "e": 5, "title": "<name>"}]`.
4. For each preset, `karaoke`, `punch`, `clean` and `highlight`: write `<samples>/<preset>.json`, the kit (below)
   with `"name": "<preset>"` and that preset, then
   ```sh
   BOQO_HOME="<samples>/home" node "$HOME/.boqo-sniper/tools/brand.mjs" save "<samples>/<preset>.json" --logo "<logo>"
   BOQO_HOME="<samples>/home" node "$HOME/.boqo-sniper/tools/render.mjs" --src "<samples>/src.mp4" \
     --picks "<samples>/pick.json" --words "<samples>/words.json" --brand "<preset>" --out "<samples>/<preset>"
   ```
   With no logo, leave out `--logo`. Each sample is `<samples>/<preset>/clip-01.mp4`.
5. One picture of the four side by side, at 2.8 s, in the order karaoke, punch, clean, highlight:
   ```sh
   ffmpeg -v error -y -ss 2.8 -i "<samples>/karaoke/clip-01.mp4" -ss 2.8 -i "<samples>/punch/clip-01.mp4" \
     -ss 2.8 -i "<samples>/clean/clip-01.mp4" -ss 2.8 -i "<samples>/highlight/clip-01.mp4" -filter_complex \
     "[0:v]scale=360:640[a];[1:v]scale=360:640[b];[2:v]scale=360:640[c];[3:v]scale=360:640[d];[a][b][c][d]hstack=4" \
     -frames:v 1 "<samples>/styles.jpg"
   ```
   Give the person `<samples>/styles.jpg` first, then the four clips, which show how the words move, and say
   what each does, a line each: karaoke shows 3 or 4 words, the spoken one in the accent; punch, 1 or 2 big uppercase
   words at a time, all in the text colour (no accent); clean, up to 6 words in the text colour; highlight, 3 or 4
   words, the spoken one on an accent box.

**The kit.** Once they choose, write `<samples>/brand.json` and save it for real:

```json
{
  "name": "<name>",
  "colors": { "text": "#FFFFFF", "accent": "#E63946" },
  "font": "Inter",
  "captions": { "preset": "karaoke" },
  "logo": { "corner": "tr" }
}
```

```sh
node "$HOME/.boqo-sniper/tools/brand.mjs" save "<samples>/brand.json" --logo "<logo>"
```

Then `rm -rf "<samples>"`, with the path written out in full (never empty), and tell the person in one line that the
kit is saved and every boqo skill uses it.
- A key not in the kit's schema is refused, and the error names it: fix the file, never work around it.
- On the person's ask only: `"font": "Anton"` (tall and condensed), `logo.corner` `tl`, `tr`, `bl` or `br`,
  `logo.scale` 0.08 to 0.3 (0.16, the share of the frame's width), `captions.position` 0.1 to 0.9 (0.72, how far
  down), `captions.size` 0.7 to 1.4 (1.0), and `"hook": false` for no title at the top.
- The first kit saved becomes the default; `brand.mjs default "<name>"` changes it.
- **Changing a kit later:** `brand.mjs show "<name>"`, change the keys in its `brand`, and save that with `--logo`
  again, or with `logo.file` as `show` printed it. A save with neither drops the logo.

## 2. The boqo connection

Look for boqo's tools: `list_accounts` among yours. A tool may be deferred (in Claude Code, search the tool list for
it) before its absence means anything.
- **With them:** call `list_accounts` and say, in one line, which accounts are connected (platform and handle: the
  text inside its `<data …>` tag), or that none are yet (they connect them in boqo, under Accounts).
- **Without them:** say once that clips work without boqo, and posting to TikTok, Instagram and YouTube from here
  needs the boqo connector. Give the one line for this agent:
  - Claude Code: `claude mcp add --transport http boqo https://mcp.boqo.ai/mcp`, then `/mcp` to sign in.
  - Cursor: the Add to Cursor button on https://boqo.ai/mcp, or `"boqo": {"url": "https://mcp.boqo.ai/mcp"}` under
    `mcpServers` in its `mcp.json`.
  - VS Code: `"boqo": {"type": "http", "url": "https://mcp.boqo.ai/mcp"}` under `servers` in its `mcp.json`.
  - Any other agent: add `https://mcp.boqo.ai/mcp` as a remote MCP server; https://boqo.ai/mcp has the steps per
    agent.

  Go on either way: nothing waits for it.

## 3. The posting rule

`mkdir -p "<home>/boqo-sniper"`. With boqo's tools, ask once: post each clip only after they say yes (the default), or
post automatically, up to N a day, to the accounts they name. Without them, write the default and ask only the
sensitivity.

**The sensitivity:** in the same message, how many moments to catch, from 30 to 95. 70, the default, suits most
streams; higher catches more moments, lower only the biggest. No answer is 70. The other session settings
(`autoClip`, `autoClipMinScore`, `windowSec`, `prompt`, `visionPerHour`) keep their defaults until the person asks
(SKILL.md → Settings).

`<home>/boqo-sniper/config.json`:
- `{"posting": "ask", "sensitivity": 70}`, the default;
- `{"posting": {"auto": 2}, "accounts": ["<account id>"], "sensitivity": 70}`, with the ids from `list_accounts`.

The rule and the sensitivity change only when the person says so ("post them automatically", "ask me first", "more
moments"): rewrite the file then.

Onboarding is done. With a channel from the person, go on at SKILL.md → Starting, step 2; without one, ask which
Twitch or Kick channel.
