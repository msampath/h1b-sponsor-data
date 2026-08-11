// Self-serve key issuance + dynamic key lookup.
//
// A key is a bearer token the caller keeps and this Worker does not: KV holds
// sha256(token) and nothing that can be replayed, so a leaked KV dump buys an
// attacker no access. Revocation is a KV delete, which means there is no
// `revoked` flag for a future reader to forget to check.
//
// Issuance is metered by the same BucketMeter the read path uses, on two
// buckets (this requester, and everyone) so one address cannot spend the
// day's global budget.

import type { CfRequest, Env } from "./index";
import { json } from "./r2";
import { bucketIp, LIMITS, type RateVerdict, type Tier } from "./ratelimit";

/**
 * Hex sha256. Lives here rather than in index.ts because hashing secrets is
 * this module's job; index.ts imports it back for the static key table.
 */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 192 bits of CSPRNG. The raw token leaves this module once, in the 201. */
function randomToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  return "h1b_" + [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface KeyMeta {
  label: string;
  createdAt: string;
  /**
   * sha256(`${ip}|${asn}`). Enough to spot one requester minting in bulk
   * across an audit listing, without putting an address on disk.
   */
  requestor: string;
}

// Positive-only cache, per isolate, mirroring keyTableCache in index.ts. A hit
// skips the KV read; a miss always pays it, so a key minted seconds ago on a
// different isolate still authenticates here. The cost is the mirror image: a
// revoked key keeps working on an isolate that cached it, for at most the TTL.
const CACHE_TTL_MS = 60_000;
const keyCache = new Map<string, { label: string; expiresAt: number }>();

/** Make a just-minted key readable on this isolate before KV converges. */
export function seedKeyCache(hash: string, label: string): void {
  keyCache.set(hash, { label, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Drop the isolate cache. Test-only; production never needs to forget a key
 *  early (revocation rides the TTL). */
export function clearKeyCache(): void {
  keyCache.clear();
}

/** Cache-only label lookup — no KV, no I/O. A hit lets the caller skip both
 *  the lookup throttle and the KV read for a key already seen on this isolate. */
export function cachedKeyLabel(hash: string): string | null {
  const hit = keyCache.get(hash);
  return hit && hit.expiresAt > Date.now() ? hit.label : null;
}

/** Label for a self-serve key, or null if KV has never heard of it. */
export async function dynamicKeyLabel(env: Env, hash: string): Promise<string | null> {
  const kv = env.KEYS;
  if (!kv) return null;

  const cached = cachedKeyLabel(hash);
  if (cached) return cached;

  let raw: string | null;
  try {
    raw = await kv.get(hash);
  } catch (e) {
    // Fail closed, dynamic keys only: a KV blip demotes a self-serve key to
    // "unknown" (401). It can never widen access, and static keys are already
    // resolved by the time we get here.
    console.error("KEYS lookup failed; treating key as unknown", e);
    return null;
  }
  if (!raw) return null;

  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch (e) {
    console.error("KEYS entry is not valid JSON; treating key as unknown", e);
    return null;
  }
  // Shape-check before trusting it: a KV value of `null`, a number, a string,
  // or an array must not authenticate. Without this, `123` read as
  // `(123).label ?? "self-serve"` and quietly minted a keyed session, and a
  // literal `null` threw out of classify() as a 500 instead of a clean 401.
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    console.error("KEYS entry has an unexpected shape; treating key as unknown");
    return null;
  }
  const rawLabel = (meta as { label?: unknown }).label;
  const label = typeof rawLabel === "string" && rawLabel ? rawLabel : "self-serve";
  seedKeyCache(hash, label);
  return label;
}

const MINT_NOTE =
  "A new key can take up to about 60 seconds to be recognized on every server. " +
  "If a request returns 401 in the first minute, wait and retry.";

/**
 * Take one token from a bucket. null means the round-trip failed at all, which
 * is a different outcome from a clean deny and the caller treats it as such.
 * Exported so the read path can throttle the KV lookup that validates a
 * presented self-serve token, on the same meter.
 */
export async function takeToken(env: Env, bucketKey: string, tier: Tier): Promise<RateVerdict | null> {
  try {
    const stub = env.BUCKET.get(env.BUCKET.idFromName(bucketKey));
    const res = await stub.fetch("https://do/take", {
      method: "POST",
      body: JSON.stringify({ tier }),
      headers: { "content-type": "application/json" },
    });
    if (!res.ok) {
      console.error("BucketMeter returned", res.status);
      return null;
    }
    return (await res.json()) as RateVerdict;
  } catch (e) {
    console.error("BucketMeter round-trip failed", e);
    return null;
  }
}

/** Hand one token back to a bucket when the charge turned out to buy nothing —
 *  a later gate in the same operation denied, or the metered work proved
 *  legitimate and was never what the meter was defending against.
 *  Best-effort: a failed refund only leaves the caller one token lighter for
 *  the window, never blocks the response. */
export async function giveToken(env: Env, bucketKey: string, tier: Tier): Promise<void> {
  try {
    const stub = env.BUCKET.get(env.BUCKET.idFromName(bucketKey));
    await stub.fetch("https://do/give", {
      method: "POST",
      body: JSON.stringify({ tier }),
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    console.error("BucketMeter refund failed", e);
  }
}

/** POST /keys/request — issue one key, or say why not. */
export async function mintKey(
  request: CfRequest,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  // CLI and server clients send no Origin; a browser always sends one. That
  // asymmetry kills drive-by minting from a page the user is merely visiting,
  // without touching the CORS policy, which still advertises GET, OPTIONS.
  if (request.headers.get("origin")) {
    return json({ error: "browser origins cannot mint keys" }, 403, cors);
  }

  // Nothing to meter if issuance can't work anyway: bail before touching a
  // bucket so a misconfigured deployment never charges a requester a token.
  const kv = env.KEYS;
  if (!kv) {
    console.error("KEYS namespace is not bound; cannot issue keys");
    return json({ error: "issuance temporarily unavailable" }, 503, cors);
  }

  const ip = bucketIp(request.headers.get("cf-connecting-ip") ?? "0.0.0.0");
  const asn = request.cf?.asn ?? 0;
  const reqBucket = `mint|${ip}|${asn}`;

  // Per-requester first: an address at its own limit denies here, before the
  // shared budget is touched, so one requester cannot drain the global cap on
  // the way to its 429.
  const perReq = await takeToken(env, reqBucket, "mint");
  // Minting fails CLOSED, the opposite of the read path: a read served during
  // a DO outage costs one response, an unmetered issuance endpoint during the
  // same outage costs every key anyone cares to ask for.
  if (!perReq) return json({ error: "issuance temporarily unavailable" }, 503, cors);
  if (!perReq.ok) {
    return json({ error: "rate limit exceeded" }, 429, {
      ...cors,
      "retry-after": String(perReq.retryAfter),
    });
  }

  // The requester's token is now spent. If the global gate denies, that token
  // bought nothing, so refund it: an honest first-time requester must not lose
  // a day's allowance to a global-exhaustion or kill-switch 429.
  const global = await takeToken(env, "mint|global", "mintGlobal");
  if (!global || !global.ok) {
    await giveToken(env, reqBucket, "mint");
    if (!global) return json({ error: "issuance temporarily unavailable" }, 503, cors);
    return json({ error: "rate limit exceeded" }, 429, {
      ...cors,
      "retry-after": String(global.retryAfter),
    });
  }

  const token = randomToken();
  const hash = await sha256Hex(token);
  const meta: KeyMeta = {
    label: "self-serve",
    createdAt: new Date().toISOString(),
    requestor: await sha256Hex(`${ip}|${asn}`),
  };
  try {
    await kv.put(hash, JSON.stringify(meta));
  } catch (e) {
    // Return nothing on a failed write, and refund both charges: no key was
    // issued, so neither the requester nor the global budget should pay.
    console.error("KEYS put failed; no key issued", e);
    await giveToken(env, reqBucket, "mint");
    await giveToken(env, "mint|global", "mintGlobal");
    return json({ error: "could not issue key" }, 500, cors);
  }

  // KV is eventually consistent; seed the isolate that is about to be asked.
  seedKeyCache(hash, meta.label);
  return json({ token, tier: "keyed", limit: LIMITS.keyed, note: MINT_NOTE }, 201, cors);
}
