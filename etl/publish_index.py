"""Render the per-employer headline numbers into one downloadable file.

Every API lookup tells this service which employers someone is checking,
and someone checking sponsorship history is telling you they need a visa.
For the one tier where that is avoidable — the headline numbers, 12 fields
per employer — the whole table fits in ~8 MB gzipped, so a client downloads
it once a quarter and answers locally. The API stays for the tiers that
genuinely need a service: jobs, titles, wage benchmarks, and typeahead.

The artifact ships as a GitHub Release asset rather than an R2 object: it
is fetched once per quarter per client, not once per request, and the R2
free tier is budgeted for the ~760k per-request objects publish.py writes.

Usage:
    python etl/publish_index.py                  # -> etl/dist/
    python etl/publish_index.py --out DIR        # write somewhere else
    python etl/publish_index.py --limit 1000     # small run; no pointer file

Then attach the two files to a release — see README, "Downloadable index".
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

# etl/ is a directory of scripts, not a package, so make the sibling
# importable however this file was invoked. build.py duplicates require_env
# "to keep the ETL scripts independent of each other"; this file is the
# deliberate opposite call. It sorts by norm_name and the `s/` search
# buckets bucket by norm_name, so a local lookup and an HTTP search have to
# agree on what a name is. A second copy would drift the way the JS/Python
# pair did before tests/etl/test_parity_contract.py pinned it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from publish import REQUIRED_PG, norm_name, require_env, stream  # noqa: E402

OUT_DIR = ROOT / "etl" / "dist"
GZIP_LEVEL = 6

# The DOL quarter this build covers (docs/DATA.md). Bump it with the data:
# it names the artifact, tags the release, and is what a client compares
# against to decide its local copy is stale.
DATA_QUARTER = "2026Q2"

SQL = """
  SELECT e.key, e.name,
         p.first_year, p.last_year,
         -- The JS consumer resolves `filings.certified ?? filings.lca ?? 0`
         -- against the e/{key}.json tier. Resolving it HERE means the local
         -- file and the HTTP path cannot answer the same question two
         -- different ways. Both columns are NOT NULL today, so this reads
         -- n_certified straight through; the COALESCE is written out anyway
         -- because the guarantee it encodes is the JS one, not the schema's.
         COALESCE(p.n_certified, p.n_lca, 0) AS lca,
         COALESCE(p.n_pwd, 0), COALESCE(p.n_perm, 0),
         p.does_gc,
         p.red_flags -> 'staffing_shop' AS staffing
  FROM sponsors.employers e
  JOIN sponsors.employer_profile p ON p.employer_id = e.id
"""


def record(row) -> dict:
    """One index line, in the column order SQL selects.

    Two-letter field names: the same 12 keys repeat 335,626 times, so their
    text is a real share of the file rather than a rounding error.
    """
    key, name, fy, ly, lca, n_pwd, n_perm, does_gc, staffing = row
    st = staffing or {}
    return {
        "k": key, "n": name, "fy": fy, "ly": ly, "lca": lca,
        "pwd": n_pwd, "perm": n_perm, "gc": bool(does_gc),
        # An employer with no LCA rows has no staffing evidence either way.
        # Absent reads as false/0, which is what the API's red_flags block
        # already reports for the same employer.
        "sv": bool(st.get("value")),
        "sh": st.get("share") or 0,
        "ns": st.get("n_secondary") or 0,
        "nt": st.get("n_total") or 0,
    }


def build(conn, limit: int = 0) -> list[str]:
    """Stream every employer, return the NDJSON lines sorted by
    (norm_name(name), key).

    Sorted is what makes a scan-based local lookup honest: a client reading
    the file top to bottom knows when it has passed the name it wants. Sort
    on the normalized name so that order matches the `s/` search buckets,
    and break ties on key, because distinct employers do share a normalized
    name (README, "name variants stay split") and an unstable tie would
    change the bytes between two builds of identical data.
    """
    rows: list[tuple[str, str, str]] = []
    for row in stream(conn, SQL, "empindex"):
        rows.append((
            norm_name(row[1]), row[0],
            json.dumps(record(row), separators=(",", ":"), ensure_ascii=False),
        ))
        if limit and len(rows) >= limit:
            break
    rows.sort(key=lambda t: (t[0], t[1]))
    return [line for _, _, line in rows]


def write(lines: list[str], out_dir: Path, built_at: str, limit: int = 0) -> dict:
    """Write index-<version>.ndjson.gz (+ the pointer) and return the pointer."""
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = f"index-{DATA_QUARTER}.ndjson.gz"
    path = out_dir / filename

    raw = 0
    with open(path, "wb") as f:
        # filename="" and mtime=0: the gzip header otherwise carries the
        # source name and the build clock, so two builds of identical data
        # would differ in bytes and every client would re-download for
        # nothing. GzipFile picks the name off fileobj.name unless told not to.
        with gzip.GzipFile(filename="", mode="wb", compresslevel=GZIP_LEVEL,
                           fileobj=f, mtime=0) as gz:
            for line in lines:
                buf = line.encode("utf-8") + b"\n"
                raw += len(buf)
                gz.write(buf)

    # Hash what actually landed on disk rather than what we meant to write:
    # the sha256 in the pointer is what a client verifies its download against.
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)

    pointer = {
        "version": DATA_QUARTER,
        "built_at": built_at,
        "employers": len(lines),
        "bytes": path.stat().st_size,
        "sha256": h.hexdigest(),
        "filename": filename,
    }

    # Same rule as publish.py's manifest: a --limit run is a partial artifact,
    # and the pointer is what declares a build releasable. Without it the
    # release recipe has nothing to read, so a smoke test cannot be shipped
    # by accident.
    if limit:
        print("limit run: pointer not written")
    else:
        (out_dir / "index-latest.json").write_text(
            json.dumps(pointer, indent=2) + "\n", encoding="utf-8")

    print(f"{path}")
    print(f"  employers: {pointer['employers']:,}")
    print(f"  raw:       {raw / (1024 * 1024):,.2f} MiB")
    print(f"  gzip:      {pointer['bytes'] / (1024 * 1024):,.2f} MiB")
    print(f"  sha256:    {pointer['sha256']}")
    return pointer


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=str(OUT_DIR), metavar="DIR")
    ap.add_argument("--limit", type=int, default=0, metavar="N",
                    help="stop after N employers; the result is partial, so "
                         "index-latest.json is not written")
    return ap.parse_args()


def main() -> int:
    load_dotenv(ROOT / ".env")
    args = parse_args()
    require_env(REQUIRED_PG)

    conn = psycopg2.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        dbname=os.environ.get("SOURCE_DB", "lca"),
    )

    print("employers + profiles ...", flush=True)
    lines = build(conn, args.limit)
    with conn.cursor() as cur:
        # Same clock publish.py stamps meta.json with, so a client can line
        # the index up against /healthz.
        cur.execute("SELECT now()")
        built_at = cur.fetchone()[0].isoformat()
    conn.close()

    write(lines, Path(args.out), built_at, args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
