import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../../worker/index";
import { clearKeyCache, sha256Hex } from "../../worker/keys";
import { LIMITS, type RateVerdict, type Tier } from "../../worker/ratelimit";

// The isolate key cache is module-level; a leaked seed from one test could mask
// a cache-miss path in the next, so start every test from an empty cache.
beforeEach(() => clearKeyCache());

// sha256("test-token") — the static secret key, precomputed as in index.test.ts.
const STATIC_TOKEN = "test-token";
const STATIC_HASH = "4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e";
const IP = "203.0.113.9";

const ALLOW: RateVerdict = { ok: true, limit: 2, remaining: 1, resetAt: 1, retryAfter: 0 };
const DENY: RateVerdict = { ok: false, limit: 2, remaining: 0, resetAt: 9, retryAfter: 43200 };

interface MeterCall {
  bucketKey: string;
  tier: Tier;
  op: "take" | "give";
}

/** Env with a Map-backed KV and a BucketMeter that records what it was asked.
 *  The meter is stateless — it just replies ALLOW, or DENY for a listed tier —
 *  so it exercises the orchestration in keys.ts/index.ts, not the bucket math
 *  (that is ratelimit.test.ts). `op` distinguishes a charge from a refund. */
function harness(
  opts: { deny?: Tier[]; doThrows?: boolean; throwOn?: Tier; kvPutThrows?: boolean } = {},
) {
  const store = new Map<string, string>();
  const gets: string[] = [];
  const puts: string[] = [];
  const calls: MeterCall[] = [];

  const e = {
    DATA: { get: async () => ({ httpEtag: '"x"', body: "{}" }) },
    BUCKET: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init: { body: string }) => {
          const { tier } = JSON.parse(init.body) as { tier: Tier };
          const op = new URL(url).pathname === "/give" ? "give" : "take";
          calls.push({ bucketKey: id.name, tier, op });
          if (opts.doThrows || opts.throwOn === tier) throw new Error("DO reset");
          return Response.json(opts.deny?.includes(tier) ? DENY : ALLOW);
        },
      }),
    },
    KEYS: {
      get: async (k: string) => {
        gets.push(k);
        return store.get(k) ?? null;
      },
      put: async (k: string, v: string) => {
        if (opts.kvPutThrows) throw new Error("KV unavailable");
        puts.push(k);
        store.set(k, v);
      },
    },
    API_KEYS: JSON.stringify({ [STATIC_HASH]: "static" }),
  } as unknown as Env;

  return { e, store, gets, puts, calls };
}

const B = "https://api.example/immigration/v1";
const req = (path: string, init?: RequestInit) =>
  new Request(`${B}${path}`, init) as unknown as Parameters<typeof worker.fetch>[0];

const mintReq = (headers: Record<string, string> = {}) =>
  req("/keys/request", { method: "POST", headers: { "cf-connecting-ip": IP, ...headers } });

/** Any keyed read route, used to prove a token authenticates. */
const readReq = (token: string) =>
  req("/employers/770493581", { headers: { authorization: `Bearer ${token}` } });

async function mint(e: Env): Promise<string> {
  const res = await worker.fetch(mintReq(), e);
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

describe("POST /keys/request", () => {
  it("issues a token, stores only its hash, and keeps the address off disk", async () => {
    const { e, store, puts } = harness();
    const res = await worker.fetch(mintReq(), e);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { token: string; tier: string; limit: number };
    expect(body.token.startsWith("h1b_")).toBe(true);
    expect(body.token).toHaveLength(4 + 48); // 24 random bytes as hex
    expect(body.tier).toBe("keyed");
    expect(body.limit).toBe(LIMITS.keyed);

    const hash = await sha256Hex(body.token);
    expect(puts).toEqual([hash]);

    const raw = store.get(hash) as string;
    expect(raw).not.toContain(body.token); // the token itself is never persisted
    expect(raw).not.toContain(IP); // and neither is the requester's address
    const meta = JSON.parse(raw) as { label: string; createdAt: string; requestor: string };
    expect(meta.label).toBe("self-serve");
    expect(meta.requestor).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(meta.createdAt))).toBe(false);
  });

  it("charges the requester before the global cap, and 429s on their own limit", async () => {
    const { e, calls, puts } = harness({ deny: ["mint"] });
    const res = await worker.fetch(mintReq(), e);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("43200");
    // Denied on their own bucket, so the shared budget is never touched, and a
    // deny consumes nothing, so there is nothing to refund.
    expect(calls).toEqual([{ bucketKey: `mint|${IP}|0`, tier: "mint", op: "take" }]);
    expect(puts).toEqual([]);
  });

  it("refunds the requester's token when the global cap denies", async () => {
    const { e, calls, puts } = harness({ deny: ["mintGlobal"] });
    const res = await worker.fetch(mintReq(), e);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("43200");
    // Charge the requester, hit the global deny, then hand the requester's
    // token back: an honest first-timer must not lose a day's allowance to a
    // global-exhaustion or kill-switch 429.
    expect(calls).toEqual([
      { bucketKey: `mint|${IP}|0`, tier: "mint", op: "take" },
      { bucketKey: "mint|global", tier: "mintGlobal", op: "take" },
      { bucketKey: `mint|${IP}|0`, tier: "mint", op: "give" },
    ]);
    expect(puts).toEqual([]);
  });

  it("403s a browser: a mint request that carries any Origin is refused", async () => {
    // Both the CORS-allowed origin and a hostile one: no page mints keys.
    for (const origin of ["https://surakshith.com", "https://evil.example"]) {
      const { e, calls, puts } = harness();
      const res = await worker.fetch(mintReq({ origin }), e);
      expect(res.status).toBe(403);
      expect(calls).toEqual([]); // rejected before spending any quota
      expect(puts).toEqual([]);
    }
  });

  it("503s and issues nothing when the meter is unreachable (fails closed)", async () => {
    // The read path fails open for availability; issuance must not, or a DO
    // outage becomes an unmetered credential faucet.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { e, puts } = harness({ doThrows: true });
    const res = await worker.fetch(mintReq(), e);
    expect(res.status).toBe(503);
    expect((await res.json()) as object).toEqual({ error: "issuance temporarily unavailable" });
    expect(puts).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("503s before spending any quota when the KEYS namespace is not bound", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { e, calls } = harness();
    const res = await worker.fetch(mintReq(), { ...e, KEYS: undefined });
    expect(res.status).toBe(503);
    // Checked before any bucket is touched, so a misconfigured deployment never
    // charges a requester a token it can never redeem.
    expect(calls).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("503s and refunds the requester when only the GLOBAL round-trip fails", async () => {
    // The per-requester charge landed, then the global bucket was unreachable:
    // no key can be issued (fail closed), and the charge that bought nothing
    // comes back. Distinct from the all-buckets-down case above, where nothing
    // was ever charged.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { e, calls, puts } = harness({ throwOn: "mintGlobal" });
    const res = await worker.fetch(mintReq(), e);
    expect(res.status).toBe(503);
    expect(puts).toEqual([]);
    expect(calls).toEqual([
      { bucketKey: `mint|${IP}|0`, tier: "mint", op: "take" },
      { bucketKey: "mint|global", tier: "mintGlobal", op: "take" },
      { bucketKey: `mint|${IP}|0`, tier: "mint", op: "give" },
    ]);
    spy.mockRestore();
  });

  it("500s without returning a token, and refunds both charges, when the KV write fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { e, store, calls } = harness({ kvPutThrows: true });
    const res = await worker.fetch(mintReq(), e);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("h1b_");
    expect(store.size).toBe(0);
    // No key was issued, so neither the requester nor the global budget pays.
    expect(calls.filter((c) => c.op === "give").map((c) => c.bucketKey)).toEqual([
      `mint|${IP}|0`,
      "mint|global",
    ]);
    spy.mockRestore();
  });

  it("collapses an IPv6 requester to its /64 so a client cannot walk addresses", async () => {
    const a = "2001:db8:abcd:1234:1111:2222:3333:4444";
    const b = "2001:db8:abcd:1234:aaaa:bbbb:cccc:dddd"; // same /64, different suffix
    const bucketOf = async (ip: string) => {
      const { e, calls } = harness();
      await worker.fetch(mintReq({ "cf-connecting-ip": ip }), e);
      return calls[0].bucketKey;
    };
    expect(await bucketOf(a)).toBe("mint|2001:db8:abcd:1234::/64|0");
    expect(await bucketOf(a)).toBe(await bucketOf(b));
  });
});

describe("dynamic key lookup", () => {
  it("authenticates a minted token on a read route", async () => {
    const { e } = harness();
    const token = await mint(e);
    const res = await worker.fetch(readReq(token), e);
    expect(res.status).toBe(200);
  });

  it("authenticates a key minted on another isolate, by reading KV", async () => {
    const { e, store, gets } = harness();
    const token = "h1b_" + "ab".repeat(24);
    const hash = await sha256Hex(token);
    store.set(
      hash,
      JSON.stringify({ label: "self-serve", createdAt: "2026-08-10T00:00:00.000Z", requestor: "x" }),
    );
    const res = await worker.fetch(readReq(token), e);
    expect(res.status).toBe(200);
    expect(gets).toContain(hash);
  });

  it("accepts a fresh key on this isolate before KV can serve it", async () => {
    const { e, store, gets } = harness();
    const token = await mint(e);
    store.clear(); // KV answers null, as an unconverged replica would
    const before = gets.length;

    const res = await worker.fetch(readReq(token), e);
    expect(res.status).toBe(200);
    expect(gets.length).toBe(before); // served from the seeded cache, no KV read
  });

  it("stops accepting a revoked key once the isolate cache expires", async () => {
    const { e, store } = harness();
    const token = await mint(e);
    store.delete(await sha256Hex(token));

    // Inside the 60s window the key still works. That is the documented cost
    // of caching, and the reason revocation is advertised as ~2 minutes.
    expect((await worker.fetch(readReq(token), e)).status).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    const after = await worker.fetch(readReq(token), e);
    vi.useRealTimers();

    expect(after.status).toBe(401);
  });

  it("still serves a valid self-serve key when the meter DO is down (fails open)", async () => {
    // The lookup gate returning null is a DO outage, not a deny. The read path
    // trades availability for that outage everywhere else, so the gate must
    // too: the KV read proceeds, the key authenticates, and the main bucket's
    // own fail-open covers the serve.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { e, store, gets } = harness({ doThrows: true });
    const token = "h1b_" + "9a".repeat(24);
    const hash = await sha256Hex(token);
    store.set(
      hash,
      JSON.stringify({ label: "self-serve", createdAt: "2026-08-10T00:00:00.000Z", requestor: "x" }),
    );
    const res = await worker.fetch(readReq(token), e);
    expect(res.status).toBe(200);
    expect(gets).toContain(hash); // the gated KV read still ran, fail-open
    spy.mockRestore();
  });

  it("401s an unknown token that KV has never held", async () => {
    const { e, gets } = harness();
    const token = "h1b_" + "cd".repeat(24);
    const res = await worker.fetch(readReq(token), e);
    expect(res.status).toBe(401);
    expect(gets).toContain(await sha256Hex(token));
  });

  it("401s rather than failing open when the KV read throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { e } = harness();
    const broken = {
      ...e,
      KEYS: { get: async () => { throw new Error("KV unavailable"); } },
    } as unknown as Env;
    const res = await worker.fetch(readReq("h1b_" + "ef".repeat(24)), broken);
    expect(res.status).toBe(401);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("validates a static secret key without ever touching KV", async () => {
    const { e, gets, calls } = harness();
    const res = await worker.fetch(readReq(STATIC_TOKEN), e);
    expect(res.status).toBe(200);
    expect(gets).toEqual([]);
    // A static key never pays the lookup throttle either.
    expect(calls.some((c) => c.tier === "lookup")).toBe(false);
  });

  it("throttles the KV validation of a presented token per (IP, ASN)", async () => {
    // The lookup bucket is what stops a flood of junk tokens from amplifying
    // into unbounded KV reads: a deny returns 429 and the KV read never runs.
    const { e, gets, calls } = harness({ deny: ["lookup"] });
    const res = await worker.fetch(readReq("h1b_" + "12".repeat(24)), e);
    expect(res.status).toBe(429);
    expect(gets).toEqual([]); // the read the throttle protects never happened
    expect(calls).toEqual([{ bucketKey: "lookup|0.0.0.0|0", tier: "lookup", op: "take" }]);
  });

  it("pays the lookup throttle only on a cache miss, not for a cached key", async () => {
    const { e, calls } = harness();
    const token = await mint(e); // seeds the isolate cache
    const before = calls.length;
    const res = await worker.fetch(readReq(token), e);
    expect(res.status).toBe(200);
    // The re-read resolves from cache: a keyed serve charge, no lookup charge.
    expect(calls.slice(before).some((c) => c.tier === "lookup")).toBe(false);
  });

  it("refunds the lookup charge once the read proves the key genuine", async () => {
    // The meter bounds junk, it does not ration a real key holder. Without the
    // refund, a client landing on cold isolates (or sharing an egress IP with
    // other key holders) is cut off at lookup=120/h despite holding a key
    // issued with keyed=200/h — a 429 with no x-ratelimit headers to explain it.
    const { e, store, calls } = harness();
    const token = "h1b_" + "56".repeat(24);
    store.set(
      await sha256Hex(token),
      JSON.stringify({ label: "self-serve", createdAt: "x", requestor: "y" }),
    );

    const res = await worker.fetch(readReq(token), e);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.tier === "lookup")).toEqual([
      { bucketKey: "lookup|0.0.0.0|0", tier: "lookup", op: "take" },
      { bucketKey: "lookup|0.0.0.0|0", tier: "lookup", op: "give" },
    ]);
  });

  it("does NOT refund the lookup charge for a token KV has never held", async () => {
    // The whole point of the meter: an unrecognized token pays and keeps
    // paying, so a flood of junk still exhausts the bucket at 120/h.
    const { e, calls } = harness();
    const res = await worker.fetch(readReq("h1b_" + "78".repeat(24)), e);
    expect(res.status).toBe(401);
    expect(calls.filter((c) => c.tier === "lookup")).toEqual([
      { bucketKey: "lookup|0.0.0.0|0", tier: "lookup", op: "take" },
    ]);
  });

  it("refunds nothing when the gate failed open, since nothing was spent", async () => {
    // throwOn: "lookup" makes takeToken return null (a DO outage, not a deny).
    // No token was charged, so a refund would be inventing one.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { e, store, calls } = harness({ throwOn: "lookup" });
    const token = "h1b_" + "9b".repeat(24);
    store.set(
      await sha256Hex(token),
      JSON.stringify({ label: "self-serve", createdAt: "x", requestor: "y" }),
    );
    const res = await worker.fetch(readReq(token), e);
    expect(res.status).toBe(200); // fail open, as before
    expect(calls.filter((c) => c.tier === "lookup" && c.op === "give")).toEqual([]);
    spy.mockRestore();
  });

  it("refuses a KV entry that is not a JSON object rather than trusting it", async () => {
    // A null, a number, a bare string, or an array must fail closed to 401.
    // Before the shape check, `123` authenticated and `null` threw a 500.
    for (const bad of ["null", "123", '"self-serve"', "[]"]) {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { e, store } = harness();
      const token = "h1b_" + "34".repeat(24);
      store.set(await sha256Hex(token), bad);
      const res = await worker.fetch(readReq(token), e);
      expect(res.status).toBe(401);
      spy.mockRestore();
    }
  });
});
