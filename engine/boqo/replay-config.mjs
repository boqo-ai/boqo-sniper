// ported from boqo-ai/boqo apps/worker/src/select/replay-config.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
// Cut: the environment readers (`replayTunablesFromEnv`, `bridgeMaxSecFromEnv`,
// `nonNegativeIntegerFromEnv`) and their imports of ../env, ../logger and
// ../render/config. Hosted production sets none of the variables, so the skill
// uses the defaults as constants.
export { DEFAULT_REPLAY_TUNABLES } from "./replay.mjs";

/**
 * The replay curve's variables (B9 spec §3.3, §3.5), set by hand on Railway and
 * read on every call, so a value takes effect as soon as the process sees it.
 * Every default lives in `DEFAULT_REPLAY_TUNABLES` and `DEFAULT_BRIDGE_MAX_SEC`.
 */
export const DEFAULT_BRIDGE_MAX_SEC = 20;
