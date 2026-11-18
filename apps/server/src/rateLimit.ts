/** Classic token bucket: `capacity` burst, refilled continuously at `refillPerSec`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(readonly capacity: number, readonly refillPerSec: number, private readonly now: () => number = Date.now) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
  }

  /** Take `cost` tokens. Returns 0 on success, or the ms to wait until it would succeed. */
  take(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) { this.tokens -= cost; return 0; }
    return Math.ceil(((cost - this.tokens) / this.refillPerSec) * 1000);
  }

  get idle(): boolean { this.refill(); return this.tokens >= this.capacity; }
}

export type BucketSpec = { capacity: number; refillPerSec: number };

/** Buckets per (key, action). Used both per connection and per public key so reconnecting doesn't reset limits. */
export class KeyedLimiter<A extends string> {
  private readonly buckets = new Map<string, Map<A, TokenBucket>>();
  constructor(private readonly specs: Record<A, BucketSpec>, private readonly now: () => number = Date.now) {}

  take(key: string, action: A, cost = 1): number {
    let perKey = this.buckets.get(key);
    if (!perKey) { perKey = new Map(); this.buckets.set(key, perKey); }
    let bucket = perKey.get(action);
    if (!bucket) { const spec = this.specs[action]; bucket = new TokenBucket(spec.capacity, spec.refillPerSec, this.now); perKey.set(action, bucket); }
    return bucket.take(cost);
  }

  /** Drop fully refilled buckets so memory stays bounded. */
  sweep(): void {
    for (const [key, perKey] of this.buckets) {
      for (const [action, bucket] of perKey) if (bucket.idle) perKey.delete(action);
      if (perKey.size === 0) this.buckets.delete(key);
    }
  }

  get size(): number { return this.buckets.size; }
}

export type Action = 'frame' | 'chat' | 'media' | 'roomCreate' | 'join' | 'profile' | 'voice' | 'signal';

/** Call signalling bursts (ICE candidates for several peers at once), so the frame bucket is generous; content buckets are tight. */
export const connectionLimits: Record<Action, BucketSpec> = {
  frame: { capacity: 400, refillPerSec: 60 },
  chat: { capacity: 10, refillPerSec: 2 },
  media: { capacity: 4, refillPerSec: 1 / 5 },
  roomCreate: { capacity: 3, refillPerSec: 1 / 60 },
  join: { capacity: 20, refillPerSec: 2 },
  profile: { capacity: 5, refillPerSec: 1 / 10 },
  voice: { capacity: 10, refillPerSec: 1 / 2 },
  signal: { capacity: 300, refillPerSec: 60 }
};

/** Per-identity limits share the same rates, so opening many sockets does not multiply throughput. */
export const keyLimits: Record<Action, BucketSpec> = {
  frame: { capacity: 800, refillPerSec: 100 },
  chat: { capacity: 15, refillPerSec: 2 },
  media: { capacity: 6, refillPerSec: 1 / 5 },
  roomCreate: { capacity: 5, refillPerSec: 1 / 120 },
  join: { capacity: 40, refillPerSec: 3 },
  profile: { capacity: 10, refillPerSec: 1 / 10 },
  voice: { capacity: 20, refillPerSec: 1 / 2 },
  signal: { capacity: 600, refillPerSec: 100 }
};
