"""Simulation orchestration.

The engine owns the full GHDL workflow:

    parse source -> write project -> analyze -> elaborate -> run -> parse VCD

Every simulation runs in a throw-away directory so concurrent requests cannot
interfere with each other.  Set ``CYCLESIM_KEEP_DIR=1`` to keep the project
(and the VCD) for debugging.
"""

from __future__ import annotations

import hashlib
import heapq
import json
import os
import traceback
import re
import shutil
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .device import BOARD, DEVICE, board_pin_map, resolve_port_pins
from .paths import bundle_root

ROOT = bundle_root()
from .qsf_parser import parse_qsf
from .board_detect import board_models, model_files
from .peripherals import decode_uart, decode_buzzer, decode_vga, read_model_dumps
from .ghdl_tool import CommandResult, GhdlNotFoundError, GhdlTool
from .testbench_gen import (
    Stimulus,
    TestbenchConfig,
    detect_clock,
    detect_reset,
    generate_testbench,
    stimulus_from_dict,
)
from .verilog_support import translate_verilog_sources
from .lint import lint_sources
from .vhdl_parser import Design, Entity, VHDLParser, tokenize
from .vcd_parser import parse_vcd
from .waveform import build_waveform, map_board, _classify_port


# Hard request caps (see BACKEND_AUDIT.md M1): a hostile or accidental huge
# request must not be able to drive GB-scale VCD dumps or Python structures.
MAX_DURATION_NS = 2_000_000_000.0        # 2 simulated seconds
MIN_DURATION_NS = 1.0
MAX_CLOCK_PERIOD_NS = 1_000_000.0        # 1 kHz
MIN_CLOCK_PERIOD_NS = 0.01               # 100 GHz (parser/unit sanity only)
MAX_RESET_CYCLES = 1_000_000
MAX_SAMPLE_CYCLES = 131072               # UI cycle-table samples (2 textbook scan rotations)
_REQ_CACHE_MAX = 48                      # interactive (compact) results kept in memory


def _finite_float(value: Any, default: float) -> tuple[float, Optional[str]]:
    """Parse a finite float; return (value, error-note)."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default, f"'{value}' is not a number; using {default:g}"
    if number != number or number in (float("inf"), float("-inf")):
        return default, f"'{value}' is not finite; using {default:g}"
    return number, None


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
    #: Optional memory-init file: ``{"name": "rom.mif", "content": "..."}`` or a
    #: plain content string (named ``rom.mif``).  Written into the simulation
    #: workdir so a design can read it with std.textio at elaboration time.
    memory_init_file: Optional[Dict[str, str]] = None
    #: Skip the GHDL synthesis-lint pass (refresh path). The lint only reports
    #: code-level warnings already surfaced by the initial compile; an input
    #: change does not alter the code, so re-running it wastes ~0.5 s.
    skip_synth: bool = False
    #: Compact board-only result (live input-change refresh). The waveform
    #: ``cycles`` are omitted (the client replays nothing) and a tiny
    #: persistence-of-vision board image is returned instead, so a switch flip
    #: updates the board without shipping ~20 MB of per-cycle samples.
    compact_board: bool = False

    #: Pin Planner mode: only explicit pin assignments map to the board.

    strict_pins: bool = False

    #: Notes produced while clamping out-of-range request parameters (M1).
    clamp_notes: List[str] = field(default_factory=list)

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

        notes: List[str] = []

        duration, note = _finite_float(data.get("duration", 1000.0), 1000.0)
        if note:
            notes.append(f"duration: {note}")
        clamped_duration = min(max(duration, MIN_DURATION_NS), MAX_DURATION_NS)
        if clamped_duration != duration:
            notes.append(
                f"duration {duration:g} ns is outside the supported range "
                f"[{MIN_DURATION_NS:g}, {MAX_DURATION_NS:g}] ns and was clamped to {clamped_duration:g} ns"
            )
        duration = clamped_duration

        period, note = _finite_float(data.get("clockPeriod", data.get("clock_period", 10.0)), 10.0)
        if note:
            notes.append(f"clockPeriod: {note}")
        clamped_period = min(max(period, MIN_CLOCK_PERIOD_NS), MAX_CLOCK_PERIOD_NS)
        if clamped_period != period:
            notes.append(
                f"clockPeriod {period:g} ns is outside the supported range "
                f"[{MIN_CLOCK_PERIOD_NS:g}, {MAX_CLOCK_PERIOD_NS:g}] ns and was clamped to {clamped_period:g} ns"
            )
        period = clamped_period

        try:
            reset_cycles = int(data.get("resetCycles", data.get("reset_cycles", 2)) or 0)
        except (TypeError, ValueError):
            reset_cycles = 2
            notes.append("resetCycles is not an integer; using 2")
        clamped_reset = min(max(reset_cycles, 0), MAX_RESET_CYCLES)
        if clamped_reset != reset_cycles:
            notes.append(
                f"resetCycles {reset_cycles} is outside the supported range "
                f"[0, {MAX_RESET_CYCLES}] and was clamped to {clamped_reset}"
            )
        reset_cycles = clamped_reset

        try:
            max_cycles = int(data.get("maxCycles", 256) or 256)
        except (TypeError, ValueError):
            max_cycles = 256
            notes.append("maxCycles is not an integer; using 256")
        clamped_max_cycles = min(max(max_cycles, 1), MAX_SAMPLE_CYCLES)
        if clamped_max_cycles != max_cycles:
            notes.append(
                f"maxCycles {max_cycles} is outside the supported range "
                f"[1, {MAX_SAMPLE_CYCLES}] and was clamped to {clamped_max_cycles}"
            )
        max_cycles = clamped_max_cycles

        memory_init = data.get("memoryInitFile", data.get("memory_init_file"))
        memory_init_file: Optional[Dict[str, str]] = None
        if isinstance(memory_init, dict):
            memory_init_file = {
                "name": str(memory_init.get("name") or "rom.mif"),
                "content": str(memory_init.get("content") or ""),
            }
        elif isinstance(memory_init, str) and memory_init:
            memory_init_file = {"name": "rom.mif", "content": memory_init}

        request = cls(
            vhdl=data.get("vhdl", "") or "",
            qsf=data.get("qsf") or None,
            top=data.get("top") or None,
            testbench=data.get("testbench") or None,
            duration=duration,
            clock_period=period,
            reset_cycles=reset_cycles,
            reset_active_high=bool(data.get("resetActiveHigh", data.get("reset_active_high", True))),
            reset_port=data.get("resetPort") or None,
            clock_port=data.get("clockPort") or None,
            stimuli=stimuli,
            constant_inputs=dict(data.get("constantInputs", {}) or {}),
            generics=dict(data.get("generics", {}) or {}),
            max_cycles=max_cycles,
            files=files,
            memory_init_file=memory_init_file,
            skip_synth=bool(data.get("skipSynth", False)),
            compact_board=bool(data.get("compactBoard", False)),
            strict_pins=bool(data.get("strictPins", data.get("strict_pins", False))),
            clamp_notes=notes,
        )
        return request

    def cache_key(self) -> str:
        """Stable key for the interactive (compact) result cache."""
        payload = {
            "vhdl": self.vhdl,
            "top": self.top,
            "testbench": self.testbench,
            "duration": self.duration,
            "clock_period": self.clock_period,
            "reset_cycles": self.reset_cycles,
            "reset_active_high": self.reset_active_high,
            "reset_port": self.reset_port,
            "clock_port": self.clock_port,
            "stimuli": [s.as_dict() for s in self.stimuli],
            "constant_inputs": self.constant_inputs,
            "generics": self.generics,
            "max_cycles": self.max_cycles,
            "files": self.files,
            "qsf": self.qsf,
            "skip_synth": self.skip_synth,
            "compact_board": self.compact_board,
            "strict_pins": self.strict_pins,
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()


class SimulationError(RuntimeError):
    """Raised for user-facing simulation failures (bad VHDL, missing GHDL...)."""

    def __init__(self, message: str, errors: Optional[List[dict]] = None, logs: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.errors = errors or []
        self.logs = logs


_COMMENT_RE = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)
_VERILOG_RE = re.compile(
    r"^\s*(?:endmodule\b|always(?:_ff|_comb|_latch)?\s*(?:@|#|\b)|module\s+[A-Za-z_]\w*\s*(?:\(|#|;)|(?:assign|wire|reg)\s+(?![<:]=|:)\S)",
    re.IGNORECASE | re.MULTILINE,
)
_QSF_RE = re.compile(
    r"set_(?:location|instance|global)_assignment|TOP_LEVEL_ENTITY|IO_STANDARD",
    re.IGNORECASE,
)


def _unsupported_source(source: str) -> Optional[dict]:
    """Legacy hook retained for callers; Verilog is translated before GHDL."""
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


def _io_warnings(entity) -> List[dict]:
    if entity is None:
        return []
    limit = DEVICE()["userIo"]
    total = 0
    for port in entity.ports:
        if port.direction == "linkage":
            continue
        total += port.width or 1
    if total <= limit:
        return []
    return [
        {
            "file": "design.vhd",
            "line": entity.line or 1,
            "column": 1,
            "severity": "warning",
            "message": (
                f"design uses {total} user I/O pins, which exceeds the {limit} available "
                f"on the {DEVICE()['part']} ({DEVICE()['package']})"
            ),
        }
    ]


_RANGE_BITS_RE = re.compile(r"([+-]?\d+)\s+(downto|to)\s+([+-]?\d+)", re.IGNORECASE)


def _range_bits(text: str) -> int:
    """Bit count of a literal range like ``15 downto 0`` (0 when unknown)."""
    match = _RANGE_BITS_RE.search(text or "")
    if not match:
        return 0
    left, right = int(match.group(1)), int(match.group(3))
    return abs(left - right) + 1


_ARRAY_RE = re.compile(
    r"type\s+\w+\s+is\s+array\s*\(([^)]*)\)\s*of\s+"
    r"(?:std_logic_vector|unsigned|signed|bit_vector)\s*\(([^)]*)\)",
    re.IGNORECASE,
)
_SIGNAL_VECTOR_RE = re.compile(
    r"\bsignal\s+\w+\s*:\s*(?:std_logic_vector|unsigned|signed|bit_vector)\s*\(([^)]*)\)",
    re.IGNORECASE,
)
_SIGNAL_SCALAR_RE = re.compile(r"\bsignal\s+\w+\s*:\s*(?:std_logic|bit)\b", re.IGNORECASE)

# Audit N3 / BLK-03: ALTPLL instantiations are counted from the source; the
# `component altpll ... end component;` declaration itself must be removed
# first so the declaration (two mentions) is not mistaken for instances.
_ALTPLL_COMPONENT_DECL_RE = re.compile(
    r"\bcomponent\s+altpll\b[\s\S]*?\bend\s+component\b[^;]*;",
    re.IGNORECASE,
)
_ALTPLL_NAME_RE = re.compile(r"\baltpll\b", re.IGNORECASE)


def _resource_warnings(combined: str) -> List[dict]:
    """Static resource estimates compared against the fitted device.

    These are source-level lower-bound estimates (multiply operators, inferred
    memory arrays, declared register bits, ALTPLL instantiations) so an
    obviously oversized design is flagged before it ever reaches a board.
    Quartus fitting is authoritative; the warning says so.
    """
    clean = re.sub(r"--[^\n]*", "", combined)
    clean = re.sub(r'"(?:[^"]|"")*"', '""', clean)
    device = DEVICE()
    part = device["part"]
    warnings: List[dict] = []

    multipliers = len(re.findall(r"\*(?!\*)", clean))
    if multipliers > device["multipliers18x18"]:
        warnings.append({
            "file": "design.vhd", "line": 1, "column": 1, "severity": "warning",
            "message": (
                f"design performs about {multipliers} multiply operations, which exceeds the "
                f"{device['multipliers18x18']} 18x18 multipliers on the {part}; "
                "Quartus fitting is authoritative"
            ),
        })

    memory_bits = sum(
        _range_bits(m.group(1)) * _range_bits(m.group(2)) for m in _ARRAY_RE.finditer(clean)
    )
    m9k_blocks = -(-memory_bits // 9216) if memory_bits else 0  # ceil
    if m9k_blocks > device["m9kBlocks"]:
        warnings.append({
            "file": "design.vhd", "line": 1, "column": 1, "severity": "warning",
            "message": (
                f"design infers about {m9k_blocks} M9K blocks ({memory_bits} bits), which exceeds the "
                f"{device['m9kBlocks']} M9K blocks ({device['m9kKbit']} Kbit) on the {part}; "
                "Quartus fitting is authoritative"
            ),
        })

    register_bits = sum(_range_bits(m.group(1)) for m in _SIGNAL_VECTOR_RE.finditer(clean))
    register_bits += len(_SIGNAL_SCALAR_RE.findall(clean))
    if register_bits > device["logicElements"]:
        warnings.append({
            "file": "design.vhd", "line": 1, "column": 1, "severity": "warning",
            "message": (
                f"design declares about {register_bits} register bits, which exceeds the "
                f"{device['logicElements']} logic elements on the {part}; "
                "Quartus fitting is authoritative"
            ),
        })

    # Audit N3 / BLK-03: count ALTPLL instantiations and warn beyond the
    # device's PLL count.  The limit comes from board/board.json devices
    # (ep4ce6: plls = 2); the fallback mirrors the EP4CE6E22C8 datasheet.
    pll_limit = int(device.get("plls", 2))  # EP4CE6E22C8N has 2 PLLs
    pll_instantiations = len(
        _ALTPLL_NAME_RE.findall(_ALTPLL_COMPONENT_DECL_RE.sub(" ", clean))
    )
    if pll_instantiations > pll_limit:
        warnings.append({
            "file": "design.vhd", "line": 1, "column": 1, "severity": "warning",
            "message": (
                f"design instantiates about {pll_instantiations} ALTPLL PLLs, which exceeds the "
                f"{pll_limit} PLLs on the {part}; "
                "Quartus fitting is authoritative"
            ),
        })
    return warnings


# ---------------------------------------------------------------------------
# textio path pre-scan (audit N7 / ENG-07 mitigation)
# ---------------------------------------------------------------------------

_TEXTIO_OPEN_RE = re.compile(r"\bfile_open\s*\(", re.IGNORECASE)
_TEXTIO_FILE_DECL_RE = re.compile(
    r"\bfile\s+[A-Za-z_]\w*\s*:[^;]*?\bis\b", re.IGNORECASE
)
_TEXTIO_STRING_RE = re.compile(r'"(?:[^"]|"")*"')

#: Patterns that mark a textio external name as an escape out of the
#: simulation work directory (audit N7, demonstrated by RB-05/ENG-07): drive
#: letters, UNC shares, absolute POSIX paths, ``..`` path segments and
#: %ENV%-style tokens.  GHDL's cwd is already the throw-away workdir, so
#: relative paths stay confined; runtime-*computed* paths (e.g. concatenated
#: strings) are NOT covered by this scan — that residual is documented in the
#: limitations lists (ENG-07).
_TEXTIO_ESCAPE_PATTERNS = (
    ("a drive-letter path", re.compile(r"[A-Za-z]:[\\/]")),
    ("a UNC network path", re.compile(r"\\\\")),
    ("an absolute POSIX path", re.compile(r"^/")),
    ("a parent-directory (..) segment", re.compile(r"(?:^|[\\/])\.\.(?:[\\/]|$)")),
    ("an %ENV% style token", re.compile(r"%[A-Za-z_][A-Za-z0-9_]*%")),
)


def _strip_vhdl_comments_keep_lines(source: str) -> str:
    """Blank out comments while keeping every newline (line numbers survive).

    Same comment handling as the rest of the pipeline (``--`` line comments
    end at the newline so it is preserved); ``/* ... */`` block comments are
    replaced by the newlines they contained.
    """
    clean = re.sub(r"--[^\n]*", "", source)
    clean = re.sub(
        r"/\*.*?\*/",
        lambda match: "\n" * match.group(0).count("\n"),
        clean,
        flags=re.DOTALL,
    )
    return clean


def _textio_escape_errors(sources: List[tuple[str, str]]) -> List[dict]:
    """Scan textio external names for literal paths that escape the workdir.

    Only string literals directly adjacent to ``file_open`` calls and
    ``file ... : ... is "..."`` declarations are inspected, so ordinary string
    constants in the design never trigger a false rejection.  Returns one
    error per offending literal, with the 1-based source line number.
    """
    errors: List[dict] = []
    for filename, content in sources:
        clean = _strip_vhdl_comments_keep_lines(content)
        regions: List[Tuple[int, int]] = []  # (start, end) spans to inspect
        for match in _TEXTIO_OPEN_RE.finditer(clean):
            depth = 1
            pos = match.end()
            while pos < len(clean) and depth:
                character = clean[pos]
                if character == "(":
                    depth += 1
                elif character == ")":
                    depth -= 1
                pos += 1
            regions.append((match.end(), pos))
        for match in _TEXTIO_FILE_DECL_RE.finditer(clean):
            close = clean.find(";", match.end())
            regions.append((match.end(), close if close != -1 else len(clean)))
        for start, end in regions:
            for literal in _TEXTIO_STRING_RE.finditer(clean[start:end]):
                text = literal.group(0)[1:-1].replace('""', '"')
                line = clean.count("\n", 0, start + literal.start()) + 1
                for label, pattern in _TEXTIO_ESCAPE_PATTERNS:
                    if pattern.search(text):
                        errors.append(
                            {
                                "file": filename,
                                "line": line,
                                "column": 1,
                                "severity": "error",
                                "message": (
                                    f"textio file path '{text}' on line {line} is "
                                    f"{label} outside the simulation work directory; "
                                    "uploaded HDL may only use relative paths inside "
                                    "the throw-away work directory (ENG-07)"
                                ),
                            }
                        )
                        break
    return errors


def _time_scale(request: "SimulationRequest") -> dict:
    """Simulation-rate vs board-real-time scale factor (see board clock)."""
    board_hz = float(BOARD.get("clockHz") or 50_000_000)
    sim_hz = 1e9 / request.clock_period if request.clock_period > 0 else 0.0
    return {
        "boardClockHz": int(board_hz),
        "simClockHz": int(round(sim_hz)),
        "scale": round(sim_hz / board_hz, 6) if board_hz else None,
        "note": (
            "simClockHz is the simulated clock rate; a design cycles the same "
            "number of clock ticks per simulated second as on the board, so "
            "wall-clock effects scale by simClockHz / boardClockHz"
        ),
    }


def _request_warnings(request: SimulationRequest) -> List[dict]:
    """User-facing warnings for clamped/normalised request parameters (M1)."""
    return [
        {
            "file": "request",
            "line": 0,
            "column": 0,
            "severity": "warning",
            "message": f"request parameter clamped: {note}",
        }
        for note in request.clamp_notes
    ]


def _write_memory_init(workdir: Path, request: SimulationRequest) -> None:
    """Materialise the optional memory-init file in the simulation workdir.

    Designs that initialise an inferred memory from a file do so with
    std.textio; the file is opened relative to the simulator's working
    directory, which is exactly where this puts it.
    """
    init = request.memory_init_file
    if not init:
        return
    name = Path(str(init.get("name") or "rom.mif")).name
    try:
        (workdir / name).write_text(str(init.get("content") or ""), encoding="utf-8")
    except OSError:
        pass


def _sources(vhdl: str, files: List[Dict[str, str]]) -> List[tuple[str, str]]:
    """Return (filename, content) pairs for a single- or multi-file design."""
    if files:
        sources: List[tuple[str, str]] = []
        for index, item in enumerate(files):
            name = Path(str(item.get("name") or f"design_{index + 1}.vhd")).name
            if not name.lower().endswith((".vhd", ".vhdl", ".v", ".sv")):
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


_NON_INST_KW = frozenset({
    "entity", "configuration", "component", "block", "process",
    "if", "case", "for", "while", "loop", "generate", "signal",
    "variable", "constant", "shared", "file", "type", "subtype",
})


def _extract_vhdl_units(content: str) -> List[dict]:
    """Extract top-level VHDL design units, line spans, and dependency edges."""
    tokens = tokenize(content)
    units: List[dict] = []
    default_ctx_lines: List[str] = []
    seen_first_unit = False
    raw_lines = content.splitlines()
    i = 0
    n = len(tokens)
    ctx_start_line: Optional[int] = None
    ctx_pkgs: set[str] = set()
    ctx_has_library = False

    def _scan_subprogram_is(idx: int) -> bool:
        pdepth = 0
        k = idx + 1
        while k < n:
            tk = tokens[k]
            if tk.is_op("("):
                pdepth += 1
            elif tk.is_op(")"):
                pdepth = max(0, pdepth - 1)
            elif pdepth == 0:
                if tk.is_kw("is"):
                    return True
                if tk.is_op(";"):
                    return False
            k += 1
        return False

    def _next_kw_among(idx: int, targets: tuple[str, ...]) -> Optional[str]:
        k = idx + 1
        while k < n:
            tk = tokens[k]
            if tk.is_op(";"):
                return ";"
            for t in targets:
                if tk.is_kw(t):
                    return t
            k += 1
        return None

    while i < n:
        tok = tokens[i]
        if tok.is_kw("library", "use") or (
            tok.is_kw("context") and _next_kw_among(i, ("is",)) != "is"
        ):
            if ctx_start_line is None:
                ctx_start_line = tok.line
            if tok.is_kw("library"):
                ctx_has_library = True
            start_clause = tok.line
            while i < n and not tokens[i].is_op(";"):
                if (
                    tokens[i].is_kw("use")
                    and i + 3 < n
                    and tokens[i + 1].kind == "ident"
                    and tokens[i + 1].value.lower() == "work"
                    and tokens[i + 2].is_op(".")
                    and tokens[i + 3].kind == "ident"
                ):
                    ctx_pkgs.add(tokens[i + 3].value.lower())
                i += 1
            end_clause = tokens[i].line if i < n else raw_lines and len(raw_lines) or start_clause
            if not seen_first_unit and "work." not in " ".join(
                raw_lines[start_clause - 1 : end_clause]
            ).lower():
                default_ctx_lines.extend(raw_lines[start_clause - 1 : end_clause])
            i += 1
            continue

        if tok.is_kw("entity", "architecture", "package", "configuration", "context"):
            seen_first_unit = True
            start_line = tok.line
            kind = tok.value.lower()
            name = ""
            entity_of: Optional[str] = None
            is_pkg_instantiation = False

            if kind == "package" and i + 1 < n and tokens[i + 1].is_kw("body"):
                kind = "package_body"
                name = tokens[i + 2].value if i + 2 < n else ""
            elif kind in ("entity", "package", "context"):
                name = tokens[i + 1].value if i + 1 < n else ""
                if kind == "package" and i + 3 < n and tokens[i + 2].is_kw("is") and tokens[i + 3].is_kw("new"):
                    is_pkg_instantiation = True
            elif kind in ("architecture", "configuration"):
                name = tokens[i + 1].value if i + 1 < n else ""
                if i + 3 < n and tokens[i + 2].is_kw("of"):
                    entity_of = tokens[i + 3].value

            used_pkgs = set(ctx_pkgs)
            instantiated: set[str] = set()
            end_line = len(raw_lines) if raw_lines else start_line

            if is_pkg_instantiation:
                while i < n and not tokens[i].is_op(";"):
                    i += 1
                end_line = tokens[i].line if i < n else end_line
                i += 1
            else:
                # Advance to `is` of unit header so its `is` isn't misread
                j = i + 1
                while j < n and not tokens[j].is_kw("is"):
                    j += 1
                j = min(j + 1, n)
                depth = 0
                while j < n:
                    tk = tokens[j]
                    prev = tokens[j - 1]
                    # Extract `use work.<pkg>` and instantiations inside unit
                    if (
                        tk.is_kw("use")
                        and j + 3 < n
                        and tokens[j + 1].value.lower() == "work"
                        and tokens[j + 2].is_op(".")
                        and tokens[j + 3].kind == "ident"
                    ):
                        used_pkgs.add(tokens[j + 3].value.lower())
                    if (
                        tk.is_kw("entity")
                        and j + 3 < n
                        and tokens[j + 1].value.lower() == "work"
                        and tokens[j + 2].is_op(".")
                        and tokens[j + 3].kind == "ident"
                    ):
                        instantiated.add(tokens[j + 3].value.lower())
                    if (
                        tk.kind == "ident"
                        and j + 3 < n
                        and tokens[j + 1].is_op(":")
                    ):
                        m = j + 2
                        if m < n and tokens[m].is_kw("component"):
                            m += 1
                        if (
                            m + 2 < n
                            and tokens[m].kind == "ident"
                            and tokens[m].value.lower() not in _NON_INST_KW
                            and tokens[m + 1].is_kw("generic", "port")
                            and tokens[m + 2].is_kw("map")
                        ):
                            instantiated.add(tokens[m].value.lower())

                    if tk.is_kw("end"):
                        if depth > 0:
                            depth -= 1
                            while j < n and not tokens[j].is_op(";"):
                                j += 1
                        else:
                            while j < n and not tokens[j].is_op(";"):
                                j += 1
                            end_line = tokens[j].line if j < n else end_line
                            j += 1
                            break
                    elif not prev.is_kw("end"):
                        if tk.is_kw("process", "loop", "generate", "block", "record", "units", "protected"):
                            depth += 1
                        elif tk.is_kw("component") and not prev.is_op(":"):
                            depth += 1
                        elif tk.is_kw("if") and _next_kw_among(j, ("then", "generate")) == "then":
                            depth += 1
                        elif tk.is_kw("case") and _next_kw_among(j, ("is", "generate")) == "is":
                            depth += 1
                        elif tk.is_kw("function", "procedure") and _scan_subprogram_is(j):
                            depth += 1
                    j += 1
                i = j

            units.append({
                "kind": kind,
                "name": name.lower(),
                "orig_name": name,
                "entity_of": entity_of.lower() if entity_of else None,
                "ctx_start_line": ctx_start_line or start_line,
                "start_line": start_line,
                "end_line": end_line,
                "has_library": ctx_has_library,
                "used_packages": used_pkgs,
                "instantiated": instantiated,
                "default_ctx_lines": list(default_ctx_lines),
            })
            ctx_start_line = None
            ctx_pkgs = set()
            ctx_has_library = False
            continue

        i += 1
    return units


def _needs_intrafile_split(units: List[dict]) -> bool:
    """True if any earlier unit in the same file depends on a later unit."""
    if len(units) < 2:
        return False
    first_def: Dict[tuple[str, str], int] = {}
    for idx, u in enumerate(units):
        key = (u["kind"], u["name"])
        if key not in first_def:
            first_def[key] = idx
    for idx, u in enumerate(units):
        for pkg in u["used_packages"]:
            if first_def.get(("package", pkg), -1) > idx:
                return True
        if u["entity_of"] and first_def.get(("entity", u["entity_of"]), -1) > idx:
            return True
        for child in u["instantiated"]:
            if first_def.get(("entity", child), -1) > idx:
                return True
    return False


def _prepare_sources_for_ghdl(
    raw_sources: List[tuple[str, str]],
) -> tuple[List[tuple[str, str]], Dict[str, str]]:
    """Split out-of-order single files (if needed) and order files topologically."""
    expanded: List[tuple[str, str, List[dict]]] = []
    aliases: Dict[str, str] = {}

    for f_idx, (fname, content) in enumerate(raw_sources):
        units = _extract_vhdl_units(content)
        if _needs_intrafile_split(units):
            lines = content.splitlines()
            for u_idx, u in enumerate(units):
                c_start = u["ctx_start_line"]
                s_line = u["start_line"]
                e_line = max(s_line, min(len(lines), u["end_line"]))
                if u["has_library"] or not u["default_ctx_lines"] or s_line - 1 < len(u["default_ctx_lines"]):
                    pad = "\n" * max(0, c_start - 1)
                    body = "\n".join(lines[c_start - 1 : e_line])
                    unit_src = pad + body + "\n"
                else:
                    ctx_hdr = "\n".join(u["default_ctx_lines"])
                    pad = "\n" * max(0, s_line - 1 - len(u["default_ctx_lines"]))
                    body = "\n".join(lines[s_line - 1 : e_line])
                    unit_src = ctx_hdr + "\n" + pad + body + "\n"
                split_name = f"__split_{f_idx}_{u_idx}_{fname}"
                aliases[split_name] = fname
                expanded.append((split_name, unit_src, [u]))
        else:
            expanded.append((fname, content, units))

    # Build dependency graph between compilation items
    n = len(expanded)
    pkg_owner: Dict[str, int] = {}
    ent_owner: Dict[str, int] = {}
    arch_owners: Dict[str, List[int]] = {}
    for idx, (_name, _content, units) in enumerate(expanded):
        for u in units:
            if u["kind"] == "package" and u["name"] and u["name"] not in pkg_owner:
                pkg_owner[u["name"]] = idx
            elif u["kind"] == "entity" and u["name"] and u["name"] not in ent_owner:
                ent_owner[u["name"]] = idx
            elif u["kind"] == "architecture" and u["entity_of"]:
                arch_owners.setdefault(u["entity_of"], []).append(idx)

    adj: List[set[int]] = [set() for _ in range(n)]
    indeg = [0] * n
    for idx, (_name, _content, units) in enumerate(expanded):
        deps: set[int] = set()
        for u in units:
            for pkg in u["used_packages"]:
                if pkg in pkg_owner:
                    deps.add(pkg_owner[pkg])
            if u["entity_of"] and u["entity_of"] in ent_owner:
                deps.add(ent_owner[u["entity_of"]])
            for child in u["instantiated"]:
                if child in ent_owner:
                    deps.add(ent_owner[child])
                for a_idx in arch_owners.get(child, ()):
                    deps.add(a_idx)
        deps.discard(idx)
        for d in deps:
            if idx not in adj[d]:
                adj[d].add(idx)
                indeg[idx] += 1

    heap = [i for i in range(n) if indeg[i] == 0]
    heapq.heapify(heap)
    order: List[int] = []
    while heap:
        cur = heapq.heappop(heap)
        order.append(cur)
        for nxt in adj[cur]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                heapq.heappush(heap, nxt)
    if len(order) < n:
        seen = set(order)
        for i in range(n):
            if i not in seen:
                order.append(i)

    ordered = [(expanded[i][0], expanded[i][1]) for i in order]
    return ordered, aliases


#: GHDL reports a missing ';' at the *end* keyword, which is cryptic: the real
#: mistake is almost always on the statement just above. Append a plain-language
#: hint to those diagnostics so students know where to look.
_MISSING_SEMI_HINT = (
    " — a ';' is missing at the end of the previous statement "
    "(GHDL points at the 'end' keyword; check the line above it)."
)

_MISSING_SEMI_PATTERNS = (
    'missing ";" at end of',
    "';' expected at end of",
)


def _augment_syntax_hints(errors: List[dict]) -> List[dict]:
    """Attach plain-language hints to common cryptic GHDL syntax errors."""
    out: List[dict] = []
    for item in errors:
        if isinstance(item, dict):
            msg = str(item.get("message", ""))
            if any(p in msg for p in _MISSING_SEMI_PATTERNS) and "';' is missing" not in msg:
                item = {**item, "message": msg + _MISSING_SEMI_HINT}
        out.append(item)
    return out


def _rewrite_diagnostic_files(
    items: List[dict],
    aliases: Dict[str, str],
    line_maps: Optional[Dict[str, Dict[int, Tuple[str, int]]]] = None,
) -> List[dict]:
    """Restore original uploaded filenames and line numbers on diagnostics."""
    if not aliases and not line_maps:
        return items
    rewritten: List[dict] = []
    for item in items:
        copy = dict(item)
        fpath = str(copy.get("file") or "")
        base = Path(fpath).name
        if aliases and base in aliases:
            copy["file"] = aliases[base]
            base = Path(aliases[base]).name
        if line_maps and base in line_maps:
            vmap = line_maps[base]
            ln = int(copy.get("line") or 1)
            mapped = vmap.get(ln)
            if mapped is None and vmap:
                prior = [k for k in vmap if k <= ln]
                mapped = vmap[max(prior)] if prior else next(iter(vmap.values()))
            if mapped is not None:
                copy["file"], copy["line"] = mapped
        rewritten.append(copy)
    return rewritten


def _instantiation_map(sources: List[tuple[str, str]]) -> Dict[str, set[str]]:
    """Map each entity (lowercase) -> set of child entities instantiated in its arch."""
    graph: Dict[str, set[str]] = {}
    for _, content in sources:
        for u in _extract_vhdl_units(content):
            if u["kind"] == "architecture" and u["entity_of"]:
                graph.setdefault(u["entity_of"], set()).update(u["instantiated"])
    return graph


def _pin_warnings(entity, qsf_pinned: Optional[set] = None) -> List[dict]:
    """Warn when a top-level port has no pin on the board profile."""
    if entity is None:
        return []
    known = set(board_pin_map())
    known |= {re.sub(r"\[\d+\]$", "", name.upper()) for name in (qsf_pinned or {})}
    warnings: List[dict] = []
    for port in entity.ports:
        base = re.sub(r"\[\d+\]$", "", port.name.upper())
        if base in known or resolve_port_pins(port.name, _classify_port(port.name)):
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
        "bitPins": parsed.bit_pins,
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


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


# One reentrant lock per cache directory (process-wide): GHDL's work library
# file is rewritten by ``ghdl -a`` and read by ``-e``/``-r``, so concurrent
# analyze/elaborate against the same shared library must be serialized.
_CACHE_LOCKS: Dict[str, threading.RLock] = {}
_CACHE_LOCKS_GUARD = threading.Lock()


def _cache_lock_for(cache_dir: Path) -> threading.RLock:
    key = str(cache_dir)
    with _CACHE_LOCKS_GUARD:
        lock = _CACHE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _CACHE_LOCKS[key] = lock
        return lock


def _looks_like_cache_corruption(result: CommandResult) -> bool:
    """Detect GHDL duplicate/redefined-unit complaints.

    GHDL silently *replaces* an already-analyzed unit when the same unit name
    is analyzed again (emitting a ``-Wlibrary`` warning), which would make the
    shared library untrustworthy.  Any such complaint invalidates the cache.
    """
    text = (result.stdout + "\n" + result.stderr).lower()
    return (
        "was also defined in file" in text
        or "duplicate" in text
        or "redefin" in text
    )


@dataclass
class _Prep:
    """Everything worked out before GHDL is invoked (pure Python phase)."""

    request: SimulationRequest
    sources: List[tuple[str, str]]
    combined: str
    errors: List[dict]
    warnings: List[dict]
    qsf_text: Optional[str]
    qsf_info: Optional[dict]
    entity: Any
    top: str
    root: str
    tb_source: str
    models: List[dict]
    aliases: Dict[str, str] = field(default_factory=dict)
    line_maps: Dict[str, Dict[int, Tuple[str, int]]] = field(default_factory=dict)
    entities: List[str] = field(default_factory=list)


class Simulator:
    def __init__(
        self,
        ghdl: Optional[GhdlTool] = None,
        library_cache: Optional[Path | str] = None,
    ) -> None:
        self.ghdl = ghdl or GhdlTool()
        # Opt-in persistent GHDL work-library cache.  ``None`` (the default)
        # keeps the classic isolated temp-workdir behaviour byte-identical.
        self.library_cache = Path(library_cache) if library_cache else None
        # Outcome of the last simulate() call: hit | miss | fallback | none.
        self.last_cache_outcome = "none"
        self._manifest: Optional[dict] = None
        self._models_key: Optional[str] = None
        self._ghdl_version: Optional[str] = None
        # ENG-03B: cancel() may be called without a token (QA/CLI). Track the
        # active run's token and a cancel flag so a stop during analysis is
        # honoured too, not only once the GHDL child exists.
        self._active_token: Optional[dict] = None
        # Interactive (compact) result cache: identical design + stimulus
        # re-runs (e.g. walking the DIP/KEY strips) return instantly.
        self._req_cache: Dict[str, Dict[str, Any]] = {}
        self._cancel_requested = False

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
        strict_pins: bool = False,
    ) -> Dict[str, Any]:
        raw_sources = _sources(vhdl, files or [])
        sources, v_line_maps, v_errors = translate_verilog_sources(raw_sources)
        if v_errors:
            return {"ok": False, "entity": None, "board": {}, "errors": v_errors, "warnings": [], "logs": ""}
        combined = "\n".join(content for _, content in sources)
        unsupported = _unsupported_source(combined)
        if unsupported is not None:
            return {"ok": False, "entity": None, "board": {}, "errors": [unsupported], "warnings": [], "logs": ""}

        # Audit N7 / ENG-07 mitigation: same textio path pre-scan as simulate.
        escape_errors = _textio_escape_errors(sources)
        if escape_errors:
            return {
                "ok": False,
                "entity": None,
                "board": {},
                "errors": escape_errors,
                "warnings": [],
                "logs": "",
            }

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
        entity = self._select_entity(design, top, required=top is not None, sources=sources)
        if entity is not None and qsf_text is not None:
            port_errors, port_warnings = _validate_qsf_ports(parse_qsf(qsf_text), entity)
            errors.extend(port_errors)
            qsf_warnings.extend(port_warnings)
        qsf_pins = (qsf_info or {}).get("pins")
        bit_pins = (qsf_info or {}).get("bitPins")
        if qsf_text is not None and errors:
            return {
                "ok": False,
                "entity": entity.as_dict() if entity else None,
                "board": map_board(entity, qsf_pins, strict_pins=strict_pins, bit_pins=bit_pins).as_dict() if entity else {},
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

        entity_names = [e.name for e in design.entities]
        sources, file_aliases = _prepare_sources_for_ghdl(sources)
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
            errors = _rewrite_diagnostic_files(errors, file_aliases, v_line_maps)
            logs = result.output
            qsf_pinned = set((qsf_info or {}).get("pins", {}))
            warnings = (_nonsynth_warnings(combined) + _pin_warnings(entity, qsf_pinned)
                        + _warnings(result.diagnostics) + _io_warnings(entity)
                        + _resource_warnings(combined)
                        + (qsf_warnings if qsf_text is not None else []))

            warnings = _rewrite_diagnostic_files(warnings, file_aliases, v_line_maps)
            if result.ok:
                synth = self.ghdl.synthesize(paths, work, entity.name)
                warnings.extend(_rewrite_diagnostic_files(_synthesis_warnings(synth), file_aliases, v_line_maps))

            board_dict = map_board(entity, qsf_pins, strict_pins=strict_pins, bit_pins=bit_pins).as_dict()
            if not result.ok:
                return {
                    "ok": False,
                    "entity": entity.as_dict(),
                    "board": board_dict,
                    "errors": errors or [{"message": result.output[-2000:], "line": 0, "column": 0, "severity": "error"}],
                    "warnings": warnings,
                    "entities": entity_names,
                    "logs": logs,
                }

            elaboration = self.ghdl.elaborate(entity.name, work)
            errors.extend(diagnostic.as_dict() for diagnostic in elaboration.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(elaboration.diagnostics))
            errors = _rewrite_diagnostic_files(errors, file_aliases, v_line_maps)
            warnings = _rewrite_diagnostic_files(warnings, file_aliases, v_line_maps)
            if not elaboration.ok:
                return {
                    "ok": False,
                    "entity": entity.as_dict(),
                    "board": board_dict,
                    "errors": errors or [{"message": elaboration.output[-2000:], "line": 0, "column": 0, "severity": "error"}],
                    "warnings": warnings,
                    "logs": logs + "\n" + elaboration.output,
                }

            return {
                "ok": True,
                "entity": entity.as_dict(),
                "board": board_dict,
                "qsf": qsf_info,
                "errors": errors,
                "warnings": warnings,
                "entities": entity_names,
                "logs": logs,
            }
        except GhdlNotFoundError as exc:
            return {
                "ok": False,
                "entity": entity.as_dict(),
                "board": map_board(entity, qsf_pins, strict_pins=strict_pins, bit_pins=bit_pins).as_dict(),
                "errors": [{"message": str(exc), "line": 0, "column": 0, "severity": "error"}],
                "warnings": [],
                "logs": "",
            }
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    # -- simulate ---------------------------------------------------------
    def cancel(self, token: Optional[dict] = None) -> bool:
        """Abort the in-flight GHDL run of this simulator (stop/cancel path).

        The session passes ITS per-run token; only that run's GHDL child is
        killed. The cancelled run returns a not-ok result which the session
        worker discards (the stop path already emitted sim_stopped).

        When no token is supplied (QA / CLI), the simulator's own active token
        is used; if no child exists yet, a cancel flag makes the worker abort
        at the next phase boundary (ENG-03B).
        """
        self._cancel_requested = True
        tok = token if token is not None else self._active_token
        if not isinstance(tok, dict):
            return False
        return self.ghdl.cancel_token(tok)

    def clear_request_cache(self) -> None:
        """Drop every cached interactive result (call on device/profile change)."""
        self._req_cache.clear()

    def simulate(self, request: SimulationRequest,
                 cancel_token: Optional[dict] = None) -> Dict[str, Any]:
        """Simulate a design (see :meth:`_simulate_dispatch`)."""
        cache_key = request.cache_key() if request.compact_board else None
        if cache_key is not None:
            cached = self._req_cache.get(cache_key)
            if cached is not None:
                # Interactive re-run of a known (design, stimulus) pair: 0 ms.
                return dict(cached)
        result = self._simulate_dispatch(request, cancel_token)
        if isinstance(result, dict) and result.get("errors"):
            result["errors"] = _augment_syntax_hints(result["errors"])
        if cache_key is not None and isinstance(result, dict) and result.get("ok"):
            self._req_cache[cache_key] = result
            while len(self._req_cache) > _REQ_CACHE_MAX:
                self._req_cache.popitem(last=False)
        return result

    def _simulate_dispatch(self, request: SimulationRequest,
                           cancel_token: Optional[dict] = None) -> Dict[str, Any]:
        """Simulate a design.

        Without ``library_cache`` every call runs the classic isolated flow: a
        fresh temp workdir and a full GHDL analyze -> synthesize-lint ->
        elaborate -> run cycle.  With ``library_cache`` the board models are
        analyzed once into a shared work library and repeat (design, testbench)
        pairs skip analysis and the lint pass entirely.  Any cache trouble
        falls back to the isolated flow, so results are identical either way.
        """
        # per-run cancel token (ENG-03): the session holds this token and
        # kills exactly this run via cancel(token) — no shared flag can
        # poison an unrelated compile or another session's run.  A caller
        # without a token (REST /api/simulate, CLI) gets a private one.
        if cancel_token is None:
            cancel_token = {"cancelled": False, "proc": None}
        self._cancel_requested = False
        self._active_token = cancel_token
        try:
            if self.library_cache is not None:
                try:
                    return self._simulate_cached(request, cancel_token)
                except Exception:  # pragma: no cover - the cache must never change a result
                    return self._simulate_isolated(request, cancel_token)
            self.last_cache_outcome = "none"
            return self._simulate_uncached(request, cancel_token)
        finally:
            if self._active_token is cancel_token:
                self._active_token = None

    def _simulate_uncached(self, request: SimulationRequest,
                           cancel_token: Optional[dict] = None) -> Dict[str, Any]:
        prep, early = self._prepare(request)
        if early is not None:
            return early
        if self._cancel_requested:
            return self._failure("Simulation cancelled")
        return self._ghdl_phase_isolated(prep, cancel_token)

    # -- cache bookkeeping ------------------------------------------------
    def warm(self) -> bool:
        """Pre-analyze the board model set into the library cache (opt-in).

        No-op (returns False) when no ``library_cache`` is configured.  Safe to
        call repeatedly; only the first call after a models/GHDL change does
        any GHDL work.
        """
        if self.library_cache is None:
            return False
        return self._cache_warm_models()

    def _analyze_signature(self) -> str:
        """Everything besides the sources that influences GHDL analysis."""
        return f"backend=ghdl;std={self.ghdl.std};flags=-a,-Werror=binding"

    def _cache_load_manifest(self) -> dict:
        if self._manifest is not None:
            return self._manifest
        manifest: dict = {}
        try:
            path = self.library_cache / "manifest.json"  # type: ignore[union-attr]
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                manifest = loaded
        except (OSError, ValueError):
            manifest = {}
        manifest.setdefault("entries", {})
        manifest.setdefault("unit_owners", {})
        manifest.setdefault("file_hashes", [])
        self._manifest = manifest
        return manifest

    def _cache_save_manifest(self, manifest: dict) -> None:
        # Best-effort: a cache write failure must never fail a simulation.
        try:
            path = self.library_cache / "manifest.json"  # type: ignore[union-attr]
            tmp = path.with_name("manifest.json.tmp")
            tmp.write_text(json.dumps(manifest), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            pass

    def _cache_invalidate(self) -> None:
        """Delete the whole cache directory (stale or corrupt beyond repair)."""
        self._manifest = None
        if self.library_cache is not None:
            shutil.rmtree(self.library_cache, ignore_errors=True)

    def _cache_warm_models(self) -> bool:
        """Analyze the board model set once into <cache>/work.

        Returns False when the cache cannot be used at all; the caller then
        falls back to the classic isolated flow.
        """
        cache = self.library_cache
        if cache is None:
            return False
        try:
            version = self.ghdl.version()
        except GhdlNotFoundError:
            return False
        self._ghdl_version = version
        model_sources = sorted((ROOT / "board" / "models").glob("*.vhd"))
        if not model_sources:
            return False
        hasher = hashlib.sha256()
        hasher.update(f"ghdl={version}\n".encode())
        hasher.update(f"analyze={self._analyze_signature()}\n".encode())
        for path in model_sources:
            hasher.update(f"model={path.name}\n".encode())
            hasher.update(hashlib.sha256(path.read_bytes()).hexdigest().encode())
            hasher.update(b"\x00")
        models_key = hasher.hexdigest()
        manifest = self._cache_load_manifest()
        if manifest.get("models_key") == models_key:
            self._models_key = models_key
            return True
        # First warm-up, or the models/GHDL changed: rebuild from scratch.
        self._cache_invalidate()
        manifest = self._cache_load_manifest()
        try:
            models_dir = cache / "models"
            models_dir.mkdir(parents=True, exist_ok=True)
            work = cache / "work"
            work.mkdir(parents=True, exist_ok=True)
            copies = []
            for path in model_sources:
                dst = models_dir / path.name
                shutil.copyfile(path, dst)
                copies.append(dst)
            result = self.ghdl.analyze(copies, work, cwd=cache)
        except OSError:
            return False
        if not result.ok:
            self._cache_invalidate()
            return False
        manifest["models_key"] = models_key
        manifest["ghdl"] = version
        manifest["std"] = self.ghdl.std
        self._cache_save_manifest(manifest)
        self._models_key = models_key
        return True

    def _case_cache_key(self, sources: List[tuple[str, str]], tb_source: str) -> str:
        hasher = hashlib.sha256()
        hasher.update(f"models={self._models_key}\n".encode())
        hasher.update(f"ghdl={self._ghdl_version}\n".encode())
        hasher.update(f"analyze={self._analyze_signature()}\n".encode())
        for name, content in sources:
            hasher.update(f"file={name}\x00".encode())
            hasher.update(_content_hash(content).encode())
            hasher.update(b"\x00")
        hasher.update(b"testbench\x00")
        hasher.update(_content_hash(tb_source).encode())
        return hasher.hexdigest()

    def _cache_plan(
        self, manifest: dict, key: str, sources: List[tuple[str, str]], tb_source: str
    ) -> tuple[List[tuple[str, str, List[str]]], bool]:
        """Decide which files still need analysis into the shared library.

        Returns (files to analyze, conflict).  A conflict means another cache
        entry already owns a unit name carried by different content; the case
        must then run in an isolated workdir instead of the shared library.
        """
        known = set(manifest["file_hashes"])
        owners = manifest["unit_owners"]
        plan: List[tuple[str, str, List[str]]] = []
        for name, content in sources:
            if _content_hash(content) in known:
                continue  # identical file already analyzed into the library
            units = [e.name for e in VHDLParser().parse(content).entities]
            if any(owners.get(u) not in (None, key) for u in units):
                return [], True
            plan.append((name, content, units))
        if _content_hash(tb_source) not in known:
            units = [e.name for e in VHDLParser().parse(tb_source).entities]
            if any(owners.get(u) not in (None, key) for u in units):
                return [], True
            plan.append(("testbench.vhd", tb_source, units))
        return plan, False

    def _entry_consistent(self, manifest: dict, key: str, entry: dict) -> bool:
        owners = manifest["unit_owners"]
        return all(owners.get(unit) == key for unit in entry.get("units", []))

    # -- simulate, cached -------------------------------------------------
    def _simulate_cached(self, request: SimulationRequest,
                         cancel_token: Optional[dict] = None) -> Dict[str, Any]:
        cache = self.library_cache
        if cache is None:  # pragma: no cover - dispatcher guarantees a cache
            return self._simulate_uncached(request, cancel_token)
        # Serialize the whole cached flow per cache directory: ``ghdl -a``
        # rewrites the shared work library file while ``-e``/``-r`` read it.
        with _cache_lock_for(cache):
            if not self._cache_warm_models():
                self.library_cache = None
                self._manifest = None
                return self._simulate_uncached(request, cancel_token)
            prep, early = self._prepare(request)
            if early is not None:
                return early
            manifest = self._cache_load_manifest()
            key = self._case_cache_key(prep.sources, prep.tb_source)
            entry = manifest["entries"].get(key)
            if entry is not None and not self._entry_consistent(manifest, key, entry):
                # Manifest inconsistency: wipe the cache, rebuild, treat as a miss.
                self._cache_invalidate()
                if not self._cache_warm_models():
                    self.library_cache = None
                    self._manifest = None
                    return self._ghdl_phase_isolated(prep)
                manifest = self._cache_load_manifest()
                entry = None
            return self._ghdl_phase_cached(prep, manifest, key, entry, cancel_token)

    def _ghdl_phase_cached(
        self, prep: _Prep, manifest: dict, key: str, entry: Optional[dict],
        cancel_token: Optional[dict] = None,
    ) -> Dict[str, Any]:
        request = prep.request
        cache = self.library_cache
        assert cache is not None
        workdir = Path(tempfile.mkdtemp(prefix="cyclone_sim_"))
        keep = os.environ.get("CYCLESIM_KEEP_DIR", "") not in ("", "0", "false", "False")
        errors = list(prep.errors)
        warnings = list(prep.warnings)
        try:
            _write_memory_init(workdir, request)
            work = cache / "work"
            vcd_file = workdir / "wave.vcd"
            if entry is not None:
                # Cache hit: the units are already analyzed; skip analyze AND
                # the synthesize-lint pass, replaying their recorded evidence
                # so the result matches the uncached path exactly.
                self.last_cache_outcome = "hit"
                errors.extend(entry.get("analyze_errors", []))
                warnings.extend(entry.get("analyze_warnings", []))
                logs = entry.get("analyze_output", "")
                warnings.extend(entry.get("synth_warnings", []))
            else:
                plan, conflict = self._cache_plan(manifest, key, prep.sources, prep.tb_source)
                if conflict:
                    # Another entry owns a unit name with different content;
                    # the shared library cannot hold this case.  Isolated run.
                    return self._simulate_isolated_prep(prep, cancel_token)
                # Persist the sources under the cache: GHDL's work library
                # references them by path at elaborate/run time.
                key_dir = cache / "sources" / key
                key_dir.mkdir(parents=True, exist_ok=True)
                design_paths: List[Path] = []
                for name, content in prep.sources:
                    (key_dir / name).write_text(content, encoding="utf-8")
                    design_paths.append(key_dir / name)
                (key_dir / "testbench.vhd").write_text(prep.tb_source, encoding="utf-8")
                analyze_paths = [key_dir / name for name, _content, _units in plan]
                if analyze_paths:
                    analyze = self.ghdl.analyze(analyze_paths, work, cwd=workdir, token=cancel_token)
                else:  # pragma: no cover - defensive: everything already there
                    analyze = CommandResult(ok=True)
                if _looks_like_cache_corruption(analyze):
                    # GHDL saw a duplicate/redefined unit: the shared library is
                    # not trustworthy.  Wipe it, rebuild, run this case isolated.
                    self._cache_invalidate()
                    return self._simulate_isolated_prep(prep, cancel_token)
                errors.extend(diagnostic.as_dict() for diagnostic in analyze.diagnostics if diagnostic.severity == "error")
                errors = _rewrite_diagnostic_files(errors, prep.aliases, prep.line_maps)

                warnings.extend(_warnings(analyze.diagnostics))
                warnings = _rewrite_diagnostic_files(warnings, prep.aliases, prep.line_maps)

                logs = analyze.output
                synth_warnings: List[dict] = []
                if analyze.ok and not prep.request.skip_synth:
                    synth = self.ghdl.synthesize(design_paths, work, prep.entity.name, cwd=workdir, token=cancel_token)
                    synth_warnings = _rewrite_diagnostic_files(_synthesis_warnings(synth), prep.aliases, prep.line_maps)
                    warnings.extend(synth_warnings)
                if not analyze.ok:
                    # Do not record failures: the library may hold partial
                    # units.  The duplicate-unit backstop above rebuilds the
                    # library if that ever bites.
                    self.last_cache_outcome = "miss"
                    return self._failure("VHDL analysis failed", errors, logs, keep, workdir, warnings)
                manifest["entries"][key] = {
                    "units": [unit for (_n, _c, units) in plan for unit in units],
                    "analyze_output": analyze.output,
                    "analyze_errors": [d.as_dict() for d in analyze.diagnostics if d.severity == "error"],
                    "analyze_warnings": [d.as_dict() for d in analyze.diagnostics if d.severity.lower() == "warning"],
                    "synth_warnings": synth_warnings,
                }
                for _name, content, units in plan:
                    content_hash = _content_hash(content)
                    if content_hash not in manifest["file_hashes"]:
                        manifest["file_hashes"].append(content_hash)
                    for unit in units:
                        manifest["unit_owners"][unit] = key
                self._cache_save_manifest(manifest)
                self.last_cache_outcome = "miss"

            elaborate = self.ghdl.elaborate(prep.top, work, cwd=workdir, token=cancel_token)
            errors.extend(diagnostic.as_dict() for diagnostic in elaborate.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(elaborate.diagnostics))
            errors = _rewrite_diagnostic_files(errors, prep.aliases, prep.line_maps)
            warnings = _rewrite_diagnostic_files(warnings, prep.aliases, prep.line_maps)
            logs += "\n" + elaborate.output
            if not elaborate.ok:
                return self._failure("Elaboration failed", errors, logs, keep, workdir, warnings)

            stop_time = max(1.0, float(request.duration) + 2.0 * float(request.clock_period))
            run = self.ghdl.run(prep.top, work, vcd_file, stop_time, cwd=workdir, token=cancel_token)
            errors.extend(diagnostic.as_dict() for diagnostic in run.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(run.diagnostics))
            errors = _rewrite_diagnostic_files(errors, prep.aliases, prep.line_maps)
            warnings = _rewrite_diagnostic_files(warnings, prep.aliases, prep.line_maps)
            logs += "\n" + run.output
            if not run.ok or not vcd_file.exists():
                return self._failure("Simulation run failed", errors, logs, keep, workdir, warnings)

            try:
                vcd = parse_vcd(str(vcd_file))
            except Exception as exc:  # pragma: no cover - corrupt VCD
                return self._failure(f"Could not parse VCD: {exc}", errors, logs, keep, workdir)

            waveform, full_transitions = build_waveform(
                vcd,
                prep.entity,
                root=prep.root,
                max_cycles=request.max_cycles,
                duration_cap=float(request.duration),
                compact=request.compact_board,
                qsf_pins=(prep.qsf_info or {}).get("pins"),
                strict_pins=request.strict_pins,
                bit_pins=(prep.qsf_info or {}).get("bitPins"),
            )

            # On-board peripheral decoding (board_spec.md section D/E).
            # The decoders consume the FULL transition lists: the serialized
            # payload's transitions are capped (audit N2) and a decimated
            # timeline would corrupt the UART/buzzer/VGA decoders.
            peripherals: Dict[str, Any] = {}
            dumps = read_model_dumps(workdir)
            if dumps:
                peripherals.update(dumps)
            try:
                if "UART_TXD" in full_transitions:
                    peripherals["uart"] = decode_uart(full_transitions["UART_TXD"])
                buz_pin = str(BOARD.get("buzzer", {}).get("pin") or "").upper()
                buz_port = next(
                    (
                        port for port, plist in (waveform.get("board", {}).get("pins") or {}).items()
                        if any(str(p).upper() == buz_pin for p in (plist or []))
                    ),
                    None,
                )
                if buz_port and buz_port.upper() in full_transitions:
                    peripherals["buzzer"] = decode_buzzer(
                        full_transitions[buz_port.upper()],
                        clock_ns=float(request.clock_period),
                        active_low=bool(BOARD["buzzer"].get("activeLow", True)),
                    )
                if all(k in full_transitions for k in ("VGA_HSYNC", "VGA_VSYNC", "VGA_R", "VGA_G", "VGA_B")):
                    peripherals["vga"] = decode_vga(
                        full_transitions["VGA_HSYNC"],
                        full_transitions["VGA_VSYNC"],
                        full_transitions["VGA_R"],
                        full_transitions["VGA_G"],
                        full_transitions["VGA_B"])
            except Exception:
                pass  # peripheral decoding is best-effort

            result: Dict[str, Any] = {
                "ok": True,
                "entity": prep.entity.as_dict(),
                "board": waveform.get("board", map_board(prep.entity, (prep.qsf_info or {}).get("pins"), strict_pins=request.strict_pins, bit_pins=(prep.qsf_info or {}).get("bitPins")).as_dict()),
                "top": prep.top,
                "duration": waveform.get("duration", request.duration),
                "timeScale": _time_scale(request),
                "waveforms": waveform,
                "peripherals": peripherals,
                "qsf": prep.qsf_info,
                "entities": prep.entities,
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

    def _simulate_isolated(self, request: SimulationRequest,
                           cancel_token: Optional[dict] = None) -> Dict[str, Any]:
        """Run one request through the classic isolated temp-workdir flow."""
        prep, early = self._prepare(request)
        if early is not None:
            return early
        return self._simulate_isolated_prep(prep, cancel_token)

    def _simulate_isolated_prep(self, prep: _Prep,
                                cancel_token: Optional[dict] = None) -> Dict[str, Any]:
        self.last_cache_outcome = "fallback"
        return self._ghdl_phase_isolated(prep, cancel_token)

    # -- simulate, shared preparation -------------------------------------
    def _prepare(self, request: SimulationRequest) -> tuple[Optional[_Prep], Optional[Dict[str, Any]]]:
        """Pure-Python phase shared by both flows: parse, validate, build TB.

        Returns (prep, None) on success or (None, failure-result) when the
        request cannot proceed to GHDL at all.
        """
        raw_sources = _sources(request.vhdl, request.files)
        sources, v_line_maps, v_errors = translate_verilog_sources(raw_sources)
        if v_errors:
            return None, self._failure(v_errors[0]["message"], v_errors)
        combined = "\n".join(content for _, content in sources)
        unsupported = _unsupported_source(combined)
        if unsupported is not None:
            return None, self._failure(unsupported["message"], [unsupported])

        # Audit N7 / ENG-07 mitigation: reject literal absolute host paths in
        # textio before GHDL ever runs (RB-05 wrote to %TEMP% with process
        # privileges).  Relative textio inside the throw-away workdir stays
        # allowed - that is the documented, tested behaviour (RB-05B).
        escape_errors = _textio_escape_errors(sources)
        if escape_errors:
            return None, self._failure(
                "uploaded VHDL opens files outside the simulation work directory",
                escape_errors,
            )

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
                return None, self._failure(f"Top entity '{top_name}' not found", errors, warnings=qsf_warnings)
        else:
            entity = self._select_entity(design, request.top, sources=sources)
        if entity is None:
            errors.append(
                {
                    "message": "No entity declaration found in the VHDL source",
                    "line": 1,
                    "column": 1,
                    "severity": "error",
                }
            )
            return None, self._failure("No entity to simulate", errors, warnings=qsf_warnings)
        models = board_models(entity)
        # Behavioral altpll megafunction model (BLK-02): only when the source
        # actually instantiates it, so designs that define their own altpll
        # entity are not shadowed.
        if re.search(r"\baltpll\b", combined, re.IGNORECASE) and not any(
            m.get("kind") == "altpll" for m in models
        ):
            models.append({"kind": "altpll"})
        if qsf_text is not None and entity is not None:
            port_errors, port_warn = _validate_qsf_ports(
                parse_qsf(qsf_text), entity)
            errors.extend(port_errors)
            qsf_warnings.extend(port_warn)

        if qsf_text is not None and errors:
            return None, self._failure("the .qsf contains errors", errors, warnings=qsf_warnings)

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

        qsf_pinned = set((qsf_info or {}).get("pins", {}))
        warnings: List[dict] = (_request_warnings(request)
                                + _nonsynth_warnings(combined) + _pin_warnings(entity, qsf_pinned)
                                + _io_warnings(entity) + _resource_warnings(combined)
                                + lint_sources(sources)
                                + (qsf_warnings if qsf_text is not None else []))

        ghdl_sources, file_aliases = _prepare_sources_for_ghdl(sources)
        warnings = _rewrite_diagnostic_files(warnings, file_aliases, v_line_maps)
        prep = _Prep(
            request=request,
            sources=ghdl_sources,
            combined=combined,
            errors=errors,
            warnings=warnings,
            qsf_text=qsf_text,
            qsf_info=qsf_info,
            entity=entity,
            top=top,
            root=root,
            tb_source=tb_source,
            models=models,
            aliases=file_aliases,
            line_maps=v_line_maps,
            entities=[e.name for e in design.entities],
        )
        return prep, None

    def _ghdl_phase_isolated(self, prep: _Prep,
                             cancel_token: Optional[dict] = None) -> Dict[str, Any]:
        """Classic flow: fresh temp workdir, full GHDL cycle per call."""
        request = prep.request
        sources = prep.sources
        entity = prep.entity
        top = prep.top
        root = prep.root
        tb_source = prep.tb_source
        models = prep.models
        errors = prep.errors
        workdir = Path(tempfile.mkdtemp(prefix="cyclone_sim_"))
        keep = os.environ.get("CYCLESIM_KEEP_DIR", "") not in ("", "0", "false", "False")
        warnings = list(prep.warnings)
        file_aliases = prep.aliases
        try:
            _write_memory_init(workdir, request)
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
            analyze = self.ghdl.analyze(design_paths + model_paths + [tb_file], work, token=cancel_token)
            errors.extend(diagnostic.as_dict() for diagnostic in analyze.diagnostics if diagnostic.severity == "error")
            errors = _rewrite_diagnostic_files(errors, prep.aliases, prep.line_maps)

            warnings.extend(_warnings(analyze.diagnostics))
            warnings = _rewrite_diagnostic_files(warnings, prep.aliases, prep.line_maps)

            logs = analyze.output
            if analyze.ok and not prep.request.skip_synth:
                synth = self.ghdl.synthesize(design_paths, work, entity.name)
                warnings.extend(_synthesis_warnings(synth))
    
            warnings = _rewrite_diagnostic_files(warnings, prep.aliases, prep.line_maps)
            if not analyze.ok:
                return self._failure("VHDL analysis failed", errors, logs, keep, workdir, warnings)

            elaborate = self.ghdl.elaborate(top, work, token=cancel_token)
            errors.extend(diagnostic.as_dict() for diagnostic in elaborate.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(elaborate.diagnostics))
            errors = _rewrite_diagnostic_files(errors, prep.aliases, prep.line_maps)
            warnings = _rewrite_diagnostic_files(warnings, prep.aliases, prep.line_maps)
            logs += "\n" + elaborate.output
            if not elaborate.ok:
                return self._failure("Elaboration failed", errors, logs, keep, workdir, warnings)

            stop_time = max(1.0, float(request.duration) + 2.0 * float(request.clock_period))
            run = self.ghdl.run(top, work, vcd_file, stop_time, token=cancel_token)
            errors.extend(diagnostic.as_dict() for diagnostic in run.diagnostics if diagnostic.severity == "error")
            warnings.extend(_warnings(run.diagnostics))
            errors = _rewrite_diagnostic_files(errors, prep.aliases, prep.line_maps)
            warnings = _rewrite_diagnostic_files(warnings, prep.aliases, prep.line_maps)
            logs += "\n" + run.output
            if not run.ok or not vcd_file.exists():
                return self._failure("Simulation run failed", errors, logs, keep, workdir, warnings)

            try:
                vcd = parse_vcd(str(vcd_file))
            except Exception as exc:  # pragma: no cover - corrupt VCD
                return self._failure(f"Could not parse VCD: {exc}", errors, logs, keep, workdir, warnings)

            waveform, full_transitions = build_waveform(
                vcd,
                entity,
                root=root,
                max_cycles=request.max_cycles,
                duration_cap=float(request.duration),
                compact=request.compact_board,
                qsf_pins=(prep.qsf_info or {}).get("pins"),
                strict_pins=request.strict_pins,
                bit_pins=(prep.qsf_info or {}).get("bitPins"),
            )

            # On-board peripheral decoding (board_spec.md section D/E).
            # The decoders consume the FULL transition lists: the serialized
            # payload's transitions are capped (audit N2) and a decimated
            # timeline would corrupt the UART/buzzer/VGA decoders.
            peripherals: Dict[str, Any] = {}
            dumps = read_model_dumps(workdir)
            if dumps:
                peripherals.update(dumps)
            try:
                if "UART_TXD" in full_transitions:
                    peripherals["uart"] = decode_uart(full_transitions["UART_TXD"])
                buz_pin = str(BOARD.get("buzzer", {}).get("pin") or "").upper()
                buz_port = next(
                    (
                        port for port, plist in (waveform.get("board", {}).get("pins") or {}).items()
                        if any(str(p).upper() == buz_pin for p in (plist or []))
                    ),
                    None,
                )
                if buz_port and buz_port.upper() in full_transitions:
                    peripherals["buzzer"] = decode_buzzer(
                        full_transitions[buz_port.upper()],
                        clock_ns=float(request.clock_period),
                        active_low=bool(BOARD["buzzer"].get("activeLow", True)),
                    )
                if all(k in full_transitions for k in ("VGA_HSYNC", "VGA_VSYNC", "VGA_R", "VGA_G", "VGA_B")):
                    peripherals["vga"] = decode_vga(
                        full_transitions["VGA_HSYNC"],
                        full_transitions["VGA_VSYNC"],
                        full_transitions["VGA_R"],
                        full_transitions["VGA_G"],
                        full_transitions["VGA_B"])
            except Exception:
                pass  # peripheral decoding is best-effort

            result: Dict[str, Any] = {
                "ok": True,
                "entity": entity.as_dict(),
                "board": waveform.get("board", map_board(entity, (prep.qsf_info or {}).get("pins"), strict_pins=request.strict_pins, bit_pins=(prep.qsf_info or {}).get("bitPins")).as_dict()),
                "top": top,
                "duration": waveform.get("duration", request.duration),
                "timeScale": _time_scale(request),
                "waveforms": waveform,
                "peripherals": peripherals,
                "qsf": prep.qsf_info,
                "entities": prep.entities,
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
    def _select_entity(
        design,
        requested: Optional[str],
        required: bool = False,
        sources: Optional[List[tuple[str, str]]] = None,
    ) -> Optional[Entity]:
        if requested:
            for entity in design.entities:
                if entity.name.lower() == requested.lower():
                    return entity
            if required:
                return None
        candidates = [e for e in design.entities if not e.name.lower().startswith("tb_")]
        if not candidates:
            candidates = list(design.entities)
        if not candidates:
            return None
        graph: Dict[str, set[str]] = _instantiation_map(sources) if (len(candidates) > 1 and sources) else {}
        if len(candidates) > 1 and sources:
            cand_names = {e.name.lower() for e in candidates}
            referenced: set[str] = set()
            for owner, children in graph.items():
                if owner in cand_names:
                    referenced.update(children)
            roots = [e for e in candidates if e.name.lower() not in referenced]
            if len(roots) == 1:
                return roots[0]
            if len(roots) > 1:
                candidates = roots
        if len(candidates) > 1:
            best = max(
                candidates,
                key=lambda ent: (
                    1 if graph.get(ent.name.lower()) else 0,
                    len(map_board(ent).pins),
                ),
            )
            if graph.get(best.name.lower()) or map_board(best).pins:
                return best
        return candidates[0]

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