// R2 key construction and the streaming response helper.
//
// The one rule that keeps this Worker inside the free tier's 10 ms CPU
// budget: never JSON.parse an object. Objects are precomputed by
// etl/publish.py to be exactly what an endpoint returns, so the body is
// streamed straight through. Waiting on R2 is I/O and does not count
// toward CPU time; parsing a 1.5 MB employer would.

import type { R2Bucket } from "@cloudflare/workers-types";

export const keys = {
  meta: () => "meta.json",
  employer: (ein: string) => `e/${ein}.json`,
  employerJobs: (ein: string) => `e/${ein}/jobs.json`,
  employerTitles: (ein: string) => `e/${ein}/titles.json`,
  wages: (soc: string, level: string) => `w/${soc}/${level}.json`,
  employerSearch: (prefix: string) => `s/${prefix}.json`,
  titleSearch: (prefix: string) => `t/${prefix}.json`,
};

export function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** Stream an R2 object through untouched, or 404 with a JSON body. */
export async function serve(
  bucket: R2Bucket,
  key: string,
  headers: Record<string, string>,
): Promise<Response> {
  const obj = await bucket.get(key);
  if (!obj) return json({ error: "not found" }, 404, headers);
  return new Response(obj.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      etag: obj.httpEtag,
      ...headers,
    },
  });
}

/** Normalize a search term the same way publish.py bucketed the prefixes. */
export function searchPrefix(q: string): string | null {
  const norm = q.trim().toLowerCase().replace(/\s+/g, " ");
  if (norm.length < 2) return null;
  // Only [a-z0-9 ] survives; anything else can't match a generated bucket.
  const cleaned = norm.replace(/[^a-z0-9 ]/g, "");
  if (cleaned.length < 2) return null;
  // 3-char buckets exist where the corpus warranted them, else fall to 2.
  return cleaned.slice(0, 3).length === 3 ? cleaned.slice(0, 3) : cleaned.slice(0, 2);
}
