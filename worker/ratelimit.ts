// BucketMeter — one Durable Object per caller, holding a token bucket plus
// an escalating lockout for callers that ignore Retry-After.
//
// There is deliberately no global meter. An earlier design ticked a
// singleton on every request, which (a) burned two DO calls per request
// against a 100k/day free-tier quota and (b) let any client drive a
// service-wide 503 by looping requests that were already being rejected.
// The Workers 100k/day request cap is the global ceiling instead.

import type { DurableObjectState } from "@cloudflare/workers-types";

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const LIMITS = { anon: 30, keyed: 200 } as const;
export type Tier = keyof typeof LIMITS;

// Escalation applies only to requests made *during* an active lockout —
// i.e. a client that was told to back off and kept going. Simply hitting
// the hourly cap never escalates, so a shared NAT or CGNAT address can't
// be driven into a long ban by ordinary traffic.
const LOCKOUTS_MS = [60_000, 15 * 60_000, 60 * 60_000];

// A client that fires ten retries in two seconds has ignored Retry-After
// once, not ten times. Counting each request as its own defiance conflates
// burst size with persistence, and escalated a naive retry loop to the
// one-hour tier almost instantly. Only the first request in this window
// counts.
const DEFIANCE_WINDOW_MS = 30_000;

interface BucketState {
  tokens: number;
  refilledAt: number;
  lockoutUntil: number;
  defiances: number[];   // ms epochs of requests made during a lockout
  lastLimit: number;
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
    const limit = LIMITS[tier];
    const now = Date.now();
    const s = await this.load(limit, now);

    if (s.lockoutUntil > now) {
      // Requesting while locked out is the actual abuse signal, but only
      // once per DEFIANCE_WINDOW_MS. Skipping the write for burst retries
      // also spares a Durable Object storage op per request.
      s.defiances = s.defiances.filter((t) => now - t < DAY_MS);
      const last = s.defiances.length ? s.defiances[s.defiances.length - 1] : 0;
      if (now - last > DEFIANCE_WINDOW_MS) {
        s.defiances.push(now);
        const idx = Math.min(s.defiances.length - 1, LOCKOUTS_MS.length - 1);
        s.lockoutUntil = Math.max(s.lockoutUntil, now + LOCKOUTS_MS[idx]);
        await this.save(s);
      }
      return this.reply(s, limit, now, false);
    }

    // Continuous refill: the bucket regains `limit` tokens per hour.
    const elapsed = now - s.refilledAt;
    if (elapsed > 0) {
      s.tokens = Math.min(limit, s.tokens + (elapsed * limit) / HOUR_MS);
      s.refilledAt = now;
    }
    if (s.lastLimit !== limit) {
      s.tokens = Math.min(s.tokens, limit);
      s.lastLimit = limit;
    }

    if (s.tokens < 1) {
      // Out of tokens: a short cool-off, no escalation.
      s.lockoutUntil = now + LOCKOUTS_MS[0];
      await this.save(s);
      return this.reply(s, limit, now, false);
    }

    s.tokens -= 1;
    await this.save(s);
    return this.reply(s, limit, now, true);
  }

  async load(limit: number, now: number): Promise<BucketState> {
    const raw = await this.state.storage.get<BucketState>("s");
    return (
      raw ?? {
        tokens: limit,
        refilledAt: now,
        lockoutUntil: 0,
        defiances: [],
        lastLimit: limit,
      }
    );
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
