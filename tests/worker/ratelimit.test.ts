import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BucketMeter, LIMITS } from "../../worker/ratelimit";
import type { DurableObjectState } from "@cloudflare/workers-types";

function meter() {
  const store = new Map<string, unknown>();
  let puts = 0;
  const state = {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => {
        puts++;
        store.set(k, v);
      },
    },
  } as unknown as DurableObjectState;
  const m = new BucketMeter(state);
  return { m, putCount: () => puts };
}

function take(m: BucketMeter, tier = "anon") {
  return m.fetch(
    new Request("https://do/take", { method: "POST", body: JSON.stringify({ tier }) }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => vi.useRealTimers());

describe("BucketMeter", () => {
  it("allows exactly `limit` requests from a fresh bucket", async () => {
    const { m } = meter();
    for (let i = 0; i < LIMITS.anon; i++) {
      const r = (await (await take(m)).json()) as { ok: boolean; remaining: number };
      expect(r.ok).toBe(true);
    }
    const denied = (await (await take(m)).json()) as { ok: boolean };
    expect(denied.ok).toBe(false);
  });

  it("advertises an honest Retry-After: waiting it out yields a token", async () => {
    const { m } = meter();
    for (let i = 0; i < LIMITS.anon; i++) await take(m);
    const denied = (await (await take(m)).json()) as { ok: boolean; retryAfter: number };
    expect(denied.ok).toBe(false);
    // anon refills 1 token per 120s; the advertised wait must cover that.
    expect(denied.retryAfter).toBeGreaterThanOrEqual(119);
    expect(denied.retryAfter).toBeLessThanOrEqual(121);

    vi.advanceTimersByTime(denied.retryAfter * 1000);
    const after = (await (await take(m)).json()) as { ok: boolean };
    expect(after.ok).toBe(true); // a compliant client is never re-denied
  });

  it("never escalates: hammering during a lockout does not extend it", async () => {
    const { m } = meter();
    for (let i = 0; i < LIMITS.anon; i++) await take(m);
    const first = (await (await take(m)).json()) as { retryAfter: number };
    // 10 defiant requests spaced 35s apart — the old ladder banned this
    // pattern (a shared NAT) for an hour.
    let last: { ok: boolean; retryAfter: number } = { ok: false, retryAfter: 0 };
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(35_000);
      last = (await (await take(m)).json()) as typeof last;
      if (last.ok) break;
    }
    // Within first.retryAfter + slack, the client is served again.
    expect(last.ok).toBe(true);
    expect(first.retryAfter).toBeLessThanOrEqual(121);
  });

  it("performs ZERO storage writes for any request during a lockout", async () => {
    // The old code kept a lastNoteAt field just to throttle its own writes;
    // with no other state changing during a lockout there is nothing to
    // persist at all. See super-review-retest-report.md.
    const { m, putCount } = meter();
    for (let i = 0; i < LIMITS.anon; i++) await take(m);
    await take(m); // exhaustion write sets lockout
    const before = putCount();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      await take(m);
    }
    expect(putCount()).toBe(before);
  });

  it("keyed tier gets its own limit", async () => {
    const { m } = meter();
    const r = (await (await take(m, "keyed")).json()) as { limit: number };
    expect(r.limit).toBe(LIMITS.keyed);
  });

  it("rejects an unknown tier loudly instead of minting NaN state", async () => {
    const { m } = meter();
    const res = await take(m, "root");
    expect(res.status).toBe(500);
  });

  it("rejects prototype-chain names like toString (Object.hasOwn, not `in`)", async () => {
    // `tier in LIMITS` was bypassable via the prototype chain; a crafted
    // tier of "toString" or "constructor" would reach state math and mint
    // NaN tokens. Object.hasOwn stops it at the door.
    const { m } = meter();
    for (const bad of ["toString", "constructor", "__proto__"]) {
      const res = await take(m, bad);
      expect(res.status).toBe(500);
    }
  });

  it("clamps stored tokens if a redeploy lowered the limit", async () => {
    const store = new Map<string, unknown>([
      ["s", { tokens: 9999, refilledAt: Date.now(), lockoutUntil: 0 }],
    ]);
    const state = {
      storage: { get: async () => store.get("s"), put: async (_: string, v: unknown) => store.set("s", v) },
    } as unknown as DurableObjectState;
    const m = new BucketMeter(state);
    const r = (await (await take(m)).json()) as { remaining: number };
    expect(r.remaining).toBeLessThanOrEqual(LIMITS.anon);
  });
});
