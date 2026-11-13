"""Simulation orchestration.

The engine owns the full GHDL workflow:

    parse source -> write project -> analyze -> elaborate -> run -> parse VCD

Every simulation runs in a throw-away directory so concurrent requests cannot
interfere with each other.  Set ``CYCLESIM_KEEP_DIR=1`` to keep the project
(and the VCD) for debugging.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from .device import BOARD, DEVICE, board_pin_map

ROOT = Path(__file__).resolve().parent.parent
from .qsf_parser import parse_qsf
from .board_detect import board_models, model_files
from .peripherals import decode_uart, decode_buzzer, decode_vga, read_model_dumps
from .board_detect import board_models, model_files
from .peripherals import decode_uart, decode_buzzer, decode_vga, read_model_dumps
from .ghdl_tool import GhdlNotFoundError, GhdlTool
from .testbench_gen import (
    Stimulus,
    TestbenchConfig,
    detect_clock,
    detect_reset,
    generate_testbench,
    stimulus_from_dict,
)
from .vhdl_parser import Design, Entity, VHDLParser
from .vcd_parser import parse_vcd
from .waveform import build_waveform, map_board


@dataclass
class SimulationRequest:
    vhdl: str
    top: Optional[str] = None
    testbench: Optional[str] = None
    duration: float = 1000.0
    clock_period: float = 10.0
    reset_cycles: int = 2
    reset_active_high: bool = True
    reset_port: Optional[str] = None
    clock_port: Optional[str] = None
    stimuli: List[Stimulus] = field(default_factory=list)
    constant_inputs: Dict[str, Any] = field(default_factory=dict)
    generics: Dict[str, Any] = field(default_factory=dict)
    max_cycles: int = 256
    files: List[Dict[str, str]] = field(default_factory=list)
    qsf: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SimulationRequest":
        stimuli = [stimulus_from_dict(item) for item in data.get("stimuli", []) or []]
        files = []
        for index, item in enumerate(data.get("files", []) or []):
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or f"design_{index + 1}.vhd")
            content = item.get("content")
            if content is None:
                content = item.get("vhdl", "")
            files.append({"name": name, "content": str(content or "")})
        return cls(
            vhdl=data.get("vhdl", "") or "",
            qsf=data.get("qsf") or None,
            top=data.get("top") or None,
            testbench=data.get("testbench") or None,
            duration=float(data.get("duration", 1000.0) or 1000.0),
            clock_period=float(data.get("clockPeriod", data.get("clock_period", 10.0)) or 10.0),
            reset_cycles=int(data.get("resetCycles", data.get("reset_cycles", 2)) or 0),
            reset_active_high=bool(data.get("resetActiveHigh", data.get("reset_active_high", True))),
            reset_port=data.get("resetPort") or None,
            clock_port=data.get("clockPort") or None,
            stimuli=stimuli,
            constant_inputs=dict(data.get("constantInputs", {}) or {}),
            generics=dict(data.get("generics", {}) or {}),
            max_cycles=max(1, int(data.get("maxCycles", 256) or 256)),
            files=files,
        )


class SimulationError(RuntimeError):
    """Raised for user-facing simulation failures (bad VHDL, missing GHDL...)."""

    def __init__(self, message: str, errors: Optional[List[dict]] = None, logs: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.errors = errors or []
        self.logs = logs


_VERILOG_RE = re.compile(r"^\s*(?:module|endmodule|always|assign|wire|reg)\b", re.IGNORECASE | re.MULTILINE)
_QSF_RE = re.compile(
    r"set_(?:location|instance|global)_assignment|TOP_LEVEL_ENTITY|IO_STANDARD",
    re.IGNORECASE,
)


def _unsupported_source(source: str) -> Optional[dict]:
    """Return a clear error for inputs this simulator cannot compile.

    GHDL is a VHDL-only simulator and there is no Quartus project reader, so
    silently reporting "No entity declaration found" for Verilog or a .qsf
    would be misleading.  Say what is unsupported instead.
    """
    if _VERILOG_RE.search(source):
        if re.search(r"\bentity\b", source, re.IGNORECASE):
            return {
                "message": (
                    "Mixed-language projects are not supported: the simulator compiles "
                    "VHDL only (GHDL). Move the Verilog/SystemVerilog module to VHDL."
                ),
                "line": 1,
                "column": 1,
                "severity": "error",
            }
        return {
            "message": (
                "Verilog/SystemVerilog is not supported: the simulator compiles VHDL "
                "only (GHDL). Rewrite the module in VHDL."
            ),
            "line": 1,
            "column": 1,
            "severity": "error",
        }
    return None


def _warnings(diagnostics: List[Any]) -> List[dict]:
    return [d.as_dict() for d in diagnostics if d.severity.lower() == "warning"]


def _synthesis_warnings(result: Any) -> List[dict]:
    """Turn GHDL synthesis-check diagnostics into user-facing warnings."""
    warnings: List[dict] = []
    for diagnostic in getattr(result, "diagnostics", []):
        message = diagnostic.message.lower()
        if "latch infered" in message or "latch inferred" in message:
            warnings.append(
                {
                    "file": diagnostic.file,
                    "line": diagnostic.line,
                    "column": diagnostic.column,
                    "severity": "warning",
                    "message": (
                        "latch inferred: this is not synthesizable as pure combinational "
                        "logic on a Cyclone IV (Quartus will implement it as a latch or reject it)"
                    ),
                }
            )
        elif "multiple assignments" in message:
            warnings.append(
                {
                    "file": diagnostic.file,
                    "line": diagnostic.line,
                    "column": diagnostic.column,
                    "severity": "warning",
                    "message": (
                        "multiple drivers: a signal is assigned from more than one source; "
                        "Quartus synthesis would report a conflict"
                    ),
                }
            )
    return warnings


_NONSYNTH_RE = re.compile(r"\b(wait\s+for|wait\s*;|after|assert|report)\b", re.IGNORECASE)


def _nonsynth_warnings(source: str) -> List[dict]:
    """Warn about simulation-only constructs in user HDL.

    GHDL executes these happily, but Quartus ignores or rejects them.  The
    simulator must not imply they will work on the board.
    """
    clean = re.sub(r"--[^\n]*", "", source)
    clean = re.sub(r'"(?:[^"]|"")*"', '""', clean)
    warnings: List[dict] = []
    seen = set()
    for match in _NONSYNTH_RE.finditer(clean):
        line = clean.count("\n", 0, match.start()) + 1
        if line in seen:
            continue
        seen.add(line)
        warnings.append(
            {
                "file": "design.vhd",
                "line": line,
                "column": 1,
                "severity": "warning",
                "message": (
                    f"'{match.group(1)}' is a simulation/testbench construct and is not "
                    "synthesizable on a Cyclone IV; Quartus will ignore or reject it"
                ),
            }
        )
    return warnings


_IO_LIMIT = 91  # EP4CE6E22C8 user I/O pins


def _io_warnings(entity) -> List[dict]:
    if entity is None:
        return []
    total = 0
    for port in entity.ports:
        if port.direction == "linkage":
            continue
        total += port.width or 1
    if total <= _IO_LIMIT:
        return []
    return [
        {
            "file": "design.vhd",
            "line": entity.line or 1,
            "column": 1,
            "severity": "warning",
            "message": (
                f"design uses {total} user I/O pins, which exceeds the 91 available "
                "on the EP4CE6E22C8 (EQFP-144)"
            ),
        }
    ]


def _sources(vhdl: str, files: List[Dict[str, str]]) -> List[tuple[str, str]]:
    """Return (filename, content) pairs for a single- or multi-file design."""
    if files:
        sources: List[tuple[str, str]] = []
        for index, item in enumerate(files):
            name = Path(str(item.get("name") or f"design_{index + 1}.vhd")).name
            if not name.lower().endswith((".vhd", ".vhdl")):
                name += ".vhd"
            sources.append((name, str(item.get("content") or "")))
        return sources
    return [("design.vhd", vhdl)]


def _parse_sources(sources: List[tuple[str, str]]) -> Design:
    design = Design()
    for _, content in sources:
        parsed = VHDLParser().parse(content)
        design.entities.extend(parsed.entities)
        design.errors.extend(parsed.errors)
    return design


def _pin_warnings(entity, qsf_pinned: Optional[set] = None) -> List[dict]:
    """Warn when a top-level port has no pin on the board profile."""
    if entity is None:
        return []
    known = set(board_pin_map())
    known |= {re.sub(r"\[\d+\]$", "", name.upper()) for name in (qsf_pinned or {})}
    warnings: List[dict] = []
    for port in entity.ports:
        base = re.sub(r"\[\d+\]$", "", port.name.upper())
        if base in known:
            continue
        warnings.append(
            {
                "file": "design.vhd",
                "line": port.line or 1,
                "column": port.column or 1,
                "severity": "warning",
                "message": (
                    f"port '{port.name}' has no pin assignment on the {BOARD['name']} "
                    "profile; it is simulated but not mapped to a board device"
                ),
            }
        )
        if len(warnings) >= 8:
            break
    return warnings


def _process_qsf(
    qsf_text: str,
    sources: List[tuple],
    entity,
) -> Tuple[Dict[str, Any], List[dict], List[dict], Optional[str]]:
    """Parse a Quartus .qsf and merge its decisions into the request.

    Returns (info, errors, warnings, top_override).  Pin assignments are
    validated against the board (144-pin EQFP, duplicates) and against the
    top-level ports actually present in the uploaded sources.
    """
    parsed = parse_qsf(qsf_text)
    errors: List[dict] = list(parsed.errors)
    warnings: List[dict] = list(parsed.warnings)
    info: Dict[str, Any] = {
        "top": parsed.top,
        "device": parsed.device,
        "pins": parsed.pins,
        "ioStandards": parsed.io_standards,
        "files": [name for _, name in parsed.files],
        "unusedPolicy": parsed.unusedPolicy,
        "assignments": parsed.assignments,
    }

    if parsed.top is None and not parsed.errors:
        warnings.append({"file": "project.qsf", "line": 1, "column": 1, "severity": "warning",
                         "message": "the .qsf does not set TOP_LEVEL_ENTITY"})

    if parsed.device:
        fitted = DEVICE()["quartusDevice"]
        if parsed.device.upper() not in (fitted.upper(), fitted.upper() + "N"):
            warnings.append({"file": "project.qsf", "line": 1, "column": 1, "severity": "warning",
                             "message": f"the .qsf targets {parsed.device}; the fitted chip is {fitted}"})

    if parsed.files:
        have = {Path(name).name.lower() for name, _ in sources}
        missing = [name for _, name in parsed.files if Path(name).name.lower() not in have]
        if missing:
            errors.append({"file": "project.qsf", "line": 1, "column": 1, "severity": "error",
                           "message": ("the .qsf references source files that were not uploaded: "
                                       + ", ".join(missing))})

    if entity is not None:
        port_errors, port_warnings = _validate_qsf_ports(parsed, entity)
        errors.extend(port_errors)
        warnings.extend(port_warnings)
    return info, errors, warnings, parsed.top


def _validate_qsf_ports(parsed, entity) -> Tuple[List[dict], List[dict]]:
    """Check the .qsf pin/IO assignments against the selected top entity."""
    errors: List[dict] = []
    warnings: List[dict] = []
    port_names = {port.name.upper() for port in entity.ports}
    for base, pin_list in parsed.pins.items():
        if base.upper() not in port_names:
            errors.append({"file": "project.qsf", "line": 1, "column": 1, "severity": "error",
                           "message": (f"pin assignment {','.join(pin_list)} targets port '{base}', "
                                       f"which does not exist on top-level entity '{entity.name}'")})
    for target, standard in parsed.io_standards.items():
        base = re.sub(r"\[\d+\]$", "", target.upper())
        if base in port_names and standard.lower() != "3.3-v lvttl":
            warnings.append({"file": "project.qsf", "line": 1, "column": 1, "severity": "warning",
                             "message": (f"IO_STANDARD '{standard}' on '{target}' differs from the "
                                         "board's 3.3-V LVTTL banks")})
    pinned = {re.sub(r"\[\d+\]$", "", b.upper()) for b in parsed.pins}
    unpinned = [port.name for port in entity.ports
                if re.sub(r"\[\d+\]$", "", port.name.upper()) not in pinned]
    if unpinned and parsed.pins:
        warnings.append({"file": "project.qsf", "line": 1, "column": 1, "severity": "warning",
                         "message": ("top-level ports without a pin assignment in the .qsf: "
                                     + ", ".join(unpinned[:10]))})
    return errors, warnings


class Simulator:
    def __init__(self, ghdl: Optional[GhdlTool] = None) -> None:
        self.ghdl = ghdl or GhdlTool()

    # -- health -----------------------------------------------------------
    def health(self) -> dict:
        try:
            version = self.ghdl.version()
            return {"ok": True, "ghdl": self.ghdl.executable, "version": version}
        except GhdlNotFoundError as exc:
            return {"ok": False, "ghdl": None, "version": None, "error": str(exc)}

    # -- compile ----------------------------------------------------------
    def compile_source(
        self,
        vhdl: str,
        top: Optional[str] = None,
        files: Optional[List[Dict[str, str]]] = None,
        request_qsf: Optional[str] = None,
    ) -> Dict[str, Any]:
        sources = _sources(vhdl, files or [])
        combined = "\n".join(content for _, content in sources)
        unsupported = _unsupported_source(combined)
        if unsupported is not None:
            return {"ok": False, "entity": None, "board": {}, "errors": [unsupported], "warnings": [], "logs": ""}

        qsf_text = request_qsf or ((vhdl if _QSF_RE.search(vhdl) else None) if vhdl else None)             or (combined if _QSF_RE.search(combined) else None)
        design = _parse_sources(sources)
        errors = list(design.errors)
        qsf_info: Optional[dict] = None
        qsf_warnings: List[dict] = []
        if qsf_text is not None:
            qsf_info, qsf_errors, qsf_warnings, qsf_top = _process_qsf(qsf_text, sources, None)
            errors.extend(qsf_errors)
            if qsf_top and top is None:
                top = qsf_top
        entity = self._select_entity(design, top, required=top is not None)
        if entity is not None and qsf_text is not None:
            port_errors, port_warnings = _validate_qsf_ports(parse_qsf(qsf_text), entity)
            errors.extend(port_errors)
            qsf_warnings.extend(port_warnings)
        if qsf_text is not None and errors:
            return {
                "ok": False,
                "entity": entity.as_dict() if entity else None,
                "board": map_board(entity).as_dict() if entity else {},
                "qsf": qsf_info,
                "errors": errors,
                "warnings": qsf_warnings,
                "logs": "",
            }
        if entity is None:
            errors.append(
                {
                    "message": f"Top entity '{top}' was not found in the uploaded VHDL source"
                    if top
                    else "No entity declaration found in the VHDL source",
                    "line": 1,
                    "column": 1,
                    "severity": "error",
                }
            )
            return {"ok": False, "entity": None, "board": {}, "qsf": qsf_info,
                    "errors": errors, "warnings": qsf_warnings, "logs": ""}

        workdir = Path(tempfile.mkdtemp(prefix="cyclone_compile_"))
        try:
            work = workdir / "work"
            work.mkdir(parents=True, exist_ok=True)
            paths = []
            for name, content in sources:
                path = workdir / name
                path.write_text(content, encoding="utf-8")
                paths.append(path)

            result = self.ghdl.analyze(paths, work)
            errors.extend(diagnostic.as_dict() for diagnostic in result.diagnostics if diagnostic.severity == "error")
            logs = result.output
            qsf_pinned = set((qsf_info or {}).get("pins", {}))
            warnings = (_nonsynth_warnings(combined) + _pin_warnings(entity, qsf_pinned)
                        + _warnings(result.diagnostics) + _io_warnings(entity)
                        + (qsf_warnings if qsf_text is not None else []))
            if result.ok:
                synth = self.ghdl.synthesize(paths, work, entity.name)
                warnings.extend(_synthesis_warnings(synth))
            if not result.ok:
                return {
                    "ok": False,
                    "entity": entity.as_dict(),
                    "board": map_board(entity).as_dict(),
                    "errors": errors or [{"message": result.output[-2000:], "line": 0, "column": 0, "severity": "error"}],
                    "warnings": warnings,
                    "logs": logs,
                }

            elaboration = self.ghdl.elaborate(entity.name, work)
            errors.extend(diagnostic.as_dict() for diagnostic in elaboration.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(elaboration.diagnostics))
            if not elaboration.ok:
                return {
                    "ok": False,
                    "entity": entity.as_dict(),
                    "board": map_board(entity).as_dict(),
                    "errors": errors or [{"message": elaboration.output[-2000:], "line": 0, "column": 0, "severity": "error"}],
                    "warnings": warnings,
                    "logs": logs + "\n" + elaboration.output,
                }

            return {
                "ok": True,
                "entity": entity.as_dict(),
                "board": map_board(entity).as_dict(),
                "qsf": qsf_info,
                "errors": errors,
                "warnings": warnings,
                "logs": logs,
            }
        except GhdlNotFoundError as exc:
            return {
                "ok": False,
                "entity": entity.as_dict(),
                "board": map_board(entity).as_dict(),
                "errors": [{"message": str(exc), "line": 0, "column": 0, "severity": "error"}],
                "warnings": [],
                "logs": "",
            }
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    # -- simulate ---------------------------------------------------------
    def simulate(self, request: SimulationRequest) -> Dict[str, Any]:
        sources = _sources(request.vhdl, request.files)
        combined = "\n".join(content for _, content in sources)
        unsupported = _unsupported_source(combined)
        if unsupported is not None:
            return self._failure(unsupported["message"], [unsupported])

        design = _parse_sources(sources)
        errors = list(design.errors)
        qsf_text = request.qsf or ((request.vhdl if _QSF_RE.search(request.vhdl) else None) if request.vhdl else None)             or (combined if _QSF_RE.search(combined) else None)
        qsf_info: Optional[dict] = None
        qsf_warnings: List[dict] = []
        qsf_top: Optional[str] = None
        if qsf_text is not None:
            qsf_info, qsf_errors, qsf_warnings, qsf_top = _process_qsf(qsf_text, sources, None)
            errors.extend(qsf_errors)
        top_name = request.top or qsf_top
        if top_name and not request.testbench:
            entity = next(
                (item for item in design.entities if item.name.lower() == top_name.lower()),
                None,
            )
            if entity is None:
                errors.append(
                    {
                        "message": f"Top entity '{top_name}' was not found in the uploaded VHDL source",
                        "line": 1,
                        "column": 1,
                        "severity": "error",
                    }
                )
                return self._failure(f"Top entity '{top_name}' not found", errors, warnings=qsf_warnings)
        else:
            entity = self._select_entity(design, request.top)
        if entity is None:
            errors.append(
                {
                    "message": "No entity declaration found in the VHDL source",
                    "line": 1,
                    "column": 1,
                    "severity": "error",
                }
            )
            return self._failure("No entity to simulate", errors, warnings=qsf_warnings)
        models = board_models(entity)
        if qsf_text is not None and entity is not None:
            port_errors, port_warn = _validate_qsf_ports(
                parse_qsf(qsf_text), entity)
            errors.extend(port_errors)
            qsf_warnings.extend(port_warn)

        if qsf_text is not None and errors:
            return self._failure("the .qsf contains errors", errors, warnings=qsf_warnings)

        # Work out the testbench / top ------------------------------------
        if request.testbench:
            tb_design = VHDLParser().parse(request.testbench)
            tb_entities = [e for e in tb_design.entities if e.name != entity.name]
            top = request.top or (
                tb_entities[0].name if tb_entities else (tb_design.entities[0].name if tb_design.entities else entity.name)
            )
            tb_source = request.testbench
            root = top
        else:
            top = f"tb_{entity.name}"
            config = TestbenchConfig(
                duration_ns=request.duration,
                clock_period_ns=request.clock_period,
                reset_cycles=request.reset_cycles,
                reset_active_high=request.reset_active_high,
                reset_port=request.reset_port,
                clock_port=request.clock_port,
                stimuli=list(request.stimuli),
                constant_inputs=dict(request.constant_inputs),
                generics=dict(request.generics),
                models=models,
            )
            tb_source = generate_testbench(entity, config)
            root = top

        workdir = Path(tempfile.mkdtemp(prefix="cyclone_sim_"))
        keep = os.environ.get("CYCLESIM_KEEP_DIR", "") not in ("", "0", "false", "False")
        qsf_pinned = set((qsf_info or {}).get("pins", {}))
        warnings: List[dict] = (_nonsynth_warnings(combined) + _pin_warnings(entity, qsf_pinned)
                                + _io_warnings(entity)
                                + (qsf_warnings if qsf_text is not None else []))
        try:
            work = workdir / "work"
            work.mkdir(parents=True, exist_ok=True)
            design_paths = []
            for name, content in sources:
                path = workdir / name
                path.write_text(content, encoding="utf-8")
                design_paths.append(path)
            tb_file = workdir / "testbench.vhd"
            tb_file.write_text(tb_source, encoding="utf-8")
            vcd_file = workdir / "wave.vcd"

            model_paths = [workdir / Path(f).name for f in model_files(models)]
            for f_src, f_dst in zip(model_files(models), model_paths):
                if not f_dst.exists():
                    shutil.copyfile(ROOT / f_src, f_dst)
            analyze = self.ghdl.analyze(design_paths + model_paths + [tb_file], work)
            errors.extend(diagnostic.as_dict() for diagnostic in analyze.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(analyze.diagnostics))
            logs = analyze.output
            if analyze.ok:
                synth = self.ghdl.synthesize(design_paths, work, entity.name)
                warnings.extend(_synthesis_warnings(synth))
            if not analyze.ok:
                return self._failure("VHDL analysis failed", errors, logs, keep, workdir, warnings)

            elaborate = self.ghdl.elaborate(top, work)
            errors.extend(diagnostic.as_dict() for diagnostic in elaborate.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(elaborate.diagnostics))
            logs += "\n" + elaborate.output
            if not elaborate.ok:
                return self._failure("Elaboration failed", errors, logs, keep, workdir, warnings)

            stop_time = max(1.0, float(request.duration) + 2.0 * float(request.clock_period))
            run = self.ghdl.run(top, work, vcd_file, stop_time)
            errors.extend(diagnostic.as_dict() for diagnostic in run.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(run.diagnostics))
            logs += "\n" + run.output
            if not run.ok or not vcd_file.exists():
                return self._failure("Simulation run failed", errors, logs, keep, workdir, warnings)

            try:
                vcd = parse_vcd(str(vcd_file))
            except Exception as exc:  # pragma: no cover - corrupt VCD
                return self._failure(f"Could not parse VCD: {exc}", errors, logs, keep, workdir)

            waveform = build_waveform(
                vcd,
                entity,
                root=root,
                max_cycles=request.max_cycles,
                duration_cap=float(request.duration),
            )

            # On-board peripheral decoding (board_spec.md section D/E)
            peripherals: Dict[str, Any] = {}
            dumps = read_model_dumps(workdir)
            if dumps:
                peripherals.update(dumps)
            try:
                signals_by_name = {sig["name"].upper(): sig for sig in waveform.get("signals", [])}
                if "UART_TXD" in signals_by_name:
                    peripherals["uart"] = decode_uart(signals_by_name["UART_TXD"]["transitions"])
                if "FPGA_BUZZER" in signals_by_name:
                    peripherals["buzzer"] = decode_buzzer(signals_by_name["FPGA_BUZZER"]["transitions"])
                if all(k in signals_by_name for k in ("VGA_HSYNC", "VGA_VSYNC", "VGA_R", "VGA_G", "VGA_B")):
                    peripherals["vga"] = decode_vga(
                        signals_by_name["VGA_HSYNC"]["transitions"],
                        signals_by_name["VGA_VSYNC"]["transitions"],
                        signals_by_name["VGA_R"]["transitions"],
                        signals_by_name["VGA_G"]["transitions"],
                        signals_by_name["VGA_B"]["transitions"])
            except Exception:
                pass  # peripheral decoding is best-effort

            result: Dict[str, Any] = {
                "ok": True,
                "entity": entity.as_dict(),
                "board": waveform.get("board", map_board(entity).as_dict()),
                "top": top,
                "duration": waveform.get("duration", request.duration),
                "waveforms": waveform,
                "peripherals": peripherals,
                "qsf": qsf_info,
                "errors": errors,
                "warnings": warnings,
                "logs": logs[-4000:],
            }
            if keep:
                result["workdir"] = str(workdir)
                result["vcd"] = str(vcd_file)
            return result
        except GhdlNotFoundError as exc:
            return self._failure(str(exc), errors)
        except Exception as exc:  # pragma: no cover - defensive
            return self._failure(f"Simulation error: {exc}", errors)
        finally:
            if not keep:
                shutil.rmtree(workdir, ignore_errors=True)

    # -- helpers ----------------------------------------------------------
    @staticmethod
    def _select_entity(design, requested: Optional[str], required: bool = False) -> Optional[Entity]:
        if requested:
            for entity in design.entities:
                if entity.name.lower() == requested.lower():
                    return entity
            if required:
                return None
        for entity in design.entities:
            if not entity.name.lower().startswith("tb_"):
                return entity
        return design.entities[0] if design.entities else None

    @staticmethod
    def _failure(
        message: str,
        errors: Optional[List[dict]] = None,
        logs: str = "",
        keep: bool = False,
        workdir: Optional[Path] = None,
        warnings: Optional[List[dict]] = None,
    ) -> Dict[str, Any]:
        result: Dict[str, Any] = {
            "ok": False,
            "entity": None,
            "board": {},
            "top": None,
            "duration": 0,
            "waveforms": None,
            "errors": errors or [{"message": message, "line": 0, "column": 0, "severity": "error"}],
            "warnings": warnings or [],
            "logs": logs[-4000:],
        }
        if keep and workdir is not None:
            result["workdir"] = str(workdir)
        return result


__all__ = [
    "SimulationError",
    "SimulationRequest",
    "Simulator",
]