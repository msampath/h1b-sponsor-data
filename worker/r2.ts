// R2 key construction and the streaming response helpers.
//
// The one rule that keeps this Worker inside the free tier's 10 ms CPU
// budget: never JSON.parse an object. Objects are precomputed by
// etl/publish.py to be exactly what an endpoint returns, so the body is
// streamed straight through. Waiting on R2 is I/O and does not count
// toward CPU time; parsing a 7 MB employer would.

import type { R2Bucket } from "@cloudflare/workers-types";

// Search buckets exist at depths 2..MAX_PREFIX_DEPTH. The publisher emits
// deeper tiers only where a shallower bucket overflows its result cap, so
// the Worker probes longest-first and serves the first object that exists.
export const MAX_PREFIX_DEPTH = 10;

export const keys = {
  meta: () => "meta.json",
  employer: (key: string) => `e/${key}.json`,
  employerJobs: (key: string) => `e/${key}/jobs.json`,
  employerTitles: (key: string) => `e/${key}/titles.json`,
  wages: (soc: string, level: string) => `w/${soc}/${level}.json`,
  employerSearch: (prefix: string) => `s/${prefix}.json`,
  titleSearch: (prefix: string) => `t/${prefix}.json`,
};

// Applied to every response, including 404s / 401s / 429s / 304s. `vary`
// belongs on all of them, not just the CORS-allowed branch: without it, a
// cache serving a public max-age=3600 body could hand a cross-origin response
// to a same-origin request, or vice versa.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  vary: "origin",
} as const;

export function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

/**
 * Stream an R2 object through untouched, or 404 with a JSON body.
 * Honors If-None-Match / If-Match via R2's onlyIf: a failed precondition
 * returns 304 with no body, which saves egress (though R2 still bills the
 * read — only an edge cache would avoid that, and the free-tier read budget
 * has ~3x headroom by construction).
 */
export async function serve(
  bucket: R2Bucket,
  key: string,
  headers: Record<string, string>,
  request?: Request,
  cacheControl = "public, max-age=3600",
): Promise<Response> {
  const obj = request
    ? await bucket.get(key, { onlyIf: request.headers })
    : await bucket.get(key);
  if (!obj) return json({ error: "not found" }, 404, headers);
  const base = {
    etag: obj.httpEtag,
    "cache-control": cacheControl,
    ...SECURITY_HEADERS,
    ...headers,
  };
  if (!("body" in obj) || obj.body === null) {
    // R2's onlyIf handles both If-None-Match (revalidation) and If-Match
    // (write-guard). Per RFC 9110, a failed If-Match on GET is 412, not
    // 304. If-None-Match failures stay 304 as before.
    const ifMatch = request?.headers.get("if-match");
    const status = ifMatch ? 412 : 304;
    return new Response(null, { status, headers: base });
  }
  return new Response(obj.body as unknown as BodyInit, {
    headers: { "content-type": "application/json; charset=utf-8", ...base },
  });
}

/** Serve the first key that exists; 404 if none do. */
export async function serveFirst(
  bucket: R2Bucket,
  candidates: string[],
  headers: Record<string, string>,
  request?: Request,
): Promise<Response> {
  for (const key of candidates) {
    const res = await serve(bucket, key, headers, request);
    if (res.status !== 404) return res;
  }
  return json({ error: "not found" }, 404, headers);
}

/**
 * Normalize a search term the same way publish.py bucketed the prefixes
 * (ASCII lowercase, single spaces, [a-z0-9 ] only — the Python side mirrors
 * this exactly; the parity is pinned by tests on both sides).
 * Returns the cleaned term capped at MAX_PREFIX_DEPTH, or null if too short.
 * A 404 downstream means "no employer with this prefix exists".
 */
export function searchPrefix(q: string): string | null {
  const norm = q.trim().toLowerCase().replace(/\s+/g, " ");
  if (norm.length < 2) return null;
  const cleaned = norm.replace(/[^a-z0-9 ]/g, "");
  if (cleaned.length < 2) return null;
  return cleaned.slice(0, MAX_PREFIX_DEPTH);
}

/** Candidate search keys for a cleaned prefix, longest (most specific) first.
 * At most five probes: the longest available prefix plus its two shorter
 * neighbors (to cover overflow chains a query overshoots — e.g. "amazee"
 * when only "amaz" exists, or "amazing" when the chain stops at "amaz"),
 * then the depth-3 base tier and depth-2. Publisher emits deeper tiers
 * only where a shallower bucket overflowed, so an unbounded ladder
 * previously paid up to 9 serial 404 reads (see super-review-retest-report.md).
 * A residual gap remains for queries so long that the chain stops more
 * than two depths above them; storing per-lineage depth pointers in the
 * shallow buckets would close it fully.
 */
export function searchKeyCandidates(cleaned: string, build: (p: string) => string): string[] {
  const longest = Math.min(cleaned.length, MAX_PREFIX_DEPTH);
  const depths = [longest, longest - 1, longest - 2, 3, 2]
    .filter((d) => d >= 2 && d <= cleaned.length)      // no slicing past the string
    .sort((a, b) => b - a);                            // longest first
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of depths) {
    const key = build(cleaned.slice(0, d));            // depths differ but slices can match
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  }
  return out;
}
