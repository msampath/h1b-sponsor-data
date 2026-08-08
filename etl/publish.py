"""Render the `sponsors` schema into R2 objects.

Every API endpoint maps to exactly one precomputed object, so the Worker
never parses JSON — it streams bytes. That is what keeps it inside the free
tier's 10 ms CPU budget.

Usage:
    python etl/publish.py --dry-run     # count objects and bytes, upload nothing
    python etl/publish.py               # upload changed objects only
    python etl/publish.py --force       # ignore the manifest, upload everything
    python etl/publish.py --resume      # after an interrupted run: list the
                                        # bucket and skip what already landed
    python etl/publish.py --limit 200   # exercise the real upload path at
                                        # small scale before a full run

Uploads are manifest-diffed (key -> sha256) because R2's free tier allows
1M Class A operations per month and a full publish is ~694k of them.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from itertools import groupby
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_KEY = "_manifest.json"
SEARCH_CAP = 50          # hits stored per prefix bucket
UPLOAD_THREADS = 32


_KEEP = set("abcdefghijklmnopqrstuvwxyz0123456789 ")


def norm_name(s: str) -> str:
    """Must match worker/r2.ts searchPrefix() exactly, or a query lands on a
    bucket that was never generated and 404s.

    ASCII-only on purpose: str.isalnum() is Unicode-aware, so it would keep
    'café corp' while the Worker's /[^a-z0-9 ]/ strips it to 'caf corp' —
    the two sides would bucket accented names differently.
    """
    out = " ".join((s or "").lower().split())
    return "".join(ch for ch in out if ch in _KEEP)


def prefixes(name: str) -> list[str]:
    """Buckets this name belongs to. The Worker asks for a 3-char prefix when
    the query has 3+ characters and a 2-char prefix otherwise, so both tiers
    must exist."""
    c = norm_name(name)
    out = []
    if len(c) >= 2:
        out.append(c[:2])
    if len(c) >= 3:
        out.append(c[:3])
    return out


def body(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), default=str).encode("utf-8")


class Publisher:
    def __init__(self, dry_run: bool, force: bool, resume: bool = False, limit: int = 0):
        self.dry_run = dry_run
        self.force = force
        self.resume = resume
        self.limit = limit
        self.manifest: dict[str, str] = {}
        self.next_manifest: dict[str, str] = {}
        self.existing: set[str] = set()
        self.failed: list[tuple[str, bytes]] = []
        self.n_objects = 0
        self.n_uploaded = 0
        self.n_skipped = 0
        self.n_bytes = 0
        self.client = None
        self.bucket = None
        self._pending: list[tuple[str, bytes]] = []

    # ── R2 ───────────────────────────────────────────────────────────────
    def connect_r2(self):
        if self.dry_run:
            return
        import boto3
        from botocore.config import Config

        account = os.environ["R2_ACCOUNT_ID"]
        self.bucket = os.environ.get("R2_BUCKET", "h1b-sponsor-data")
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            # R2 returns transient InternalError under sustained concurrency.
            # The default of 4 attempts is not enough for a 700k object run.
            config=Config(
                retries={"max_attempts": 10, "mode": "adaptive"},
                max_pool_connections=UPLOAD_THREADS * 2,
            ),
        )
        if not self.force:
            try:
                raw = self.client.get_object(Bucket=self.bucket, Key=MANIFEST_KEY)
                self.manifest = json.loads(raw["Body"].read())
                print(f"manifest: {len(self.manifest):,} known objects")
            except Exception:
                print("manifest: none found, treating as first publish")

        if self.resume and not self.manifest:
            # The manifest is only written at the end, so an interrupted run
            # leaves objects in the bucket with no record of them. Listing is
            # ~450 Class A ops against ~450k re-uploads, so seed from the
            # bucket instead. Presence is sufficient here because object
            # content is deterministic for a given build; --resume is opt-in
            # precisely so this never silently skips genuinely changed objects
            # on a later rebuild.
            print("resume: listing bucket to find what already landed ...", flush=True)
            pager = self.client.get_paginator("list_objects_v2")
            for page in pager.paginate(Bucket=self.bucket):
                for o in page.get("Contents", []):
                    self.existing.add(o["Key"])
            print(f"resume: {len(self.existing):,} objects already present")

    def put(self, key: str, data: bytes):
        # --limit exists because --dry-run returns before anything is queued,
        # so it never executes flush(), _put_one(), or the manifest write. A
        # clean dry-run says nothing about whether uploading works. This runs
        # the real path against a handful of objects instead.
        if self.limit and self.n_objects >= self.limit:
            return
        self.n_objects += 1
        self.n_bytes += len(data)
        digest = hashlib.sha256(data).hexdigest()
        self.next_manifest[key] = digest
        if self.dry_run:
            return
        if not self.force and self.manifest.get(key) == digest:
            return
        if not self.force and key in self.existing:
            self.n_skipped += 1
            return
        self._pending.append((key, data))
        if len(self._pending) >= 2000:
            self.flush()

    def _put_one(self, item):
        """Upload with backoff. A single object must never kill the run."""
        key, data = item
        for attempt in range(5):
            try:
                self.client.put_object(
                    Bucket=self.bucket, Key=key, Body=data,
                    ContentType="application/json",
                )
                return None
            except Exception:
                if attempt == 4:
                    return item
                time.sleep(2 ** attempt * 0.5)
        return item

    def flush(self):
        if self.dry_run or not self._pending:
            self._pending = []
            return
        batch, self._pending = self._pending, []
        with ThreadPoolExecutor(max_workers=UPLOAD_THREADS) as pool:
            failures = [f for f in pool.map(self._put_one, batch) if f]
        self.failed.extend(failures)
        self.n_uploaded += len(batch) - len(failures)
        note = f"  uploaded {self.n_uploaded:,} / seen {self.n_objects:,}"
        if self.n_skipped:
            note += f" / skipped {self.n_skipped:,}"
        if self.failed:
            note += f" / FAILED {len(self.failed):,}"
        print(note, flush=True)

    def finish(self):
        self.flush()
        if self.dry_run:
            return
        # One more pass at anything that exhausted its retries. These are
        # transient R2 errors, so a second attempt after the burst usually
        # clears them.
        if self.failed:
            print(f"retrying {len(self.failed):,} failed objects ...", flush=True)
            retry, self.failed = self.failed, []
            with ThreadPoolExecutor(max_workers=8) as pool:
                self.failed = [f for f in pool.map(self._put_one, retry) if f]
            self.n_uploaded += len(retry) - len(self.failed)
        # --limit only ever sees the first N objects, so its next_manifest is
        # a tiny fraction of reality. Writing it would clobber the real
        # manifest and make the following run believe almost nothing had been
        # published.
        if self.limit:
            print("limit run: manifest not written")
            return
        # Only claim a key in the manifest if it actually made it up, or a
        # later run would skip an object that was never written.
        bad = {k for k, _ in self.failed}
        self.client.put_object(
            Bucket=self.bucket, Key=MANIFEST_KEY,
            Body=body({k: v for k, v in self.next_manifest.items() if k not in bad}),
            ContentType="application/json",
        )
        if self.failed:
            print(f"WARNING: {len(self.failed):,} objects still failed. "
                  f"Re-run with --resume to pick them up.")


def stream(conn, sql: str, name: str, size: int = 10_000):
    cur = conn.cursor(name=name)
    cur.itersize = size
    cur.execute(sql)
    yield from cur
    cur.close()


def main() -> int:
    load_dotenv(ROOT / ".env")
    dry = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    resume = "--resume" in sys.argv
    limit = 0
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    conn = psycopg2.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        dbname=os.environ.get("SOURCE_DB", "lca"),
    )

    p = Publisher(dry, force, resume, limit)
    p.connect_r2()

    # ── employer profiles ────────────────────────────────────────────────
    print("employers + profiles ...", flush=True)
    search_buckets: dict[str, list] = defaultdict(list)
    counts = {}

    sql = """
      SELECT e.id, e.key, e.ein, e.name,
             p.first_year, p.last_year, p.n_lca, p.n_certified,
             p.n_certified_withdrawn, p.n_denied, p.n_withdrawn,
             p.n_new, p.n_transfer, p.n_continued, p.n_pwd, p.n_perm,
             p.does_gc, p.wage_vs_pw, p.gc_by_year, p.gc_by_soc,
             p.filings_by_soc_year, p.trend, p.level_mix, p.red_flags
      FROM sponsors.employers e
      JOIN sponsors.employer_profile p ON p.employer_id = e.id
      ORDER BY e.id
    """
    for r in stream(conn, sql, "emp"):
        (eid, key, ein, name, fy, ly, n_lca, n_cert, n_cw, n_den, n_wd,
         n_new, n_tr, n_cont, n_pwd, n_perm, does_gc, wvp,
         gc_year, gc_soc, soc_year, trend, level_mix, red_flags) = r

        p.put(f"e/{key}.json", body({
            "employer": {"id": key, "ein": ein, "name": name},
            "years": {"first": fy, "last": ly},
            "filings": {
                "lca": n_lca, "certified": n_cert,
                "certified_withdrawn": n_cw, "denied": n_den, "withdrawn": n_wd,
                "new": n_new, "transfer": n_tr, "continued": n_cont,
            },
            "green_card": {
                # absence of a filing is not evidence the employer won't sponsor
                "evidence": "present" if does_gc else "absent",
                "pwd": n_pwd, "perm": n_perm,
                "by_year": gc_year or [], "by_soc": gc_soc or {},
            },
            "wage_vs_prevailing": float(wvp) if wvp is not None else None,
            "filings_by_soc_year": soc_year or {},
            "trend": trend or [],
            "level_mix": level_mix or {},
            "red_flags": red_flags or {},
        }))

        for pref in prefixes(name):
            search_buckets[pref].append((n_lca or 0, key, ein, name))

    # ── per-employer jobs / titles ───────────────────────────────────────
    print("employer jobs ...", flush=True)
    sql = """
      SELECT e.key, j.year, j.soc_code, j.level, j.avg_wage, j.min_wage,
             j.max_wage, j.avg_prev_wage, j.state, j.county, j.zip, j.n_filings
      FROM sponsors.jobs j JOIN sponsors.employers e ON e.id = j.employer_id
      ORDER BY e.key, j.year DESC, j.soc_code
    """
    for key, rows in groupby(stream(conn, sql, "jobs"), key=lambda r: r[0]):
        p.put(f"e/{key}/jobs.json", body({"id": key, "jobs": [
            {"year": y, "soc_code": s, "level": lv,
             "avg_offered_wage": aw, "min_wage": mn, "max_wage": mx,
             "avg_prevailing_wage": pw, "state": st, "county": co,
             "zip": z, "n_filings": n}
            for _, y, s, lv, aw, mn, mx, pw, st, co, z, n in rows
        ]}))

    print("employer titles ...", flush=True)
    title_buckets: dict[str, dict] = defaultdict(dict)
    sql = """
      SELECT e.key, t.soc_code, t.title, t.n_filings, t.avg_wage,
             t.min_wage, t.max_wage, t.level_mix
      FROM sponsors.job_titles t JOIN sponsors.employers e ON e.id = t.employer_id
      ORDER BY e.key, t.n_filings DESC
    """
    for key, rows in groupby(stream(conn, sql, "titles"), key=lambda r: r[0]):
        items = []
        for _, soc, title, n, aw, mn, mx, mix in rows:
            items.append({"soc_code": soc, "title": title, "n_filings": n,
                          "avg_wage": aw, "min_wage": mn, "max_wage": mx,
                          "level_mix": mix or {}})
            # title -> soc lookup corpus for career-ops
            for pref in prefixes(title):
                b = title_buckets[pref].setdefault((norm_name(title), soc),
                                                   {"title": title, "soc_code": soc, "n": 0})
                b["n"] += n or 0
        p.put(f"e/{key}/titles.json", body({"id": key, "titles": items}))

    # ── wage benchmarks, one object per (soc, level) ─────────────────────
    print("wage benchmarks ...", flush=True)
    sql = """
      SELECT soc_code, level, scope, state, zip, year, n_filings,
             employer_count, p25, p50, p75, mean, min_wage, max_wage
      FROM sponsors.wage_benchmarks
      ORDER BY soc_code, level, scope, state, zip, year
    """
    for (soc, level), rows in groupby(stream(conn, sql, "bench"),
                                      key=lambda r: (r[0], r[1])):
        doc = {"soc_code": soc, "level": level,
               "national": [], "states": defaultdict(list), "zips": defaultdict(list)}
        for _, _, scope, state, zipc, year, n, ec, p25, p50, p75, mean, mn, mx in rows:
            stat = {"year": year, "n_filings": n, "employer_count": ec,
                    "p25": p25, "p50": p50, "p75": p75, "mean": mean,
                    "min_wage": mn, "max_wage": mx}
            if scope == "national":
                doc["national"].append(stat)
            elif scope == "state":
                doc["states"][state].append(stat)
            else:
                doc["zips"][zipc].append(stat)
        doc["states"] = dict(doc["states"])
        doc["zips"] = dict(doc["zips"])
        p.put(f"w/{soc}/{level or 'NA'}.json", body(doc))

    # ── prefix indexes ───────────────────────────────────────────────────
    print("search indexes ...", flush=True)
    for pref, hits in search_buckets.items():
        hits.sort(key=lambda h: (-h[0], h[3]))
        p.put(f"s/{pref}.json", body({
            "prefix": pref, "total": len(hits),
            "results": [{"id": k, "ein": e, "name": nm, "n_filings": n}
                        for n, k, e, nm in hits[:SEARCH_CAP]],
        }))

    for pref, bucket in title_buckets.items():
        items = sorted(bucket.values(), key=lambda b: -b["n"])
        p.put(f"t/{pref}.json", body({
            "prefix": pref, "total": len(items), "results": items[:SEARCH_CAP],
        }))

    # ── meta (this is what /healthz serves) ──────────────────────────────
    cur = conn.cursor()
    for t in ("employers", "jobs", "gc_filings", "job_titles", "wage_benchmarks"):
        cur.execute(f"SELECT COUNT(*) FROM sponsors.{t}")
        counts[t] = cur.fetchone()[0]
    cur.execute("SELECT now()")
    built = cur.fetchone()[0]
    cur.close()
    p.put("meta.json", body({"ok": True, "rows": counts, "built_at": built,
                             "objects": p.n_objects + 1}))

    p.finish()
    conn.close()

    mb = p.n_bytes / (1024 * 1024)
    print(f"\nobjects: {p.n_objects:,}   total: {mb:,.1f} MB")
    if dry:
        print("dry run — nothing uploaded.")
        print(f"a full publish would use ~{p.n_objects:,} of 1,000,000 monthly "
              f"Class A operations.")
    else:
        print(f"uploaded (changed only): {p.n_uploaded:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
