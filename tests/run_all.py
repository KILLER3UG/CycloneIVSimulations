"""One-command QA run: python tests/run_all.py

Runs every registered case against the real backend, writes tests/RESULTS.md,
and exits non-zero if any case fails.  Optional: --filter SUBSTRING, --verbose.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "qa"))

import harness  # noqa: E402

# Importing a module registers its cases.
MODULES = [
    "test_baseline",
    "test_inputs_outputs",
    "test_hdl_coverage",
    "test_blocks",
    "test_engine_ui",
    "test_fidelity",
    "test_spec_fidelity",
]

for name in MODULES:
    try:
        __import__(name)
    except ModuleNotFoundError as exc:
        if exc.name == name:
            continue
        raise

if __name__ == "__main__":
    raise SystemExit(harness.main(sys.argv[1:]))