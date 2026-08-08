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

// During a lockout, persist at most one state write per this window. The
// reply does not depend on the write; this only bounds DO storage ops when
// a client retries in a tight loop.
const NOTE_WINDOW_MS = 30_000;

interface BucketState {
  tokens: number;
  refilledAt: number;
  lockoutUntil: number;
  lastNoteAt: number;
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
    if (!(tier in LIMITS)) {
      // Programmer error in the caller, not client traffic. Fail loud; the
      // Worker's try/catch treats a non-JSON/non-200 DO reply as fail-open.
      return new Response("unknown tier", { status: 500 });
    }
    const limit = LIMITS[tier];
    const now = Date.now();
    const s = await this.load(limit, now);

    if (s.lockoutUntil > now) {
      if (now - s.lastNoteAt > NOTE_WINDOW_MS) {
        s.lastNoteAt = now;
        await this.save(s);
      }
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
      s.lastNoteAt = now;
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
      return { tokens: limit, refilledAt: now, lockoutUntil: 0, lastNoteAt: 0 };
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
    return Response.json({
      ok,
      limit,
      remaining: Math.max(0, Math.floor(s.tokens)),
      resetAt: Math.floor((ok ? now + HOUR_MS / limit : s.lockoutUntil) / 1000),
      retryAfter: Math.ceil(retryMs / 1000),
    });
  }
}
