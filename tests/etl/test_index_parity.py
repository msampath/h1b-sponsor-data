"""Hold etl/publish_index.py against etl/publish.py.

Two publishers now read the same employer columns: publish.py renders them
into the `e/{key}.json` object the Worker serves, publish_index.py renders
them into the line a client scans locally. Nothing in either file makes the
other break when one drifts, so the guard is here. Same shape as
test_publish.py: no network, no database.
"""

import gzip
import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent

spec = importlib.util.spec_from_file_location("publish", ROOT / "etl" / "publish.py")
publish = importlib.util.module_from_spec(spec)
# Registered BEFORE publish_index loads: its `from publish import norm_name`
# has to resolve to this module object, or test_index_imports_norm_name
# compares two separately-loaded copies and can never fail.
sys.modules["publish"] = publish
spec.loader.exec_module(publish)

spec = importlib.util.spec_from_file_location(
    "publish_index", ROOT / "etl" / "publish_index.py")
publish_index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish_index)


# ── row fixtures ─────────────────────────────────────────────────────────
def emp_row(key="204938068", name="Amazon Web Services, Inc.", eid=1,
            ein="204938068", fy=2019, ly=2026, n_lca=24611, n_cert=24611,
            n_pwd=4313, n_perm=3828, does_gc=True, red_flags=None):
    """A row in the column order etl/publish.py's employer query selects."""
    return (eid, key, ein, name, fy, ly, n_lca, n_cert,
            0, 0, 0,            # certified_withdrawn, denied, withdrawn
            0, 0, 0,            # new, transfer, continued
            n_pwd, n_perm, does_gc, None,
            None, None, None, None, None, red_flags)


def index_row(row):
    """Project a publish.py employer row into the row publish_index's SQL
    hands to record(). This is that SQL transcribed: COALESCE takes the
    first non-NULL, and `red_flags -> 'staffing_shop'` is SQL NULL when the
    column is NULL or the key is absent (psycopg2 -> None)."""
    (_eid, key, _ein, name, fy, ly, n_lca, n_cert, _cw, _den, _wd,
     _new, _tr, _cont, n_pwd, n_perm, does_gc, _wvp,
     _gcy, _gcs, _sy, _trend, _lvl, red_flags) = row

    def coalesce(*vals):
        return next((v for v in vals if v is not None), None)

    return (key, name, fy, ly,
            coalesce(n_cert, n_lca, 0),
            coalesce(n_pwd, 0), coalesce(n_perm, 0),
            does_gc,
            (red_flags or {}).get("staffing_shop"))


def consumer_lca(filings):
    """`filings.certified ?? filings.lca ?? 0`, the JS consumer's precedence,
    transcribed. `??` falls through on null/undefined only and never on 0,
    which is why a GC-only employer (certified = 0) resolves to 0 on both
    sides rather than falling through to lca."""
    if filings["certified"] is not None:
        return filings["certified"]
    if filings["lca"] is not None:
        return filings["lca"]
    return 0


def staffing_block(value=False, share=0.02, n_secondary=512, n_total=24611):
    return {"value": value, "basis": "secondary_entity_share", "share": share,
            "n_secondary": n_secondary, "n_total": n_total}


SAMPLE = {
    "large lca employer": emp_row(red_flags={"staffing_shop": staffing_block()}),
    "staffing shop": emp_row(
        key="731375130", name="Infosys Limited", n_lca=5002, n_cert=4300,
        red_flags={"staffing_shop": staffing_block(
            value=True, share=0.87, n_secondary=4351, n_total=5002)}),
    # 42% of the universe: GC filings, zero LCA rows. certified is 0, not
    # NULL, so `??` must NOT fall through to lca here.
    "gc only": emp_row(key="n-3f9a1c2d4e5b6789", name="Willow Creek Dental PC",
                       ein=None, n_lca=0, n_cert=0, n_pwd=3, n_perm=2,
                       red_flags={"staffing_shop": staffing_block(
                           share=0, n_secondary=0, n_total=0)}),
    # certified diverges from lca once denials and withdrawals exist
    "partly denied": emp_row(key="112233445", name="Bright Path Systems LLC",
                             n_lca=900, n_cert=812,
                             red_flags={"staffing_shop": staffing_block(
                                 n_secondary=10, n_total=900)}),
    "no red_flags column": emp_row(key="998877665", name="Quiet Fields Inc",
                                   does_gc=False, n_pwd=0, n_perm=0,
                                   red_flags=None),
    "red_flags without staffing": emp_row(
        key="556677889", name="Northwind Labs", does_gc=False,
        n_pwd=0, n_perm=0, red_flags={"h1b_dependent": {"value": True}}),
    # normalization-sensitive name: BOM and NBSP both matter to norm_name
    "odd name": emp_row(key="n-aa11bb22cc33dd44",
                        name="﻿Café  Corp", ein=None,
                        n_lca=4, n_cert=4),
}


# ── the guard: same employer, same answer on both sides ──────────────────
@pytest.mark.parametrize("label", sorted(SAMPLE))
def test_index_record_matches_employer_object(label):
    row = SAMPLE[label]
    doc = publish.employer_doc(row, has_jobs=set(), has_titles=set())
    rec = publish_index.record(index_row(row))

    assert rec["k"] == doc["employer"]["id"]
    assert rec["n"] == doc["employer"]["name"]
    assert rec["fy"] == doc["years"]["first"]
    assert rec["ly"] == doc["years"]["last"]
    # The whole reason the index resolves the COALESCE at build time.
    assert rec["lca"] == consumer_lca(doc["filings"])
    assert rec["pwd"] == doc["green_card"]["pwd"]
    assert rec["perm"] == doc["green_card"]["perm"]
    assert rec["gc"] == (doc["green_card"]["evidence"] == "present")

    st = doc["red_flags"].get("staffing_shop") or {}
    assert rec["sv"] == bool(st.get("value"))
    assert rec["sh"] == (st.get("share") or 0)
    assert rec["ns"] == (st.get("n_secondary") or 0)
    assert rec["nt"] == (st.get("n_total") or 0)


def test_gc_only_employer_does_not_fall_through_to_lca():
    """The one case where `??` and `||` disagree. If either side ever
    switches to a falsy-coalesce, a GC-only employer reports its LCA count
    in the certified slot on one path and 0 on the other."""
    row = SAMPLE["gc only"]
    doc = publish.employer_doc(row, has_jobs=set(), has_titles=set())
    assert doc["filings"]["certified"] == 0
    assert publish_index.record(index_row(row))["lca"] == 0


def test_record_fields_are_exactly_the_documented_twelve():
    """The field list is published in README and docs/DATA.md, and a client
    parses it positionally-by-name. Adding a key is a format change."""
    rec = publish_index.record(index_row(SAMPLE["large lca employer"]))
    assert set(rec) == {"k", "n", "fy", "ly", "lca", "pwd", "perm", "gc",
                        "sv", "sh", "ns", "nt"}


# ── normalization parity (the reason norm_name is imported) ──────────────
def test_index_imports_norm_name_rather_than_reimplementing_it():
    assert publish_index.norm_name is publish.norm_name


def test_index_sql_resolves_the_consumer_precedence():
    """Source-level pin, same idea as test_parity_contract.py: the COALESCE
    order IS the contract, and it is invisible to the value tests above
    because they transcribe it."""
    assert re.search(r"COALESCE\(p\.n_certified,\s*p\.n_lca,\s*0\)",
                     publish_index.SQL)


def test_lines_sorted_by_norm_name_then_key(monkeypatch):
    rows = [index_row(r) for r in SAMPLE.values()]
    # Same normalized name, different keys: pins the tie-break, which is
    # what keeps two builds of identical data byte-identical.
    rows.append(("111111111", "Quiet Fields Inc", 2020, 2024, 1, 0, 0, False, None))
    monkeypatch.setattr(publish_index, "stream", lambda conn, sql, name: iter(rows))

    lines = publish_index.build(conn=None)
    got = [(json.loads(ln)["n"], json.loads(ln)["k"]) for ln in lines]
    want = sorted(((r[1], r[0]) for r in rows),
                  key=lambda t: (publish.norm_name(t[0]), t[1]))
    assert got == want


def test_limit_stops_the_stream(monkeypatch):
    rows = [index_row(r) for r in SAMPLE.values()]
    monkeypatch.setattr(publish_index, "stream", lambda conn, sql, name: iter(rows))
    assert len(publish_index.build(conn=None, limit=2)) == 2


# ── artifact shape ───────────────────────────────────────────────────────
def test_gzip_bytes_reproducible_across_builds(tmp_path, monkeypatch):
    """mtime=0 and an empty filename header: identical data must produce
    identical bytes, or every client re-downloads 8 MB for a rebuild that
    changed nothing."""
    rows = [index_row(r) for r in SAMPLE.values()]
    monkeypatch.setattr(publish_index, "stream", lambda conn, sql, name: iter(rows))
    lines = publish_index.build(conn=None)

    a = publish_index.write(lines, tmp_path / "a", "2026-01-01T00:00:00+00:00")
    b = publish_index.write(lines, tmp_path / "b", "2099-12-31T23:59:59+00:00")

    assert a["sha256"] == b["sha256"]
    assert a["bytes"] == b["bytes"]
    assert ((tmp_path / "a" / a["filename"]).read_bytes()
            == (tmp_path / "b" / b["filename"]).read_bytes())

    # and it really is NDJSON, one line per employer
    raw = gzip.decompress((tmp_path / "a" / a["filename"]).read_bytes())
    decoded = [json.loads(ln) for ln in raw.decode("utf-8").splitlines()]
    assert len(decoded) == a["employers"] == len(rows)


def test_pointer_describes_the_file_on_disk(tmp_path, monkeypatch):
    rows = [index_row(r) for r in SAMPLE.values()]
    monkeypatch.setattr(publish_index, "stream", lambda conn, sql, name: iter(rows))
    ptr = publish_index.write(publish_index.build(conn=None), tmp_path, "t0")

    written = json.loads((tmp_path / "index-latest.json").read_text(encoding="utf-8"))
    assert written == ptr
    assert ptr["version"] == publish_index.DATA_QUARTER
    assert ptr["filename"] == f"index-{publish_index.DATA_QUARTER}.ndjson.gz"
    assert ptr["bytes"] == (tmp_path / ptr["filename"]).stat().st_size


def test_limit_run_writes_no_pointer(tmp_path, monkeypatch):
    """Same rule as publish.py's manifest: a partial artifact must not be
    releasable, and the pointer is what the release recipe reads."""
    rows = [index_row(r) for r in SAMPLE.values()]
    monkeypatch.setattr(publish_index, "stream", lambda conn, sql, name: iter(rows))
    publish_index.write(publish_index.build(conn=None, limit=2), tmp_path, "t0", limit=2)
    assert not (tmp_path / "index-latest.json").exists()
