-- Normalizers for the sponsors serving layer.
--
-- These exist because the raw DOL columns are dirty in ways that silently
-- corrupt joins rather than erroring. Every rule here was derived from
-- inspecting the actual value distributions in `lca`, not from the form spec.
--
-- IMMUTABLE + PARALLEL SAFE so the planner can inline them and parallelize
-- the big aggregate scans in 03_populate.sql.

CREATE SCHEMA IF NOT EXISTS sponsors;

-- SOC codes appear as '15-1252', '15-1252.00', '15-1252-00',
-- '15-1252 - Software Developers', and — in pwd_soc_code — as datetime
-- strings ('2015-06-01 00:00:00', 6,772 rows), semicolon-joined lists (540),
-- and '999999'. A bare split_part() lets all of that through into join keys.
-- Anchor on the real shape and extract only that.
CREATE OR REPLACE FUNCTION sponsors.norm_soc(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT substring(btrim(t) FROM '^([0-9]{2}-[0-9]{4})')
$$;

-- Booleans ship as Yes/No/Y/N/N/A/NULL. Matching only 'Y' would miss ~80%
-- of h_1b_dependent (769,152 'Yes' vs 197,581 'Y'). Unknown stays NULL
-- rather than collapsing to false — 'N/A' is not the same as 'No'.
CREATE OR REPLACE FUNCTION sponsors.norm_bool(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE lower(btrim(coalesce(t, '')))
    WHEN 'y' THEN true
    WHEN 'yes' THEN true
    WHEN 'n' THEN false
    WHEN 'no' THEN false
    ELSE NULL
  END
$$;

-- pw_wage_level is I/II/III/IV plus 'N/A', NULL, and 21 junk 'V' rows.
CREATE OR REPLACE FUNCTION sponsors.norm_level(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE upper(btrim(coalesce(t, '')))
    WHEN 'I' THEN 'I' WHEN 'II' THEN 'II'
    WHEN 'III' THEN 'III' WHEN 'IV' THEN 'IV'
    ELSE NULL
  END
$$;

-- FEIN is the employer identity. Strip formatting; anything that is not
-- exactly 9 digits is not a usable identity and becomes NULL.
--
-- The prefix check is a PRIVACY control, not a data-quality one. The IRS
-- issues EINs from a fixed set of campus prefixes. A 9-digit taxpayer ID
-- outside that set is not a business EIN — prefixes 96/97 fall in the ITIN
-- range and 09/19/89 are valid SSN area numbers, both of which identify a
-- natural person. Sole proprietors sometimes file one in this field. 21 such
-- values exist in this dataset; rejecting them here keeps them out of the
-- published `ein` AND out of the identity key, so they never reach an object
-- path or a URL. Those employers fall through to a name-derived key instead.
CREATE OR REPLACE FUNCTION sponsors.norm_ein(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN regexp_replace(coalesce(t, ''), '[^0-9]', '', 'g') ~ '^[0-9]{9}$'
     AND left(regexp_replace(coalesce(t, ''), '[^0-9]', '', 'g'), 2) IN (
       '01','02','03','04','05','06','10','11','12','13','14','15','16',
       '20','21','22','23','24','25','26','27','30','31','32','33','34',
       '35','36','37','38','39','40','41','42','43','44','45','46','47',
       '48','50','51','52','53','54','55','56','57','58','59','60','61',
       '62','63','64','65','66','67','68','71','72','73','74','75','76',
       '77','80','81','82','83','84','85','86','87','88','90','91','92',
       '93','94','95','98','99')
      THEN regexp_replace(t, '[^0-9]', '', 'g')
    ELSE NULL
  END
$$;

-- Employer names carry inconsistent whitespace and casing across filings.
-- Used for the prefix search index, never for display.
CREATE OR REPLACE FUNCTION sponsors.norm_name(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(btrim(regexp_replace(lower(coalesce(t, '')), '\s+', ' ', 'g')), '')
$$;
