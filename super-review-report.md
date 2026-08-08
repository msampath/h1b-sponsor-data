# Super-review: h1b-sponsor-data

Date: 2026-08-08. Target: whole working tree (12 source/config files, ~1,674
lines). Reviewed just after the initial build + deploy, when the repo had zero
tests. Method: 14-agent adversarial engine (100% file audit + 10 reviewer
lenses) to two independent validators re-derived every finding to tech-lead
fixes to new test suites to this report.

## Scope and file accounting

All 12 files read and evaluated, both solo-audit targets
(`etl/publish.py`, `sql/03_populate.sql`) read end-to-end by their auditor and
again by the tech lead. Off-limits and untouched: `.env`, `secrets/`. No
deploys, no publishes, and no database writes were made during the review
itself; the fixes that follow were applied afterward with the owner's approval.

## Findings

84 raw findings: 0 critical, 3 high, 27 medium, 34 low, 20 info. Both
validators confirmed every finding against the code; none were refuted. The
84 dedupe to ~40 root causes (17 were the same 7 causes seen through different
lenses). Two of my own earlier "fixes" were shown wrong by the validators
re-deriving the traces, see the rate limiter below.

### High

H1. Search reachability: 59% of employers were undiscoverable.
`SEARCH_CAP = 50` per prefix bucket, and the Worker truncated every query to 3
characters, so any employer outside the top-50-by-volume of its 3-char name
bucket could never appear in search. Measured against the live data: **199,072
of 335,625 employers** ranked below the cap in their bucket, 107,746 of them
`n-`keyed (search was their the only discovery path, since their key is an opaque
hash). Confirmed by both validators independently.
Fix: the publisher now emits deeper prefix tiers (up to 10 chars) only where a
bucket overflows the cap, and the Worker probes longest-prefix-first
(`serveFirst`). Simulated against live names, reachability rises from **41% to
98%**. `worker/r2.ts`, `etl/publish.py`. Needs a re-publish to take effect.

H2. No test suite. Both runners collected zero tests; the only gate was
`tsc`. Corrected to medium by both validators (a maintainability gap, not a
runtime bug), but fixed as a high priority: 45 vitest + 20 pytest now cover
the rate-limit bucket math, prefix/key parity across the language boundary,
CORS, routing, auth, and the publisher's manifest/retry/delete accounting.

H3. ETL unreproducible by forkers. `sql/` jumped 00 to 01 to 03 with no
raw-table DDL, no loader, and no DOL source link, so an MIT-licensed public
repo's data pipeline could not be run by anyone but the owner. Corrected to
medium (docs gap). Fix: `sql/02_raw_schema.sql` (raw DDL dumped from the live
DB) + `docs/DATA.md` (source files, table mapping, load steps).

### Medium (root causes, all fixed)

- Decimal wages serialized as JSON strings. `default=str` emitted
  `numeric(12,2)` as `"123456.00"`; `wage_vs_prevailing` was already a number,
  so wage fields were inconsistently typed. `to_num()` now coerces at emit.
  (needs re-publish)
- No deletion pass. A rebuild that drops a key left the old object served
  forever (guaranteed once an `n-`key later resolves to a FEIN). `finish()` now
  deletes `manifest − next_manifest`; DeleteObject is a free-class op.
- Rate-limit escalation punished the wrong party. Two traces the validators
  re-derived: (a) three ordinary post-cap requests spaced >30s escalated a
  shared NAT to a 1-hour ban in ~2 minutes; (b) `Retry-After` advertised 60s
  while anon refills one token per 120s, so a compliant client returned and
  was re-denied. The ladder also never saved quota, a request during lockout
  costs a Worker invocation regardless. Removed entirely; the bucket is the
  protection, and `Retry-After` is now the exact time to one token.
- Uncaught `decodeURIComponent` on `/employers/%zz` threw after the DO
  token was already spent to 1101. Now a 400.
- Unguarded Durable Object round-trip. A transient DO error escaped as an
  uncaught 1101 with no CORS/JSON. Now wrapped: fail-open with a log, since
  this is a public read-only API and the daily Worker cap bounds cost anyway.
- `npm publish` footgun. `scripts.publish` shadowed the npm lifecycle hook
  and there was no `private: true`, so a typo'd `npm publish` would push to the
  registry and run the production ETL. `private: true`; renamed `etl:publish`.
- Swallowed `API_KEYS` parse silently demoted every keyed caller to anon on
  a malformed secret. Now logs, and an unknown Bearer returns 401 instead of
  silently degrading. The table is parsed once per isolate (memoized).
- `w/{soc}/NA.json` published but rejected. 464 benchmark objects for
  null-wage-level filings existed in R2 but the Worker rejected `level=NA`. Now
  accepted.
- No caching. No `cache-control`, no conditional GET. Added ETag/304 via
  R2 `onlyIf` and `cache-control` per object class.
- No observability. No logging anywhere, no `[observability]`. Enabled, with
  `console.error` on the new catch paths.
- Non-total `ORDER BY` in the exports made object bodies non-deterministic
  across rebuilds, flipping sha256s and re-uploading unchanged data. Extended to
  total orders with explicit tie-breaks.
- Publisher hardening (`--dry-run --resume` rejected; `--limit` value and
  unknown flags validated via argparse; env vars checked with a helpful message;
  `head_bucket` fail-fast; manifest GET distinguishes 404 from 403; manifest
  write retried; the 5x-sleep-loop-on-top-of-boto3 collapsed to one attempt).

### Low / info

19 fixed (SQL index-drop idempotency, `Certified - Withdrawn` split in `trend`,
`DISTINCT ON` tie-break, county/ZIP normalization, `--verify-only` and the
retired `02` documented, stale row-count comments corrected, dead search
ternary, per-request key parse, NaN-on-unknown-tier to 500, the per-IP-not-ASN
comment). The rest declined with reasons (speculative fork-config seams and
minor duplication the repo's own no-abstraction convention rejects; ETL-time
micro-optimizations; an unbounded-but-years-away DO storage row), all recorded
in `review/triage.json`.

## Coverage

Before: 0 tests, both runners empty. After: 65 tests (45 vitest, 20 pytest),
all passing, `tsc --noEmit` clean. They target the testable logic: rate-limit
token/lockout/refill math with an injected clock, the Python and TS name-bucketing
parity (shared vectors on both sides, including the JS-vs-Python whitespace
divergence), employer-key validation, CORS allow/deny, routing and param
validation, DO fail-open, and the publisher's dedup / stale-delete / failed-key
/ limit / resume accounting through a fake S3 client. Intentionally not
unit-tested: the thin `serve` streaming glue (exercised via the route tests) and
the SQL itself (gated instead by `build.py`'s row-count and reconciliation
checks against the live DB).

## Verification

`npx tsc --noEmit` clean · `npx vitest run` 45/45 · `python -m pytest -q` 20/20.
The data-shape fixes (Decimal-to-float, `has_jobs`/`has_titles`, tiered search,
county/ZIP) require a database rebuild + R2 re-publish to reach production; the
owner approved a full re-publish. Worker code fixes deploy independently.

## Deferred / follow-up

- Edge cache (`caches.default`) on hot objects would spare R2 reads. The current ETag/304 saves transfer but R2 still bills the read.
- The keyed-row SQL pattern is duplicated across `lca_n`/`gc_n`/`emp_src` and
  the `build.py` reconcile gate; factoring it into Postgres views would remove
  the hand-mirroring. Left as a larger refactor.
