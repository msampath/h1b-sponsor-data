# Super-review retest: h1b-sponsor-data (review-only)

Date: 2026-08-08, hours after the fix batch (commit 3b5217b) shipped. Owner
instruction: review only, no fixes. Everything below is reported, nothing was
changed. Method: the two original validators retested every primary finding
from the first review against the new code, and a fresh 14-agent engine pass
audited the post-fix tree (16 files this time, the 4 new test files included)
hunting for defects the fixes introduced. Three streams cross-checked each
other; the tech lead reproduced every medium-or-higher claim personally.

A production R2 re-publish was running during this retest; reviewers were
barred from publish/build/deploy and from writing to the database, and the
review ran entirely against the working tree.

## Retest of the original 84 findings

Validator A (worker/config half): 23 fixed, 5 not-fixed, of which 4 are the
documented declines or by-design items it cross-checked against the report
(hardcoded origins, healthz-before-limiter, DO storage growth,
meter-before-validate). Validator B (etl/sql/docs half): 24 fixed, 1 fixed
differently, 4 not-fixed, of which 3 are the deliberately declined ETL
micro-optimizations.

That leaves two genuine misses from the fix batch:

1. The README's dev-mode fix documents a command that does not work.
   `npm run dev --remote` never forwards the flag (npm consumes it as
   npm_config_remote), so the quickstart still launches the empty local R2
   simulation the finding was about. Correct forms: `npm run dev -- --remote`
   or `npx wrangler dev --remote`. README.md:113, package.json:7.
2. The compat-date drift (original idx 40) was deferred as an owner decision
   but never listed in the report's declined section, so it silently vanished
   from the record. wrangler.toml pinned compatibility_date 2025-08-01 while
   the installed workers-types described the 2026 runtime surface. Owner
   decision at retest planning: bumped to 2026-08-08 and deployed as Version
   e85cb8b9-c6ae-41dc-903e-a968214a6e6c; the live smoke suite (lowercase
   bearer -> 401 keyed, %zz -> 400, vary: origin on 200/401/404/OPTIONS,
   If-Match stale -> 412, If-None-Match match -> 304) passed against it.

## New defects introduced by the fix batch

These are the reason a retest exists. Every one is confirmed by at least two
independent streams (validator, engine, or tech-lead reproduction).

### The --include-prefix cluster (etl/publish.py), the important one

The budget-scoping flag added during the fix batch has three related defects.
None have bitten yet (the flag has never been used against production), but
together they can recreate both incidents this machinery exists to prevent.

- Orphaned stale keys (engine severity: high). A key that dropped out of the
  database and is outside the include filter is (a) filtered out of the delete
  pass and (b) absent from the written manifest. From then on no publish,
  filtered or full, can ever delete it: the Worker serves the stale object
  forever and its storage is never reclaimed. This resurrects the
  stale-forever defect (original idx 4) on a new path. publish.py:238-241.
- --force --include-prefix destroys dedup state. Under --force the manifest is
  never loaded, so the carry-forward branch preserves nothing and finish()
  writes a manifest containing only the included prefixes. The next normal
  publish diffs ~690k keys against nothing and re-uploads all of them, the
  exact Class A overspend the manifest exists to prevent, on a month already
  over the free allowance. A plausible invocation ("force-republish just the
  search indexes") triggers it. parse_args guards --dry-run/--resume but not
  this pair. publish.py:134, 166-169.
- delete_objects failures are silently ignored. Quiet=True and the response is
  discarded, so a per-key delete failure (HTTP 200 with an Errors list, which
  botocore does not retry) leaves the object live while the manifest forgets
  it, permanently undeletable by the same mechanism as the orphan case, on
  the failure path. n_deleted counts attempts, not deletions. publish.py:244.
- Test gap: the include-prefix manifest semantics, the most involved new
  Publisher logic, have zero test coverage, four engine finders flagged this
  independently.

### Worker

- serveFirst read amplification (validator A: medium). The tiered-search probe
  walks depths min(len,10) down to 2 serially. The common typeahead case, a query
  longer than 3 chars whose 3-char bucket never overflowed, pays one 404 GET
  per depth before the hit, up to 9 serial R2 reads per request. Worst case at
  the Workers daily cap is ~27M Class B reads/month against the 10M free
  allowance, and a deep query adds several serial round-trips of latency.
  Fix that keeps the never-parse model: cap the candidate ladder to
  [min(len,10), 3, 2], three probes max. worker/r2.ts:78.
- Dead suppression machinery (engine: medium; tech-lead confirmed). With the
  escalation ladder gone, the lockout-path save() persists nothing but
  lastNoteAt itself: a storage write whose only purpose is to throttle
  itself. The lockout branch could skip persisting entirely, removing a DO
  write per throttled burst. worker/ratelimit.ts:53-58.
- Failed If-Match served as 304 instead of 412 (validator A: info). serve()
  forwards all request headers to onlyIf and maps every body-less R2Object to
  304; RFC 9110 says a failed If-Match on GET is 412. Unreachable in normal
  revalidation. worker/r2.ts:63.

### Residual search gap, now sharply characterized

Reachability went 41% to 98.2%; the remaining ~5,888 employers are ones whose
bucket is still over cap at depth 10, plus a subtler case validator A pinned:
a name exactly as long as an overflowing prefix can never surface, even when
the user types the exact full name, deeper tiers only admit strictly longer
names, and its own bucket serves the capped top-50 without it. A cheap
special-case (always include a name in the bucket matching its full prefix)
would close that class. publish.py:290.

### Config and docs

- tsconfig.json includes only worker/**/*, so npm run typecheck never
  type-checks the four new test files; only vitest's transpile sees them.
- npm run build executes python etl/build.py, a ~13-minute destructive
  rebuild of the sponsors schema behind the most conventional script name in
  the Node ecosystem. An operator running "npm run build" out of habit gets a
  database rebuild, not a bundle. package.json:11.
- The parity vectors claimed to be "duplicated on both sides" are asymmetric:
  the NBSP/NEL/FS exotics exist only in the pytest file; the TS list stops at
  the ASCII cases. The cross-language pinning is therefore one-sided exactly
  where the divergence risk lives. tests/worker/r2.test.ts:13.
- The self-hosting README note promised in triage as the compensating action
  for declined finding 26 was never written. A declined finding's mitigation
  silently not happening is a process defect worth naming. README.md.

## Known residual gaps (deliberate)

- serveFirst probes the longest available prefix, its two shorter neighbors,
  depth 3, and depth 2 (five max). For a query longer than 5 chars whose
  overflow chain stops more than two depths above it, the intermediate
  bucket is not reached — a name outside the top 50 of the shallower
  bucket can still be unreachable via the exact query. Closing this fully
  would need per-lineage depth pointers stored in the shallow bucket
  objects so the Worker knows the chain length from one read.
- serve() maps every body-less R2 hit with an If-Match header to 412 even
  if the caller also sent If-None-Match that would have matched. Real read
  clients don't send both preconditions; recording it as info-only.

## Additional confirmed items from the validator tail round

The low/info tail went through both validators; full verdicts are in
review/retest-tail.json. The ones worth naming:

- `startsWith("Bearer ")` is case-sensitive, so an RFC-legal lowercase
  `bearer` header silently drops to anon, sidestepping the new 401 contract.
  worker/index.ts:82.
- The unknown-tier guard uses `tier in LIMITS`; `"toString" in LIMITS` is true
  via the prototype chain, so a crafted tier still mints NaN state and is
  granted (reproduced in node). Unreachable from the worker's own caller;
  `Object.hasOwn` is the correct check. worker/ratelimit.ts:43.
- corsHeaders returns {} with no `vary: origin` for disallowed origins while
  responses carry public max-age=3600, a shared-cache variant-pollution risk.
  worker/index.ts:33.
- Nothing pins the two MAX_PREFIX_DEPTH constants across languages; the
  "must match" contract is enforced by comment only.
- GC-only employers (~70k) get `"years": {"first": null, "last": null}` in
  their profile: the year aggregate reads only LCA rows. publish.py.
- Under --include-prefix, meta.json either goes stale (deferred) or reports a
  partial object count (included); neither is right.
- level_mix semantics diverge between objects: profiles drop NULL levels,
  job_titles buckets them as "unknown".
- The JS-parity fix breaks at edge positions: leading U+FEFF is stripped by
  JS trim() but not Python strip(), so Python buckets " acme corp" under " a"
  while the Worker probes "ac" (reproduced in both runtimes). Validator B
  retracted its earlier parity-held verdict on the record after finding this.
- --force --resume is a third unguarded flag pair: it pays the bucket-listing
  ops, then the force branch ignores the result.
- build.py kept bare os.environ access; require_env was only added to
  publish.py.
- The index route tests never exercise the /jobs and /titles subroutes, and
  the DO fail-open test does not cover the res.ok-false branch.

## Verdict tallies

Original findings: 47 of 49 primaries fixed or fixed-differently; 2 genuine
misses (dev --remote, compat-date bookkeeping); declines all held and
re-verified consistent.

Fresh engine pass: 82 raw findings. After the validator round: roughly 35 root
causes, of which 20 tail items confirmed, 28 folded as duplicates, and 7
rejected outright with evidence (for example, a measured zero rows with both
dates NULL, and a scratch-tsconfig proof that the tests co-compile cleanly,
refuting the engine's no-co-compile claim). Two severity disputes are recorded
as such rather than flattened: the include-prefix orphan (engine high,
validator B medium, tech lead medium-high: latent but silent and permanent
when it fires) and the npm build foot-gun (engine medium, validator A low:
local idempotent rebuild, production untouched).

## Suite state at time of review

npx tsc --noEmit clean. npx vitest run 45/45. python -m pytest 20/20. The R2
re-publish was mid-flight (~170k of ~760k objects) with one transient object
failure being carried by the new failure-collection path for the end-of-run
retry, which is that incident fix operating as designed on its first
production run.

## Recommended next batch (when fixes are authorized)

1. Guard --force with --include-prefix (one argparse line) and carry
   deferred-stale digests forward in finish() so filtered runs cannot orphan
   keys. Add the missing include-prefix tests.
2. Inspect the delete_objects response; retry failures once, and keep
   still-failed keys in the written manifest so the next run retries them.
3. Cap the serveFirst probe ladder to three candidates.
4. Fix the README dev command to `npx wrangler dev --remote`.
5. Skip the lockout-path save() entirely.
6. Widen tsconfig include to tests/, or add a vitest typecheck step.
7. Rename the build script (etl:build) to match etl:publish.
8. Mirror the exotic parity vectors into the TS test.
9. Write the promised self-hosting note; record the compat-date decision.
10. From the tail round: case-insensitive Bearer parsing feeding the 401
    contract, Object.hasOwn for the tier guard, vary: origin on every
    response, align Python strip() with JS trim() at string edges (and mirror
    the edge vectors on both sides), compute first/last_year across GC
    sources, unify level_mix semantics, guard --force with --resume, extend
    require_env to build.py, and cover the /jobs and /titles subroutes plus
    the res.ok-false fail-open branch in tests.
