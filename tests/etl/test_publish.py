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
    ("\ufeffacme corp", "acme corp"),   # leading BOM: JS trim() strips, must match
    ("acme corp\ufeff", "acme corp"),   # trailing BOM too
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


def test_tiered_buckets_exact_name_not_duplicated_in_tail():
    """Opus review: promoting an exact-name from tail to head must strip it
    from tail too, or the emitted payload list carries the same object at
    two indexes (and `total` is inflated)."""
    cap = 3
    entries = [(f"abcxx{i}", (100 - i, f"k{i}")) for i in range(5)]
    entries.append(("abc", (1, "kabc")))
    tiers = publish.tiered_buckets(entries, sort_key=lambda p: (-p[0], p[1]), cap=cap)
    payloads = tiers["abc"]
    kabc_count = sum(1 for p in payloads if p[1] == "kabc")
    assert kabc_count == 1, f"kabc appeared {kabc_count}x in the emitted bucket"
    # And the exact-name IS in the head (cap slice), which is the whole point.
    head_names = [p[1] for p in payloads[:cap]]
    assert "kabc" in head_names


def test_tiered_buckets_exact_name_always_reachable():
    """A member whose name equals its bucket's prefix cannot descend to a
    deeper tier (deeper tiers only admit strictly longer names). It must
    appear inside the [:cap] slice of its own-prefix bucket, or typing the
    exact full name returns the capped top-N without it."""
    cap = 3
    # Bucket "abc": five higher-volume names PLUS the short 3-char name
    # itself with volume 1 — without the exact-name fix, "abc" would be
    # slice-ranked below the top-3 and vanish from search.
    entries = [(f"abcxx{i}", (100 - i, f"k{i}")) for i in range(5)]
    entries.append(("abc", (1, "kabc")))
    tiers = publish.tiered_buckets(entries, sort_key=lambda p: (-p[0], p[1]), cap=cap)
    head = tiers["abc"][:cap]
    assert ("kabc",) in [(t[1],) for t in head] or any(t[1] == "kabc" for t in head), \
        "exact-name 'abc' fell outside the emitted head of bucket 'abc'"


# ── Publisher accounting through a fake client ───────────────────────────
class FakeClient:
    def __init__(self, fail_keys=(), delete_fail_keys=(), delete_fail_max=None):
        self.objects = {}
        self.deleted = []
        self.fail_keys = set(fail_keys)
        # delete_fail_keys returns an Errors entry (mirrors R2's 200-with-
        # Errors behaviour); delete_fail_max, when set, caps how many times
        # a given key fails so we can exercise the retry-succeeds path.
        self.delete_fail_keys = set(delete_fail_keys)
        self.delete_fail_max = delete_fail_max
        self.delete_attempts: dict = {}
        self.put_calls = 0

    def put_object(self, Bucket, Key, Body, ContentType):
        self.put_calls += 1
        if Key in self.fail_keys:
            raise RuntimeError("transient")
        self.objects[Key] = Body

    def delete_objects(self, Bucket, Delete):
        errors = []
        for o in Delete["Objects"]:
            k = o["Key"]
            n = self.delete_attempts.get(k, 0) + 1
            self.delete_attempts[k] = n
            if k in self.delete_fail_keys and (
                self.delete_fail_max is None or n <= self.delete_fail_max
            ):
                errors.append({"Key": k, "Code": "InternalError", "Message": "x"})
            else:
                self.deleted.append(k)
                self.objects.pop(k, None)
        return {"Errors": errors} if errors else {}


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


@pytest.mark.parametrize("flags", [
    ["--force", "--include-prefix", "s/"],
    ["--force", "--resume"],
])
def test_argparse_rejects_dangerous_flag_pairs(flags):
    """Both pairs would silently destroy dedup state or waste ops."""
    argv = sys.argv
    sys.argv = ["publish.py", *flags]
    try:
        with pytest.raises(SystemExit):
            publish.parse_args()
    finally:
        sys.argv = argv


# ── --include-prefix semantics ───────────────────────────────────────────
def test_include_prefix_carries_forward_deferred_stale_digest():
    """Key that dropped from the DB but is outside the include filter must
    keep its OLD manifest digest, so the next unfiltered publish still sees
    it in `stale` and can delete it."""
    p = make_publisher(include=("s/",))
    p.manifest = {"s/old.json": "aa",       # in scope, dropped -> should delete
                  "e/x.json": "bb"}         # out of scope, dropped -> carry
    p.put("s/keep.json", b"{}")             # in scope, new
    p.finish()
    manifest = json.loads(p.client.objects[publish.MANIFEST_KEY])
    assert manifest["e/x.json"] == "bb", "out-of-scope digest was orphaned"
    assert "s/old.json" not in manifest, "in-scope stale was not deleted"
    assert "s/keep.json" in manifest
    assert p.client.deleted == ["s/old.json"]


def test_include_prefix_common_path_put_still_preserves_digest():
    """Sonnet review: the frequent path is a key that IS produced this run
    but falls outside --include-prefix. put() must keep its OLD digest and
    upload nothing. The finish() branch only fires when the key drops from
    the DB entirely, which is far less common."""
    p = make_publisher(include=("s/",))
    p.manifest = {"e/x.json": "old-digest"}
    p.put("s/keep.json", b"{}")
    # Same key as in the manifest, but the DB still produces it — put() gets
    # called this time (unlike the finish-branch case).
    p.put("e/x.json", b'{"new": true}')
    p.finish()
    # Neither uploaded nor deleted; old digest preserved.
    assert "e/x.json" not in p.client.objects
    assert p.client.deleted == []
    manifest = json.loads(p.client.objects[publish.MANIFEST_KEY])
    assert manifest["e/x.json"] == "old-digest"


def test_meta_object_count_after_failure_excludes_failed_keys():
    """Sonnet #1: meta.json's `objects` count must reflect the *served*
    manifest, not the run-local next_manifest that still contains failed
    keys before finish() strips them."""
    p = make_publisher()
    p.client.fail_keys = {"bad.json"}
    p.put("bad.json", b"{}")
    p.put("good.json", b"{}")
    p.finish()
    # main()'s pattern: len(next_manifest) after finish() should exclude bad.
    assert "bad.json" not in p.next_manifest
    # meta.json emission wrapper (same shape main() uses)
    old_include, p.include = p.include, ()
    old_force, p.force = p.force, True
    p.put("meta.json", publish.body({"ok": True, "objects": len(p.next_manifest) + 1}))
    p.flush()
    p.include, p.force = old_include, old_force
    doc = json.loads(p.client.objects["meta.json"])
    assert doc["objects"] == 2  # good.json + meta itself, NOT 3


def test_include_prefix_does_not_delete_out_of_scope_keys():
    p = make_publisher(include=("s/",))
    p.manifest = {"e/x.json": "bb"}
    p.put("s/keep.json", b"{}")
    p.finish()
    assert "e/x.json" not in p.client.deleted


def test_delete_failure_keeps_manifest_entry_for_retry_next_run():
    """A delete that fails permanently must not have its manifest entry
    dropped, or the key becomes an undeletable orphan (same class as the
    stale-forever defect the deletion pass exists to prevent)."""
    p = make_publisher()
    p.manifest = {"stale.json": "aa"}
    p.client.delete_fail_keys = {"stale.json"}
    # delete_fail_max=None -> fails forever, both attempts inside finish()
    p.put("new.json", b"{}")
    p.finish()
    manifest = json.loads(p.client.objects[publish.MANIFEST_KEY])
    assert manifest["stale.json"] == "aa", "undeletable key was orphaned"
    assert p.n_deleted == 0


def test_delete_failure_retried_and_succeeds():
    p = make_publisher()
    p.manifest = {"stale.json": "aa"}
    p.client.delete_fail_keys = {"stale.json"}
    p.client.delete_fail_max = 1        # transient: first call fails, retry wins
    p.put("new.json", b"{}")
    p.finish()
    manifest = json.loads(p.client.objects[publish.MANIFEST_KEY])
    assert "stale.json" not in manifest
    assert p.n_deleted == 1


def test_meta_object_count_equals_final_manifest_size():
    """meta.json's `objects` must reflect the served state, not the run-local
    counter, so /healthz never advertises a partial or stale count."""
    p = make_publisher()
    p.put("a.json", b"{}")
    p.put("b.json", b"{}")
    # emulate what main() does around meta.json
    p.finish()
    old_include, p.include = p.include, ()
    old_force, p.force = p.force, True
    p.put("meta.json", publish.body({"ok": True, "objects": len(p.next_manifest) + 1}))
    p.flush()
    p.include, p.force = old_include, old_force
    doc = json.loads(p.client.objects["meta.json"])
    assert doc["objects"] == 3    # a + b + meta itself
