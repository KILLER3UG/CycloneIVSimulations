"""Long-run stability soak.

Runs a toggling design through the real backend repeatedly for ``--seconds``
(default 300) and reports wall time, process CPU time and peak working set.

    python tests/qa/soak.py --seconds 300
"""
from __future__ import annotations

import argparse
import ctypes
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "tests" / "qa"))

from harness import run  # noqa: E402


def peak_working_set_kb() -> int:
    class MEMORY(Exception):
        pass

    try:
        import ctypes.wintypes as wt

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", wt.DWORD),
                ("PageFaultCount", wt.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(counters)
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            return int(counters.WorkingSetSize) // 1024
    except Exception:
        pass
    try:
        import resource

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except Exception:
        return -1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=300)
    args = parser.parse_args()

    started = time.time()
    cpu_started = time.process_time()
    deadline = started + args.seconds
    iterations = 0
    failures = 0
    rss_start = peak_working_set_kb()
    while time.time() < deadline:
        result = run(
            "board.vhd",
            top="sw_led8",
            duration=80,
            resetCycles=0,
            stimuli=[{"port": "sw", "kind": "toggle", "periodCycles": 1}],
        )
        iterations += 1
        if not result.get("ok"):
            failures += 1
        if iterations % 20 == 0:
            elapsed = time.time() - started
            print(
                f"t={elapsed:6.1f}s runs={iterations:4d} fail={failures} "
                f"cpu={time.process_time() - cpu_started:6.1f}s "
                f"rss={peak_working_set_kb()}kB",
                flush=True,
            )
    elapsed = time.time() - started
    print(
        f"SOAK DONE seconds={elapsed:.1f} runs={iterations} failures={failures} "
        f"cpu={time.process_time() - cpu_started:.1f}s "
        f"rss_start={rss_start}kB rss_end={peak_working_set_kb()}kB",
        flush=True,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())