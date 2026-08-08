import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { classify, employerKey, keyTable, type Env } from "../../worker/index";

// sha256("test-token") — precomputed so tests need no crypto round-trip.
const TOKEN = "test-token";
const TOKEN_HASH = "4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e";

function env(overrides: Partial<Record<string, unknown>> = {}): Env {
  const rateReply = { ok: true, limit: 30, remaining: 29, resetAt: 1, retryAfter: 0 };
  return {
    DATA: {
      get: async (key: string) =>
        key === "meta.json" ? { httpEtag: '"m"', body: '{"ok":true}' } : null,
    },
    BUCKET: {
      idFromName: () => ({}),
      get: () => ({ fetch: async () => Response.json(rateReply) }),
    },
    API_KEYS: JSON.stringify({ [TOKEN_HASH]: "test" }),
    ...overrides,
  } as unknown as Env;
}

const B = "https://api.example/immigration/v1";
const req = (path: string, init?: RequestInit) =>
  new Request(`${B}${path}`, init) as unknown as Parameters<typeof worker.fetch>[0];

describe("routing and validation", () => {
  it("serves healthz without auth or rate limiting", async () => {
    const res = await worker.fetch(req("/healthz"), env());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("204s OPTIONS preflight with CORS for an allowed origin", async () => {
    const res = await worker.fetch(
      req("/healthz", { method: "OPTIONS", headers: { origin: "https://surakshith.com" } }),
      env(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://surakshith.com");
  });

  it("emits no CORS headers for a disallowed origin", async () => {
    const res = await worker.fetch(
      req("/healthz", { headers: { origin: "https://evil.example" } }),
      env(),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("405s non-GET, 404s outside the prefix", async () => {
    expect((await worker.fetch(req("/healthz", { method: "PUT" }), env())).status).toBe(405);
    const outside = new Request("https://api.example/nope") as Parameters<typeof worker.fetch>[0];
    expect((await worker.fetch(outside, env())).status).toBe(404);
  });

  it("400s a malformed percent-encoding instead of throwing", async () => {
    const res = await worker.fetch(req("/employers/%zz"), env());
    expect(res.status).toBe(400);
    expect((await res.json()) as object).toEqual({ error: "malformed employer id" });
  });

  it("401s a presented-but-unknown API key instead of silent anon", async () => {
    const res = await worker.fetch(
      req("/employers/search?q=amazon", { headers: { authorization: "Bearer wrong" } }),
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("Bearer parsing is case-insensitive per RFC 6750", async () => {
    // Lowercase 'bearer' used to silently drop to anon and skip the 401,
    // sidestepping the auth contract. Both known and unknown tokens must
    // route the same regardless of case.
    const unknown = await worker.fetch(
      req("/employers/search?q=am", { headers: { authorization: "bearer wrong" } }),
      env(),
    );
    expect(unknown.status).toBe(401);
    const known = await worker.fetch(
      req("/employers/search?q=am", { headers: { authorization: `bearer ${TOKEN}` } }),
      env({
        DATA: { get: async () => ({ httpEtag: '"x"', body: '{"prefix":"am"}' }) },
      }),
    );
    expect(known.status).toBe(200);
    expect(known.headers.get("x-ratelimit-limit")).toBe("30");
  });

  it("vary: origin is set on every response including 401/404/429/OPTIONS", async () => {
    // Without vary, a shared cache serving public max-age=3600 could mix
    // origin variants. Both Sonnet and Opus flagged the OPTIONS branch had
    // been missed by the first pass; this pins all four status classes.
    const cases: Array<{ path: string; init: RequestInit; wantStatus: number }> = [
      { path: "/healthz", init: {}, wantStatus: 200 },
      { path: "/healthz", init: { method: "OPTIONS" }, wantStatus: 204 },
      { path: "/employers/search?q=am", init: { headers: { authorization: "Bearer nope" } }, wantStatus: 401 },
      { path: "/nope", init: {}, wantStatus: 404 },
    ];
    for (const c of cases) {
      for (const origin of ["https://surakshith.com", "https://evil.example", undefined]) {
        const baseHeaders = (c.init.headers ?? {}) as Record<string, string>;
        const headers = { ...baseHeaders, ...(origin ? { origin } : {}) };
        const res = await worker.fetch(req(c.path, { ...c.init, headers }), env());
        expect(res.status).toBe(c.wantStatus);
        expect(res.headers.get("vary")?.toLowerCase()).toContain("origin");
      }
    }
  });

  it("healthz never carries rate-limit headers (served pre-meter)", async () => {
    const res = await worker.fetch(req("/healthz"), env());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
    expect(res.headers.get("x-ratelimit-remaining")).toBeNull();
  });

  it("validates wages params and accepts level=NA", async () => {
    expect((await worker.fetch(req("/wages?soc=bad&level=II"), env())).status).toBe(400);
    expect((await worker.fetch(req("/wages?soc=15-1252&level=V"), env())).status).toBe(400);
    // NA is a published level (filings whose wage level was absent/junk).
    const na = await worker.fetch(req("/wages?soc=15-1252&level=NA"), env());
    expect(na.status).toBe(404); // stub bucket has no object, but validation passed
  });

  it("search probes deeper buckets first and falls back", async () => {
    const got: string[] = [];
    const e = env({
      DATA: {
        get: async (key: string) => {
          got.push(key);
          return key === "s/ama.json" ? { httpEtag: '"s"', body: "{}" } : null;
        },
      },
    });
    const res = await worker.fetch(req("/employers/search?q=Amazon Web"), e);
    expect(res.status).toBe(200);
    expect(got[0]).toBe("s/amazon web.json"); // longest cleaned prefix first
    expect(got.at(-1)).toBe("s/ama.json");
  });

  it("429s with Retry-After when the bucket denies", async () => {
    const e = env({
      BUCKET: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async () =>
            Response.json({ ok: false, limit: 30, remaining: 0, resetAt: 9, retryAfter: 120 }),
        }),
      },
    });
    const res = await worker.fetch(req("/employers/search?q=am"), e);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(res.headers.get("x-ratelimit-limit")).toBe("30");
  });

  it("fails open with a log when the rate-limit DO is unreachable", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = env({
      DATA: { get: async () => ({ httpEtag: '"x"', body: "{}" }) },
      BUCKET: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => { throw new Error("DO reset"); } }),
      },
    });
    const res = await worker.fetch(req("/employers/770493581"), e);
    expect(res.status).toBe(200); // availability wins
    expect(res.headers.get("x-ratelimit-limit")).toBeNull(); // no fabricated headers
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("fails open on non-ok DO reply (500), same shape as the throw path", async () => {
    // The res.ok=false branch backstops any protocol error the DO can emit
    // (unknown tier, bad JSON) without taking the API down.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = env({
      DATA: { get: async () => ({ httpEtag: '"x"', body: "{}" }) },
      BUCKET: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => new Response("unknown tier", { status: 500 }) }),
      },
    });
    const res = await worker.fetch(req("/employers/770493581"), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("serves /employers/:id/jobs and /titles subroutes", async () => {
    const seen: string[] = [];
    const e = env({
      DATA: {
        get: async (key: string) => {
          seen.push(key);
          return { httpEtag: '"x"', body: "{}" };
        },
      },
    });
    await worker.fetch(req("/employers/770493581/jobs"), e);
    await worker.fetch(req("/employers/770493581/titles"), e);
    expect(seen).toEqual(["e/770493581/jobs.json", "e/770493581/titles.json"]);
  });

  it("returns 412 (not 304) when If-Match precondition fails", async () => {
    const e = env({
      DATA: {
        get: async (_: string, opts?: { onlyIf?: Headers }) => {
          if (opts?.onlyIf?.get("if-match")) return { httpEtag: '"m"' }; // body-less
          return { httpEtag: '"m"', body: "{}" };
        },
      },
    });
    const res = await worker.fetch(
      req("/healthz", { headers: { "if-match": '"stale"' } }),
      e,
    );
    expect(res.status).toBe(412);
  });

  it("returns 304 for a successful If-None-Match revalidation", async () => {
    const e = env({
      DATA: {
        get: async (_: string, opts?: { onlyIf?: Headers }) => {
          if (opts?.onlyIf?.get("if-none-match") === '"m"') return { httpEtag: '"m"' };
          return { httpEtag: '"m"', body: "{}" };
        },
      },
    });
    const res = await worker.fetch(
      req("/healthz", { headers: { "if-none-match": '"m"' } }),
      e,
    );
    expect(res.status).toBe(304);
  });
});

describe("classify", () => {
  const cf = (headers: Record<string, string>) =>
    ({ headers: new Headers(headers), cf: { asn: 396982 } }) as unknown as Parameters<
      typeof classify
    >[0];

  it("keys by token hash, not IP", async () => {
    const c = await classify(cf({ authorization: `Bearer ${TOKEN}` }), env());
    expect(c).toEqual({ tier: "keyed", bucketKey: `keyed|${TOKEN_HASH}` });
  });

  it("buckets anon by (IP, ASN)", async () => {
    const c = await classify(cf({ "cf-connecting-ip": "1.2.3.4" }), env());
    expect(c).toEqual({ tier: "anon", bucketKey: "anon|1.2.3.4|396982" });
  });

  it("flags an unknown presented key", async () => {
    const c = await classify(cf({ authorization: "Bearer nope" }), env());
    expect(c).toEqual({ unknownKey: true });
  });
});

describe("keyTable", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("parses once per secret value (memoized)", () => {
    const e = env();
    const t1 = keyTable(e);
    const t2 = keyTable(e);
    expect(t1).toBe(t2);
  });

  it("logs and returns empty on malformed JSON instead of throwing", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = keyTable(env({ API_KEYS: "{not json" }));
    expect(t).toEqual({});
    expect(spy).toHaveBeenCalled();
  });
});

describe("employerKey", () => {
  it.each([
    ["941156497", "941156497"],
    ["94-1156497", "941156497"],
    [" n-3f9a1c2d4e5b6789 ", "n-3f9a1c2d4e5b6789"],
    ["12345678", null],
    ["n-UPPER", null],
    ["<script>", null],
  ])("%s -> %s", (input, want) => {
    expect(employerKey(input)).toBe(want);
  });
});
