"""Pin the JS/Python parity contracts by reading the sibling source files
directly. The prior "must match" comment was enforceable by review only;
one accidental edit to either side would silently break search.
"""

import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
spec = importlib.util.spec_from_file_location("publish", ROOT / "etl" / "publish.py")
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


def test_max_prefix_depth_matches_worker():
    src = (ROOT / "worker" / "r2.ts").read_text(encoding="utf-8")
    m = re.search(r"MAX_PREFIX_DEPTH\s*=\s*(\d+)\s*;", src)
    assert m, "MAX_PREFIX_DEPTH declaration not found in worker/r2.ts"
    ts_depth = int(m.group(1))
    assert publish.MAX_PREFIX_DEPTH == ts_depth, (
        f"MAX_PREFIX_DEPTH out of sync: publish.py={publish.MAX_PREFIX_DEPTH} "
        f"vs worker/r2.ts={ts_depth}. Update both."
    )


def test_search_cap_documented_matches_source():
    # SEARCH_CAP is Python-side only, but the worker's serveFirst honors
    # whatever the publisher emits per-bucket. Sanity-check the constant
    # against its use so a rename can't drift silently.
    src = (ROOT / "etl" / "publish.py").read_text(encoding="utf-8")
    assert re.search(r"\bSEARCH_CAP\s*=\s*50\b", src)
