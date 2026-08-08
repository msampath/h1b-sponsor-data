-- Serving schema. Lives as `sponsors` inside the `lca` database so the
-- rollup is a plain INSERT..SELECT (no FDW, no cross-database hop) while
-- still being isolatable by grant.
--
-- This is the source of truth that etl/publish.py renders into R2 JSON.

DROP TABLE IF EXISTS sponsors.wage_benchmarks;
DROP TABLE IF EXISTS sponsors.job_titles;
DROP TABLE IF EXISTS sponsors.gc_filings;
DROP TABLE IF EXISTS sponsors.jobs;
DROP TABLE IF EXISTS sponsors.employer_profile;
DROP TABLE IF EXISTS sponsors.employers;

-- Union of all three sources. Two things drive the identity model:
--   * 42% of employers appear only in PWD/PERM (green cards, no H-1Bs), so
--     building from LCA alone orphans exactly the employers where does_gc
--     matters most.
--   * employer_fein is 100% NULL for FY2020-FY2023 in every source table —
--     DOL only added the column in FY2024. Keying on FEIN alone would throw
--     away four of the six years.
--
-- So identity is `key`, resolved in three steps (see 03_populate.sql):
--   1. the FEIN, when the filing carries one
--   2. else the FEIN this employer's name maps to in a FY2024+ filing
--      (recovers 85.7% of the FEIN-less rows)
--   3. else an opaque hash key, `n-<16 hex chars>` (never the name:
--      many FEIN-less employers are sole proprietorships named after
--      a person, and names do not belong in URLs or logs)
-- `key` is what appears in API URLs. `ein` stays nullable and truthful.
CREATE TABLE sponsors.employers (
  id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key   text NOT NULL UNIQUE,
  ein   text,
  name  text NOT NULL
);

-- One row per employer. Everything the small `e/{ein}.json` object needs,
-- so the common path never touches the large per-employer objects.
CREATE TABLE sponsors.employer_profile (
  employer_id  integer PRIMARY KEY REFERENCES sponsors.employers(id),
  first_year   smallint,
  last_year    smallint,

  -- approval funnel; these four reconcile to n_lca
  n_lca                 integer NOT NULL DEFAULT 0,
  n_certified           integer NOT NULL DEFAULT 0,
  n_certified_withdrawn integer NOT NULL DEFAULT 0,   -- 207,238 rows overall
  n_denied              integer NOT NULL DEFAULT 0,
  n_withdrawn           integer NOT NULL DEFAULT 0,

  -- these are position COUNTS on the form, not flags (values run 0..100)
  n_new        bigint NOT NULL DEFAULT 0,
  n_transfer   bigint NOT NULL DEFAULT 0,
  n_continued  bigint NOT NULL DEFAULT 0,

  n_pwd        integer NOT NULL DEFAULT 0,
  n_perm       integer NOT NULL DEFAULT 0,
  does_gc      boolean NOT NULL DEFAULT false,

  wage_vs_pw   numeric(6,3),   -- filing-weighted mean(offered / prevailing)

  gc_by_year           jsonb,  -- [{year, pwd, perm, pwd_approved, perm_approved}]
  gc_by_soc            jsonb,  -- {soc: {pwd, perm}}          → answers Q3
  filings_by_soc_year  jsonb,  -- {soc: {year: n}}            → answers Q1
  trend                jsonb,  -- [{year, filings, new, transfer, continued, ...}]
  level_mix            jsonb,  -- {"I":5,"II":20,...}
  red_flags            jsonb   -- value + evidence counts per flag
);

-- ~1.87M rows (see build.py EXPECTED for the gated range).
CREATE TABLE sponsors.jobs (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employer_id   integer NOT NULL REFERENCES sponsors.employers(id),
  year          smallint NOT NULL,
  soc_code      text NOT NULL,
  level         text,
  avg_wage      numeric(12,2),
  min_wage      numeric(12,2),
  max_wage      numeric(12,2),
  avg_prev_wage numeric(12,2),   -- prevailing wage, for the offered/PW ratio
  state         text,
  county        text,
  zip           text,
  n_filings     integer NOT NULL
);

-- ~760k rows (see build.py EXPECTED). Kept as a table (not just profile JSON) because Q3 asks
-- per-SOC and the profile's gc_by_year is keyed by year.
CREATE TABLE sponsors.gc_filings (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employer_id integer NOT NULL REFERENCES sponsors.employers(id),
  year        smallint NOT NULL,
  type        text NOT NULL CHECK (type IN ('PWD','PERM')),
  soc_code    text NOT NULL,
  n           integer NOT NULL,
  n_approved  integer NOT NULL
);

-- ~1.35M rows (see build.py EXPECTED). What this employer calls the role, and what they pay for it.
CREATE TABLE sponsors.job_titles (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employer_id integer NOT NULL REFERENCES sponsors.employers(id),
  soc_code    text NOT NULL,
  title       text NOT NULL,
  n_filings   integer NOT NULL,
  avg_wage    numeric(12,2),
  min_wage    numeric(12,2),
  max_wage    numeric(12,2),
  level_mix   jsonb
);

-- ~300k rows. THE percentile table. Percentiles do not compose, so each
-- geographic scope is materialized separately via GROUPING SETS.
CREATE TABLE sponsors.wage_benchmarks (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  soc_code       text NOT NULL,
  level          text,
  year           smallint NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('national','state','zip')),
  state          text,
  zip            text,
  n_filings      integer NOT NULL,
  employer_count integer NOT NULL,
  p25            numeric(12,2),
  p50            numeric(12,2),
  p75            numeric(12,2),
  mean           numeric(12,2),
  min_wage       numeric(12,2),
  max_wage       numeric(12,2)
);
