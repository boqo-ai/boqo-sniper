// ported from boqo-ai/boqo apps/worker/src/render/track.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
                                                 

/**
 * Spec §5.2: "reframe when needed", not continuous follow. The window holds
 * still until the subject drifts far enough to matter, then travels to
 * re-centre them and holds again.
 *
 * Constant velocity rather than an eased approach, measured rather than
 * assumed: an exponential ease matched this on framing (p95 0.28, 0.1%
 * outside) while producing 23 segments against 8 and 55 direction reversals
 * against 14, because it approaches asymptotically and never quite arrives,
 * so it keeps emitting fresh values. Reversals are the jitter signature.
 *
 * `seed` is the shot's summarised position, not its first sample. That is
 * what makes a shot with no real motion settle on exactly stage 2's
 * rectangle and emit a single value — the byte-identical guarantee in §5.6
 * gate 3 depends on it.
 */
export function smoothPath(
  samples             ,
  options                                                    ,
)              {
  const out              = [];
  let current = options.seed;
  let moving = false;
  let previousT                = null;

  for (const sample of samples) {
    // Elapsed time drives the speed cap, so a gap left by a detection
    // drop-out lets the window travel further in one step rather than
    // silently slowing the pan. The first sample has no predecessor and
    // therefore cannot move at all, which is the correct reading of "hold
    // the last known position".
    const dt = previousT === null ? 0 : sample.t - previousT;
    previousT = sample.t;

    if (!moving && Math.abs(sample.v - current) > options.deadzone) {
      moving = true;
    }

    if (moving && dt > 0) {
      const delta = sample.v - current;
      const step = options.maxPan * dt;
      if (Math.abs(delta) <= step) {
        current = sample.v;
        moving = false;
      } else {
        current += delta > 0 ? step : -step;
      }
    }

    out.push({ t: sample.t, v: current });
  }

  return out;
}

/**
 * Run-length compression over quantised values.
 *
 * The point that ENDS a hold is kept as well as the point that starts the
 * next move, so a hold renders as a flat segment rather than a ramp that
 * begins the moment the previous keypoint was emitted. Dropping it would
 * turn every hold into a slow drift — a subtle, constant motion which is
 * precisely what the dead zone exists to prevent.
 *
 * Quantised to whole pixels by default: the crop rectangle is integral
 * anyway, so sub-pixel differences cannot render and would only inflate the
 * segment count.
 */
export function compressPath(points             , quantum = 1)              {
  if (points.length === 0) return [];
  const q = (v        ) => Math.round(v / quantum) * quantum;

  const out              = [{ t: points[0] .t, v: q(points[0] .v) }];
  for (let i = 1; i < points.length; i += 1) {
    const value = q(points[i] .v);
    const previous = out[out.length - 1] ;
    if (value === previous.v) continue;
    // Keep the last point of the hold we are leaving, so the ramp starts
    // here rather than back at the hold's beginning.
    const before = points[i - 1] ;
    if (q(before.v) === previous.v && before.t !== previous.t) {
      out.push({ t: before.t, v: previous.v });
    }
    out.push({ t: points[i] .t, v: value });
  }
  return out;
}

/**
 * A compressed path as an ffmpeg `crop` x/y expression.
 *
 * Commas are escaped because the filtergraph parser splits arguments on `,`
 * before the expression parser ever sees the string: unescaped,
 * `if(lt(t,3),300,100)` fails with `No such filter: '3)'`, an error naming
 * neither crop nor the expression. Colons must never appear for the same
 * reason. Measured on ffmpeg 5.1.9, which is what production runs.
 *
 * A single-point path emits a bare integer, so a shot with no motion
 * produces byte-identical output to stage 2 (§5.6 gate 3).
 */
export function pathExpression(points             )         {
  if (points.length === 0) return "0";
  if (points.length === 1) return String(Math.round(points[0] .v));

  const lt = (t        ) => `lt(t\\,${t})`;
  let expression = String(Math.round(points[points.length - 1] .v));

  for (let i = points.length - 1; i > 0; i -= 1) {
    const a = points[i - 1] ;
    const b = points[i] ;
    const span = b.t - a.t;
    const segment =
      span <= 0
        ? String(Math.round(b.v))
        : `${Math.round(a.v)}+(t-${a.t})*(${Math.round(b.v)}-${Math.round(a.v)})/${span}`;
    expression = `if(${lt(b.t)}\\,${segment}\\,${expression})`;
  }

  // Before the first keypoint, hold its value rather than extrapolating the
  // first ramp backwards — a shot's own t starts at 0 and the first keypoint
  // may not.
  return `if(${lt(points[0] .t)}\\,${Math.round(points[0] .v)}\\,${expression})`;
}
