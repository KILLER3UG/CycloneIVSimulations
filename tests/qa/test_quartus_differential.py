"""Section 30: differential testing — backend.simulate() vs the Quartus
toolchain's own simulator (ModelSim-Altera).

For each representative design the auto-generated testbench is run twice:
once through the backend pipeline (GHDL -> VCD -> waveforms) and once in
ModelSim-Altera (vcom/vsim, the simulator that ships with Quartus) using the
SAME VHDL sources and the SAME auto-generated testbench.  The per-port value
timelines must match at every timestamp: VHDL simulation semantics are
defined by the IEEE 1076 standard, so any compliant simulator must agree.

Skips (documented) when ModelSim is not installed on this machine.
"""
from __future__ import annotations

import glob
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from harness import ROOT, case, check, simulator

DESIGNS = [
    ("QSIM-01", "counter", "examples/counter.vhd", "counter", 300, 10),
    ("QSIM-02", "FSM (Moore traffic light)", "tests/qa/designs/fsm.vhd", "traffic_moore", 400, 10),
    ("QSIM-03", "dual-port RAM", "tests/qa/designs/memory.vhd", "ram_dp", 200, 10),
    ("QSIM-04", "UART TX", "examples/uart_tx.vhd", "uart_tx", 500, 10),
    ("QSIM-05", "7-segment decoder", "examples/seven_segment.vhd", "seven_segment", 200, 10),
]

_VCOM_TIMEOUT = 120
_VSIM_TIMEOUT = 300

_BIT_SLICE_RE = re.compile(r"\[(\d+)\]\s*$")
_META_CHARS = set("XZWHUL-")


def _find_modelsim() -> Path | None:
    exe = shutil.which("vsim")
    if exe:
        return Path(exe).parent
    for pattern in (
        "C:/intelFPGA*/*/modelsim_ase/win32aloem",
        "C:/intelFPGA*/modelsim_ase/win32aloem",
    ):
        for hit in sorted(glob.glob(pattern), reverse=True):
            if (Path(hit) / "vsim.exe").exists():
                return Path(hit)
    return None


def _norm(value):
    if isinstance(value, str):
        if value in ("0", "1"):
            return int(value)
        text = value.upper()
        # All-meta vectors: GHDL fills uninitialized std_logic with 'U',
        # ModelSim writes 'X' (VCD has no 'U'); both mean "not yet driven",
        # so they compare as one class instead of failing on the spelling.
        if text and all(ch in _META_CHARS for ch in text):
            return "META"
        return text
    return value


def _merge_modelsim_signals(ms_vcd):
    """Reassemble ModelSim's bit-sliced vector vars into whole vectors.

    ModelSim-Altera writes one 1-bit ``$var`` per vector element
    (``led [7]``, ``led [6]``, ...) while GHDL writes a single
    ``led[7:0]`` var.  Group by base name and stitch the slices back
    together (bit i from ``name [i]``) so the comparison sees the same
    vector timeline the backend produces.
    """
    from backend.vcd_parser import VcdSignal

    groups: dict = {}
    for signal in ms_vcd.signals:
        groups.setdefault(signal.name, []).append(signal)
    merged = {}
    for name, group in groups.items():
        if len(group) == 1:
            merged[name] = group[0]
            continue
        slices: dict = {}
        for signal in group:
            match = _BIT_SLICE_RE.search(signal.reference or "")
            if not match:
                slices = None
                break
            slices[int(match.group(1))] = signal
        if not slices or len(slices) != max(slices) + 1:
            merged[name] = group[0]
            continue
        times = sorted({t for s in slices.values() for t, _v in s.transitions})
        transitions = []
        for t in times:
            value = 0
            meta = False
            for bit, s in slices.items():
                bit_val = s.value_at(t)
                if isinstance(bit_val, str):
                    if bit_val.lower() in ("0", "1"):
                        bit_val = int(bit_val)
                    else:
                        meta = True
                        break
                value |= (bit_val & 1) << bit
            transitions.append((t, "META" if meta else value))
        merged[name] = VcdSignal(
            identifier=name, name=name, scope=group[0].scope,
            width=len(slices), kind=group[0].kind, transitions=transitions,
        )
    return merged


def _collapsed(transitions, cap):
    """Last value per timestamp (<= cap)."""
    out = []
    for t, v in sorted(transitions, key=lambda item: item[0]):
        if t > cap:
            break
        nv = _norm(v)
        if out and out[-1][0] == t:
            out[-1] = (t, nv)
        else:
            out.append((t, nv))
    return out


def _dedup(collapsed):
    deduped = []
    for t, v in collapsed:
        if deduped and deduped[-1][1] == v:
            continue
        deduped.append((t, v))
    return deduped


def _modelsim_run(ms_dir: Path, sources: list[Path], top: str,
                  stop_ns: float, workdir: Path) -> dict:
    """Compile the sources with vcom and run vsim in batch mode, dumping VCD."""
    vlib = str(ms_dir / "vlib.exe")
    vmap = str(ms_dir / "vmap.exe")
    vcom = str(ms_dir / "vcom.exe")
    vsim = str(ms_dir / "vsim.exe")

    subprocess.run([vlib, "work"], cwd=str(workdir), check=True,
                   capture_output=True, text=True, timeout=_VCOM_TIMEOUT)
    subprocess.run([vmap, "work", "work"], cwd=str(workdir), check=True,
                   capture_output=True, text=True, timeout=_VCOM_TIMEOUT)

    stds = ["-2008", None]  # prefer VHDL-2008; fall back to the tool default
    last_error = ""
    ok = False
    for std in stds:
        ok = True
        for src in sources:
            cmd = [vcom]
            if std:
                cmd.append(std)
            cmd += ["-work", "work", str(src)]
            run = subprocess.run(cmd, cwd=str(workdir), capture_output=True,
                                 text=True, timeout=_VCOM_TIMEOUT)
            if run.returncode != 0:
                ok = False
                last_error = (run.stdout + run.stderr)[-1500:]
                break
        if ok:
            break
    if not ok:
        raise RuntimeError(f"vcom failed: {last_error}")

    # Relative paths inside the Tcl -do script: backslash escapes in Windows
    # absolute paths corrupt the vcd file command.
    vcd = workdir / "msim.vcd"
    do = f"vcd file msim.vcd; vcd add -r /*; run {stop_ns:g} ns; quit -f"
    run = subprocess.run([vsim, "-c", "-do", do, f"work.{top}"],
                         cwd=str(workdir), capture_output=True, text=True,
                         timeout=_VSIM_TIMEOUT)
    if not vcd.exists():
        raise RuntimeError(
            f"vsim produced no VCD: {(run.stdout + run.stderr)[-1500:]}")
    return {"vcd": vcd, "log": (run.stdout + run.stderr)[-800:]}


def _compare(case_id: str, description: str, rel_path: str, top: str,
             duration: float, period: float) -> str:
    from backend.simulator import SimulationRequest
    from backend.testbench_gen import TestbenchConfig, generate_testbench
    from backend.vcd_parser import parse_vcd
    from backend.vhdl_parser import VHDLParser

    ms_dir = _find_modelsim()
    if ms_dir is None:
        return ("documented: ModelSim (Quartus toolchain) is not installed on "
                "this machine — install Quartus with ModelSim-Altera to run "
                "this differential case")

    design_path = ROOT / rel_path
    source = design_path.read_text(encoding="utf-8")
    entity = next(e for e in VHDLParser().parse(source).entities if e.name == top)
    tb_source = generate_testbench(entity, TestbenchConfig(
        duration_ns=duration, clock_period_ns=period, reset_cycles=2))
    tb_top = f"tb_{top}"

    workdir = Path(tempfile.mkdtemp(prefix="cyclone_qsim_"))
    try:
        design_file = workdir / "design.vhd"
        design_file.write_text(source, encoding="utf-8")
        tb_file = workdir / "testbench.vhd"
        tb_file.write_text(tb_source, encoding="utf-8")

        ms = _modelsim_run(ms_dir, [design_file, tb_file], tb_top,
                           duration + 2 * period, workdir)
        ms_vcd = parse_vcd(str(ms["vcd"]))

        result = simulator().simulate(SimulationRequest.from_dict({
            "vhdl": source, "top": top,
            "duration": duration, "clockPeriod": period}))
        check(result.get("ok"), f"backend simulation failed: {result.get('errors')}")

        port_names = [p.name for p in entity.ports]
        ms_by_name = _merge_modelsim_signals(ms_vcd)
        backend_by_name = {s["name"]: s for s in result["waveforms"]["signals"]}

        cap = duration + 1e-9
        compared = 0
        for name in port_names:
            backend_signal = backend_by_name.get(name)
            check(backend_signal is not None, f"{name}: missing from backend waveforms")
            ms_signal = ms_by_name.get(name)
            check(ms_signal is not None,
                  f"{name}: missing from the ModelSim VCD (has {sorted(ms_by_name)[:8]})")
            want = _dedup(_collapsed(backend_signal["transitions"], cap))
            got = _dedup(_collapsed([(t, v) for t, v in ms_signal.transitions], cap))
            check(want == got,
                  f"{name}: backend and ModelSim differ\n  modelsim={got[:8]}\n  backend={want[:8]}")
            compared += 1
        return (f"{top}: {compared} ports identical between backend.simulate() "
                f"and ModelSim {ms_dir.name}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


for _id, _desc, _path, _top, _dur, _period in DESIGNS:
    def _make(i=_id, d=_desc, p=_path, t=_top, du=_dur, pe=_period):
        def run_case() -> str:
            return _compare(i, d, p, t, du, pe)
        return run_case

    case(_id, "30", f"Differential: {_desc} - backend vs ModelSim (Quartus toolchain)", "VHDL",
         "every port's value timeline is identical between the backend waveform and "
         "ModelSim-Altera running the same design + auto testbench")(_make())
