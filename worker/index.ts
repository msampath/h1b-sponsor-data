// Entry point: CORS → route → auth → rate limit → stream from R2.

import type {
  DurableObjectNamespace,
  IncomingRequestCfProperties,
  R2Bucket,
} from "@cloudflare/workers-types";
import { BucketMeter, type RateVerdict, type Tier } from "./ratelimit";
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
}

type CfRequest = Request<unknown, IncomingRequestCfProperties>;

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

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  | { unknownKey: true };

// RFC 6750: the scheme name is case-insensitive. `startsWith("Bearer ")`
// silently dropped a lowercase `bearer` header to the anon tier, sidestepping
// the 401 contract on unknown keys.
const BEARER_RE = /^\s*bearer\s+(\S.*)$/i;

/** Classify the caller. A presented-but-unknown key is a 401, not silent anon. */
export async function classify(request: CfRequest, env: Env): Promise<Caller> {
  const auth = request.headers.get("authorization");
  const match = auth ? BEARER_RE.exec(auth) : null;
  const token = match ? match[1].trim() : "";

  if (token) {
    const hash = await sha256Hex(token);
    if (hash in keyTable(env)) {
      // Bucket keyed callers by the key itself: a leaked key must share one
      // quota everywhere rather than minting a fresh one per network.
      return { tier: "keyed", bucketKey: `keyed|${hash}` };
    }
    return { unknownKey: true };
  }

  // Anonymous: (IP, ASN). The IP is part of the key, so each address gets
  // its own bucket; the ASN only disambiguates the same IP seen via
  // different networks.
  const ip = request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  const asn = request.cf?.asn ?? 0;
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
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405, cors);
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return json({ error: "not found" }, 404, cors);
    const path = url.pathname.slice(PREFIX.length);

    // healthz: a single small precomputed R2 GET, served before the rate
    // limiter by design — nothing here can be amplified.
    if (path === "/healthz") {
      return serve(env.DATA, keys.meta(), cors, request, "public, max-age=300");
    }

    const caller = await classify(request, env);
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
