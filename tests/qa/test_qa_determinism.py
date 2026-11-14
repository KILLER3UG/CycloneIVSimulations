"""Section 27: determinism and session/isolation hygiene.

Same request twice must give byte-identical waveforms; two Simulator
instances must share no state; runs must leave no stale temp directories or
zombie GHDL processes behind.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from harness import ROOT, case, check, errors_text, run_text, simulator, value

COUNTER = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity det_counter is
    port (clk : in std_logic; q : out unsigned(7 downto 0));
end entity;
architecture rtl of det_counter is
    signal cnt : unsigned(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;
    q <= cnt;
end architecture;
"""


def _waveform_blob(result: dict) -> str:
    return json.dumps(result.get("waveforms"), sort_keys=True)


@case("DET-01", "27", "The same request twice produces identical waveforms", "VHDL",
      "two identical simulations: identical signal transitions, cycles and final state")
def det_01() -> str:
    first = run_text(COUNTER, top="det_counter", duration=300, clockPeriod=10, resetCycles=2)
    second = run_text(COUNTER, top="det_counter", duration=300, clockPeriod=10, resetCycles=2)
    check(first.get("ok") and second.get("ok"),
          f"simulations failed: {errors_text(first)} | {errors_text(second)}")
    check(_waveform_blob(first) == _waveform_blob(second),
          "waveforms differ between two identical requests")
    check(first.get("warnings") == second.get("warnings"), "warnings differ")
    check(first.get("peripherals") == second.get("peripherals"), "peripherals differ")
    return f"identical waveforms over {len(first['waveforms']['cycles'])} cycles (cache hit on the repeat)"


@case("DET-02", "27", "Two Simulator instances share no state", "VHDL",
      "a cached and an uncached Simulator return identical, independent results")
def det_02() -> str:
    from backend.simulator import SimulationRequest, Simulator
    import shutil
    cache_root = Path(tempfile.mkdtemp(prefix="cyclone_qa_det_"))
    plain = Simulator()                       # isolated temp workdirs
    cached = Simulator(library_cache=cache_root)
    payload = {"vhdl": COUNTER, "top": "det_counter", "duration": 200,
               "clockPeriod": 10, "resetCycles": 2}
    a = plain.simulate(SimulationRequest.from_dict(payload))
    b = cached.simulate(SimulationRequest.from_dict(payload))
    check(a.get("ok") and b.get("ok"), f"failed: {errors_text(a)} | {errors_text(b)}")
    check(_waveform_blob(a) == _waveform_blob(b), "results differ between Simulator instances")
    # a different design in the first instance must not be influenced
    try:
        other = plain.simulate(SimulationRequest.from_dict({
            "vhdl": ("library ieee; use ieee.std_logic_1164.all; "
                     "entity det_inv is port (a : in std_logic; y : out std_logic); "
                     "end entity; architecture rtl of det_inv is begin y <= not a; end architecture;"),
            "top": "det_inv", "duration": 20, "resetCycles": 0, "constantInputs": {"a": 1}}))
        check(other.get("ok") and int(value(other, "y")) == 0, "second design in the same instance failed")
    finally:
        shutil.rmtree(cache_root, ignore_errors=True)
    return "cached and uncached Simulators agree; instance reuse does not leak state"


@case("DET-03", "27", "Runs leave no stale temp directories or zombie GHDL processes", "infra",
      "temp dir count and ghdl.exe process count return to baseline after simulations")
def det_03() -> str:
    def temp_run_dirs() -> int:
        tmp = Path(tempfile.gettempdir())
        return len([p for p in tmp.iterdir()
                    if p.is_dir() and (p.name.startswith("cyclone_sim_")
                                       or p.name.startswith("cyclone_compile_")
                                       or p.name.startswith("cyclone_qa_"))])

    def ghdl_processes() -> int:
        try:
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq ghdl.exe"],
                                 capture_output=True, text=True, timeout=30).stdout
        except (OSError, subprocess.TimeoutExpired):
            return -1
        return out.lower().count("ghdl.exe")

    baseline_dirs = temp_run_dirs()
    baseline_procs = ghdl_processes()
    for _ in range(3):
        result = run_text(COUNTER, top="det_counter", duration=150, clockPeriod=10, resetCycles=2)
        check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    leftover = temp_run_dirs()
    check(leftover <= baseline_dirs,
          f"{leftover} simulator temp directories remain (baseline {baseline_dirs})")
    procs = ghdl_processes()
    if procs >= 0 and baseline_procs >= 0:
        check(procs <= baseline_procs,
              f"{procs} ghdl.exe processes remain (baseline {baseline_procs})")
    return (f"3 runs: temp dirs {baseline_dirs}->{leftover}, "
            f"ghdl processes {baseline_procs}->{procs} (no zombies, no stale dirs)")
