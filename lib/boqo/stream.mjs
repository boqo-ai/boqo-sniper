// ported from boqo-ai/boqo packages/core/src/stream.ts @ bcc9d99cc; keep in step (scripts/boqo-drift.mjs)
/**
 * The Stream Sniper vocabulary (C1 design §5.1). Pure and dependency-free:
 * the web validates against it, the watcher writes with it, and the tile
 * labels from it, so the three cannot drift.
 */

export const STREAM_PLATFORMS = ["twitch", "kick"]         ;
                                                               

                                                                          

/**
 * Twitch logins: 3-25 of [a-z0-9_]. The vocabulary this module chooses to
 * accept (design §5.1) — not a cited or measured claim about Twitch's own
 * validation rule; §1.5, the spec's one measured-platform section, does
 * not establish it either.
 */
const TWITCH_LOGIN = /^[a-z0-9_]{3,25}$/;
/**
 * Kick slugs: 1-50 of [a-z0-9_-]. The vocabulary this module chooses to
 * accept (design §5.1), likewise not a cited platform fact. Load-bearing
 * point: `parseStreamChannel` lowercases every input unconditionally
 * before this pattern ever runs, which is safe only because this module
 * treats a Kick slug as case-insensitive by its own policy — not because
 * Kick is known to lowercase slugs itself, which was never measured.
 */
const KICK_SLUG = /^[a-z0-9_-]{1,50}$/;

const TWITCH_HOSTS = new Set(["twitch.tv", "www.twitch.tv", "m.twitch.tv"]);
const KICK_HOSTS = new Set(["kick.com", "www.kick.com"]);

/**
 * `twitch.tv/xqc`, `https://www.twitch.tv/xqc`, `kick.com/xqc`, `twitch:xqc`,
 * `kick:xqc` — lowercased, trimmed, with a trailing slash or a query
 * tolerated. Anything with a second path segment (`/videos/…`) is not a
 * channel. Null rather than a throw: the route turns it into a 400 sentence.
 */
export function parseStreamChannel(input        )                       {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;

  const shorthand = /^(twitch|kick):([^/?#\s]+)$/.exec(trimmed);
  if (shorthand) return validate(shorthand[1]                  , shorthand[2] ?? "");

  const withScheme = /^[a-z]+:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url     ;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // A clip link is a Blur source, never a channel (C6 spec §6.1). The
  // `kick.com/<ch>?clip=clip_…` form parsed as the channel until this line.
  if (url.searchParams.has("clip")) return null;

  const segments = url.pathname.split("/").filter((s) => s !== "");
  if (segments.length !== 1) return null;
  const name = segments[0] ?? "";

  if (TWITCH_HOSTS.has(url.hostname)) return validate("twitch", name);
  if (KICK_HOSTS.has(url.hostname)) return validate("kick", name);
  return null;
}

function validate(platform                , channel        )                       {
  const pattern = platform === "twitch" ? TWITCH_LOGIN : KICK_SLUG;
  return pattern.test(channel) ? { platform, channel } : null;
}

/**
 * A channel name as the watcher accepts it, lowercased first. Blur's
 * detection reads a clip link's channel through this, so a clip and a watch
 * agree on what a channel name is.
 */
export function streamChannel(platform                , name        )                       {
  return validate(platform, name.toLowerCase());
}

/** The short form the tile, the notice and the log carry. */
export function streamChannelLabel(c               )         {
  return c.platform === "twitch" ? `twitch.tv/${c.channel}` : `kick.com/${c.channel}`;
}

/** What streamlink is given. */
export function streamUrl(c               )         {
  return c.platform === "twitch" ? `https://www.twitch.tv/${c.channel}` : `https://kick.com/${c.channel}`;
}

// (port: the rest of boqo's stream.ts, the stage, bound, moment and Redis-key vocabulary of the hosted app, is not ported: no part of the skill reads it.)
