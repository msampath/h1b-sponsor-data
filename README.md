# h1b-sponsor-data

A rate limited public API over six years of DOL immigration disclosures: H-1B
LCA, PWD, and PERM (signals of immigration support by employers). 335,626 employers, 1.85M wage rows, 759,638 green card
filings. Cloudflare Workers and R2, free tier

**Updated as of latest disclosure data from DOL as of Q2 FY2026**

Portfolio: [surakshith.com/portfolio](https://surakshith.com/portfolio)
Base URL: `https://api.surakshith.com/immigration/v1`
Data source: [DOL foreign labor performance data](https://www.dol.gov/agencies/eta/foreign-labor/performance)
API key: `curl -X POST https://api.surakshith.com/immigration/v1/keys/request`

## Endpoints

| Path | Answers |
| --- | --- |
| `GET /healthz` | row counts and build timestamp |
| `GET /employers/search?q=` | typeahead by employer name (min 2 chars) |
| `GET /employers/:id` | profile, red flags, sponsorship trend, GC evidence |
| `GET /employers/:id/jobs` | wage detail by year, SOC, level, location |
| `GET /employers/:id/titles` | what this employer calls each role, and pays |
| `GET /wages?soc=15-1252&level=II` | wage percentiles nationally, by state, by ZIP |
| `GET /titles?q=` | title to SOC lookup corpus |

`:id` is the FEIN (`941156497` or `94-1156497`) where DOL published one.
Employers seen only in the FY2020-23 files carry no FEIN, so they get an
opaque key (`n-3f9a1c2d4e5b6789`). Search returns both forms and both work
in the endpoints above. The opaque key is a hash of the name and not a
readable slug, since many of these employers are sole proprietorships named
after a person.

The profile carries `has_jobs` and `has_titles` booleans. 47% of employers
have green-card filings but no LCA rows, so their `/jobs` and `/titles`
subresources are absent, and the flags tell that apart from a bad id.

`level` on `/wages` accepts `I`, `II`, `III`, `IV`, or `NA` (filings whose
wage level DOL left blank or unparseable). An `Authorization: Bearer <key>`
that isn't recognized returns 401.

Green card evidence is `present` or `absent`, not a boolean. Absent means
no filing was found for this employer in the disclosures, which is a
different question from whether they sponsor.

Red flags carry their counts so a caller can apply their own threshold:

```json
"red_flags": {
  "staffing_shop": {"value": true, "basis": "secondary_entity_share",
                    "share": 0.87, "n_secondary": 4351, "n_total": 5002}
}
```

`staffing_shop` is a heuristic: over 50% of an employer's filings placed
the worker at a third party client site.

## Rate limits

- Anonymous: 30 requests/hour per (IP, ASN). IPv6 is bucketed by /64.
- Keyed: 200 requests/hour, bucketed by key.
- Every read response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
  `X-RateLimit-Reset`. A 429 adds `Retry-After` set to the time until the
  next token refills, so a client that respects it is never re-denied.
  `POST /keys/request` is not a read and carries only `Retry-After` on a 429;
  so does a 429 from the key-validation meter, the one a flood of unrecognized
  tokens meets before any KV read.
- No escalation ladder. The bucket alone is the protection.

## API keys

Anonymous access needs no key. A key raises the ceiling to 200 requests/hour
and issues itself:

```bash
curl -X POST https://api.surakshith.com/immigration/v1/keys/request
```

```json
{"token": "h1b_a3f1...", "tier": "keyed", "limit": 200,
 "note": "A new key can take up to about 60 seconds to be recognized on every server. If a request returns 401 in the first minute, wait and retry."}
```

Send it back as `Authorization: Bearer <token>`. The token is shown once and
only its sha256 is stored, so a lost key means asking for another one.

Issuance is metered with a token bucket per (IP, ASN): 2 available at once,
then one more every 12 hours, so a long-idle requester can mint 2 back to back
and a busy day tops out around 4. A global bucket of the same shape brakes
total issuance at roughly 200 to 400 per day. Validating a presented key costs
one metered lookup per (IP, ASN) on a cache miss, so a flood of junk tokens
cannot amplify into unbounded KV reads; the charge is handed back when the read
proves the token genuine, so a real key keeps its full 200 requests/hour even
when every request lands on a server that has not seen it before. A request
carrying an `Origin` header
is refused, since a browser always sends one and a page has no business minting
keys on a visitor's behalf. If any of that gets in your way, email
`sms@surakshith.com`.

## Downloadable index

Every call to the API tells this service which employers someone is looking
up, and someone looking up sponsorship history is telling you they need a
visa. The headline numbers do not need a service to answer them: 12 fields
for all 335,626 employers is 7.9 MiB gzipped, so a client downloads the file
once a quarter and answers locally. Nothing about the query leaves the
machine.

```bash
BASE=https://github.com/msampath/h1b-sponsor-data/releases/download/index-latest
curl -sL "$BASE/index-latest.json"
curl -OL "$BASE/index-2026Q2.ndjson.gz"
```

`index-latest.json` is the pointer: `{version, built_at, employers, bytes,
sha256, filename}`. Read `filename` out of it instead of hardcoding the
quarter, and check the download against `sha256`.

`index-latest` is a permanent tag, not a version. Its assets are replaced
in place each quarter, so the two URLs above never change. The quarter
files accumulate on it, so an older build stays fetchable by name after a
newer one lands.

The data is gzipped NDJSON, one employer per line, sorted by normalized name
then key. The normalization is `norm_name` in `etl/publish.py`, the same one
`/employers/search` buckets by, so the file arrives in the order the search
buckets are published in and two builds of identical data produce identical
bytes. It is not an index a client can stop reading early: `norm_name` keeps
spaces where a consumer normalizer may not, and a name matched part-way
through can still be beaten by a higher-evidence entity further down. A
lookup is a whole pass, a couple of seconds on the shipped build, which is
why this is one file and not sharded.

```json
{"k":"204938068","n":"Amazon Web Services, Inc.","fy":2019,"ly":2026,"filed":25358,"cert":24611,"pwd":4313,"perm":3828,"gc":true,"sv":false,"sh":0,"ns":9}
```

| Field | Is |
| --- | --- |
| `k` | employer key, the same `:id` the API endpoints take |
| `n` | employer name as DOL published it |
| `fy` / `ly` | first and last year seen, across LCA and green card filings |
| `filed` | H-1B filings the employer submitted, the API's `filings.lca` |
| `cert` | how many of those came back certified, the API's `filings.certified` |
| `pwd` / `perm` | prevailing wage and PERM filings, the two green card steps |
| `gc` | true when either exists, i.e. `green_card.evidence == "present"` |
| `sv` | the `staffing_shop` red flag |
| `sh` / `ns` | its evidence: `ns`, the secondary entity count, and `sh`, that count over `filed` rounded to 3 decimals |

`filed` and `cert` are published side by side rather than resolved into one
headline, and they differ for the 50,755 employers carrying a denial or a
withdrawal. Filing is the employer's act: it is what says this employer
sponsors, and it is what a client should count. What happened to a filing
afterwards is somebody else's decision, a USCIS denial or a candidate who
took another offer, so `cert` is reported next to `filed` rather than in
place of it. Publishing the coalesce instead described 3,777 employers that
had filed as having no record at all.

`sh` is `ns / filed` rounded, so the `nt` field earlier drafts carried was a second
copy of `filed`; it is gone, and the single `lca` field it sat beside is now
the `filed` / `cert` pair. Still 12 fields per employer.

Not in the file: jobs, titles, wage benchmarks, and typeahead search. Those
are per-request shapes with no small precomputed form, and they stay on the
API. Derived from the same public
[DOL disclosure files](https://www.dol.gov/agencies/eta/foreign-labor/performance)
as everything else here.

### Cutting a release

Build, then replace the assets on the permanent tag:

```bash
python etl/publish_index.py          # -> etl/dist/, ~15s
VERSION=$(python -c "import json;print(json.load(open('etl/dist/index-latest.json'))['version'])")

# First time only, to create the tag:
# gh release create index-latest --repo msampath/h1b-sponsor-data \
#   --title "Employer index" \
#   --notes "Per-employer headline numbers derived from DOL OFLC disclosure data."

gh release upload index-latest \
  --repo msampath/h1b-sponsor-data \
  "etl/dist/index-$VERSION.ndjson.gz" etl/dist/index-latest.json --clobber
```

Re-running a build over unchanged data produces byte-identical output (the
gzip header carries no mtime and no filename), so a re-publish that changed
nothing does not make every client re-download.

A fixed tag is what makes this safe. `releases/latest/download/` resolves
to the newest release of any kind, so the first code release tagged in this
repo would have silently pointed every client at an asset that is not
there. Naming the tag removes that failure mode instead of documenting
around it.

## Architecture

```
lca (Postgres)
├── public.*     raw DOL disclosures, read only, never written
└── sponsors.*   curated serving layer   <- sql/*.sql
                       │
                       ├─ etl/publish.py (boto3 to R2, manifest diffed)
                       │       v
                       │  R2: h1b-sponsor-data    ~760k precomputed JSON objects
                       │       ^
                       │  Worker (api.surakshith.com) -> BucketMeter DO for rate limiting
                       │
                       └─ etl/publish_index.py
                               v
                          GitHub Release: index-<quarter>.ndjson.gz
                          335k employers, 7.9 MiB, scanned on the client
```

R2 instead of D1, because D1's free tier is 100,000 row writes per day and
this dataset is 2.2M rows: the first load alone would take 25+ days and
lock every D1 query on the account each time it hit the cap. The data is
read only and refreshed quarterly, and every access pattern is a point
lookup, so R2 fits.

Nothing gets parsed. Workers Free gives 10 ms CPU per request and waiting
on I/O doesn't count against it. Each endpoint maps to one precomputed
object streamed straight through, so CPU stays near zero even on the
largest employer (34,044 job rows).

Accepted gap: no ad hoc filtering. Every query shape has to be
precomputed, so a new filter means a new object type and a re-publish.

Publish budget: a full publish writes ~760k objects against R2's 1M/month
Class A allowance. `publish.py` is manifest diffed (`_manifest.json` holds
key to sha256), so a normal re-run only uploads what changed and a
quarterly refresh runs at ~200k writes. `--force` rewrites everything.
Going over the allowance bills instead of blocking, so keep a Cloudflare
budget alert on the account.

## Development

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create h1b-sponsor-data
npm run dev            # -> wrangler dev --remote (the local simulated R2 is
                       # empty; --remote is baked into the script)
npm test               # vitest + pytest (via `python -m pytest`)
```

## Data pipeline

Needs a local Postgres holding `lca_disclosure`, `pwd_disclosure`, and
`perm_disclosure`. See [docs/DATA.md](docs/DATA.md) for where those come
from and how to load them; `sql/02_raw_schema.sql` is the raw DDL. Config
in `.env` (see `.env.example`).

```bash
python -m pip install -r etl/requirements.txt
python etl/build.py               # raw to sponsors schema, runs verification gates
python etl/build.py --verify-only # re-run the gates without rebuilding
python etl/publish.py --dry-run   # object count and bytes, uploads nothing
python etl/publish.py             # uploads changed objects only (manifest diff)
python etl/publish_index.py       # downloadable index -> etl/dist/, never touches R2
```

`publish.py` also takes `--resume` (after an interrupted run, lists the
bucket and skips what already landed), `--limit N` (exercise the real
upload path on N objects; never writes the manifest), and
`--include-prefix P` (publish only keys under a prefix, e.g. just the `s/`
search tiers).

`publish_index.py` takes `--out DIR` and `--limit N`. A `--limit` run writes
a partial file and no `index-latest.json`, on the same reasoning that keeps
a `--limit` publish from writing the manifest: the pointer is what makes a
build releasable, so a smoke test cannot be shipped by mistake.

`build.py` fails if a row count drifts outside its measured range or a
verification gate breaks. Regressions in the normalizers produce data that
looks plausible, so the gates are how you catch them.

### Aggregation rules

Derived from the value distributions in the source tables, not the form
spec. `sql/00_functions.sql` holds the normalizers.

Employer identity: `employer_fein` is 100% NULL for FY2020 through FY2023
in all three tables, since DOL added the column in FY2024. Keying on FEIN
alone drops 2.67M LCA rows (66%) and four of the six years. Resolution
order is the filing's own FEIN, then the FEIN this employer's name maps
to in a FY2024+ filing, then an opaque `n-` hash of the name. The middle
step recovers 85.7% of FEIN-less rows against a 41% name level match rate,
since high volume employers appear in both eras.

Identifiers measured and left unused. All are 100% populated in the
FEIN-less years:

| Signal | Maps to 1 FEIN | Recovers | Left out because |
| --- | --- | --- | --- |
| `employer_name` | 99.0% | 89.1% | in use |
| `employer_address1` (+name) | 99.4% | | addresses move between filings |
| `employer_phone` | 94.9% | 51.1% | shared PEO and switchboard numbers |
| `employer_poc_email` | 95.1% | 42.8% | often the immigration attorney's |
| `naics_code` | | | industry code |
| `lawfirm_business_fein` | | | 0% before FY2025, identifies the lawyer |

Phone and email catch spelling variants that name misses; under a strict
guard they reach 92.1%. Left out anyway: `n/a` appears as a literal
`poc_email` across 3,137 employers and `@amazon.com` spans 140 employer
names, so a loose guard merges unrelated companies. The remaining 7.9%
keep `n-` keys.

Accepted gap: name variants stay split. "GOOGLE INC." has 29 filings and
no FEIN, so it does not fold into Google LLC. A wrongly merged employer
is invisible, so the split is the cheaper failure to accept.

Taxpayer IDs: the IRS issues EINs from a fixed set of campus prefixes.
21 values in this dataset fall outside it. `96` and `97` are ITINs,
`09`/`19`/`89` are SSN area numbers, and sole proprietors sometimes file
one in the FEIN field. `norm_ein` rejects them so they reach neither the
published `ein` nor the identity key. `build.py` gates on it.

SOC codes: inconsistent across tables. `15-1252` and `15-1252.00`, plus
datetime strings, semicolon joined lists, and `999999` in `pwd_soc_code`.
`norm_soc` anchors on `^\d{2}-\d{4}`. PWD uses `suggested_soc_code` (1.11M
clean) over `pwd_soc_code` (740k, 47k junk).

Booleans: six variants, `Yes`/`No`/`Y`/`N`/`N/A`/NULL. `h_1b_dependent`
is 769k `Yes` plus 198k `Y`, so matching `'Y'` alone misses 80%.

`new_employment`, `change_employer`, `continued_employment`: position
counts running 0 to 100, so they get summed.

Approvals: PWD success is `Determination Issued`, so approval is
`case_status <> 'Withdrawn'`. PERM counts every `Certified%` variant
including `Certified-Expired`, since the certification did happen and the
employer only missed the I-140 window.

GC totals (`n_pwd`, `n_perm`, `does_gc`, `gc_by_year`, `first_year`,
`last_year`) count every disclosed filing, including ones whose SOC code
doesn't parse. Per-SOC breakdowns (`gc_by_soc`, `sponsors.gc_filings`)
restrict to well-formed SOC. Junk-SOC filings still count toward whether
an employer sponsors, they just don't get bucketed into an occupation.

Employer universe: built from all three sources. 47% have GC filings but
no LCA rows.

Wages: every case status is included, since the offered wage is a federal
attestation of what the employer was willing to pay. The approval funnel
is tracked separately. Only annual wages are averaged, so `jobs` and
`job_titles` cover annual filings while the profile counts cover all of
them.

Percentiles: materialized per scope, since percentiles don't compose and
a national p50 can't come from ZIP level p50s. National, state and ZIP
tiers are built with `GROUPING SETS`. ZIP rows only at n>=5.

### What this API does not publish

About 40 of the 101 LCA columns are contact details for named individuals:
`employer_poc_*`, `preparer_*`, `agent_attorney_*`, `lawfirm_*`, covering
names, job titles, emails, phones and postal addresses. None of them
enter the `sponsors` schema.

Accepted gap: 69% of `jobs` rows describe a single filing, so those wage
figures amount to one person's compensation at a known employer, role,
year and ZIP. DOL publishes the same thing at row level and there is no
anonymity expectation on already public federal disclosure, so the rows
ship as they are. `wage_benchmarks` is gated at n>=5 for its ZIP tier.

## Deploy

```bash
npx wrangler kv namespace create KEYS   # paste the printed id into wrangler.toml
npx wrangler deploy
npx wrangler secret put API_KEYS        # {"<sha256-of-token>": "career-ops"}
```

`API_KEYS` holds keys you hand out yourself. It is a secret parsed once per
isolate, so those keys keep working through a KV outage. Self-serve keys live
in the `KEYS` namespace instead. Smoke test issuance after a deploy, then use
what it returns:

```bash
curl -X POST https://api.surakshith.com/immigration/v1/keys/request
curl -H "Authorization: Bearer h1b_..." \
  "https://api.surakshith.com/immigration/v1/employers/search?q=amazon"
```

Attach `api.surakshith.com` under Workers, h1b-sponsor-data, Settings,
Domains and Routes. Or set `routes = [{ pattern = "api.<yours>",
custom_domain = true }]` in `wrangler.toml` so a redeploy reasserts it.

### Administering self-serve keys

```bash
npx wrangler kv key list --binding KEYS --remote             # audit every key
npx wrangler kv key get <sha256> --binding KEYS --remote     # inspect one
npx wrangler kv key delete <sha256> --binding KEYS --remote  # revoke one
```

The key name is the sha256 of the token, and the value holds `label`,
`createdAt`, and `requestor`. `requestor` is a sha256 of the IP and ASN that
asked, which is enough to spot one caller minting in bulk across a listing
without keeping an address on disk. There is no revoked flag: a delete is the
revocation, so nothing downstream can forget to check it.

Kill switch: set `mintGlobal` to 0 in `worker/ratelimit.ts` and redeploy. New
keys stop being issued and every key already out there keeps working.

Three limits come with this design and are accepted rather than fixed:

- A fresh key can 401 for about 60 seconds on servers other than the isolate
  that minted it, until KV converges. The 201 body says so, and a retry works.
- A revoked key can keep working for up to about 2 minutes, since each isolate
  caches a positive lookup for 60 seconds and may have just refreshed one.
- Issuance is braked at roughly 200 to 400 keys per day across all callers.
  Past that, everyone waits for the bucket to refill.

## Self-hosting

Three things to change under a different domain, across two files:

- `worker/index.ts`: `ALLOWED_ORIGINS`, the CORS allowlist for browsers
  calling the API from your site's origin.
- `wrangler.toml`: the `routes` block, the hostname the Worker is bound
  to, and the `KEYS` KV namespace id from `wrangler kv namespace create KEYS`.

`api.surakshith.com` in the README and its own CORS entries are the
owner's config. Nothing else in the code knows about the specific
hostname.

## Search semantics

`/employers/search?q=X` and `/titles?q=X` return `{prefix, total, results}`
where `results` is capped at 50 by filing volume. A 404 means no employer
has a name starting with the normalized query prefix. Deeper prefix tiers
(up to 10 characters) exist only where a shallower bucket overflowed, and
the Worker probes at most five keys (longest available, two shorter
neighbors, depth 3, depth 2), so typeahead pays one to five sequential R2
reads. About 98% of the 335k employers reach the top 50 of some bucket;
the remainder share an overcrowded prefix with many higher-volume
employers.

## Non-goals

- No ad hoc filtering or range queries.
- No POC, preparer or attorney contact fields.
- No writes through the API.
- No BLS area enrichment. LCA carries county, and I don't derive what
  isn't there.
- No auto refresh on DOL drops. Reloading is `build`, `publish`, then
  `publish_index` and a release.

## License

[MIT](LICENSE), Copyright (c) 2026 Surakshith Sampath.

Covers this project's code and derived schema. Not the underlying
records: those are US Department of Labor Office of Foreign Labor
Certification public disclosure data, which as a work of the US federal
government carries no copyright protection in the US (17 U.S.C. Sec. 105)
and is in the public domain.
