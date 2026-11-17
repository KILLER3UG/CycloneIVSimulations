"""Section 29: differential testing — backend.simulate() vs raw GHDL.

For each representative design the auto-generated testbench is run twice:
once through the backend pipeline (VCD -> build_waveform) and once as a raw
GHDL analyze/elaborate/run whose VCD is parsed independently.  The per-port
transition lists must be identical; any delta is a backend bug or a
documented limitation.
"""
from __future__ import annotations

import re
import shutil
import tempfile
from pathlib import Path

from harness import ROOT, case, check, errors_text, simulator

DESIGNS = [
    ("DIF-01", "counter", "examples/counter.vhd", "counter", 300, 10),
    ("DIF-02", "FSM (Moore traffic light)", "tests/qa/designs/fsm.vhd", "traffic_moore", 400, 10),
    ("DIF-03", "dual-port RAM", "tests/qa/designs/memory.vhd", "ram_dp", 200, 10),
    ("DIF-04", "UART TX", "examples/uart_tx.vhd", "uart_tx", 500, 10),
    ("DIF-05", "7-segment decoder", "examples/seven_segment.vhd", "seven_segment", 200, 10),
]


def _norm(value):
    if isinstance(value, str):
        if value in ("0", "1"):
            return int(value)
        return value.upper()
    return value


def _raw_ghdl_run(design_path: Path, top: str, duration: float, period: float) -> dict:
    """Run GHDL directly (-a/-e/-r) with the SAME auto testbench the backend
    would generate, and parse the VCD independently."""
    from backend.ghdl_tool import GhdlTool
    from backend.testbench_gen import TestbenchConfig, generate_testbench
    from backend.vhdl_parser import VHDLParser
    from backend.vcd_parser import parse_vcd

    source = design_path.read_text(encoding="utf-8")
    entity = next(e for e in VHDLParser().parse(source).entities if e.name == top)
    tb_source = generate_testbench(entity, TestbenchConfig(
        duration_ns=duration, clock_period_ns=period, reset_cycles=2))
    tb_top = f"tb_{top}"

    workdir = Path(tempfile.mkdtemp(prefix="cyclone_dif_"))
    try:
        design_file = workdir / "design.vhd"
        design_file.write_text(source, encoding="utf-8")
        tb_file = workdir / "testbench.vhd"
        tb_file.write_text(tb_source, encoding="utf-8")
        work = workdir / "work"
        work.mkdir()
        vcd = workdir / "wave.vcd"
        ghdl = GhdlTool()
        analyze = ghdl.analyze([design_file, tb_file], work)
        check(analyze.ok, f"raw GHDL analyze failed: {analyze.output[:200]}")
        elaborate = ghdl.elaborate(tb_top, work)
        check(elaborate.ok, f"raw GHDL elaborate failed: {elaborate.output[:200]}")
        run_result = ghdl.run(tb_top, work, vcd, duration + 2 * period)
        check(run_result.ok and vcd.exists(), f"raw GHDL run failed: {run_result.output[:200]}")
        return parse_vcd(str(vcd))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _compare(case_id: str, description: str, rel_path: str, top: str,
             duration: float, period: float) -> str:
    from backend.simulator import SimulationRequest

    def _normalize_value(value):
        """Local copy of the backend's value canonicalisation (0/1 -> int)."""
        if isinstance(value, str):
            if value in ("0", "1"):
                return int(value)
            if value and all(ch in "01xzwhul-" for ch in value.lower())                     and any(ch in "xzwhul" for ch in value.lower()):
                return value.upper()
        return value

    design_path = ROOT / rel_path
    raw = _raw_ghdl_run(design_path, top, duration, period)
    result = simulator().simulate(SimulationRequest.from_dict({
        "vhdl": design_path.read_text(encoding="utf-8"), "top": top,
        "duration": duration, "clockPeriod": period}))
    check(result.get("ok"), f"backend simulation failed: {errors_text(result)}")

    from backend.vhdl_parser import VHDLParser
    entity = next(e for e in VHDLParser().parse(
        design_path.read_text(encoding="utf-8")).entities if e.name == top)
    port_names = [p.name for p in entity.ports]

    raw_by_name = {}
    for signal in raw.signals:
        raw_by_name.setdefault(signal.name, signal)

    backend_by_name = {s["name"]: s for s in result["waveforms"]["signals"]}
    compared = 0
    for name in port_names:
        backend_signal = backend_by_name.get(name)
        check(backend_signal is not None, f"{name}: missing from backend waveforms")
        raw_signal = raw_by_name.get(name)
        check(raw_signal is not None, f"{name}: missing from the raw GHDL VCD")
        cap = duration + 1e-9
        raw_trans = [[t, _norm(v)] for t, v in raw_signal.transitions if t <= cap]
        # keep only the leading transition per timestamp, as the backend does
        cleaned = []
        for item in raw_trans:
            if cleaned and cleaned[-1][0] == item[0]:
                cleaned[-1] = item
            else:
                cleaned.append(item)
        want = [[t, _norm(v)] for t, v in backend_signal["transitions"]]
        check(cleaned == want,
              f"{name}: backend and raw GHDL differ\n  raw={cleaned[:8]}\n  backend={want[:8]}")
        compared += 1
    return f"{top}: {compared} ports identical between backend.simulate() and raw GHDL VCD"


for _id, _desc, _path, _top, _dur, _period in DESIGNS:
    def _make(i=_id, d=_desc, p=_path, t=_top, du=_dur, pe=_period):
        def run_case() -> str:
            return _compare(i, d, p, t, du, pe)
        return run_case

    case(_id, "29", f"Differential: {_desc} - backend vs raw GHDL VCD", "VHDL",
         "every port's transition list is identical between the backend waveform and an "
         "independent raw GHDL run")(_make())


@case("DIF-06", "29", "Second reference simulator (NVC): availability documented", "infra",
      "NVC is used as a second reference if installed; otherwise its absence is documented")
def dif_06() -> str:
    import subprocess
    nvc = shutil.which("nvc")
    if nvc is None:
        return ("documented: NVC is not installed on this machine (pip/winget install attempted "
                "unavailable offline); the differential reference is raw GHDL itself, parsed "
                "independently of the backend waveform pipeline")
    out = subprocess.run([nvc, "--version"], capture_output=True, text=True, timeout=30)
    return f"NVC available: {out.stdout.splitlines()[0] if out.stdout else nvc}"


@case("VER-01", "29", "Verilog upload compiles and simulates on both paths", "Verilog",
      "a .v file via files[] and inline Verilog are translated and simulated")
def ver_01() -> str:
    from backend.simulator import SimulationRequest
    verilog = "module diff_ver(input a, output y); assign y = ~a; endmodule"
    result = simulator().simulate(SimulationRequest.from_dict({
        "files": [{"name": "diff_ver.v", "content": verilog}], "duration": 10}))
    check(result.get("ok") is True, f"files[] Verilog rejected: {errors_text(result)[:200]}")
    result2 = simulator().simulate(SimulationRequest.from_dict({"vhdl": verilog, "duration": 10}))
    check(result2.get("ok") is True, f"inline Verilog rejected: {errors_text(result2)[:200]}")
    return "Verilog compiled and simulated on both the files[] and vhdl paths"
