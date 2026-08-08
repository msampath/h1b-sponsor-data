"""Build the `sponsors` serving schema inside the `lca` database.

Runs sql/00_functions.sql, sql/01_schema.sql, sql/03_populate.sql in order,
then reports row counts and runs the verification gates from the plan.

Usage:
    python etl/build.py
    python etl/build.py --verify-only   # re-run the gates without rebuilding

Config comes from .env (see .env.example). Reads and writes `lca` only —
the raw public.* tables are never modified.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
SQL = ROOT / "sql"

# 02_raw_schema.sql is reference DDL for the RAW tables (docs/DATA.md); the
# raw load is a one-time manual step, so build.py never executes it.
STEPS = ["00_functions.sql", "01_schema.sql", "03_populate.sql"]

# Ranges are wide on purpose: they exist to catch a normalizer collapsing or
# exploding a table, not to pin an exact number. Tighten only after a run you
# have actually reconciled.
EXPECTED = {
    "employers": (150_000, 400_000),
    "employer_profile": (150_000, 400_000),
    "jobs": (1_500_000, 3_500_000),
    "gc_filings": (500_000, 1_200_000),
    "job_titles": (1_000_000, 2_500_000),
    "wage_benchmarks": (200_000, 400_000),
}

# The API is sold as "six years". Anything less means employer identity broke
# again — this is the gate that would have caught the FY2020-23 FEIN gap.
MIN_YEARS = 6


def _require_env(names):
    """Same shape as publish.py's require_env: fail on a missing key with a
    helpful message instead of a raw KeyError. Duplicated rather than
    imported to keep the ETL scripts independent of each other."""
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        print(f"missing in .env: {', '.join(missing)} (copy .env.example and fill in)",
              file=sys.stderr)
        sys.exit(2)


def main() -> int:
    load_dotenv(ROOT / ".env")
    _require_env(["POSTGRES_HOST", "POSTGRES_USER", "POSTGRES_PASSWORD"])
    dsn = dict(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        dbname=os.environ.get("SOURCE_DB", "lca"),
    )

    print(f"connecting to {dsn['user']}@{dsn['host']}:{dsn['port']}/{dsn['dbname']}")
    db = psycopg2.connect(**dsn)
    db.autocommit = True          # the SQL files manage their own transactions
    cur = db.cursor()
    cur.execute("SET work_mem = '512MB'")
    cur.execute("SET statement_timeout = 0")

    # --verify-only re-runs the gates against an existing build. Useful when
    # a gate itself was wrong; the full rollup takes ~12 minutes.
    if "--verify-only" not in sys.argv:
        for name in STEPS:
            print(f"running {name} ...", flush=True)
            t0 = time.time()
            cur.execute((SQL / name).read_text(encoding="utf-8"))
            print(f"  done in {time.time() - t0:.1f}s", flush=True)

    # ── row counts + gates ───────────────────────────────────────────────
    print("\nrow counts:")
    failures = []
    for table, (lo, hi) in EXPECTED.items():
        cur.execute(f"SELECT COUNT(*) FROM sponsors.{table}")
        n = cur.fetchone()[0]
        cur.execute(
            "SELECT pg_size_pretty(pg_total_relation_size(%s))", (f"sponsors.{table}",)
        )
        size = cur.fetchone()[0]
        ok = lo <= n <= hi
        print(f"  {table:18s} {n:>10,}  {size:>9s}  {'ok' if ok else 'OUT OF RANGE'}")
        if not ok:
            failures.append(f"{table}={n:,} outside [{lo:,}, {hi:,}]")

    # ── verification gates ───────────────────────────────────────────────
    print("\nverification:")

    cur.execute("SELECT COUNT(*) FROM sponsors.employer_profile WHERE does_gc")
    n_gc = cur.fetchone()[0]
    print(f"  employers with GC evidence      {n_gc:,}")
    if n_gc < 50_000:
        failures.append(f"does_gc={n_gc:,} implausibly low — SOC normalization suspect")

    cur.execute("""
        SELECT COUNT(*) FROM sponsors.employer_profile
        WHERE n_certified + n_certified_withdrawn + n_denied + n_withdrawn <> n_lca
    """)
    bad = cur.fetchone()[0]
    print(f"  funnel mismatches               {bad:,}")
    if bad:
        failures.append(f"{bad:,} profiles where the status funnel does not reconcile")

    cur.execute("""
        SELECT n_filings, p25, p50, p75 FROM sponsors.wage_benchmarks
        WHERE soc_code = '15-1252' AND level = 'II' AND year = 2024
          AND scope = 'national'
    """)
    row = cur.fetchone()
    if row:
        n, p25, p50, p75 = row
        print(f"  15-1252 L2 2024 national        n={n:,} p25={p25:,.0f} "
              f"p50={p50:,.0f} p75={p75:,.0f}")
        if not (p25 < p50 < p75):
            failures.append("percentiles not monotonic for 15-1252 L2 2024")
    else:
        failures.append("no national benchmark row for 15-1252 L2 2024")

    # Year coverage. FY2020-FY2023 carry no employer_fein at all, so any
    # regression in identity resolution shows up here as missing years long
    # before it shows up in a row count.
    cur.execute("SELECT MIN(year), MAX(year), COUNT(DISTINCT year) FROM sponsors.jobs")
    lo, hi, n_years = cur.fetchone()
    print(f"  jobs year coverage              {lo}-{hi} ({n_years} distinct)")
    if n_years < MIN_YEARS:
        failures.append(f"jobs spans only {n_years} years — identity resolution suspect")

    # Every employer must have a first/last year: the GC-only cohort (~70k)
    # previously got NULLs because the year aggregate read LCA rows only.
    # A regression on the gc_years CTE surfaces here.
    cur.execute("""
        SELECT COUNT(*) FROM sponsors.employer_profile
        WHERE first_year IS NULL OR last_year IS NULL
    """)
    n_null_years = cur.fetchone()[0]
    print(f"  profiles missing first/last     {n_null_years:,}")
    if n_null_years:
        failures.append(f"{n_null_years:,} profiles with NULL first_year/last_year "
                        f"— GC-year merge suspect")

    cur.execute("""
        SELECT COUNT(*) FILTER (WHERE ein IS NOT NULL),
               COUNT(*) FILTER (WHERE ein IS NULL)
        FROM sponsors.employers
    """)
    with_ein, without = cur.fetchone()
    print(f"  employers with real FEIN        {with_ein:,} "
          f"(name-keyed: {without:,})")

    # Hash keys must stay 1:1 with employer names. DISTINCT ON (key) during
    # the load would silently merge two employers on a collision, so check
    # rather than trust the probability.
    cur.execute("""
        SELECT COUNT(DISTINCT key), COUNT(DISTINCT sponsors.norm_name(name))
        FROM sponsors.employers WHERE ein IS NULL
    """)
    n_keys, n_names = cur.fetchone()
    print(f"  name-key collisions             {n_names - n_keys:,}")
    if n_keys != n_names:
        failures.append(f"{n_names - n_keys} hash collisions merged distinct employers")

    # No natural-person taxpayer IDs may reach a published identifier.
    cur.execute("""
        SELECT COUNT(*) FROM sponsors.employers
        WHERE ein IS NOT NULL AND left(ein, 2) IN ('96','97','09','19','89')
    """)
    leaked = cur.fetchone()[0]
    print(f"  ITIN/SSN-shaped ids published   {leaked:,}")
    if leaked:
        failures.append(f"{leaked} personal taxpayer IDs reached sponsors.employers")

    # And none may appear in a key either (a rejected EIN must fall through
    # to the opaque name hash, not sit in the path segment).
    cur.execute("""
        SELECT COUNT(*) FROM sponsors.employers
        WHERE key ~ '^[0-9]{9}$' AND left(key, 2) IN ('96','97','09','19','89')
    """)
    leaked_key = cur.fetchone()[0]
    if leaked_key:
        failures.append(f"{leaked_key} personal taxpayer IDs used as identity keys")

    # Reconcile the three largest employers end to end against the raw table.
    # Chosen by volume rather than hardcoded — an earlier version pinned a
    # FEIN that turned out not to exist in this dataset, so the gate failed
    # on its own bad assumption instead of on the data.
    cur.execute("""
        SELECT e.key, e.name, p.n_lca
        FROM sponsors.employers e
        JOIN sponsors.employer_profile p ON p.employer_id = e.id
        ORDER BY p.n_lca DESC LIMIT 3
    """)
    for key, name, profile_n in cur.fetchall():
        # The raw side must resolve identity exactly the way the load did,
        # or this compares two different things and always "passes".
        cur.execute("""
            SELECT COUNT(*) FROM lca_disclosure d
            LEFT JOIN sponsors.fein_map fm
                   ON fm.nm = sponsors.norm_name(d.employer_name)
            WHERE sponsors.emp_key(sponsors.norm_ein(d.employer_fein), fm.fein,
                                   sponsors.norm_name(d.employer_name)) = %s
              AND sponsors.norm_name(d.employer_name) IS NOT NULL
              AND COALESCE(d.decision_date, d.received_date) IS NOT NULL
        """, (key,))
        raw_n = cur.fetchone()[0]
        match = profile_n == raw_n
        print(f"  reconcile {name[:30]:30s} profile={profile_n:>7,} raw={raw_n:>7,} "
              f"{'ok' if match else 'MISMATCH'}")
        if not match:
            failures.append(f"{name}: profile={profile_n:,} vs raw={raw_n:,}")

    cur.close()
    db.close()

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("\nall gates passed. next: python etl/publish.py --dry-run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
