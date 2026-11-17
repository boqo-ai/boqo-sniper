// ported from boqo-ai/boqo apps/watcher/src/watch/buckets.ts @ 0fe2ee1c1; keep in step (scripts/boqo-drift.mjs)
/**
 * Values keyed by the wall-clock second they arrived in — chat messages and
 * loudness readings both land here, and the session drains one second per
 * detector tick (C1 design §4.4, §4.5). `take` is destructive so a second is
 * counted once; `dropBefore` bounds memory if a tick is ever missed.
 */
export class SecondBuckets    {
                   buckets = new Map             ();

  add(atMs        , value   )       {
    const second = Math.floor(atMs / 1000);
    const bucket = this.buckets.get(second);
    if (bucket) bucket.push(value);
    else this.buckets.set(second, [value]);
  }

  take(secondEpoch        )      {
    const bucket = this.buckets.get(secondEpoch) ?? [];
    this.buckets.delete(secondEpoch);
    return bucket;
  }

  dropBefore(secondEpoch        )       {
    for (const key of this.buckets.keys()) if (key < secondEpoch) this.buckets.delete(key);
  }
}
