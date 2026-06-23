#!/usr/bin/env python
"""Refresh the local D1 export used by classifier.ipynb.

Run this as a STANDALONE process (terminal, or a scheduled task), NOT from
inside Jupyter. Spawning wrangler (Node) from the Jupyter kernel on Windows
crashes libuv with 0xC0000409; a normal Python process has no such problem.

It queries the remote D1 database via wrangler and writes a flat list of row
dicts to train/data/submissions.json, the exact format cell-6 of the notebook
expects.

Usage:
    python refresh_data.py            # from the train/ directory
Exit codes:
    0 success, non-zero on any failure (so a scheduler can detect problems).
"""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # .../metric-glance/train
COLLECT_DIR = (HERE / ".." / "collect").resolve()
DATA_DIR = HERE / "data"
EXPORT_FILE = DATA_DIR / "submissions.json"

# Column subset the notebook uses. install_id is included so corrections can be
# weighted per install (trusted installs count for more); it is a random
# per-install id, not PII. Still omitted: dedup_key, title, received_at.
SQL = (
    "SELECT id, install_id, label, tier, span, num, unit, unit_id, "
    "before_ctx, after_ctx, sentence, heading, tag, "
    "page_units, span_start, span_end, "
    "interacted, seen, url, lang, locale, client_ts "
    "FROM submissions ORDER BY id"
)


def main() -> int:
    if not COLLECT_DIR.is_dir():
        print(f"ERROR: collect/ not found at {COLLECT_DIR}", file=sys.stderr)
        return 2

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    # shell=True so Windows resolves the npx.cmd shim. This is a normal Python
    # process, so Node does not hit the Jupyter-only libuv crash.
    proc = subprocess.run(
        f'npx wrangler d1 execute metric-glance --remote --json --command "{SQL}"',
        cwd=str(COLLECT_DIR),
        shell=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        stdin=subprocess.DEVNULL,
    )
    if proc.returncode != 0:
        print(f"ERROR: wrangler exited {proc.returncode}", file=sys.stderr)
        print(proc.stderr, file=sys.stderr)
        return proc.returncode or 1

    try:
        rows = json.loads(proc.stdout)[0]["results"]
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        print(f"ERROR: could not parse wrangler output: {e}", file=sys.stderr)
        print(proc.stdout[:500], file=sys.stderr)
        return 3

    # Atomic write: write to a temp file, then replace, so a crash mid-write
    # never leaves a half-written submissions.json for the notebook to read.
    tmp = EXPORT_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    tmp.replace(EXPORT_FILE)

    print(f"OK: wrote {len(rows):,} rows to {EXPORT_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
