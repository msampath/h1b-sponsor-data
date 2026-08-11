// Entry point: CORS → key issuance (POST) → route → auth → rate limit →
// stream from R2.

import type {
  DurableObjectNamespace,
  IncomingRequestCfProperties,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";
import {
  cachedKeyLabel,
  dynamicKeyLabel,
  giveToken,
  mintKey,
  sha256Hex,
  takeToken,
} from "./keys";
import { BucketMeter, bucketIp, type RateVerdict, type Tier } from "./ratelimit";
import {
  json,
  keys,
  searchKeyCandidates,
  searchPrefix,
  serve,
  serveFirst,
} from "./r2";

export { BucketMeter };

export interface Env {
  DATA: R2Bucket;
  BUCKET: DurableObjectNamespace;
  /** JSON map of sha256(token) -> label. Set with `wrangler secret put API_KEYS`. */
  API_KEYS?: string;
  /** sha256(token) -> key metadata JSON, for self-serve keys. Optional so a
   *  deployment (or a test) without the namespace still runs, key-less. */
  KEYS?: KVNamespace;
}

export type CfRequest = Request<unknown, IncomingRequestCfProperties>;

const PREFIX = "/immigration/v1";
const ALLOWED_ORIGINS = new Set(["https://surakshith.com", "https://www.surakshith.com"]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    // without this the browser hides the rate-limit headers from the page
    "access-control-expose-headers":
      "x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

// API_KEYS is a handful of entries and immutable per deployment; parse once
// per isolate. A malformed secret is an operator error and must be loud, not
// a silent demotion of every keyed caller to the anon tier.
let keyTableCache: { raw: string; table: Record<string, string> } | null = null;

export function keyTable(env: Env): Record<string, string> {
  const raw = env.API_KEYS ?? "";
  if (keyTableCache && keyTableCache.raw === raw) return keyTableCache.table;
  let table: Record<string, string> = {};
  if (raw) {
    try {
      table = JSON.parse(raw);
    } catch (e) {
      console.error("API_KEYS secret is not valid JSON; all keyed auth will 401", e);
      table = {};
    }
  }
  keyTableCache = { raw, table };
  return table;
}

type Caller =
  | { tier: Tier; bucketKey: string }
  | { unknownKey: true }
  | { throttled: true; retryAfter: number };

// RFC 6750: the scheme name is case-insensitive. `startsWith("Bearer ")`
// silently dropped a lowercase `bearer` header to the anon tier, sidestepping
// the 401 contract on unknown keys.
const BEARER_RE = /^\s*bearer\s+(\S.*)$/i;

/** Classify the caller. A presented-but-unknown key is a 401, not silent anon. */
export async function classify(request: CfRequest, env: Env): Promise<Caller> {
  const auth = request.headers.get("authorization");
  const match = auth ? BEARER_RE.exec(auth) : null;
  const token = match ? match[1].trim() : "";

  // (IP, ASN) identity, shared by the anon bucket and the lookup throttle.
  // IPv6 collapses to its /64 so a client cannot walk its address space to
  // dodge a per-address limit; the ASN disambiguates the same IP across
  // networks.
  const ip = bucketIp(request.headers.get("cf-connecting-ip") ?? "0.0.0.0");
  const asn = request.cf?.asn ?? 0;

  if (token) {
    const hash = await sha256Hex(token);
    if (hash in keyTable(env)) {
      // Bucket keyed callers by the key itself: a leaked key must share one
      // quota everywhere rather than minting a fresh one per network.
      return { tier: "keyed", bucketKey: `keyed|${hash}` };
    }
    // Self-serve keys live in KV. Static keys resolved above and never pay
    // this lookup, so the operator's own keys keep working through a KV
    // outage. Both kinds share the keyed bucket namespace and the keyed limit.
    if (env.KEYS) {
      // A key already seen on this isolate is free to re-check.
      if (cachedKeyLabel(hash)) return { tier: "keyed", bucketKey: `keyed|${hash}` };
      // Cache miss means a KV read, which is the step a flood of junk tokens
      // could amplify (each miss is one read, and the positive-only cache
      // never absorbs junk). Meter that read per (IP, ASN) first. A clean deny
      // throttles the flood; a DO failure (null) fails OPEN to the read, since
      // the read path already trades availability for a DO outage and the KV
      // lookup still fails closed to 401 on its own errors.
      const lookupBucket = `lookup|${ip}|${asn}`;
      const gate = await takeToken(env, lookupBucket, "lookup");
      if (gate && !gate.ok) return { throttled: true, retryAfter: gate.retryAfter };
      const label = await dynamicKeyLabel(env, hash);
      if (label) {
        // The read proved the token genuine, so refund the charge: this meter
        // exists to bound junk, not to ration a real key holder's reads. Only
        // a miss that stays a miss should cost. Without the refund a client
        // whose requests keep landing on cold isolates — or one sharing an
        // egress IP with other key holders — is cut off at `lookup` (120/h)
        // instead of the `keyed` limit (200/h) its key was issued with, and
        // the 429 that ends it carries no x-ratelimit headers to explain why.
        // `gate` is non-null here, so a token really was spent.
        if (gate) await giveToken(env, lookupBucket, "lookup");
        return { tier: "keyed", bucketKey: `keyed|${hash}` };
      }
    }
    return { unknownKey: true };
  }

  // Anonymous: one bucket per (IP, ASN).
  return { tier: "anon", bucketKey: `anon|${ip}|${asn}` };
}

export default {
  async fetch(request: CfRequest, env: Env): Promise<Response> {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      // vary: origin on every response, including preflight — without it a
      // shared cache could mix origin variants of the CORS reply too.
      return new Response(null, {
        status: 204,
        headers: { ...cors, vary: "origin" },
      });
    }
    // Issuance is the one write in the API, so the URL has to be parsed
    // before the read-only method gate rather than after it.
    const url = new URL(request.url);
    if (request.method === "POST") {
      return url.pathname === PREFIX + "/keys/request"
        ? mintKey(request, env, cors)
        : json({ error: "method not allowed" }, 405, cors);
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405, cors);
    }

    if (!url.pathname.startsWith(PREFIX)) return json({ error: "not found" }, 404, cors);
    const path = url.pathname.slice(PREFIX.length);

    // healthz: a single small precomputed R2 GET, served before the rate
    // limiter by design — nothing here can be amplified.
    if (path === "/healthz") {
      return serve(env.DATA, keys.meta(), cors, request, "public, max-age=300");
    }

    const caller = await classify(request, env);
    if ("throttled" in caller) {
      return json({ error: "rate limit exceeded" }, 429, {
        ...cors,
        "retry-after": String(caller.retryAfter),
      });
    }
    if ("unknownKey" in caller) {
      return json({ error: "invalid API key" }, 401, cors);
    }

    // Rate limit. If the Durable Object round-trip fails (transient DO error,
    // reset, bad internal reply), fail OPEN with a log line: this is a public
    // read-only API and availability wins; the Workers daily cap still bounds
    // total cost. Fail-closed would let a DO outage take the API down.
    let rl: RateVerdict | null = null;
    try {
      const stub = env.BUCKET.get(env.BUCKET.idFromName(caller.bucketKey));
      const res = await stub.fetch("https://do/take", {
        method: "POST",
        body: JSON.stringify({ tier: caller.tier }),
        headers: { "content-type": "application/json" },
      });
      if (res.ok) rl = (await res.json()) as RateVerdict;
      else console.error("BucketMeter returned", res.status);
    } catch (e) {
      console.error("BucketMeter round-trip failed; failing open", e);
    }

    const headers: Record<string, string> = { ...cors };
    if (rl) {
      headers["x-ratelimit-limit"] = String(rl.limit);
      headers["x-ratelimit-remaining"] = String(rl.remaining);
      headers["x-ratelimit-reset"] = String(rl.resetAt);
    }

    if (rl && !rl.ok) {
      return json({ error: "rate limit exceeded" }, 429, {
        ...headers,
        "retry-after": String(rl.retryAfter),
      });
    }

    return route(path, url, env, headers, request);
  },
};

async function route(
  path: string,
  url: URL,
  env: Env,
  headers: Record<string, string>,
  request: CfRequest,
): Promise<Response> {
  if (path === "/employers/search" || path === "/titles") {
    const prefix = searchPrefix(url.searchParams.get("q") ?? "");
    if (!prefix) return json({ error: "q must be at least 2 characters" }, 400, headers);
    const build = path === "/titles" ? keys.titleSearch : keys.employerSearch;
    // Deeper buckets exist only where a shallower one overflowed; probe
    // longest-first. A 404 from every depth means no name has this prefix.
    return serveFirst(env.DATA, searchKeyCandidates(prefix, build), headers, request);
  }

  if (path === "/wages") {
    const soc = (url.searchParams.get("soc") ?? "").trim();
    const level = (url.searchParams.get("level") ?? "").trim().toUpperCase();
    if (!/^\d{2}-\d{4}$/.test(soc)) {
      return json({ error: "soc must look like 15-1252" }, 400, headers);
    }
    // NA serves filings whose wage level was absent or unparseable.
    if (!["I", "II", "III", "IV", "NA"].includes(level)) {
      return json({ error: "level must be I, II, III, IV or NA" }, 400, headers);
    }
    return serve(env.DATA, keys.wages(soc, level), headers, request);
  }

  const emp = path.match(/^\/employers\/([^/]+)(\/jobs|\/titles)?$/);
  if (emp) {
    let raw: string;
    try {
      raw = decodeURIComponent(emp[1]);
    } catch {
      return json({ error: "malformed employer id" }, 400, headers);
    }
    const key = employerKey(raw);
    if (!key) {
      return json(
        { error: "employer id must be a 9-digit FEIN or an n- prefixed key" },
        400,
        headers,
      );
    }
    if (emp[2] === "/jobs") return serve(env.DATA, keys.employerJobs(key), headers, request);
    if (emp[2] === "/titles") return serve(env.DATA, keys.employerTitles(key), headers, request);
    return serve(env.DATA, keys.employer(key), headers, request);
  }

  return json({ error: "not found" }, 404, headers);
}

/**
 * Employers are identified by FEIN where DOL published one. Employers seen
 * only in the FY2020-23 files (no FEIN column) carry an opaque `n-` key.
 */
export function employerKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^n-[a-z0-9-]{1,64}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, "");
  return digits.length === 9 ? digits : null;
}
