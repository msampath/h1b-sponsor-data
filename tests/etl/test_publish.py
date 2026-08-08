"""Tests for etl/publish.py — the pure logic and the Publisher's upload
accounting, driven through a fake S3 client. No network, no database."""

import importlib.util
import json
import sys
from decimal import Decimal
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
spec = importlib.util.spec_from_file_location("publish", ROOT / "etl" / "publish.py")
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


# ── name normalization: MUST match worker/r2.ts (vectors duplicated there) ──
@pytest.mark.parametrize("raw,want", [
    ("Google LLC", "google llc"),
    ("  Ernst  &  Young  ", "ernst  young"),
    ("Café Corp", "caf corp"),
    ("3M Company", "3m company"),
    ("A&B", "ab"),
    ("O'Neill Inc", "oneill inc"),
    ("A\u00a0B", "a b"),    # NBSP is JS whitespace -> space
    ("A\u0085B", "ab"),     # NEL is NOT JS whitespace -> stripped
    ("A\u001cB", "ab"),     # FS is NOT JS whitespace -> stripped
    ("", ""),
])
def test_norm_name_parity(raw, want):
    assert publish.norm_name(raw) == want


def test_prefixes_tiers():
    assert publish.prefixes("Google") == ["go", "goo"]
    assert publish.prefixes("AB") == ["ab"]
    assert publish.prefixes("X") == []


def test_to_num_decimal_becomes_float_not_string():
    # The bug this pins: default=str serialized numeric(12,2) as "123456.00".
    out = json.loads(json.dumps(
        {"w": publish.to_num(Decimal("123456.00")), "n": publish.to_num(7)},
    ))
    assert out == {"w": 123456.0, "n": 7}
    assert isinstance(out["w"], float)


# ── tiered search buckets ────────────────────────────────────────────────
def test_tiered_buckets_emit_deeper_only_on_overflow():
    cap = 3
    # 5 employers share prefix "abc" (> cap) and 2 share "xyz" (<= cap).
    entries = [(f"abc{i} corp", (10 - i, f"k{i}")) for i in range(5)]
    entries += [("xyz one", (5, "x1")), ("xyz two", (4, "x2"))]
    tiers = publish.tiered_buckets(entries, sort_key=lambda p: (-p[0], p[1]), cap=cap)
    # depth-4 buckets exist under the overflowing "abc"...
    assert "abc0" in tiers and "abc4" in tiers
    # ...but not under "xyz", which fits its bucket
    assert not any(k.startswith("xyz") and len(k) > 3 for k in tiers)
    # members are sorted by the provided key
    assert [p[1] for p in tiers["abc"]] == ["k0", "k1", "k2", "k3", "k4"]


def test_tiered_buckets_respect_max_depth():
    cap = 1
    entries = [(f"aaaaaaaa{i}", (i, str(i))) for i in range(3)]
    tiers = publish.tiered_buckets(entries, sort_key=lambda p: p[0], cap=cap, max_depth=4)
    assert max(len(k) for k in tiers) == 4


# ── Publisher accounting through a fake client ───────────────────────────
class FakeClient:
    def __init__(self, fail_keys=()):
        self.objects = {}
        self.deleted = []
        self.fail_keys = set(fail_keys)
        self.put_calls = 0

    def put_object(self, Bucket, Key, Body, ContentType):
        self.put_calls += 1
        if Key in self.fail_keys:
            raise RuntimeError("transient")
        self.objects[Key] = Body

    def delete_objects(self, Bucket, Delete):
        self.deleted += [o["Key"] for o in Delete["Objects"]]


def make_publisher(**kw):
    p = publish.Publisher(dry_run=False, force=False, **kw)
    p.client = FakeClient()
    p.bucket = "test"
    return p


def test_manifest_dedup_skips_unchanged():
    p = make_publisher()
    data = b'{"a":1}'
    import hashlib
    p.manifest = {"k.json": hashlib.sha256(data).hexdigest()}
    p.put("k.json", data)
    p.finish()
    assert p.n_uploaded == 0
    assert "k.json" not in p.client.objects  # nothing re-uploaded


def test_finish_deletes_stale_keys_and_writes_manifest():
    p = make_publisher()
    p.manifest = {"old.json": "deadbeef"}
    p.put("new.json", b"{}")
    p.finish()
    assert p.client.deleted == ["old.json"]
    manifest = json.loads(p.client.objects[publish.MANIFEST_KEY])
    assert set(manifest) == {"new.json"}


def test_failed_upload_excluded_from_manifest_single_attempt():
    p = make_publisher()
    p.client.fail_keys = {"bad.json"}
    p.put("bad.json", b"{}")
    p.put("good.json", b"{}")
    p.finish()
    manifest = json.loads(p.client.objects[publish.MANIFEST_KEY])
    assert "good.json" in manifest and "bad.json" not in manifest
    # one attempt in flush + one re-pass in finish — never a 5x sleep loop
    bad_attempts = p.client.put_calls - 2  # good.json + manifest
    assert bad_attempts == 2


def test_limit_run_never_touches_manifest_or_deletes():
    p = make_publisher(limit=1)
    p.manifest = {"keep.json": "aa"}
    p.put("one.json", b"{}")
    p.put("two.json", b"{}")   # ignored: over limit
    p.finish()
    assert p.n_objects == 1
    assert publish.MANIFEST_KEY not in p.client.objects
    assert p.client.deleted == []


def test_resume_skips_existing_bucket_keys():
    p = make_publisher(resume=True)
    p.existing = {"already.json"}
    p.put("already.json", b"{}")
    p.put("fresh.json", b"{}")
    p.finish()
    assert "already.json" not in p.client.objects
    assert "fresh.json" in p.client.objects
    # but BOTH are claimed in the manifest (they exist in the bucket)
    manifest = json.loads(p.client.objects[publish.MANIFEST_KEY])
    assert set(manifest) == {"already.json", "fresh.json"}


def test_dry_run_with_resume_is_rejected():
    argv = sys.argv
    sys.argv = ["publish.py", "--dry-run", "--resume"]
    try:
        with pytest.raises(SystemExit):
            publish.parse_args()
    finally:
        sys.argv = argv
