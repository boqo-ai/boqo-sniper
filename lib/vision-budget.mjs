// The images the agent may look at in a rolling hour (spec §7.7, `visionPerHour`, default 600). Each read of
// frames asks for its count first: `take(n)` is true and spends n, or false and spends nothing.
// `now` is a clock in seconds (epoch or any steady one); tests pass their own.

export const VISION_WINDOW_SEC = 3600;

export function visionBudget({ perHour = 600, now = () => Date.now() / 1000 } = {}) {
  const spent = []; // [t, n], oldest first
  let used = 0;

  function expire(t) {
    // a reading older than an hour is out; one of exactly an hour is still in
    while (spent.length && t - spent[0][0] > VISION_WINDOW_SEC) used -= spent.shift()[1];
  }

  return {
    take(n) {
      if (!Number.isInteger(n) || n <= 0) return false;
      const t = now();
      expire(t);
      if (used + n > perHour) return false;
      spent.push([t, n]);
      used += n;
      return true;
    },
    used() {
      expire(now());
      return used;
    },
  };
}
