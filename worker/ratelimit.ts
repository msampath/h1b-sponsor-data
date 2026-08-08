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

export const LIMITS = { anon: 30, keyed: 200 } as const;
export type Tier = keyof typeof LIMITS;

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
    if (new URL(request.url).pathname !== "/take") {
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
    const now = Date.now();
    const s = await this.load(limit, now);

    if (s.lockoutUntil > now) {
      // Nothing to persist during a lockout: `tokens`, `refilledAt` and
      // `lockoutUntil` are all unchanged from when the lockout was set, so
      // reply and go — one storage write saved per throttled request.
      return this.reply(s, limit, now, false);
    }

    // Continuous refill: `limit` tokens per hour.
    const elapsed = now - s.refilledAt;
    if (elapsed > 0) {
      s.tokens = Math.min(limit, s.tokens + (elapsed * limit) / HOUR_MS);
      s.refilledAt = now;
    }

    if (s.tokens < 1) {
      // Honest cool-off: exactly the time until one whole token exists.
      // Advertising less (a fixed 60s did) re-denies a compliant client
      // that returns exactly at Retry-After.
      s.lockoutUntil = now + Math.ceil(((1 - s.tokens) * HOUR_MS) / limit);
      await this.save(s);
      return this.reply(s, limit, now, false);
    }

    s.tokens -= 1;
    await this.save(s);
    return this.reply(s, limit, now, true);
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

  reply(s: BucketState, limit: number, now: number, ok: boolean): Response {
    const retryMs = Math.max(0, s.lockoutUntil - now);
    const verdict: RateVerdict = {
      ok,
      limit,
      remaining: Math.max(0, Math.floor(s.tokens)),
      resetAt: Math.floor((ok ? now + HOUR_MS / limit : s.lockoutUntil) / 1000),
      retryAfter: Math.ceil(retryMs / 1000),
    };
    return Response.json(verdict);
  }
}
