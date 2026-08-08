// Entry point: CORS → route → auth → rate limit → stream from R2.

import type { DurableObjectNamespace, R2Bucket } from "@cloudflare/workers-types";
import { BucketMeter, LIMITS, type Tier } from "./ratelimit";
import { json, keys, searchPrefix, serve } from "./r2";

export { BucketMeter };

export interface Env {
  DATA: R2Bucket;
  BUCKET: DurableObjectNamespace;
  /** JSON map of sha256(token) -> label. Set with `wrangler secret put API_KEYS`. */
  API_KEYS?: string;
}

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

/** Returns the rate-limit bucket key and tier for this caller. */
async function classify(
  request: Request,
  env: Env,
): Promise<{ tier: Tier; bucketKey: string }> {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (token && env.API_KEYS) {
    const hash = await sha256Hex(token);
    let table: Record<string, string> = {};
    try {
      table = JSON.parse(env.API_KEYS);
    } catch {
      table = {};
    }
    if (hash in table) {
      // Bucket keyed callers by the key itself. Bucketing them by IP would
      // hand a leaked key a fresh quota on every network it is used from.
      return { tier: "keyed", bucketKey: `keyed|${hash}` };
    }
  }

  // Anonymous: (IP, ASN) so rotating IPs within one VPN provider still
  // share a bucket.
  const cf = (request as unknown as { cf?: { asn?: number } }).cf;
  const ip = request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  return { tier: "anon", bucketKey: `anon|${ip}|${cf?.asn ?? 0}` };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405, cors);
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return json({ error: "not found" }, 404, cors);
    const path = url.pathname.slice(PREFIX.length);

    // healthz is a single small R2 GET of a precomputed object — no scans,
    // nothing an attacker can amplify.
    if (path === "/healthz") return serve(env.DATA, keys.meta(), cors);

    const { tier, bucketKey } = await classify(request, env);
    const stub = env.BUCKET.get(env.BUCKET.idFromName(bucketKey));
    const rl = (await (
      await stub.fetch("https://do/take", {
        method: "POST",
        body: JSON.stringify({ tier }),
        headers: { "content-type": "application/json" },
      })
    ).json()) as { ok: boolean; limit: number; remaining: number; resetAt: number; retryAfter: number };

    const headers: Record<string, string> = {
      ...cors,
      "x-ratelimit-limit": String(rl.limit ?? LIMITS[tier]),
      "x-ratelimit-remaining": String(rl.remaining),
      "x-ratelimit-reset": String(rl.resetAt),
    };

    if (!rl.ok) {
      return json({ error: "rate limit exceeded" }, 429, {
        ...headers,
        "retry-after": String(rl.retryAfter),
      });
    }

    return route(path, url, env, headers);
  },
};

async function route(
  path: string,
  url: URL,
  env: Env,
  headers: Record<string, string>,
): Promise<Response> {
  if (path === "/employers/search") {
    const prefix = searchPrefix(url.searchParams.get("q") ?? "");
    if (!prefix) return json({ error: "q must be at least 2 characters" }, 400, headers);
    return serve(env.DATA, keys.employerSearch(prefix), headers);
  }

  if (path === "/titles") {
    const prefix = searchPrefix(url.searchParams.get("q") ?? "");
    if (!prefix) return json({ error: "q must be at least 2 characters" }, 400, headers);
    return serve(env.DATA, keys.titleSearch(prefix), headers);
  }

  if (path === "/wages") {
    const soc = (url.searchParams.get("soc") ?? "").trim();
    const level = (url.searchParams.get("level") ?? "").trim().toUpperCase();
    if (!/^\d{2}-\d{4}$/.test(soc)) {
      return json({ error: "soc must look like 15-1252" }, 400, headers);
    }
    if (!["I", "II", "III", "IV"].includes(level)) {
      return json({ error: "level must be I, II, III or IV" }, 400, headers);
    }
    return serve(env.DATA, keys.wages(soc, level), headers);
  }

  const emp = path.match(/^\/employers\/([^/]+)(\/jobs|\/titles)?$/);
  if (emp) {
    const key = employerKey(decodeURIComponent(emp[1]));
    if (!key) {
      return json(
        { error: "employer id must be a 9-digit FEIN or an n- prefixed key" },
        400,
        headers,
      );
    }
    if (emp[2] === "/jobs") return serve(env.DATA, keys.employerJobs(key), headers);
    if (emp[2] === "/titles") return serve(env.DATA, keys.employerTitles(key), headers);
    return serve(env.DATA, keys.employer(key), headers);
  }

  return json({ error: "not found" }, 404, headers);
}

/**
 * Employers are identified by FEIN where one exists. DOL only began
 * publishing employer_fein in FY2024, so employers seen solely in the
 * FY2020-23 files carry a name-derived `n-` key instead. Both forms appear
 * in search results and both are valid here.
 */
function employerKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^n-[a-z0-9-]{1,64}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, "");
  return digits.length === 9 ? digits : null;
}
