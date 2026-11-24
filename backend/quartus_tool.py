"""Real Quartus Prime CLI project generator, compiler runner, and report parser."""

from __future__ import annotations

import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .paths import projects_dir
from .settings import validate_quartus_path

STAGES = [
    {"id": "analysis", "label": "Analysis & Synthesis", "exe": "quartus_map", "pctStart": 0, "pctEnd": 25},
    {"id": "fitter", "label": "Fitter (Place & Route)", "exe": "quartus_fit", "pctStart": 25, "pctEnd": 60},
    {"id": "assembler", "label": "Assembler", "exe": "quartus_asm", "pctStart": 60, "pctEnd": 75},
    {"id": "timing", "label": "Timing Analysis", "exe": "quartus_sta", "pctStart": 75, "pctEnd": 90},
    {"id": "eda", "label": "EDA Netlist Writer", "exe": "quartus_eda", "pctStart": 90, "pctEnd": 100},
]

_STAGE_INDEX = {s["id"]: idx for idx, s in enumerate(STAGES)}

# e.g. "Info (293000): Quartus Prime Full Compilation was successful. 0 errors, 12 warnings"
# e.g. "Error (10500): VHDL syntax error at buzzb.vhd(14) near text ..."
# e.g. "Critical Warning (332012): Synopsys Design Constraints File file not found: ..."
# e.g. "Warning (18236): Number of processors has not been specified ..."
_QUARTUS_MSG_RE = re.compile(
    r"^\s*(Critical Warning|Error|Warning|Extra Info|Info)\s*(?:\((\d+)\))?\s*:\s*(.+)$",
    re.IGNORECASE,
)
_AT_FILE_LINE_RE = re.compile(
    r"\bat\s+([^\s():]+(?:\.(?:vhd|vhdl|v|sv|qsf|sdc)))\s*\((\d+)(?:,\s*(\d+))?\)",
    re.IGNORECASE,
)
_FILE_LINE_COLON_RE = re.compile(
    r"\b([^\s():]+(?:\.(?:vhd|vhdl|v|sv|qsf|sdc))):(\d+)(?::(\d+))?",
    re.IGNORECASE,
)
_PROGRESS_RE = re.compile(r"^\s*(?:Info.*?:\s*)?(?:\w+\s+)?(\d{1,3})%\s*$")


def _no_window_flags() -> int:
    if os.name == "nt":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return 0


def normalize_quartus_device(device: Optional[str]) -> str:
    d = str(device or "EP4CE6E22C8").strip().upper()
    if d.endswith("N") and d.startswith("EP4CE"):
        d = d[:-1]
    return d or "EP4CE6E22C8"


def sanitize_project_name(name: Optional[str]) -> str:
    clean = re.sub(r"[^A-Za-z0-9_]", "_", str(name or "design").strip())
    clean = re.sub(r"_+", "_", clean).strip("_")
    if not clean or clean[0].isdigit():
        clean = f"proj_{clean or 'design'}"
    return clean


def resolve_project_dir(project_dir: Optional[str], project_name: str) -> Path:
    if project_dir and str(project_dir).strip():
        p = Path(str(project_dir).strip()).expanduser()
    else:
        p = projects_dir(create=True) / sanitize_project_name(project_name)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _qsf_quote(val: str) -> str:
    if re.search(r"[\s;]", val):
        return f'"{val}"'
    return val


def _extract_pin_lines(qsf_pins: str) -> List[str]:
    lines: List[str] = []
    for raw in str(qsf_pins or "").splitlines():
        s = raw.strip()
        if not s or s.startswith("#"):
            continue
        low = s.lower()
        if low.startswith("set_location_assignment ") or low.startswith("set_instance_assignment "):
            lines.append(s)
    return lines


def sync_quartus_project(
    project_dir: Path,
    project_name: str,
    files: List[Dict[str, Any]],
    top_entity: str,
    qsf_pins: str = "",
    device: str = "EP4CE6E22C8",
    family: str = "Cyclone IV E",
) -> Dict[str, Any]:
    """Write open source files plus real .qpf and .qsf files in project_dir."""
    project_dir = Path(project_dir)
    project_dir.mkdir(parents=True, exist_ok=True)
    proj = sanitize_project_name(project_name)
    top = str(top_entity or proj).strip() or proj
    dev = normalize_quartus_device(device)
    fam = str(family or "Cyclone IV E").strip() or "Cyclone IV E"

    written_files: List[str] = []
    hdl_assignments: List[str] = []

    for item in files or []:
        if not isinstance(item, dict):
            continue
        raw_name = str(item.get("name") or "").strip()
        if not raw_name:
            continue
        # Flatten unsafe path traversal while preserving relative subfolder names
        rel = Path(raw_name.replace("\\", "/"))
        if rel.is_absolute() or ".." in rel.parts:
            rel = Path(rel.name)
        target = project_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        content = str(item.get("content") if item.get("content") is not None else item.get("vhdl") or "")
        target.write_text(content, encoding="utf-8")
        rel_posix = rel.as_posix()
        written_files.append(rel_posix)

        low = rel.name.lower()
        if low.endswith((".vhd", ".vhdl")):
            hdl_assignments.append(f"set_global_assignment -name VHDL_FILE {_qsf_quote(rel_posix)}")
        elif low.endswith(".sv"):
            hdl_assignments.append(f"set_global_assignment -name SYSTEMVERILOG_FILE {_qsf_quote(rel_posix)}")
        elif low.endswith(".v"):
            hdl_assignments.append(f"set_global_assignment -name VERILOG_FILE {_qsf_quote(rel_posix)}")

    qpf_path = project_dir / f"{proj}.qpf"
    qsf_path = project_dir / f"{proj}.qsf"

    qpf_text = "\n".join([
        'QUARTUS_VERSION = "18.1"',
        "",
        f'PROJECT_REVISION = "{proj}"',
        "",
    ])
    qpf_path.write_text(qpf_text, encoding="utf-8")

    # Minimal SDC constraint so TimeQuest (quartus_sta) analyzes the 50 MHz board clock cleanly
    sdc_path = project_dir / f"{proj}.sdc"
    if not sdc_path.exists():
        sdc_path.write_text(
            "create_clock -name clk -period 20.000 [get_ports {clk*}]\n"
            "derive_pll_clocks\n"
            "derive_clock_uncertainty\n",
            encoding="utf-8",
        )

    qsf_lines = [
        "# Generated by Quartus Prime Standard Edition (Cyclone IV Studio)",
        f'set_global_assignment -name FAMILY "{fam}"',
        f"set_global_assignment -name DEVICE {dev}",
        f"set_global_assignment -name TOP_LEVEL_ENTITY {_qsf_quote(top)}",
        'set_global_assignment -name PROJECT_OUTPUT_DIRECTORY output_files',
        "set_global_assignment -name MIN_CORE_JUNCTION_TEMP 0",
        "set_global_assignment -name MAX_CORE_JUNCTION_TEMP 85",
        "set_global_assignment -name ERROR_CHECK_FREQUENCY_DIVISOR 1",
        "set_global_assignment -name NOMINAL_CORE_SUPPLY_VOLTAGE 1.2V",
        "set_global_assignment -name NUM_PARALLEL_PROCESSORS ALL",
        f'set_global_assignment -name EDA_SIMULATION_TOOL "ModelSim-Altera (VHDL)"',
        'set_global_assignment -name EDA_TIME_SCALE "1 ps" -section_id eda_simulation',
        "set_global_assignment -name EDA_OUTPUT_DATA_FORMAT VHDL -section_id eda_simulation",
        "set_global_assignment -name EDA_NETLIST_WRITER_OUTPUT_DIR simulation/modelsim -section_id eda_simulation",
        f"set_global_assignment -name SDC_FILE {_qsf_quote(sdc_path.name)}",
        *hdl_assignments,
        *_extract_pin_lines(qsf_pins),
        "",
    ]
    qsf_path.write_text("\n".join(qsf_lines), encoding="utf-8")

    return {
        "projectName": proj,
        "topEntity": top,
        "device": dev,
        "projectDir": str(project_dir),
        "qpfPath": str(qpf_path),
        "qsfPath": str(qsf_path),
        "files": written_files,
    }


def parse_quartus_line(raw_line: str) -> Dict[str, Any]:
    """Parse one Quartus stdout/stderr line into Type / ID / Message / location."""
    line = str(raw_line or "").rstrip("\r\n")
    m = _QUARTUS_MSG_RE.match(line)
    if m:
        kind_raw = m.group(1).strip().lower()
        msg_id = (m.group(2) or "").strip()
        text = m.group(3).strip()
        if kind_raw == "error":
            sev = "error"
        elif kind_raw == "critical warning":
            sev = "critical_warning"
        elif kind_raw == "warning":
            sev = "warning"
        else:
            sev = "info"
    else:
        sev = "info"
        msg_id = ""
        text = line.strip()
        low = text.lower()
        if low.startswith("error:") or "error (" in low:
            sev = "error"
        elif "critical warning" in low:
            sev = "critical_warning"
        elif low.startswith("warning:"):
            sev = "warning"

    file_name: Optional[str] = None
    line_no: Optional[int] = None
    col_no: Optional[int] = None

    loc_m = _AT_FILE_LINE_RE.search(text)
    if loc_m:
        file_name = Path(loc_m.group(1)).name
        line_no = int(loc_m.group(2))
        col_no = int(loc_m.group(3)) if loc_m.group(3) else 1
    else:
        loc_c = _FILE_LINE_COLON_RE.search(text)
        if loc_c:
            file_name = Path(loc_c.group(1)).name
            line_no = int(loc_c.group(2))
            col_no = int(loc_c.group(3)) if loc_c.group(3) else 1

    return {
        "severity": sev,
        "id": msg_id,
        "message": text,
        "raw": line,
        "file": file_name,
        "line": line_no,
        "column": col_no,
    }


def _parse_kv_summary(text: str) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    for raw in text.splitlines():
        if ":" not in raw:
            continue
        stripped = raw.strip()
        if not stripped or stripped.startswith(("+", "-", "|", ";")):
            continue
        k, v = stripped.split(":", 1)
        key = k.strip()
        val = v.strip()
        if key and val and not key.lower().startswith("compilation"):
            rows.append({"key": key, "value": val})
    return rows


def _parse_ascii_table(text: str, section_hint: str) -> List[List[str]]:
    lines = text.splitlines()
    in_section = not section_hint
    table_lines: List[str] = []
    for ln in lines:
        if not in_section:
            if section_hint.lower() in ln.lower() and ln.strip().startswith(";"):
                in_section = True
            continue
        if ln.strip().startswith(";"):
            if ln.strip().startswith("; --") or ln.strip().startswith("; =="):
                if table_lines:
                    break
            elif "|" in ln:
                table_lines.append(ln)
        elif ln.strip().startswith("+--") and table_lines:
            continue
        elif table_lines and not ln.strip().startswith(";"):
            break

    rows: List[List[str]] = []
    for ln in table_lines:
        body = ln.strip().lstrip(";").strip()
        if not body.startswith("|"):
            continue
        cells = [c.strip() for c in body.strip("|").split("|")]
        if any(cells):
            rows.append(cells)
    return rows


def parse_compilation_report(project_dir: Path, project_name: str) -> Dict[str, Any]:
    """Parse Quartus output_files/*.summary and *.rpt into structured report sections."""
    project_dir = Path(project_dir)
    proj = sanitize_project_name(project_name)
    out_dir = project_dir / "output_files"
    sim_dir = project_dir / "simulation" / "modelsim"

    def _read(name: str) -> str:
        for base in (out_dir, project_dir):
            p = base / name
            if p.is_file():
                return p.read_text(encoding="utf-8", errors="replace")
        return ""

    flow_rpt = _read(f"{proj}.flow.rpt")
    map_sum = _read(f"{proj}.map.summary")
    fit_sum = _read(f"{proj}.fit.summary")
    sta_sum = _read(f"{proj}.sta.summary")
    asm_rpt = _read(f"{proj}.asm.rpt")
    eda_rpt = _read(f"{proj}.eda.rpt")

    flow_summary = _parse_ascii_table(flow_rpt, "Flow Summary")
    if not flow_summary and fit_sum:
        flow_summary = [["Item", "Value"], *[[r["key"], r["value"]] for r in _parse_kv_summary(fit_sum)]]
    elif not flow_summary and map_sum:
        flow_summary = [["Item", "Value"], *[[r["key"], r["value"]] for r in _parse_kv_summary(map_sum)]]

    flow_settings = _parse_ascii_table(flow_rpt, "Flow Settings")
    flow_non_default = _parse_ascii_table(flow_rpt, "Flow Non-Default Global Settings")
    elapsed = _parse_ascii_table(flow_rpt, "Flow Elapsed Time")
    flow_os_summary = _parse_ascii_table(flow_rpt, "Flow OS Summary")

    # Extract Flow Log text block (after `; Flow Log ;` header)
    flow_log_lines: List[str] = []
    in_flow_log = False
    for raw_ln in flow_rpt.splitlines():
        if not in_flow_log:
            if "flow log" in raw_ln.lower() and raw_ln.strip().startswith(";"):
                in_flow_log = True
            continue
        if raw_ln.strip().startswith("; --") and flow_log_lines:
            continue
        if raw_ln.strip().startswith(";"):
            break
        flow_log_lines.append(raw_ln)

    map_rows = _parse_kv_summary(map_sum)
    fit_rows = _parse_kv_summary(fit_sum)
    sta_rows = _parse_kv_summary(sta_sum)
    asm_rows = _parse_ascii_table(asm_rpt, "Assembler") or _parse_kv_summary(asm_rpt)

    eda_files: List[str] = []
    if sim_dir.is_dir():
        for ext in ("*.vho", "*.vo", "*.sdo", "*.v", "*.vhd"):
            for p in sorted(sim_dir.glob(ext)):
                eda_files.append(str(p))

    sof_path = out_dir / f"{proj}.sof"
    if not sof_path.is_file():
        sof_path = project_dir / f"{proj}.sof"

    vho_path = sim_dir / f"{proj}.vho"
    sdo_candidates = [
        sim_dir / f"{proj}_vhd.sdo",
        sim_dir / f"{proj}.sdo",
        sim_dir / f"{proj}_8_1200mv_85c_vhd_slow.sdo",
    ]
    sdo_path = next((p for p in sdo_candidates if p.is_file()), None)

    return {
        "projectName": proj,
        "projectDir": str(project_dir),
        "sofPath": str(sof_path) if sof_path.is_file() else "",
        "vhoPath": str(vho_path) if vho_path.is_file() else "",
        "sdoPath": str(sdo_path) if sdo_path else "",
        "edaFiles": eda_files,
        "flowSummary": flow_summary,
        "flowSettings": flow_settings,
        "flowNonDefault": flow_non_default,
        "elapsedTimes": elapsed,
        "flowOsSummary": flow_os_summary,
        "flowLog": "\n".join(flow_log_lines).strip(),
        "assemblerSummary": asm_rows,
        "resourceUsage": fit_rows or map_rows,
        "synthesisSummary": map_rows,
        "timing": sta_rows,
        "raw": {
            "flow": flow_rpt[:30000],
            "map": map_sum[:15000],
            "fit": fit_sum[:15000],
            "asm": asm_rpt[:15000],
            "eda": eda_rpt[:15000],
            "sta": sta_sum[:15000],
        },
    }


def _kill_process_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=_no_window_flags(),
                timeout=10,
                check=False,
            )
            return
        except Exception:
            pass
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            return
        except Exception:
            pass
    try:
        proc.kill()
    except Exception:
        pass


class QuartusCompileRunner:
    """Runs real Quartus CLI stages asynchronously with live output streaming and cancellation."""

    def __init__(
        self,
        quartus_bin: str,
        project_dir: Path,
        project_name: str,
        *,
        on_stage: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_message: Optional[Callable[[Dict[str, Any]], None]] = None,
        on_done: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.quartus_bin = quartus_bin
        self.project_dir = Path(project_dir)
        self.project_name = sanitize_project_name(project_name)
        self.on_stage = on_stage
        self.on_message = on_message
        self.on_done = on_done

        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._proc: Optional[subprocess.Popen] = None
        self._thread: Optional[threading.Thread] = None

    def stop(self) -> None:
        self._cancel.set()
        with self._lock:
            proc = self._proc
        if proc is not None:
            _kill_process_tree(proc)

    def _emit_stage(self, payload: Dict[str, Any]) -> None:
        if self.on_stage:
            try:
                self.on_stage(payload)
            except Exception:
                pass

    def _emit_message(self, payload: Dict[str, Any]) -> None:
        if self.on_message:
            try:
                self.on_message(payload)
            except Exception:
                pass

    def _emit_done(self, payload: Dict[str, Any]) -> None:
        if self.on_done:
            try:
                self.on_done(payload)
            except Exception:
                pass

    def _stage_args(self, stage_id: str, exe_path: str) -> List[str]:
        proj = self.project_name
        if stage_id == "analysis":
            return [exe_path, "--read_settings_files=on", "--write_settings_files=off", proj, "-c", proj]
        if stage_id == "fitter":
            return [exe_path, "--read_settings_files=off", "--write_settings_files=off", proj, "-c", proj]
        if stage_id == "assembler":
            return [exe_path, "--read_settings_files=off", "--write_settings_files=off", proj, "-c", proj]
        if stage_id == "timing":
            return [exe_path, proj, "-c", proj]
        if stage_id == "eda":
            return [exe_path, "--read_settings_files=on", "--write_settings_files=off", proj, "-c", proj]
        return [exe_path, proj]

    def run_blocking(self, stage: Optional[str] = None) -> Dict[str, Any]:
        info = validate_quartus_path(self.quartus_bin)
        if not info["valid"]:
            result = {
                "ok": False,
                "cancelled": False,
                "missingQuartus": True,
                "error": info["error"],
                "errors": [{"severity": "error", "id": "", "message": info["error"]}],
                "warnings": [],
                "counts": {"error": 1, "critical_warning": 0, "warning": 0, "info": 0},
            }
            self._emit_done(result)
            return result

        binaries = info["binaries"]
        if stage and stage in _STAGE_INDEX:
            stages_to_run = [STAGES[_STAGE_INDEX[stage]]]
        else:
            stages_to_run = list(STAGES)

        counts = {"error": 0, "critical_warning": 0, "warning": 0, "info": 0}
        errors: List[Dict[str, Any]] = []
        warnings: List[Dict[str, Any]] = []
        started = time.monotonic()

        env = os.environ.copy()
        env["PATH"] = info["path"] + os.pathsep + env.get("PATH", "")

        for st in stages_to_run:
            if self._cancel.is_set():
                break
            st_id = st["id"]
            st_idx = _STAGE_INDEX[st_id]
            exe_path = binaries.get(st["exe"])
            if not exe_path:
                msg = f"Quartus tool '{st['exe']}' not found in {info['path']}"
                parsed = {"severity": "error", "id": "", "message": msg, "file": None, "line": None, "column": None}
                counts["error"] += 1
                errors.append(parsed)
                self._emit_message(parsed)
                self._emit_stage({"stage": st_id, "index": st_idx, "state": "error", "pct": st["pctStart"], "label": st["label"]})
                return self._finish(False, False, started, counts, errors, warnings)

            stage_t0 = time.monotonic()
            self._emit_stage({"stage": st_id, "index": st_idx, "state": "run", "pct": st["pctStart"], "label": st["label"]})
            argv = self._stage_args(st_id, exe_path)

            creationflags = _no_window_flags()
            popen_kwargs: Dict[str, Any] = {
                "cwd": str(self.project_dir),
                "env": env,
                "stdout": subprocess.PIPE,
                "stderr": subprocess.STDOUT,
                "text": True,
                "encoding": "utf-8",
                "errors": "replace",
                "bufsize": 1,
            }
            if os.name == "nt":
                popen_kwargs["creationflags"] = creationflags
            else:
                popen_kwargs["start_new_session"] = True

            proc = subprocess.Popen(argv, **popen_kwargs)
            with self._lock:
                self._proc = proc

            assert proc.stdout is not None
            for raw_line in proc.stdout:
                if self._cancel.is_set():
                    break
                line = raw_line.rstrip("\r\n")
                if not line.strip():
                    continue
                pm = _PROGRESS_RE.match(line)
                if pm:
                    local_pct = max(0, min(100, int(pm.group(1))))
                    overall = st["pctStart"] + ((st["pctEnd"] - st["pctStart"]) * local_pct) / 100.0
                    self._emit_stage({
                        "stage": st_id,
                        "index": st_idx,
                        "state": "run",
                        "pct": round(overall),
                        "label": st["label"],
                    })
                    continue

                parsed = parse_quartus_line(line)
                sev = parsed["severity"]
                if sev in counts:
                    counts[sev] += 1
                if sev == "error":
                    errors.append(parsed)
                elif sev in ("warning", "critical_warning"):
                    warnings.append(parsed)
                self._emit_message(parsed)

            rc = proc.wait()
            with self._lock:
                self._proc = None

            elapsed_s = time.monotonic() - stage_t0
            if self._cancel.is_set():
                self._emit_stage({
                    "stage": st_id,
                    "index": st_idx,
                    "state": "error",
                    "pct": st["pctStart"],
                    "label": st["label"],
                    "duration": elapsed_s,
                })
                return self._finish(False, True, started, counts, errors, warnings)

            if rc != 0:
                self._emit_stage({
                    "stage": st_id,
                    "index": st_idx,
                    "state": "error",
                    "pct": st["pctStart"],
                    "label": f"{st['label']} failed",
                    "duration": elapsed_s,
                })
                return self._finish(False, False, started, counts, errors, warnings)

            self._emit_stage({
                "stage": st_id,
                "index": st_idx,
                "state": "done",
                "pct": st["pctEnd"],
                "label": st["label"],
                "duration": elapsed_s,
            })

        if self._cancel.is_set():
            return self._finish(False, True, started, counts, errors, warnings)

        total_elapsed = time.monotonic() - started
        summary_msg = parse_quartus_line(
            f"Info (293000): Quartus Prime Full Compilation was successful. "
            f"{counts['error']} errors, {counts['warning'] + counts['critical_warning']} warnings"
        )
        counts["info"] += 1
        self._emit_message(summary_msg)
        return self._finish(True, False, started, counts, errors, warnings, elapsed=total_elapsed)

    def _finish(
        self,
        ok: bool,
        cancelled: bool,
        started: float,
        counts: Dict[str, int],
        errors: List[Dict[str, Any]],
        warnings: List[Dict[str, Any]],
        elapsed: Optional[float] = None,
    ) -> Dict[str, Any]:
        dur = elapsed if elapsed is not None else (time.monotonic() - started)
        report = parse_compilation_report(self.project_dir, self.project_name) if ok else None
        result = {
            "ok": ok,
            "cancelled": cancelled,
            "durationSec": round(dur, 2),
            "counts": counts,
            "errors": errors,
            "warnings": warnings,
            "report": report,
            "projectName": self.project_name,
            "projectDir": str(self.project_dir),
        }
        self._emit_done(result)
        return result

    def start_background(self, stage: Optional[str] = None) -> None:
        self._thread = threading.Thread(
            target=self.run_blocking,
            args=(stage,),
            daemon=True,
            name="quartus-compile",
        )
        self._thread.start()


def launch_quartus_gui(qpf_path: Path, quartus_bin: str) -> Dict[str, Any]:
    info = validate_quartus_path(quartus_bin)
    if not info["valid"]:
        return {"ok": False, "error": info["error"]}
    gui_exe = info["binaries"].get("quartus")
    if not gui_exe:
        return {"ok": False, "error": f"quartus.exe not found in {info['path']}"}
    args = [gui_exe]
    if qpf_path and Path(qpf_path).is_file():
        args.append(str(qpf_path))
    kwargs: Dict[str, Any] = {"cwd": str(Path(qpf_path).parent) if qpf_path else info["path"]}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    else:
        kwargs["start_new_session"] = True
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = subprocess.DEVNULL
    proc = subprocess.Popen(args, **kwargs)
    return {"ok": True, "pid": proc.pid, "exe": gui_exe}


def launch_quartus_programmer(quartus_bin: str, sof_path: Optional[Path] = None) -> Dict[str, Any]:
    info = validate_quartus_path(quartus_bin)
    if not info["valid"]:
        return {"ok": False, "error": info["error"]}
    pgm_exe = info["binaries"].get("quartus_pgmw") or info["binaries"].get("quartus_pgm")
    if not pgm_exe:
        return {"ok": False, "error": f"quartus_pgmw.exe / quartus_pgm.exe not found in {info['path']}"}
    args = [pgm_exe]
    if sof_path and Path(sof_path).is_file() and Path(pgm_exe).stem.lower() == "quartus_pgmw":
        args.append(str(sof_path))
    kwargs: Dict[str, Any] = {"cwd": str(Path(sof_path).parent) if sof_path else info["path"]}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
    else:
        kwargs["start_new_session"] = True
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = subprocess.DEVNULL
    proc = subprocess.Popen(args, **kwargs)
    return {"ok": True, "pid": proc.pid, "exe": pgm_exe}
