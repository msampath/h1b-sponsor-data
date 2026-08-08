import { describe, expect, it } from "vitest";
import {
  MAX_PREFIX_DEPTH,
  keys,
  searchKeyCandidates,
  searchPrefix,
  serve,
  serveFirst,
} from "../../worker/r2";
import type { R2Bucket } from "@cloudflare/workers-types";

describe("searchPrefix", () => {
  // These vectors are duplicated in tests/etl/test_publish.py — the two
  // sides MUST bucket identically or queries land on objects that were
  // never generated. Change one, change both.
  const parity: Array<[string, string | null]> = [
    ["Google LLC", "google llc"],
    ["  Ernst  &  Young  ", "ernst  you"],
    ["Café Corp", "caf corp"],
    ["3M Company", "3m company"],
    ["A&B", "ab"],
    ["AB", "ab"],
    ["X", null],
    ["\ufeffacme corp", "acme corp"], // leading BOM: JS trim() strips, must match
    ["acme corp\ufeff", "acme corp"], // trailing BOM too
    ["A\u00a0B", "a b"],              // NBSP is JS \s -> space
    ["A\u0085B", "ab"],               // NEL is NOT JS \s -> stripped
    ["A\u001cB", "ab"],               // FS is NOT JS \s -> stripped
    ["éé", null], // strips to empty
    ["O'Neill Inc", "oneill inc"],
  ];
  for (const [input, want] of parity) {
    it(`buckets ${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => {
      expect(searchPrefix(input)).toBe(want);
    });
  }

  it("caps at MAX_PREFIX_DEPTH", () => {
    expect(searchPrefix("abcdefghij")!.length).toBe(MAX_PREFIX_DEPTH);
  });
});

describe("searchKeyCandidates", () => {
  it("probes longest, -1, -2, depth 3, depth 2 (five max)", () => {
    // The 4-probe ladder skipped depth 4 for a 6-char query: [6, 5, 3, 2]
    // meant "amazee" couldn't reach s/amaz.json even when it existed.
    // Third neighbor closes that (validator A retest, 2026-08-08).
    expect(searchKeyCandidates("amazee", keys.employerSearch)).toEqual([
      "s/amazee.json",
      "s/amaze.json",
      "s/amaz.json",
      "s/ama.json",
      "s/am.json",
    ]);
  });
  it("dedupes when the longest available IS a shorter depth", () => {
    // len=3 -> {3,2}; len=4 -> {4,3,2}; len=5 -> {5,4,3,2}
    expect(searchKeyCandidates("ama", keys.employerSearch)).toEqual([
      "s/ama.json",
      "s/am.json",
    ]);
    expect(searchKeyCandidates("amaz", keys.employerSearch)).toEqual([
      "s/amaz.json",
      "s/ama.json",
      "s/am.json",
    ]);
    expect(searchKeyCandidates("amazi", keys.employerSearch)).toEqual([
      "s/amazi.json",
      "s/amaz.json",
      "s/ama.json",
      "s/am.json",
    ]);
  });
  it("handles 2-char prefixes", () => {
    expect(searchKeyCandidates("ab", keys.titleSearch)).toEqual(["t/ab.json"]);
  });
});

function fakeBucket(objects: Record<string, string>): R2Bucket {
  return {
    get: async (key: string, opts?: { onlyIf?: Headers }) => {
      if (!(key in objects)) return null;
      const etag = `"etag-${key}"`;
      if (opts?.onlyIf instanceof Headers && opts.onlyIf.get("if-none-match") === etag) {
        return { httpEtag: etag }; // precondition failed: R2Object, no body
      }
      return { httpEtag: etag, body: objects[key] };
    },
  } as unknown as R2Bucket;
}

describe("serve", () => {
  it("streams the object with etag, cache-control and nosniff", async () => {
    const res = await serve(fakeBucket({ "meta.json": '{"ok":true}' }), "meta.json", {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get("etag")).toBe('"etag-meta.json"');
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("404s with a JSON body when the object is absent", async () => {
    const res = await serve(fakeBucket({}), "e/x.json", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("returns 304 when If-None-Match matches", async () => {
    const req = new Request("https://x/", {
      headers: { "if-none-match": '"etag-meta.json"' },
    });
    const res = await serve(fakeBucket({ "meta.json": "{}" }), "meta.json", {}, req);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"etag-meta.json"');
  });
});

describe("serveFirst", () => {
  it("serves the deepest existing bucket", async () => {
    const bucket = fakeBucket({ "s/ama.json": '{"prefix":"ama"}' });
    const res = await serveFirst(bucket, ["s/amazo.json", "s/amaz.json", "s/ama.json"], {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"prefix":"ama"}');
  });

  it("404s when no candidate exists", async () => {
    const res = await serveFirst(fakeBucket({}), ["s/zz.json"], {});
    expect(res.status).toBe(404);
  });
});
