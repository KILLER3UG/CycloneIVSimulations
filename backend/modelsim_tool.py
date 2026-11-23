"""ModelSim (vsim) netlist simulation runner for Quartus EDA .vho + .sdo outputs."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .device import BOARD
from .peripherals import decode_buzzer, decode_uart, decode_vga, read_model_dumps
from .qsf_parser import parse_qsf
from .settings import detect_modelsim_bin, validate_modelsim_path
from .testbench_gen import TestbenchConfig, generate_testbench, stimulus_from_dict
from .vcd_parser import parse_vcd
from .vhdl_parser import VHDLParser
from .waveform import board_image_from_model, build_waveform, map_board, WaveformModel


def _no_window_flags() -> int:
    if os.name == "nt":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return 0


def _run_tool(argv: List[str], cwd: Path, env: Dict[str, str], timeout: float = 60.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_no_window_flags(),
        check=False,
    )


def _find_vho_entity(vho_path: Path, preferred_name: Optional[str] = None):
    text = vho_path.read_text(encoding="utf-8", errors="replace")
    design = VHDLParser().parse(text)
    if preferred_name:
        for ent in design.entities:
            if ent.name.lower() == preferred_name.lower():
                return ent
    return design.primary


def simulate_vho_with_modelsim(
    vho_path: Path,
    *,
    modelsim_path: Optional[str] = None,
    quartus_bin: Optional[str] = None,
    top_entity: Optional[str] = None,
    sdo_path: Optional[Path] = None,
    qsf_text: str = "",
    strict_pins: bool = False,
    duration_ns: float = 2000.0,
    clock_period_ns: float = 20.0,
    reset_cycles: int = 2,
    reset_active_high: bool = True,
    clock_port: Optional[str] = None,
    reset_port: Optional[str] = None,
    stimuli: Optional[List[Dict[str, Any]]] = None,
    compact: bool = True,
    timeout_sec: float = 45.0,
) -> Dict[str, Any]:
    """Compile and run Quartus-generated .vho netlist under ModelSim (vsim -c).

    Returns ``{"ok": True, "engine": "modelsim", ...}`` with ``boardImage``,
    ``final``, ``peripherals``, ``signals`` and ``waveform`` compatible with the
    3D board UI, or ``{"ok": False, "available": bool, "error": ...}``.
    """
    vho_path = Path(vho_path)
    if not vho_path.is_file():
        return {"ok": False, "available": False, "error": f"EDA netlist not found: {vho_path}"}

    ms_info = (
        validate_modelsim_path(modelsim_path, quartus_bin=quartus_bin)
        if modelsim_path
        else detect_modelsim_bin(quartus_bin=quartus_bin)
    )
    if not ms_info["valid"]:
        return {
            "ok": False,
            "available": False,
            "error": ms_info.get("error") or "ModelSim (vsim) is not installed.",
        }

    entity = _find_vho_entity(vho_path, preferred_name=top_entity)
    if entity is None:
        return {"ok": False, "available": True, "error": f"No entity found inside {vho_path.name}"}

    # Strip generics on post-fit netlist entity if any slipped through parser
    entity.generics = []

    work_root = vho_path.parent
    lib_dir = work_root / "_vsim_work"
    if lib_dir.exists():
        shutil.rmtree(lib_dir, ignore_errors=True)

    tb_name = f"tb_{re.sub(r'[^A-Za-z0-9_]', '_', entity.name)}"
    dur_ns = max(100.0, min(float(duration_ns or 2000.0), 500000.0))
    stim_objs = [stimulus_from_dict(s) for s in (stimuli or []) if isinstance(s, dict)]
    tb_cfg = TestbenchConfig(
        duration_ns=dur_ns,
        clock_period_ns=float(clock_period_ns or 20.0),
        reset_cycles=int(reset_cycles or 2),
        reset_active_high=bool(reset_active_high),
        clock_port=clock_port,
        reset_port=reset_port,
        stimuli=stim_objs,
        testbench_name=tb_name,
    )
    tb_vhdl = generate_testbench(entity, tb_cfg)
    tb_path = work_root / f"{tb_name}.vhd"
    tb_path.write_text(tb_vhdl, encoding="utf-8")

    vcd_name = "vsim_dump.vcd"
    vcd_path = work_root / vcd_name
    if vcd_path.exists():
        try:
            vcd_path.unlink()
        except OSError:
            pass

    binaries = ms_info["binaries"]
    env = os.environ.copy()
    env["PATH"] = ms_info["path"] + os.pathsep + env.get("PATH", "")

    t0 = time.monotonic()
    vlib_res = _run_tool([binaries["vlib"], str(lib_dir)], work_root, env, timeout=20.0)
    if vlib_res.returncode != 0:
        return {
            "ok": False,
            "available": True,
            "engine": "modelsim",
            "error": f"vlib failed: {(vlib_res.stderr or vlib_res.stdout).strip()}",
        }

    vmap_exe = str(Path(binaries["vsim"]).parent / ("vmap.exe" if os.name == "nt" else "vmap"))
    if Path(vmap_exe).is_file():
        _run_tool([vmap_exe, "work", str(lib_dir)], work_root, env, timeout=15.0)

    vcom_res = _run_tool(
        [binaries["vcom"], "-93", "-work", str(lib_dir), str(vho_path.name), str(tb_path.name)],
        work_root,
        env,
        timeout=timeout_sec,
    )
    if vcom_res.returncode != 0:
        return {
            "ok": False,
            "available": True,
            "engine": "modelsim",
            "error": f"vcom failed: {(vcom_res.stdout + vcom_res.stderr).strip()[-1500:]}",
        }

    # Build vsim .do script: dump all top-level testbench signals to VCD
    run_ps = int(round(dur_ns * 1000))
    do_lines = [
        f"vcd file {vcd_name}",
        f"vcd add /{tb_name.lower()}/*",
        f"run {run_ps} ps",
        "vcd flush",
        "quit -f",
    ]
    do_path = work_root / "_run_vsim.do"
    do_path.write_text("\n".join(do_lines) + "\n", encoding="utf-8")

    vsim_cmd = [
        binaries["vsim"],
        "-c",
        "-t",
        "1ps",
        "-L",
        "cycloneive",
        "-L",
        "altera",
        "-L",
        "altera_mf",
        "-work",
        str(lib_dir),
    ]
    if sdo_path and Path(sdo_path).is_file():
        vsim_cmd.extend(["-sdftyp", f"/{tb_name.lower()}/uut={Path(sdo_path).name}"])
    vsim_cmd.extend([f"work.{tb_name.lower()}", "-do", str(do_path.name)])

    vsim_res = _run_tool(vsim_cmd, work_root, env, timeout=timeout_sec)
    if vsim_res.returncode != 0 or not vcd_path.is_file():
        return {
            "ok": False,
            "available": True,
            "engine": "modelsim",
            "error": f"vsim failed (rc={vsim_res.returncode}): {(vsim_res.stdout + vsim_res.stderr).strip()[-1500:]}",
        }

    vcd_data = parse_vcd(str(vcd_path))
    qsf_parsed = parse_qsf(qsf_text or "") if qsf_text else None
    qsf_pins = qsf_parsed.pins if qsf_parsed else None
    bit_pins = qsf_parsed.bit_pins if qsf_parsed else None

    waveform, transitions_by_name = build_waveform(
        vcd_data,
        entity,
        root=tb_name.lower(),
        max_cycles=max(100, min(8192, int(dur_ns / max(1.0, clock_period_ns)))),
        duration_cap=dur_ns,
        compact=compact,
        qsf_pins=qsf_pins,
        strict_pins=strict_pins,
        bit_pins=bit_pins,
    )
    board_map = map_board(entity, qsf_pins, strict_pins=strict_pins, bit_pins=bit_pins)
    model = WaveformModel(vcd_data, entity, tb_name.lower(), duration_cap=dur_ns)
    board_image = waveform.get("boardImage") or board_image_from_model(model, board_map)
    board_dict = waveform.get("board") or board_map.as_dict()
    peripherals: Dict[str, Any] = {}
    dumps = read_model_dumps(work_root)
    if dumps:
        peripherals.update(dumps)
    try:
        if "UART_TXD" in transitions_by_name:
            peripherals["uart"] = decode_uart(transitions_by_name["UART_TXD"])
        buz_pin = str(BOARD.get("buzzer", {}).get("pin") or "").upper()
        buz_port = next(
            (
                port for port, plist in (board_dict.get("pins") or {}).items()
                if any(str(p).upper() == buz_pin for p in (plist or []))
            ),
            None,
        )
        if buz_port and buz_port.upper() in transitions_by_name:
            peripherals["buzzer"] = decode_buzzer(
                transitions_by_name[buz_port.upper()],
                clock_ns=float(clock_period_ns or 20.0),
                active_low=bool(BOARD.get("buzzer", {}).get("activeLow", True)),
            )
        if all(k in transitions_by_name for k in ("VGA_HSYNC", "VGA_VSYNC", "VGA_R", "VGA_G", "VGA_B")):
            peripherals["vga"] = decode_vga(
                transitions_by_name["VGA_HSYNC"],
                transitions_by_name["VGA_VSYNC"],
                transitions_by_name["VGA_R"],
                transitions_by_name["VGA_G"],
                transitions_by_name["VGA_B"],
            )
    except Exception:
        pass

    return {
        "ok": True,
        "available": True,
        "engine": "modelsim",
        "durationSec": round(time.monotonic() - t0, 2),
        "entity": entity.as_dict(),
        "board": board_dict,
        "boardImage": board_image,
        "final": waveform.get("final") or {},
        "signals": waveform.get("signals") or [],
        "cycles": waveform.get("cycles") or [],
        "totalCycles": waveform.get("totalCycles") or 0,
        "clockNs": float(clock_period_ns or 20.0),
        "peripherals": peripherals,
        "vsimOutput": (vsim_res.stdout or "")[-4000:],
    }
