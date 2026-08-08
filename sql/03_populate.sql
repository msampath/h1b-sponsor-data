-- Populate the sponsors serving layer from the raw disclosures.
-- Idempotent: truncates and rebuilds. Safe to re-run after each DOL drop.
--
-- Shape: normalize once into temp staging tables, then aggregate from those
-- several times. Normalizing inline in each aggregate would re-run the regex
-- functions over 4M rows per pass.
--
-- Two counting conventions, deliberately different:
--   * `jobs` and `job_titles` cover only filings with an ANNUAL offered wage.
--     Mixing $60/hr with $120k/yr into one average is not meaningful.
--   * `employer_profile.n_*` and `filings_by_soc_year` count EVERY filing
--     regardless of wage unit, so "how many did they file" stays truthful.

-- ── employer identity ────────────────────────────────────────────────────
-- employer_fein is NULL for every FY2020-FY2023 row in all three sources;
-- DOL added the column in FY2024. Keying on FEIN alone would silently drop
-- 2.67M LCA rows (66%) and four of the six years.
--
-- Build a name -> FEIN map from every filing that DOES carry one, then use
-- it to backfill the older rows. Where a name has claimed several FEINs,
-- the most-used one wins. This recovers 85.7% of the FEIN-less rows —
-- far above the 41% name-level match rate, because the employers that file
-- in volume are exactly the ones present in both eras.

-- Permanent, not temp: this is the audit trail for why an employer resolved
-- to a given identity, and it lets the verification gates re-run without a
-- full rebuild.
DROP TABLE IF EXISTS sponsors.fein_map;
CREATE TABLE sponsors.fein_map AS
SELECT nm, fein FROM (
  SELECT nm, fein,
         ROW_NUMBER() OVER (PARTITION BY nm ORDER BY COUNT(*) DESC, fein) AS rn
  FROM (
    SELECT sponsors.norm_name(employer_name) AS nm,
           sponsors.norm_ein(employer_fein)  AS fein
    FROM lca_disclosure
    UNION ALL
    SELECT sponsors.norm_name(employer_legal_business_name),
           sponsors.norm_ein(employer_fein)
    FROM pwd_disclosure
    UNION ALL
    SELECT sponsors.norm_name(employer_name), sponsors.norm_ein(employer_fein)
    FROM perm_disclosure
  ) src
  WHERE nm IS NOT NULL AND fein IS NOT NULL
  GROUP BY nm, fein
) ranked
WHERE rn = 1;

CREATE INDEX ON sponsors.fein_map (nm);
ANALYZE sponsors.fein_map;

-- Resolve a (fein, name) pair to the public identity used in API paths.
--
-- The fallback key is an OPAQUE hash, never a slug of the employer name.
-- Many FEIN-less employers are sole proprietorships and professional
-- practices whose legal name is a natural person ("... DDS PC", "..., Esq.").
-- A readable slug would put that person's name into request paths, server
-- logs, referrer headers and browser history. The name is still returned in
-- the response body — it is the disclosed party and belongs there — but it
-- has no reason to be in the identifier.
--
-- 64 bits over ~167k name-keyed employers: collision probability ~1e-9.
-- 01_schema.sql keeps a UNIQUE constraint on key, and build.py gates that
-- distinct names and distinct keys stay 1:1, so a collision fails loudly
-- rather than silently merging two employers.
CREATE OR REPLACE FUNCTION sponsors.emp_key(fein text, mapped text, nm text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(fein, mapped, 'n-' || left(md5(nm), 16))
$$;

-- ── staging ──────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS lca_n;
CREATE TEMP TABLE lca_n AS
SELECT
  sponsors.emp_key(sponsors.norm_ein(employer_fein), fm.fein,
                   sponsors.norm_name(employer_name))                 AS ekey,
  sponsors.norm_ein(employer_fein)                                    AS ein,
  EXTRACT(YEAR FROM COALESCE(decision_date, received_date))::smallint AS year,
  sponsors.norm_soc(soc_code)                                         AS soc,
  sponsors.norm_level(pw_wage_level)                                  AS level,
  nullif(btrim(job_title), '')                                        AS title,
  worksite_state                                                      AS state,
  -- county arrives in mixed case (488 variant collisions measured) and
  -- postal_code carries ZIP+4 and junk (203,121 non-5-digit values);
  -- both are GROUP BY keys, so normalize here or the grain fragments.
  nullif(upper(btrim(worksite_county)), '')                           AS county,
  substring(worksite_postal_code FROM '^([0-9]{5})')                  AS zip,
  case_status                                                         AS status,
  -- wage columns are NULL unless the filing is quoted annually
  CASE WHEN wage_unit_of_pay = 'Year' THEN wage_rate_of_pay_from END  AS wage_from,
  CASE WHEN wage_unit_of_pay = 'Year'
       THEN COALESCE(wage_rate_of_pay_to, wage_rate_of_pay_from) END  AS wage_to,
  CASE WHEN wage_unit_of_pay = 'Year'
       THEN (wage_rate_of_pay_from
             + COALESCE(wage_rate_of_pay_to, wage_rate_of_pay_from)) / 2.0 END AS wage_mid,
  -- prevailing wage only comparable when it too is annual
  CASE WHEN pw_unit_of_pay = 'Year' THEN prevailing_wage END          AS pw,
  COALESCE(new_employment, 0)                                         AS new_emp,
  COALESCE(change_employer, 0)                                        AS chg_emp,
  COALESCE(continued_employment, 0)                                   AS cont_emp,
  sponsors.norm_bool(secondary_entity)                                AS secondary,
  sponsors.norm_bool(h_1b_dependent)                                  AS dependent,
  sponsors.norm_bool(willful_violator)                                AS willful
FROM lca_disclosure l
LEFT JOIN sponsors.fein_map fm ON fm.nm = sponsors.norm_name(l.employer_name)
WHERE sponsors.norm_name(employer_name) IS NOT NULL
  AND COALESCE(decision_date, received_date) IS NOT NULL;

CREATE INDEX ON lca_n (ekey);
ANALYZE lca_n;

-- GC staging, one row per filing. PWD uses suggested_soc_code (1.11M
-- well-formed, 885 junk) rather than pwd_soc_code (740k, 46,950 junk).
-- "Approved" = a determination exists: for PWD everything except Withdrawn
-- (Determination Issued + the Redetermination / Center-Director outcomes);
-- for PERM every Certified* variant, including Certified-Expired — the
-- certification happened, the employer just missed the I-140 window.
DROP TABLE IF EXISTS gc_n;
CREATE TEMP TABLE gc_n AS
SELECT
  sponsors.emp_key(sponsors.norm_ein(p.employer_fein), fm.fein,
                   sponsors.norm_name(p.employer_legal_business_name))       AS ekey,
  EXTRACT(YEAR FROM COALESCE(p.determination_date, p.received_date))::smallint AS year,
  'PWD'::text                                                                AS typ,
  sponsors.norm_soc(p.suggested_soc_code)                                    AS soc,
  (p.case_status <> 'Withdrawn')                                             AS approved
FROM pwd_disclosure p
LEFT JOIN sponsors.fein_map fm ON fm.nm = sponsors.norm_name(p.employer_legal_business_name)
WHERE sponsors.norm_name(p.employer_legal_business_name) IS NOT NULL
  AND sponsors.norm_soc(p.suggested_soc_code) IS NOT NULL
  AND COALESCE(p.determination_date, p.received_date) IS NOT NULL
UNION ALL
SELECT
  sponsors.emp_key(sponsors.norm_ein(p.employer_fein), fm.fein,
                   sponsors.norm_name(p.employer_name)),
  EXTRACT(YEAR FROM COALESCE(p.decision_date, p.received_date))::smallint,
  'PERM',
  sponsors.norm_soc(p.pw_soc_code),
  (p.case_status LIKE 'Certified%')
FROM perm_disclosure p
LEFT JOIN sponsors.fein_map fm ON fm.nm = sponsors.norm_name(p.employer_name)
WHERE sponsors.norm_name(p.employer_name) IS NOT NULL
  AND sponsors.norm_soc(p.pw_soc_code) IS NOT NULL
  AND COALESCE(p.decision_date, p.received_date) IS NOT NULL;

CREATE INDEX ON gc_n (ekey);
ANALYZE gc_n;

-- Name + EIN candidates across all three sources; most recent filing wins.
DROP TABLE IF EXISTS emp_src;
CREATE TEMP TABLE emp_src AS
SELECT sponsors.emp_key(sponsors.norm_ein(l.employer_fein), fm.fein,
                        sponsors.norm_name(l.employer_name))         AS ekey,
       sponsors.norm_ein(l.employer_fein)                            AS ein,
       btrim(l.employer_name)                                        AS name,
       COALESCE(l.decision_date, l.received_date)                    AS d
FROM lca_disclosure l
LEFT JOIN sponsors.fein_map fm ON fm.nm = sponsors.norm_name(l.employer_name)
WHERE sponsors.norm_name(l.employer_name) IS NOT NULL
UNION ALL
SELECT sponsors.emp_key(sponsors.norm_ein(p.employer_fein), fm.fein,
                        sponsors.norm_name(p.employer_legal_business_name)),
       sponsors.norm_ein(p.employer_fein),
       btrim(p.employer_legal_business_name),
       COALESCE(p.determination_date, p.received_date)
FROM pwd_disclosure p
LEFT JOIN sponsors.fein_map fm ON fm.nm = sponsors.norm_name(p.employer_legal_business_name)
WHERE sponsors.norm_name(p.employer_legal_business_name) IS NOT NULL
UNION ALL
SELECT sponsors.emp_key(sponsors.norm_ein(p.employer_fein), fm.fein,
                        sponsors.norm_name(p.employer_name)),
       sponsors.norm_ein(p.employer_fein),
       btrim(p.employer_name),
       COALESCE(p.decision_date, p.received_date)
FROM perm_disclosure p
LEFT JOIN sponsors.fein_map fm ON fm.nm = sponsors.norm_name(p.employer_name)
WHERE sponsors.norm_name(p.employer_name) IS NOT NULL;

ANALYZE emp_src;

-- ── load ─────────────────────────────────────────────────────────────────

BEGIN;

TRUNCATE sponsors.wage_benchmarks, sponsors.job_titles, sponsors.gc_filings,
         sponsors.jobs, sponsors.employer_profile, sponsors.employers
         RESTART IDENTITY CASCADE;

INSERT INTO sponsors.employers (key, ein, name)
SELECT DISTINCT ON (ekey) ekey,
       -- (67) an employer keyed by FEIN can still surface a most-recent row
       -- whose own ein column was NULL; the key IS the FEIN, so backfill it.
       COALESCE(ein, CASE WHEN ekey ~ '^[0-9]{9}$' THEN ekey END) AS ein,
       name
FROM emp_src
-- belt-and-braces: norm_name(...) IS NOT NULL in every emp_src arm already
-- implies a non-empty name; kept as an invariant guard, not a filter.
WHERE name IS NOT NULL AND name <> ''
-- name/ein tie-break: two sources can file the same employer on the same
-- date; without a total order the chosen spelling flips per rebuild and
-- churns every derived object's sha256.
ORDER BY ekey, d DESC NULLS LAST, name, ein NULLS LAST;

-- jobs: annual-wage filings only (see header note)
INSERT INTO sponsors.jobs (employer_id, year, soc_code, level, avg_wage,
                           min_wage, max_wage, avg_prev_wage,
                           state, county, zip, n_filings)
SELECT e.id, l.year, l.soc, l.level,
       ROUND(AVG(l.wage_mid), 2),
       MIN(l.wage_from),
       MAX(l.wage_to),
       ROUND(AVG(l.pw), 2),
       l.state, l.county, l.zip,
       COUNT(*)
FROM lca_n l
JOIN sponsors.employers e ON e.key = l.ekey
WHERE l.soc IS NOT NULL AND l.wage_mid IS NOT NULL
GROUP BY e.id, l.year, l.soc, l.level, l.state, l.county, l.zip;

INSERT INTO sponsors.gc_filings (employer_id, year, type, soc_code, n, n_approved)
SELECT e.id, g.year, g.typ, g.soc, COUNT(*), COUNT(*) FILTER (WHERE g.approved)
FROM gc_n g
JOIN sponsors.employers e ON e.key = g.ekey
GROUP BY e.id, g.year, g.typ, g.soc;

-- job_titles: counts cover all filings for the title; wage stats cover the
-- annual-wage subset, so the weighted mean divides by COUNT(wage_mid).
INSERT INTO sponsors.job_titles (employer_id, soc_code, title, n_filings,
                                 avg_wage, min_wage, max_wage, level_mix)
SELECT id, soc, title,
       SUM(c)::int,
       ROUND(SUM(am * cw) / NULLIF(SUM(cw), 0), 2),
       MIN(mn), MAX(mx),
       jsonb_object_agg(COALESCE(level, 'unknown'), c)
FROM (
  SELECT e.id, l.soc, l.title, l.level,
         COUNT(*)          AS c,
         COUNT(l.wage_mid) AS cw,
         AVG(l.wage_mid)   AS am,
         MIN(l.wage_from)  AS mn,
         MAX(l.wage_to)    AS mx
  FROM lca_n l
  JOIN sponsors.employers e ON e.key = l.ekey
  WHERE l.soc IS NOT NULL AND l.title IS NOT NULL
  GROUP BY e.id, l.soc, l.title, l.level
) t
GROUP BY id, soc, title;

-- wage_benchmarks: three geographic scopes in one pass. GROUPING() tells a
-- rollup NULL apart from a NULL that is actually in the data — without it,
-- a filing with a missing zip would be indistinguishable from the national
-- rollup row. Zip tier is emitted only at n>=5; below that a percentile is
-- noise and it would add ~840k near-empty rows.
INSERT INTO sponsors.wage_benchmarks (soc_code, level, year, scope, state, zip,
                                      n_filings, employer_count,
                                      p25, p50, p75, mean, min_wage, max_wage)
SELECT soc, level, year,
       CASE WHEN gz = 0 THEN 'zip' WHEN gs = 0 THEN 'state' ELSE 'national' END,
       CASE WHEN gs = 0 THEN state END,
       CASE WHEN gz = 0 THEN zip END,
       n_filings, employer_count, p25, p50, p75, mean, min_wage, max_wage
FROM (
  SELECT l.soc, l.level, l.year, l.state, l.zip,
         GROUPING(l.state) AS gs,
         GROUPING(l.zip)   AS gz,
         COUNT(*)::int                  AS n_filings,
         COUNT(DISTINCT l.ekey)::int     AS employer_count,
         ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY l.wage_mid)::numeric, 2) AS p25,
         ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY l.wage_mid)::numeric, 2) AS p50,
         ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY l.wage_mid)::numeric, 2) AS p75,
         ROUND(AVG(l.wage_mid), 2)      AS mean,
         MIN(l.wage_from)               AS min_wage,
         MAX(l.wage_to)                 AS max_wage
  FROM lca_n l
  WHERE l.soc IS NOT NULL AND l.wage_mid IS NOT NULL
  GROUP BY GROUPING SETS (
    (l.soc, l.level, l.year),
    (l.soc, l.level, l.year, l.state),
    (l.soc, l.level, l.year, l.state, l.zip)
  )
) t
WHERE (gz = 0 AND zip IS NOT NULL AND n_filings >= 5)
   OR (gz = 1 AND gs = 0 AND state IS NOT NULL)
   OR (gz = 1 AND gs = 1);

-- employer_profile: driven from sponsors.employers with LEFT JOINs so the
-- 70,452 employers that have GC filings but no LCA rows still get a row.
INSERT INTO sponsors.employer_profile (
  employer_id, first_year, last_year,
  n_lca, n_certified, n_certified_withdrawn, n_denied, n_withdrawn,
  n_new, n_transfer, n_continued, n_pwd, n_perm, does_gc, wage_vs_pw,
  gc_by_year, gc_by_soc, filings_by_soc_year, trend, level_mix, red_flags)
WITH base AS (
  SELECT e.id, l.*
  FROM lca_n l JOIN sponsors.employers e ON e.key = l.ekey
),
agg AS (
  SELECT id,
    MIN(year) AS first_year, MAX(year) AS last_year,
    COUNT(*)::int                                                 AS n_lca,
    COUNT(*) FILTER (WHERE status = 'Certified')::int              AS n_certified,
    COUNT(*) FILTER (WHERE status = 'Certified - Withdrawn')::int  AS n_cw,
    COUNT(*) FILTER (WHERE status = 'Denied')::int                 AS n_denied,
    COUNT(*) FILTER (WHERE status = 'Withdrawn')::int              AS n_withdrawn,
    COALESCE(SUM(new_emp), 0)                                      AS n_new,
    COALESCE(SUM(chg_emp), 0)                                      AS n_transfer,
    COALESCE(SUM(cont_emp), 0)                                     AS n_continued,
    COUNT(*) FILTER (WHERE secondary)::int                         AS n_secondary,
    COUNT(*) FILTER (WHERE dependent)::int                         AS n_dependent,
    COUNT(*) FILTER (WHERE willful)::int                           AS n_willful,
    ROUND(AVG(wage_mid / pw) FILTER (WHERE wage_mid IS NOT NULL AND pw > 0), 3) AS wage_vs_pw
  FROM base GROUP BY id
),
lvl AS (
  SELECT id, jsonb_object_agg(level, c) AS j
  FROM (SELECT id, level, COUNT(*) AS c FROM base
        WHERE level IS NOT NULL GROUP BY id, level) t
  GROUP BY id
),
trend AS (
  SELECT id, jsonb_agg(jsonb_build_object(
           'year', year, 'filings', f, 'new', nw, 'transfer', tr,
           'continued', ct, 'certified', ce, 'denied', dn, 'withdrawn', wd,
           'certified_withdrawn', cw
         ) ORDER BY year) AS j
  FROM (
    SELECT id, year, COUNT(*) AS f,
           COALESCE(SUM(new_emp), 0) AS nw,
           COALESCE(SUM(chg_emp), 0) AS tr,
           COALESCE(SUM(cont_emp), 0) AS ct,
           COUNT(*) FILTER (WHERE status = 'Certified') AS ce,
           COUNT(*) FILTER (WHERE status = 'Denied') AS dn,
           COUNT(*) FILTER (WHERE status = 'Withdrawn') AS wd,
           COUNT(*) FILTER (WHERE status = 'Certified - Withdrawn') AS cw
    FROM base GROUP BY id, year
  ) t GROUP BY id
),
soc_year AS (
  SELECT id, jsonb_object_agg(soc, ym) AS j
  FROM (
    SELECT id, soc, jsonb_object_agg(year::text, n) AS ym
    FROM (SELECT id, soc, year, COUNT(*) AS n FROM base
          WHERE soc IS NOT NULL GROUP BY id, soc, year) a
    GROUP BY id, soc
  ) b GROUP BY id
),
gcb AS (
  SELECT e.id, g.year, g.typ, g.soc, g.approved
  FROM gc_n g JOIN sponsors.employers e ON e.key = g.ekey
),
gc_tot AS (
  SELECT id,
    COUNT(*) FILTER (WHERE typ = 'PWD')::int  AS n_pwd,
    COUNT(*) FILTER (WHERE typ = 'PERM')::int AS n_perm
  FROM gcb GROUP BY id
),
gc_year AS (
  SELECT id, jsonb_agg(jsonb_build_object(
           'year', year, 'pwd', pwd, 'perm', perm,
           'pwd_approved', pwa, 'perm_approved', pea) ORDER BY year) AS j
  FROM (
    SELECT id, year,
      COUNT(*) FILTER (WHERE typ = 'PWD')  AS pwd,
      COUNT(*) FILTER (WHERE typ = 'PERM') AS perm,
      COUNT(*) FILTER (WHERE typ = 'PWD'  AND approved) AS pwa,
      COUNT(*) FILTER (WHERE typ = 'PERM' AND approved) AS pea
    FROM gcb GROUP BY id, year
  ) t GROUP BY id
),
gc_soc AS (
  SELECT id, jsonb_object_agg(soc, o) AS j
  FROM (
    SELECT id, soc, jsonb_build_object(
             'pwd',  COUNT(*) FILTER (WHERE typ = 'PWD'),
             'perm', COUNT(*) FILTER (WHERE typ = 'PERM')) AS o
    FROM gcb GROUP BY id, soc
  ) t GROUP BY id
)
SELECT
  e.id, a.first_year, a.last_year,
  COALESCE(a.n_lca, 0), COALESCE(a.n_certified, 0), COALESCE(a.n_cw, 0),
  COALESCE(a.n_denied, 0), COALESCE(a.n_withdrawn, 0),
  COALESCE(a.n_new, 0), COALESCE(a.n_transfer, 0), COALESCE(a.n_continued, 0),
  COALESCE(gt.n_pwd, 0), COALESCE(gt.n_perm, 0),
  COALESCE(gt.n_pwd, 0) + COALESCE(gt.n_perm, 0) > 0,
  a.wage_vs_pw,
  gy.j, gs.j, sy.j, tr.j, lv.j,
  jsonb_build_object(
    'staffing_shop', jsonb_build_object(
      'value', COALESCE(a.n_secondary::numeric / NULLIF(a.n_lca, 0) > 0.5, false),
      'basis', 'secondary_entity_share',
      'share', ROUND(COALESCE(a.n_secondary::numeric / NULLIF(a.n_lca, 0), 0), 3),
      'n_secondary', COALESCE(a.n_secondary, 0), 'n_total', COALESCE(a.n_lca, 0)),
    'h1b_dependent', jsonb_build_object(
      'value', COALESCE(a.n_dependent::numeric / NULLIF(a.n_lca, 0) > 0.5, false),
      'n_yes', COALESCE(a.n_dependent, 0), 'n_total', COALESCE(a.n_lca, 0)),
    -- any occurrence counts: a willful-violator finding is rare (1,291 rows
    -- in 4M) and serious enough that a majority test would hide it
    'willful_violator', jsonb_build_object(
      'value', COALESCE(a.n_willful, 0) > 0,
      'n_yes', COALESCE(a.n_willful, 0), 'n_total', COALESCE(a.n_lca, 0)))
FROM sponsors.employers e
LEFT JOIN agg      a  ON a.id  = e.id
LEFT JOIN lvl      lv ON lv.id = e.id
LEFT JOIN trend    tr ON tr.id = e.id
LEFT JOIN soc_year sy ON sy.id = e.id
LEFT JOIN gc_tot   gt ON gt.id = e.id
LEFT JOIN gc_year  gy ON gy.id = e.id
LEFT JOIN gc_soc   gs ON gs.id = e.id;

COMMIT;

-- ── indexes ──────────────────────────────────────────────────────────────
-- Built after the load; maintaining them during bulk INSERT costs more than
-- one rebuild at the end.
DROP INDEX IF EXISTS sponsors.jobs_by_employer;
DROP INDEX IF EXISTS sponsors.gc_by_employer;
DROP INDEX IF EXISTS sponsors.gc_by_emp_soc;
DROP INDEX IF EXISTS sponsors.titles_by_employer;
DROP INDEX IF EXISTS sponsors.titles_by_title;
DROP INDEX IF EXISTS sponsors.bench_lookup;
DROP INDEX IF EXISTS sponsors.employers_name;
DROP INDEX IF EXISTS sponsors.employers_ein;
CREATE INDEX jobs_by_employer   ON sponsors.jobs (employer_id);
CREATE INDEX gc_by_employer     ON sponsors.gc_filings (employer_id);
CREATE INDEX gc_by_emp_soc      ON sponsors.gc_filings (employer_id, soc_code);
CREATE INDEX titles_by_employer ON sponsors.job_titles (employer_id);
CREATE INDEX titles_by_title    ON sponsors.job_titles (sponsors.norm_name(title));
CREATE INDEX bench_lookup       ON sponsors.wage_benchmarks (soc_code, level);
CREATE INDEX employers_name     ON sponsors.employers (sponsors.norm_name(name) text_pattern_ops);
CREATE INDEX employers_ein      ON sponsors.employers (ein) WHERE ein IS NOT NULL;

ANALYZE sponsors.employers;
ANALYZE sponsors.employer_profile;
ANALYZE sponsors.jobs;
ANALYZE sponsors.gc_filings;
ANALYZE sponsors.job_titles;
ANALYZE sponsors.wage_benchmarks;
