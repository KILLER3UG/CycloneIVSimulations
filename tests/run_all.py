"""One-command QA run: python tests/run_all.py

Runs EVERYTHING under tests/:
  1. the pytest unit suite (tests/test_*.py), and
  2. every registered QA case against the real backend (GHDL),
then writes tests/RESULTS.md and exits non-zero if anything failed.
Optional: --filter SUBSTRING (QA cases only, skips the unit suite),
--skip-units, --verbose, --jobs N (default min(8, cpu_count)), --timing,
--fail-fast.  Mutation tooling (tests/qa/mutation.py) and the soak
(tests/qa/soak.py) stay separate on purpose.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
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
    "test_audit_board",
    "test_audit_polarity",
    "test_audit_qsf",
    "test_audit_open_drain",
    "test_audit_protocols",
    "test_audit_robustness",
    "test_audit_e2e",
    "test_qa_semantics",
    "test_qa_pinmap",
    "test_qa_peripherals",
    "test_qa_protocols",
    "test_qa_scaling",
    "test_qa_determinism",
    "test_qa_robustness",
    "test_qa_differential",
    "test_qa_qsf",
]

# Remember which module registered which case, so parallel workers can import
# exactly the module they need (Windows spawn: plain strings cross processes).
CASE_MODULES = {}
for name in MODULES:
    registered_before = len(harness.CASES)
    try:
        __import__(name)
    except ModuleNotFoundError as exc:
        if exc.name == name:
            continue
        raise
    for registered in harness.CASES[registered_before:]:
        CASE_MODULES[registered.id] = name


def run_unit_tests() -> tuple[bool, str]:
    """Run the pytest unit suite (tests/test_*.py).

    Returns (ok, summary).  tests/qa/ is ignored: its test_*.py modules are
    harness case definitions (no pytest-collectable tests) and importing them
    here would only duplicate the registration above.
    """
    cmd = [sys.executable, "-m", "pytest", str(ROOT / "tests"),
           "--ignore", str(HERE / "qa"), "-p", "no:cacheprovider"]
    proc = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, text=True)
    out = proc.stdout or ""
    passed = re.findall(r"(\d+) passed", out)
    failed = re.findall(r"(\d+) failed", out)
    errors = re.findall(r"(\d+) error", out)
    summary = f"Units: {passed[0] if passed else '?'} passed (pytest tests/)"
    if failed or errors or proc.returncode != 0:
        tail = "\n".join(out.splitlines()[-40:])
        print(tail, file=sys.stderr)
        if proc.stderr:
            print(proc.stderr[-2000:], file=sys.stderr)
        return False, summary + (f"; {failed[0]} FAILED" if failed else "; FAILED")
    return True, summary


if __name__ == "__main__":
    argv = sys.argv[1:]
    # A --filter run targets one QA case; the unit suite is not needed there.
    skip_units = "--skip-units" in argv or "--filter" in argv
    units_ok = True
    extra_header = None
    if skip_units:
        extra_header = ["Units: skipped (--skip-units/--filter)"]
    else:
        units_ok, units_summary = run_unit_tests()
        print(units_summary)
        extra_header = [units_summary]
    qa_code = harness.main(argv, modules=MODULES, case_modules=CASE_MODULES,
                           extra_header=extra_header)
    raise SystemExit(qa_code if units_ok else 1)
