"""Repeatable QA harness for the Cyclone IV simulator.

Every case executes the real backend (GHDL) and records observed evidence.
Run everything with::

    python tests/run_all.py
    python tests/run_all.py --jobs 8 --timing --fail-fast

The runner writes ``tests/RESULTS.md`` (evidence table) and prints a summary.
Cases run in a process pool (``--jobs N``, default min(8, cpu_count)) against
a shared GHDL analysis cache in ``tests/.qa_ghdl_cache/``; each worker gets a
private copy of the warmed cache so GHDL never writes concurrently.
"""

from __future__ import annotations

import atexit
import collections
import concurrent.futures
import importlib
import json
import os
import shutil
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from backend.simulator import SimulationRequest, Simulator  # noqa: E402


def frontend_dir() -> Path:
    """The frontend that is actually served (legacy app or built Vite app)."""
    base = ROOT / "frontend"
    for candidate in (base / "legacy", base):
        if (candidate / "app.js").exists() or (candidate / "index.html").exists():
            return candidate
    return base


def frontend_src(*names: str) -> str:
    """Concatenated frontend module sources (paths relative to frontend/).

    The modern app lives in ``frontend/src`` as ES modules; the QA source
    checks read these instead of the retired single-file layout.
    """
    base = ROOT / "frontend"
    return "\n".join(
        (base / name).read_text(encoding="utf-8", errors="replace")
        for name in names
        if (base / name).exists()
    )


DESIGNS = Path(__file__).resolve().parent / "designs"
CACHE_DIR = ROOT / "tests" / ".qa_ghdl_cache"

_SIMULATOR: Optional[Simulator] = None


def simulator() -> Simulator:
    """The shared Simulator, backed by the QA GHDL analysis cache.

    Set ``CYCLESIM_QA_CACHE=0`` to fall back to uncached isolated workdirs.
    """
    global _SIMULATOR
    if _SIMULATOR is None:
        cache = CACHE_DIR
        if os.environ.get("CYCLESIM_QA_CACHE", "1") in ("0", "false", "False"):
            cache = None  # type: ignore[assignment]
        _SIMULATOR = Simulator(library_cache=cache)
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
    cache: str = ""  # hit | miss | fallback | none


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
    waveforms = result.get("waveforms") or {}  # failure results carry None
    text = " ".join(
        [str(e.get("message", "")) for e in result.get("errors", [])]
        + [str(e.get("message", "")) for e in waveforms.get("errors", []) if isinstance(e, dict)]
    )
    lowered = text.lower()
    return any(needle.lower() in lowered for needle in needles)


def snippet(text: str, limit: int = 260) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def run_all(only: Optional[str] = None, verbose: bool = False, fail_fast: bool = False) -> List[Case]:
    """Run cases sequentially.  Returns the cases that actually executed."""
    selected = [c for c in CASES if only is None or only.lower() in c.id.lower()]
    executed: List[Case] = []
    for item in selected:
        sim = simulator()
        sim.last_cache_outcome = "none"
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
        item.cache = sim.last_cache_outcome
        mark = "PASS" if item.passed else "FAIL"
        print(f"[{mark}] {item.id:<10} {item.description[:70]}")
        if not item.passed:
            print(f"         actual: {snippet(item.actual, 400)}")
        if verbose and item.passed:
            print(f"         {snippet(item.actual, 300)}")
        executed.append(item)
        if fail_fast and not item.passed:
            break
    return executed


def cache_stats(cases: List[Case]) -> Dict[str, int]:
    counts = {"hits": 0, "misses": 0, "fallbacks": 0}
    for item in cases:
        if item.cache == "hit":
            counts["hits"] += 1
        elif item.cache == "miss":
            counts["misses"] += 1
        elif item.cache == "fallback":
            counts["fallbacks"] += 1
    return counts


# ---------------------------------------------------------------------------
# Parallel runner (Windows spawn: module-level functions, plain picklable data)
# ---------------------------------------------------------------------------

_WORKER_SIMULATOR: Optional[Simulator] = None


def _worker_init(shared_cache_dir: str) -> None:
    """ProcessPoolExecutor initializer.

    Gives this worker a private COPY of the warmed GHDL cache (shutil.copytree
    preserves the source mtimes GHDL's work library records), so workers never
    write to the shared cache dir or to each other's workdirs.
    """
    global _WORKER_SIMULATOR, _SIMULATOR
    private_root = Path(tempfile.mkdtemp(prefix="cyclone_qa_worker_"))
    private_cache = private_root / "cache"
    try:
        shutil.copytree(shared_cache_dir, private_cache)
    except OSError:
        private_cache.mkdir(parents=True, exist_ok=True)
    atexit.register(shutil.rmtree, private_root, ignore_errors=True)
    _WORKER_SIMULATOR = Simulator(library_cache=private_cache)
    _SIMULATOR = _WORKER_SIMULATOR


def _run_case_worker(module_name: str, case_id: str) -> Dict[str, Any]:
    """Run one case inside a worker process.

    Imports the test module (which registers its cases), finds the case by id
    and executes it.  Returns plain picklable data only — never a closure.
    """
    global _SIMULATOR
    if _WORKER_SIMULATOR is None:  # direct/debug calls without the pool
        _worker_init(str(CACHE_DIR))
    _SIMULATOR = _WORKER_SIMULATOR
    sim = _WORKER_SIMULATOR
    assert sim is not None
    importlib.import_module(module_name)
    target = next((c for c in CASES if c.id == case_id), None)
    if target is None:
        return {"case_id": case_id,
                "actual": f"HARNESS EXCEPTION: case {case_id!r} not found in module {module_name}",
                "passed": False, "error": "", "seconds": 0.0, "cache": "none"}
    sim.last_cache_outcome = "none"
    started = time.time()
    try:
        actual = target.fn()
        return {"case_id": case_id, "actual": actual or "(no output)", "passed": True,
                "error": "", "seconds": time.time() - started, "cache": sim.last_cache_outcome}
    except CheckError as exc:
        return {"case_id": case_id, "actual": str(exc), "passed": False,
                "error": "", "seconds": time.time() - started, "cache": sim.last_cache_outcome}
    except Exception as exc:  # noqa: BLE001 - report harness bugs as failures
        return {"case_id": case_id, "actual": f"HARNESS EXCEPTION: {type(exc).__name__}: {exc}",
                "passed": False, "error": traceback.format_exc(),
                "seconds": time.time() - started, "cache": sim.last_cache_outcome}


def run_all_parallel(
    cases: List[Case],
    jobs: int,
    case_modules: Dict[str, str],
    fail_fast: bool = False,
    verbose: bool = False,
) -> tuple[List[Case], int]:
    """Run cases in a process pool; results are applied in registration order.

    Returns (executed cases, skipped count).  With ``fail_fast`` no new cases
    are scheduled after the first failure; already-running ones still finish.
    """
    payloads: Dict[str, Dict[str, Any]] = {}
    queue: Any = collections.deque()
    for item in cases:
        module_name = case_modules.get(item.id)
        if module_name is None:
            payloads[item.id] = {"case_id": item.id,
                                 "actual": f"HARNESS EXCEPTION: no test module mapped for case {item.id}",
                                 "passed": False, "error": "", "seconds": 0.0, "cache": "none"}
        else:
            queue.append((item.id, module_name))
    running: Dict[concurrent.futures.Future, str] = {}
    by_id = {c.id: c for c in cases}
    stop = False

    with concurrent.futures.ProcessPoolExecutor(
        max_workers=jobs, initializer=_worker_init, initargs=(str(CACHE_DIR),)
    ) as pool:
        def submit_ready() -> None:
            nonlocal stop
            while not stop and queue and len(running) < jobs * 2:
                case_id, module_name = queue.popleft()
                running[pool.submit(_run_case_worker, module_name, case_id)] = case_id

        submit_ready()
        while running:
            done, _ = concurrent.futures.wait(running, return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                case_id = running.pop(future)
                item = by_id[case_id]
                try:
                    payload = future.result()
                except Exception as exc:  # noqa: BLE001 - worker crash / broken pool
                    payload = {"case_id": case_id,
                               "actual": f"HARNESS EXCEPTION: {type(exc).__name__}: {exc}",
                               "passed": False, "error": traceback.format_exc(),
                               "seconds": 0.0, "cache": "none"}
                payloads[case_id] = payload
                mark = "PASS" if payload["passed"] else "FAIL"
                print(f"[{mark}] {item.id:<10} {item.description[:70]}")
                if not payload["passed"]:
                    print(f"         actual: {snippet(payload['actual'], 400)}")
                if verbose and payload["passed"]:
                    print(f"         {snippet(payload['actual'], 300)}")
                if not payload["passed"] and fail_fast:
                    stop = True
            submit_ready()

    executed: List[Case] = []
    for item in cases:
        payload = payloads.get(item.id)
        if payload is None:
            continue  # skipped by --fail-fast
        item.actual = payload["actual"]
        item.passed = payload["passed"]
        item.error = payload.get("error", "")
        item.seconds = payload.get("seconds", 0.0)
        item.cache = payload.get("cache", "none")
        executed.append(item)
    return executed, len(cases) - len(executed)


def write_results(cases: List[Case], path: Path, wall_seconds: Optional[float] = None,
                  jobs: int = 1, cache: Optional[Dict[str, int]] = None, skipped: int = 0,
                  extra_header: Optional[List[str]] = None) -> None:
    passed = sum(1 for c in cases if c.passed)
    failed = len(cases) - passed
    lines = [
        "# QA results",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"GHDL: {simulator().health().get('version')}",
    ]
    if wall_seconds is not None:
        lines.append(f"Wall time: {wall_seconds:.1f}s")
    lines.append(f"Jobs: {jobs}")
    if cache is not None:
        lines.append(f"Cache: {cache.get('hits', 0)} hits, {cache.get('misses', 0)} misses, "
                     f"{cache.get('fallbacks', 0)} fallbacks")
    if skipped:
        lines.append(f"Skipped by --fail-fast: {skipped}")
    for extra in extra_header or []:
        lines.append(extra)
    lines += [
        f"Total: {len(cases)}  PASS: {passed}  FAIL: {failed}",
        "",
        "| ID | Description | Lang | Expected | Actual | Result |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for item in cases:
        actual = snippet(item.actual, 220).replace("|", "\\|")
        expected = item.expected.replace("|", "\\|")
        # Audit N5: a raw '|' in the description used to drop the whole row
        # from gen_report's table parse — escape it like actual/expected.
        description = item.description.replace("|", "\\|")
        lines.append(
            f"| {item.id} | {description} | {item.language} | {expected} | {actual} | "
            f"{'PASS' if item.passed else 'FAIL'} |"
        )
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")



def write_test_table(cases: List[Case], path: Path) -> None:
    """Write tests/TEST_TABLE.md: one row per executed case.

    Columns: ID | what | expected | observed | PASS/FAIL (task-5 format).
    """
    passed = sum(1 for c in cases if c.passed)
    lines = [
        "# Test table — every executed QA case",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"Total: {len(cases)}  PASS: {passed}  FAIL: {len(cases) - passed}",
        "",
        "| ID | What | Expected | Observed | Result |",
        "| --- | --- | --- | --- | --- |",
    ]
    for item in cases:
        what = item.description.replace("|", chr(92) + "|")
        expected = item.expected.replace("|", chr(92) + "|")
        observed = snippet(item.actual, 220).replace("|", chr(92) + "|")
        lines.append(
            f"| {item.id} | {what} | {expected} | {observed} | "
            f"{'PASS' if item.passed else 'FAIL'} |"
        )
    lines.append("")
    path.write_text(chr(10).join(lines), encoding="utf-8")


def main(argv: Optional[List[str]] = None, modules: Optional[List[str]] = None,
         case_modules: Optional[Dict[str, str]] = None,
         extra_header: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    only = None
    if "--filter" in argv:
        only = argv[argv.index("--filter") + 1]
    verbose = "--verbose" in argv
    timing = "--timing" in argv
    fail_fast = "--fail-fast" in argv
    jobs = min(8, os.cpu_count() or 1)
    if "--jobs" in argv:
        try:
            jobs = max(1, int(argv[argv.index("--jobs") + 1]))
        except ValueError:
            print(f"invalid --jobs value; using default {jobs}")

    # Warm the shared GHDL cache (board models) once, before workers copy it.
    simulator().warm()

    selected = [c for c in CASES if only is None or only.lower() in c.id.lower()]
    started = time.time()
    skipped = 0
    if jobs > 1 and len(selected) > 1 and modules:
        executed, skipped = run_all_parallel(selected, jobs, case_modules or {},
                                             fail_fast=fail_fast, verbose=verbose)
    else:
        executed = run_all(only=only, verbose=verbose, fail_fast=fail_fast)
        skipped = len(selected) - len(executed)
    wall = time.time() - started

    if timing:
        print()
        print("Slowest cases:")
        for item in sorted(executed, key=lambda c: c.seconds, reverse=True):
            print(f"  {item.seconds:8.2f}s  {item.id:<10} {item.description[:58]}")

    results = ROOT / "tests" / "RESULTS.md"
    write_results(executed, results, wall_seconds=wall, jobs=jobs,
                  cache=cache_stats(executed), skipped=skipped,
                  extra_header=extra_header)
    write_test_table(executed, ROOT / "tests" / "TEST_TABLE.md")
    failed = [c for c in executed if not c.passed]
    print()
    summary = f"{len(executed) - len(failed)}/{len(executed)} passed"
    if skipped:
        summary += f"; {skipped} skipped by --fail-fast"
    print(f"{summary}; results written to {results}")
    if failed:
        print("FAILED:", ", ".join(c.id for c in failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())