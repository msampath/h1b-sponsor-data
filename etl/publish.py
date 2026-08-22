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
                                        # small scale (never writes the manifest)

Uploads are manifest-diffed (key -> sha256): R2's free tier allows 1M Class A
operations per month and a full publish is ~700k of them. DeleteObject is a
free-class operation, so the stale-key cleanup pass costs nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from itertools import groupby
from pathlib import Path

import psycopg2
import sentry_sdk
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_KEY = "_manifest.json"
SEARCH_CAP = 50          # hits stored per prefix bucket
MAX_PREFIX_DEPTH = 10    # deepest search tier; must match worker/r2.ts
UPLOAD_THREADS = 32

_KEEP = set("abcdefghijklmnopqrstuvwxyz0123456789 ")

# Exactly JavaScript's \s (worker/r2.ts normalizes with /\s+/). Python's
# str.split() treats more codepoints as whitespace (FS/GS/RS/US, NEL), which
# would bucket a name differently on the two sides. Zero current names carry
# those bytes; this keeps it that way by construction.
_JS_WS = re.compile(
    "[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


def norm_name(s: str) -> str:
    """Must match worker/r2.ts searchPrefix() exactly, or a query lands on a
    bucket that was never generated and 404s. Parity is pinned by test
    vectors duplicated in tests/worker/r2.test.ts and tests/etl.

    Order matters: collapse JS-\\s runs FIRST, then strip leading/trailing
    spaces. Python's str.strip() misses codepoints JS trim() strips (leading
    U+FEFF is the case that bit us), but once the whitespace class is
    collapsed to ASCII spaces, a plain .strip() aligns with the JS side.
    """
    out = _JS_WS.sub(" ", (s or "").lower()).strip(" ")
    return "".join(ch for ch in out if ch in _KEEP)


def prefixes(name: str) -> list[str]:
    """Base bucket tiers (2- and 3-char) this name belongs to. Deeper tiers
    are derived later, only where a bucket overflows SEARCH_CAP."""
    c = norm_name(name)
    out = []
    if len(c) >= 2:
        out.append(c[:2])
    if len(c) >= 3:
        out.append(c[:3])
    return out


def to_num(v):
    """numeric(12,2) arrives as Decimal; default=str would emit "123456.00"
    as a JSON *string*, making wage fields inconsistently typed across the
    API. Floats are exact for these magnitudes (2 decimal places, < 2^53)."""
    return float(v) if isinstance(v, Decimal) else v


def body(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), default=str).encode("utf-8")


def employer_doc(row, has_jobs: set, has_titles: set) -> dict:
    """The `e/{key}.json` body, in the column order the employer query
    selects. Extracted from main()'s loop so tests/etl/test_index_parity.py
    can hold it against the same employer's line in the downloadable index:
    both publishers read these columns, and the two must not answer the same
    question differently."""
    (eid, key, ein, name, fy, ly, n_lca, n_cert, n_cw, n_den, n_wd,
     n_new, n_tr, n_cont, n_pwd, n_perm, does_gc, wvp,
     gc_year, gc_soc, soc_year, trend, level_mix, red_flags) = row
    return {
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
        "wage_vs_prevailing": to_num(wvp),
        "has_jobs": eid in has_jobs,
        "has_titles": eid in has_titles,
        "filings_by_soc_year": soc_year or {},
        "trend": trend or [],
        "level_mix": level_mix or {},
        "red_flags": red_flags or {},
    }


def search_volume(doc) -> int:
    """The volume the employer search buckets rank by: all the sponsorship
    evidence there is, LCA filings plus the two green card steps.

    Distinct employers share a normalized name constantly (36,535 groups in
    the 2026Q2 build) and the resolver takes the first match in bucket order,
    so the bucket order decides which of them a lookup lands on. Summing
    exactly what the consumer's tier sums is what makes it impossible, by
    construction, to seat an entity ahead of a same-named sibling that has
    more evidence than it does. Any narrower key can, and did: ranking by
    certified alone put a strictly lower-evidence entity first for 6,135 of
    those groups, and ranking by raw n_lca for 5,844.

    Green card only employers are why no single column works. 156,616
    employers in the build have no LCA rows at all but do have PWD or PERM
    filings, so both n_lca and n_certified read 0 for them and they sort as
    if they had never sponsored anyone: they are the right answer in 4,836 of
    the 6,135 groups above. lib/index.mjs in the career-ops plugin sorts its
    local candidates by this same sum, so a name resolves to the same entity
    over HTTP and on disk."""
    return ((doc["filings"]["lca"] or 0)
            + (doc["green_card"]["pwd"] or 0)
            + (doc["green_card"]["perm"] or 0))


class Publisher:
    def __init__(self, dry_run: bool, force: bool, resume: bool = False, limit: int = 0,
             include: tuple[str, ...] = ()):
        self.dry_run = dry_run
        self.force = force
        self.resume = resume
        self.limit = limit
        self.include = tuple(include)
        self.manifest: dict[str, str] = {}
        self.next_manifest: dict[str, str] = {}
        self.existing: set[str] = set()
        self.failed: list[tuple[str, bytes]] = []
        self.n_objects = 0
        self.n_uploaded = 0
        self.n_skipped = 0
        self.n_deleted = 0
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
        from botocore.exceptions import ClientError

        account = os.environ["R2_ACCOUNT_ID"]
        self.bucket = os.environ.get("R2_BUCKET", "h1b-sponsor-data")
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            # R2 returns transient InternalError under sustained concurrency;
            # adaptive mode also throttles the whole client when errors rise,
            # instead of 32 threads independently hammering a failing backend.
            config=Config(
                retries={"max_attempts": 10, "mode": "adaptive"},
                max_pool_connections=UPLOAD_THREADS * 2,
            ),
        )
        # Fail fast on bad credentials/bucket rather than 300k objects in.
        self.client.head_bucket(Bucket=self.bucket)

        if not self.force:
            try:
                raw = self.client.get_object(Bucket=self.bucket, Key=MANIFEST_KEY)
                self.manifest = json.loads(raw["Body"].read())
                print(f"manifest: {len(self.manifest):,} known objects")
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code", "")
                if code in ("NoSuchKey", "404"):
                    print("manifest: none found, treating as first publish")
                else:
                    # A 403/500 here is NOT "first publish" — uploading
                    # everything against a broken config would burn the
                    # monthly write budget. Surface it.
                    raise

        if self.resume and not self.manifest:
            # An interrupted first publish leaves objects but no manifest.
            # Listing is ~700 Class A ops against ~700k re-uploads. Opt-in
            # because it trusts key presence, valid only mid-interruption.
            print("resume: listing bucket to find what already landed ...", flush=True)
            pager = self.client.get_paginator("list_objects_v2")
            for page in pager.paginate(Bucket=self.bucket):
                for o in page.get("Contents", []):
                    self.existing.add(o["Key"])
            print(f"resume: {len(self.existing):,} objects already present")

    def put(self, key: str, data: bytes):
        if self.limit and self.n_objects >= self.limit:
            return
        # --include-prefix defers everything else: a deferred-but-changed key
        # keeps its OLD manifest digest so the next unfiltered publish still
        # sees the diff. A deferred NEW key gets no manifest entry at all.
        if self.include and not any(key.startswith(pre) for pre in self.include):
            if key in self.manifest:
                self.next_manifest[key] = self.manifest[key]
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
        """One attempt per call. boto3's adaptive mode already retries up to
        10x with client-wide backoff; stacking a sleep loop on top multiplied
        that into ~50 transport attempts per object. Failures return the item
        for the single re-pass in finish()."""
        key, data = item
        try:
            self.client.put_object(
                Bucket=self.bucket, Key=key, Body=data,
                ContentType="application/json",
            )
            return None
        except Exception:
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
        if self.failed:
            print(f"retrying {len(self.failed):,} failed objects ...", flush=True)
            retry, self.failed = self.failed, []
            with ThreadPoolExecutor(max_workers=8) as pool:
                self.failed = [f for f in pool.map(self._put_one, retry) if f]
            self.n_uploaded += len(retry) - len(self.failed)

        # A --limit run sees only the first N objects; writing its manifest
        # would clobber the real one and un-dedupe the next full publish.
        if self.limit:
            print("limit run: manifest not written")
            return

        # Under --include-prefix, keys outside the filter that ALSO dropped
        # out of the DB are not reached by put() at all. Carry their old
        # digests forward so the next unfiltered publish still sees them in
        # `stale` and deletes them; otherwise an --include-prefix run
        # silently orphans them (super-review-retest-report.md).
        n_carried = 0
        if self.include and self.manifest:
            for k, v in self.manifest.items():
                if k in self.next_manifest:
                    continue
                if not any(k.startswith(pre) for pre in self.include):
                    self.next_manifest[k] = v  # carry forward, not for delete
                    n_carried += 1
        if n_carried:
            print(f"carried forward {n_carried:,} deferred digests outside {self.include}")

        # Delete keys that existed in the previous manifest but were not
        # produced this run (identity churn between rebuilds would otherwise
        # leave stale employer objects served forever). DeleteObject is a
        # free-class R2 operation. Only valid when a manifest was loaded —
        # under --force/--resume-from-nothing there is no old set to diff.
        stale = sorted(set(self.manifest) - set(self.next_manifest))
        if self.include:
            # only reason about prefixes this run actually produced; the
            # carry-forward above keeps out-of-scope keys out of `stale`.
            stale = [k for k in stale if any(k.startswith(pre) for pre in self.include)]
        undeletable: list[str] = []
        for i in range(0, len(stale), 1000):
            chunk = stale[i : i + 1000]
            resp = self.client.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": k} for k in chunk]},  # Quiet=False
            )
            errs = resp.get("Errors", []) or []
            failed_keys = {e["Key"] for e in errs}
            self.n_deleted += len(chunk) - len(failed_keys)
            # Retry each failed key once; delete_objects with a single-item
            # list is cheap and separates the transient-503 case from the
            # permanent-error case.
            for e in errs:
                r2 = self.client.delete_objects(
                    Bucket=self.bucket,
                    Delete={"Objects": [{"Key": e["Key"]}]},
                )
                if not (r2.get("Errors") or []):
                    self.n_deleted += 1
                    failed_keys.discard(e["Key"])
            undeletable.extend(sorted(failed_keys))
        if self.n_deleted:
            print(f"deleted {self.n_deleted:,} stale objects")
        if undeletable:
            # Keep their old digest so the next run's stale diff retries the
            # delete; a discarded manifest entry would orphan them forever.
            print(f"WARNING: {len(undeletable):,} deletions still failing "
                  f"after retry; keeping their manifest entries so next run "
                  f"retries. First few: {undeletable[:5]}")
            for k in undeletable:
                if k in self.manifest:
                    self.next_manifest[k] = self.manifest[k]

        # Failed uploads must be excluded from BOTH the written manifest AND
        # self.next_manifest itself: main() reads len(self.next_manifest)
        # for meta.json's object count, and that count has to match what's
        # actually served. (Sonnet review #1.)
        bad = {k for k, _ in self.failed}
        for k in bad:
            self.next_manifest.pop(k, None)
        manifest_body = body(self.next_manifest)
        # The manifest is the dedup state for ~700k objects; give it the same
        # persistence the data got.
        for attempt in range(5):
            if self._put_one((MANIFEST_KEY, manifest_body)) is None:
                break
        else:
            print("WARNING: manifest write failed after retries. Next run will "
                  "see stale dedup state; re-run with --resume if interrupted.")
        if self.failed:
            print(f"WARNING: {len(self.failed):,} objects still failed. "
                  f"Re-run with --resume to pick them up.")


def stream(conn, sql: str, name: str, size: int = 10_000):
    cur = conn.cursor(name=name)
    cur.itersize = size
    cur.execute(sql)
    yield from cur
    cur.close()


def tiered_buckets(entries, sort_key, cap=SEARCH_CAP, max_depth=MAX_PREFIX_DEPTH):
    """entries: list of (norm_name, payload). Returns {prefix: [payload,...]}
    with base tiers at depth 2-3 and deeper tiers emitted only where a bucket
    overflows the cap — so the Worker's longest-prefix-first probe always
    lands on a bucket that actually discriminates. Without this, 59% of
    employers (everything ranked >cap in its 3-char bucket) were unreachable
    through search.

    Exact-name floor (validator A finding): a member whose full normalized
    name equals its bucket's prefix cannot descend to a deeper tier because
    deeper tiers only admit strictly longer names. So even typing the exact
    full name would return the capped top-50 without them. Force those
    members into the emitted head so an exact-name query always resolves.
    """
    buckets: dict[str, list] = defaultdict(list)
    for nm, payload in entries:
        for pref in prefixes(nm):
            buckets[pref].append((nm, payload))

    for depth in range(3, max_depth):
        for pref in [p for p, m in list(buckets.items()) if len(p) == depth and len(m) > cap]:
            for nm, payload in buckets[pref]:
                if len(nm) >= depth + 1:
                    buckets[nm[: depth + 1]].append((nm, payload))

    out: dict[str, list] = {}
    for pref, members in buckets.items():
        ranked = sorted(members, key=lambda e: sort_key(e[1]))
        # Callers slice the returned list to `cap`. If an exact-name member
        # ranks outside `cap`, promote it into the head so a full-name query
        # always resolves. IMPORTANT: strip promoted entries from the tail
        # too, or the emitted `results` array (and its `total`) contains the
        # same payload twice. (Opus review: duplicate-in-tail.)
        head, tail = ranked[:cap], ranked[cap:]
        promoted = [e for e in tail if e[0] == pref]
        if promoted:
            keep = [e for e in head if e[0] == pref]      # already in head
            fillers = [e for e in head if e[0] != pref]
            room = cap - len(keep) - len(promoted)
            head = keep + fillers[: max(0, room)] + promoted
            head.sort(key=lambda e: sort_key(e[1]))
            tail = [e for e in tail if e[0] != pref]      # no duplicates downstream
        out[pref] = [payload for _, payload in head + tail]
    return out


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--limit", type=int, default=0, metavar="N")
    ap.add_argument("--include-prefix", action="append", default=[], metavar="P",
                    help="publish only keys under these prefixes; deferred "
                         "changed keys keep their old manifest digest")
    args = ap.parse_args()
    if args.dry_run and args.resume:
        ap.error("--dry-run never contacts R2, so --resume has no effect with it")
    # These two only matter for real uploads — under --dry-run the manifest
    # is never loaded or written, so neither combination can damage anything.
    # Allowing --dry-run --force --include-prefix is deliberate: it's the
    # safe way to preview a scoped force-publish before running it for real.
    if not args.dry_run:
        if args.force and args.include_prefix:
            # --force skips the manifest load, so the include-branch cannot
            # carry deferred digests forward. finish() would then write a
            # manifest containing only the included prefixes and the next
            # full publish would re-upload every other key.
            ap.error("--force with --include-prefix would destroy the manifest's "
                     "dedup state for deferred keys; run without --force")
        if args.force and args.resume:
            # --resume lists the bucket to seed self.existing, but the force
            # branch in put() ignores self.existing entirely, so the listing
            # is wasted Class A ops and every key uploads anyway.
            ap.error("--force ignores existing bucket keys, making --resume "
                     "a no-op that still costs Class A listing operations")
    return args


REQUIRED_PG = ["POSTGRES_HOST", "POSTGRES_USER", "POSTGRES_PASSWORD"]
REQUIRED_R2 = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]


def require_env(names):
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        print(f"missing in .env: {', '.join(missing)} (copy .env.example and fill in)",
              file=sys.stderr)
        sys.exit(2)


def main() -> int:
    load_dotenv(ROOT / ".env")
    sentry_sdk.init(dsn=os.environ.get("SENTRY_DSN", ""))
    args = parse_args()
    require_env(REQUIRED_PG)
    if not args.dry_run:
        require_env(REQUIRED_R2)

    conn = psycopg2.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        dbname=os.environ.get("SOURCE_DB", "lca"),
    )
    with conn.cursor() as c0:
        # The export ORDER BYs sort multi-million-row sets; default work_mem
        # spills them to disk.
        c0.execute("SET work_mem = '512MB'")

    p = Publisher(args.dry_run, args.force, args.resume, args.limit,
                  tuple(args.include_prefix))
    p.connect_r2()

    # Which employers have jobs/titles subresources (the profile advertises
    # this so clients can tell "GC-only employer" apart from a bad id).
    with conn.cursor() as c1:
        c1.execute("SELECT DISTINCT employer_id FROM sponsors.jobs")
        has_jobs = {r[0] for r in c1.fetchall()}
        c1.execute("SELECT DISTINCT employer_id FROM sponsors.job_titles")
        has_titles = {r[0] for r in c1.fetchall()}

    # ── employer profiles ────────────────────────────────────────────────
    print("employers + profiles ...", flush=True)
    search_entries: list[tuple[str, tuple]] = []
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
        doc = employer_doc(r, has_jobs, has_titles)
        emp = doc["employer"]
        p.put(f"e/{emp['id']}.json", body(doc))
        search_entries.append((
            norm_name(emp["name"]),
            (search_volume(doc), emp["id"], emp["ein"], emp["name"]),
        ))

    # ── per-employer jobs / titles ───────────────────────────────────────
    print("employer jobs ...", flush=True)
    sql = """
      SELECT e.key, j.year, j.soc_code, j.level, j.avg_wage, j.min_wage,
             j.max_wage, j.avg_prev_wage, j.state, j.county, j.zip, j.n_filings
      FROM sponsors.jobs j JOIN sponsors.employers e ON e.id = j.employer_id
      ORDER BY e.key, j.year DESC, j.soc_code, j.level NULLS LAST,
               j.state NULLS LAST, j.county NULLS LAST, j.zip NULLS LAST
    """
    for key, rows in groupby(stream(conn, sql, "jobs"), key=lambda r: r[0]):
        p.put(f"e/{key}/jobs.json", body({"id": key, "jobs": [
            {"year": y, "soc_code": s, "level": lv,
             "avg_offered_wage": to_num(aw), "min_wage": to_num(mn),
             "max_wage": to_num(mx), "avg_prevailing_wage": to_num(pw),
             "state": st, "county": co, "zip": z, "n_filings": n}
            for _, y, s, lv, aw, mn, mx, pw, st, co, z, n in rows
        ]}))

    print("employer titles ...", flush=True)
    title_entries: dict[tuple[str, str], dict] = {}
    sql = """
      SELECT e.key, t.soc_code, t.title, t.n_filings, t.avg_wage,
             t.min_wage, t.max_wage, t.level_mix
      FROM sponsors.job_titles t JOIN sponsors.employers e ON e.id = t.employer_id
      ORDER BY e.key, t.n_filings DESC, t.soc_code, t.title
    """
    for key, rows in groupby(stream(conn, sql, "titles"), key=lambda r: r[0]):
        items = []
        for _, soc, title, n, aw, mn, mx, mix in rows:
            items.append({"soc_code": soc, "title": title, "n_filings": n,
                          "avg_wage": to_num(aw), "min_wage": to_num(mn),
                          "max_wage": to_num(mx), "level_mix": mix or {}})
            nm = norm_name(title)
            b = title_entries.setdefault((nm, soc), {"title": title, "soc_code": soc, "n": 0})
            b["n"] += n or 0
        p.put(f"e/{key}/titles.json", body({"id": key, "titles": items}))

    # ── wage benchmarks, one object per (soc, level) ─────────────────────
    print("wage benchmarks ...", flush=True)
    sql = """
      SELECT soc_code, level, scope, state, zip, year, n_filings,
             employer_count, p25, p50, p75, mean, min_wage, max_wage
      FROM sponsors.wage_benchmarks
      ORDER BY soc_code, level NULLS LAST, scope, state NULLS LAST,
               zip NULLS LAST, year
    """
    for (soc, level), rows in groupby(stream(conn, sql, "bench"),
                                      key=lambda r: (r[0], r[1])):
        doc = {"soc_code": soc, "level": level,
               "national": [], "states": defaultdict(list), "zips": defaultdict(list)}
        for _, _, scope, state, zipc, year, n, ec, p25, p50, p75, mean, mn, mx in rows:
            stat = {"year": year, "n_filings": n, "employer_count": ec,
                    "p25": to_num(p25), "p50": to_num(p50), "p75": to_num(p75),
                    "mean": to_num(mean), "min_wage": to_num(mn), "max_wage": to_num(mx)}
            if scope == "national":
                doc["national"].append(stat)
            elif scope == "state":
                doc["states"][state].append(stat)
            else:
                doc["zips"][zipc].append(stat)
        doc["states"] = dict(doc["states"])
        doc["zips"] = dict(doc["zips"])
        p.put(f"w/{soc}/{level or 'NA'}.json", body(doc))

    # ── search indexes (tiered) ──────────────────────────────────────────
    print("search indexes ...", flush=True)
    emp_tiers = tiered_buckets(search_entries, sort_key=lambda h: (-h[0], h[3], h[1]))
    for pref in sorted(emp_tiers):
        hits = emp_tiers[pref]
        p.put(f"s/{pref}.json", body({
            "prefix": pref, "total": len(hits),
            "results": [{"id": k, "ein": e, "name": nm, "n_filings": n}
                        for n, k, e, nm in hits[:SEARCH_CAP]],
        }))

    title_list = [(nm, b) for (nm, _soc), b in title_entries.items()]
    title_tiers = tiered_buckets(title_list, sort_key=lambda b: (-b["n"], b["soc_code"], b["title"]))
    for pref in sorted(title_tiers):
        items = title_tiers[pref]
        p.put(f"t/{pref}.json", body({
            "prefix": pref, "total": len(items), "results": items[:SEARCH_CAP],
        }))

    # ── meta (served by /healthz) ────────────────────────────────────────
    # meta.json ALWAYS emits regardless of --include-prefix; the include
    # filter should never leave healthz reporting a partial state or stale
    # against the last full publish. Object count is the manifest size so it
    # tracks what's actually served, not this run's local counter.
    with conn.cursor() as cur:
        for t in ("employers", "jobs", "gc_filings", "job_titles", "wage_benchmarks"):
            cur.execute(f"SELECT COUNT(*) FROM sponsors.{t}")
            counts[t] = cur.fetchone()[0]
        cur.execute("SELECT now()")
        built = cur.fetchone()[0].isoformat()
    # Emit meta.json AFTER finish() so its object count reflects the final
    # served state (carry-forwards, deletes, undeletable fallbacks all
    # applied). The include filter is lifted so meta.json always goes
    # through: an --include-prefix run must never leave healthz stale, and
    # it must never report a partial-run count.
    p.finish()
    _filter, p.include = p.include, ()
    _force, p.force = p.force, True   # bypass manifest-dedup for meta itself
    p.put("meta.json", body({"ok": True, "rows": counts, "built_at": built,
                             "objects": len(p.next_manifest) + 1}))
    p.flush()
    # meta.json is not managed by the manifest diff (never deleted, always
    # rewritten), so we don't need a second finish() pass here.
    p.include, p.force = _filter, _force
    conn.close()

    mb = p.n_bytes / (1024 * 1024)
    print(f"\nobjects: {p.n_objects:,}   total: {mb:,.1f} MB")
    if args.dry_run:
        print("dry run — nothing uploaded.")
        if args.limit:
            print(f"(--limit {args.limit}: counts cover only the first "
                  f"{args.limit} objects, not a full publish)")
        else:
            print(f"a full publish would use ~{p.n_objects:,} of 1,000,000 "
                  f"monthly Class A operations, minus unchanged objects "
                  f"skipped by the manifest diff.")
    else:
        print(f"uploaded (changed only): {p.n_uploaded:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
