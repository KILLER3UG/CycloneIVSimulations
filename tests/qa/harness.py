"""Repeatable QA harness for the Cyclone IV simulator.

Every case executes the real backend (GHDL) and records observed evidence.
Run everything with::

    python tests/run_all.py

The runner writes ``tests/RESULTS.md`` (evidence table) and prints a summary.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from backend.simulator import SimulationRequest, Simulator  # noqa: E402

DESIGNS = Path(__file__).resolve().parent / "designs"

_SIMULATOR: Optional[Simulator] = None


def simulator() -> Simulator:
    global _SIMULATOR
    if _SIMULATOR is None:
        _SIMULATOR = Simulator()
    return _SIMULATOR


# ---------------------------------------------------------------------------
# Case registry
# ---------------------------------------------------------------------------


@dataclass
class Case:
    id: str
    section: str
    description: str
    language: str
    expected: str
    fn: Callable[[], str]
    actual: str = ""
    passed: bool = False
    error: str = ""
    seconds: float = 0.0


CASES: List[Case] = []


def case(identifier: str, section: str, description: str, language: str, expected: str):
    def register(fn: Callable[[], str]) -> Callable[[], str]:
        CASES.append(
            Case(
                id=identifier,
                section=section,
                description=description,
                language=language,
                expected=expected,
                fn=fn,
            )
        )
        return fn

    return register


class CheckError(AssertionError):
    pass


def check(condition: Any, actual: str) -> None:
    if not condition:
        raise CheckError(actual)


# ---------------------------------------------------------------------------
# Simulation helpers
# ---------------------------------------------------------------------------


def source(name: str) -> str:
    return (DESIGNS / name).read_text(encoding="utf-8")


def run(name: str, **options: Any) -> Dict[str, Any]:
    """Simulate a design file with the real backend."""
    payload = {"vhdl": source(name)}
    payload.update(options)
    return simulator().simulate(SimulationRequest.from_dict(payload))


def run_text(vhdl: str, **options: Any) -> Dict[str, Any]:
    payload = {"vhdl": vhdl}
    payload.update(options)
    return simulator().simulate(SimulationRequest.from_dict(payload))


def run_tb(design: str, testbench: str, top: str, **options: Any) -> Dict[str, Any]:
    """Simulate a design file together with a custom testbench file."""
    payload = {"vhdl": source(design), "testbench": source(testbench), "top": top}
    payload.update(options)
    return simulator().simulate(SimulationRequest.from_dict(payload))


def compile_text(vhdl: str, top: Optional[str] = None, files: Optional[List[dict]] = None,
                 qsf: Optional[str] = None) -> Dict[str, Any]:
    return simulator().compile_source(vhdl, top, files, qsf)


def must_run(name: str, **options: Any) -> Dict[str, Any]:
    result = run(name, **options)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    return result


def must_compile(name: str, top: Optional[str] = None) -> Dict[str, Any]:
    result = compile_text(source(name), top)
    check(result.get("ok"), f"compile failed: {errors_text(result)}")
    return result


def errors_text(result: Dict[str, Any]) -> str:
    return " | ".join(
        f"{e.get('file', '?')}:{e.get('line', 0)}: {e.get('message', '')}"
        for e in result.get("errors", [])
    )


def value(result: Dict[str, Any], port: str) -> Any:
    final = result["waveforms"]["final"]
    check(port in final, f"port {port!r} missing from final state {sorted(final)}")
    return final[port]


def signal(result: Dict[str, Any], name: str) -> Dict[str, Any]:
    for item in result["waveforms"]["signals"]:
        if item["name"].lower() == name.lower():
            return item
    raise CheckError(f"signal {name!r} not found; have {[s['name'] for s in result['waveforms']['signals']]}")


def cycle_values(result: Dict[str, Any], index: int) -> Dict[str, Any]:
    cycles = result["waveforms"]["cycles"]
    check(len(cycles) > index, f"only {len(cycles)} cycles")
    return cycles[index]["values"]


def cycle_count(result: Dict[str, Any]) -> int:
    return len(result["waveforms"]["cycles"])


def cycles_where(result: Dict[str, Any], port: str, predicate: Callable[[Any], bool]) -> List[Dict[str, Any]]:
    return [c for c in result["waveforms"]["cycles"] if predicate(c["values"].get(port))]


def has_error(result: Dict[str, Any], *needles: str) -> bool:
    text = " ".join(
        [str(e.get("message", "")) for e in result.get("errors", [])]
        + [str(e.get("message", "")) for e in result.get("waveforms", {}).get("errors", []) if isinstance(e, dict)]
    )
    lowered = text.lower()
    return any(needle.lower() in lowered for needle in needles)


def snippet(text: str, limit: int = 260) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def run_all(only: Optional[str] = None, verbose: bool = False) -> List[Case]:
    selected = [c for c in CASES if only is None or only.lower() in c.id.lower()]
    for item in selected:
        started = time.time()
        try:
            actual = item.fn()
            item.actual = actual or "(no output)"
            item.passed = True
        except CheckError as exc:
            item.actual = str(exc)
            item.passed = False
        except Exception as exc:  # noqa: BLE001 - report harness bugs as failures
            item.actual = f"HARNESS EXCEPTION: {type(exc).__name__}: {exc}"
            item.error = traceback.format_exc()
            item.passed = False
        item.seconds = time.time() - started
        mark = "PASS" if item.passed else "FAIL"
        print(f"[{mark}] {item.id:<10} {item.description[:70]}")
        if not item.passed:
            print(f"         actual: {snippet(item.actual, 400)}")
        if verbose and item.passed:
            print(f"         {snippet(item.actual, 300)}")
    return selected


def write_results(cases: List[Case], path: Path) -> None:
    passed = sum(1 for c in cases if c.passed)
    failed = len(cases) - passed
    lines = [
        "# QA results",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"GHDL: {simulator().health().get('version')}",
        f"Total: {len(cases)}  PASS: {passed}  FAIL: {failed}",
        "",
        "| ID | Description | Lang | Expected | Actual | Result |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for item in cases:
        actual = snippet(item.actual, 220).replace("|", "\\|")
        expected = item.expected.replace("|", "\\|")
        lines.append(
            f"| {item.id} | {item.description} | {item.language} | {expected} | {actual} | "
            f"{'PASS' if item.passed else 'FAIL'} |"
        )
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    only = None
    verbose = "--verbose" in argv
    if "--filter" in argv:
        only = argv[argv.index("--filter") + 1]
    cases = run_all(only=only, verbose=verbose)
    results = ROOT / "tests" / "RESULTS.md"
    write_results(cases, results)
    failed = [c for c in cases if not c.passed]
    print()
    print(f"{len(cases) - len(failed)}/{len(cases)} passed; results written to {results}")
    if failed:
        print("FAILED:", ", ".join(c.id for c in failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())