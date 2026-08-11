// BucketMeter — one Durable Object per caller, holding a token bucket.
//
// There is deliberately no global meter (the Workers 100k/day cap is the
// global ceiling) and, since the 2026-08-08 review, no escalation ladder.
// Escalation punished the wrong party: a request during a lockout costs a
// Worker invocation whether or not we extend the lockout, so extending never
// saved quota — but three ordinary requests spaced >30s during one cool-off
// (a shared NAT, a CGNAT carrier) escalated the whole address to an hour.
// The bucket itself is the protection; the only job of a 429 is to say,
// honestly, when to come back.

import type { DurableObjectState } from "@cloudflare/workers-types";

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const LIMITS = { anon: 30, keyed: 200, mint: 2, mintGlobal: 200, lookup: 120 } as const;
export type Tier = keyof typeof LIMITS;

// Read tiers refill over an hour. Issuance refills over a day: a key is a
// durable credential, so the honest cool-off after burning the allowance is
// long, and the same bucket math gives it without a second implementation.
// `lookup` gates the KV read that validates a presented self-serve token, so a
// flood of junk tokens cannot amplify into unbounded KV reads; it refills over
// an hour like the read tiers.
const WINDOWS: Record<Tier, number> = {
  anon: HOUR_MS,
  keyed: HOUR_MS,
  mint: DAY_MS,
  mintGlobal: DAY_MS,
  lookup: HOUR_MS,
};

/**
 * Bucketing identity for an IP. IPv4 is used whole; IPv6 collapses to its /64
 * prefix, because a single residential or mobile client is routinely handed a
 * whole /64 (2^64 addresses) and would otherwise get a fresh bucket per
 * address, walking straight around any per-address limit. The result only has
 * to be stable per /64, not canonical, so `::` is expanded just enough to read
 * the first four groups.
 */
export function bucketIp(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4, or the 0.0.0.0 fallback
  const head = ip.split("%")[0]; // drop any zone id
  const [left, right] = head.split("::");
  let groups: string[];
  if (right !== undefined) {
    const l = left ? left.split(":") : [];
    const r = right ? right.split(":") : [];
    const missing = Math.max(0, 8 - l.length - r.length);
    groups = [...l, ...Array(missing).fill("0"), ...r];
  } else {
    groups = head.split(":");
  }
  return (
    groups
      .slice(0, 4)
      .map((g) => g || "0")
      .join(":")
      .toLowerCase() + "::/64"
  );
}

/** Reply shape shared with worker/index.ts so producer and consumer stay pinned. */
export interface RateVerdict {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter: number;
}

interface BucketState {
  tokens: number;
  refilledAt: number;
  lockoutUntil: number;
}

export class BucketMeter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/take" && path !== "/give") {
      return new Response("not found", { status: 404 });
    }
    const { tier } = (await request.json()) as { tier: Tier };
    // Object.hasOwn — `tier in LIMITS` was prototype-chain bypassable, so
    // a crafted tier like "toString" reached the state math and produced
    // NaN tokens, which then passed `tokens < 1`. Caller-unreachable from
    // this Worker's own dispatch, but the guard should still be tight.
    if (!Object.hasOwn(LIMITS, tier)) {
      return new Response("unknown tier", { status: 500 });
    }
    const limit = LIMITS[tier];
    const windowMs = WINDOWS[tier];
    const now = Date.now();
    const s = await this.load(limit, now);

    // /give refunds one token: the caller charged this bucket, then a LATER
    // gate in the same operation denied, so the charge bought nothing and must
    // be undone. Capped at limit, and it lifts any lockout the refunded charge
    // would have implied. Refunds only ever fire when issuance is already
    // blocked downstream, so they cannot be farmed to exceed a limit.
    if (path === "/give") {
      s.tokens = Math.min(limit, s.tokens + 1);
      s.lockoutUntil = 0;
      await this.save(s);
      return this.reply(s, limit, windowMs, now, true);
    }

    if (s.lockoutUntil > now) {
      // Nothing to persist during a lockout: `tokens`, `refilledAt` and
      // `lockoutUntil` are all unchanged from when the lockout was set, so
      // reply and go — one storage write saved per throttled request.
      return this.reply(s, limit, windowMs, now, false);
    }

    // Continuous refill: `limit` tokens per window.
    const elapsed = now - s.refilledAt;
    if (elapsed > 0) {
      s.tokens = Math.min(limit, s.tokens + (elapsed * limit) / windowMs);
      s.refilledAt = now;
    }

    if (s.tokens < 1) {
      // Honest cool-off: exactly the time until one whole token exists.
      // Advertising less (a fixed 60s did) re-denies a compliant client
      // that returns exactly at Retry-After. A limit of 0 is the operator's
      // kill switch for a tier; it would divide to Infinity and put that in
      // a header, so it advertises one window, which is finite and true.
      s.lockoutUntil =
        now + (limit > 0 ? Math.ceil(((1 - s.tokens) * windowMs) / limit) : windowMs);
      await this.save(s);
      return this.reply(s, limit, windowMs, now, false);
    }

    s.tokens -= 1;
    await this.save(s);
    return this.reply(s, limit, windowMs, now, true);
  }

  async load(limit: number, now: number): Promise<BucketState> {
    const raw = await this.state.storage.get<BucketState>("s");
    if (!raw) {
      return { tokens: limit, refilledAt: now, lockoutUntil: 0 };
    }
    // A redeploy may lower a tier's limit; clamp so old state can't exceed it.
    raw.tokens = Math.min(raw.tokens, limit);
    return raw;
  }

  async save(s: BucketState): Promise<void> {
    await this.state.storage.put("s", s);
  }

  reply(s: BucketState, limit: number, windowMs: number, now: number, ok: boolean): Response {
    const retryMs = Math.max(0, s.lockoutUntil - now);
    const verdict: RateVerdict = {
      ok,
      limit,
      remaining: Math.max(0, Math.floor(s.tokens)),
      resetAt: Math.floor((ok ? now + windowMs / limit : s.lockoutUntil) / 1000),
      retryAfter: Math.ceil(retryMs / 1000),
    };
    return Response.json(verdict);
  }
}
