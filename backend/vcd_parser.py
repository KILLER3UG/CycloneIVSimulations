"""VCD (Value Change Dump) parser.

GHDL writes a standard VCD file when invoked with ``--vcd=...``.  The parser
converts it into a compact, JSON-friendly structure: a list of signals, each
with a list of ``(time_ns, value)`` transitions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

_TIME_UNIT_NS = {
    "s": 1e9,
    "sec": 1e9,
    "second": 1e9,
    "ms": 1e6,
    "us": 1e3,
    "µs": 1e3,
    "ns": 1.0,
    "ps": 1e-3,
    "fs": 1e-6,
}

_VECTOR_PREFIXES = ("b", "B", "r", "R", "s", "S")
_SCALAR_VALUES = set("01xXzZhHuUwWlL-")

_TIMESCALE_RE = re.compile(r"(\d+)\s*([a-zA-Zµ]+)")


@dataclass
class VcdSignal:
    identifier: str
    name: str
    scope: str
    width: int
    kind: str  # reg, wire, integer, ...
    transitions: List[Tuple[float, Any]] = field(default_factory=list)
    #: Raw $var reference as written in the VCD (e.g. ``led [7]``).  ModelSim
    #: dumps vectors bit-sliced, so the raw reference is needed to reassemble
    #: them (the GHDL path emits one var per vector instead).
    reference: str = ""

    @property
    def path(self) -> str:
        return f"{self.scope}.{self.name}" if self.scope else self.name

    def initial(self) -> Any:
        return self.transitions[0][1] if self.transitions else None

    def final_value(self) -> Any:
        return self.transitions[-1][1] if self.transitions else None

    def value_at(self, time_ns: float) -> Any:
        value = self.initial()
        for timestamp, item in self.transitions:
            if timestamp <= time_ns:
                value = item
            else:
                break
        return value

    def to_dict(self) -> dict:
        return {
            "id": self.path,
            "name": self.name,
            "scope": self.scope,
            "width": self.width,
            "type": self.kind,
            "transitions": [[time, value] for time, value in self.transitions],
        }


@dataclass
class VcdData:
    timescale_ns: float
    signals: List[VcdSignal]
    duration_ns: float
    raw_signals: Dict[str, VcdSignal] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "timescaleNs": self.timescale_ns,
            "duration": self.duration_ns,
            "signals": [signal.to_dict() for signal in self.signals],
        }


def _convert_vector(text: str) -> Any:
    """Convert a VCD binary/real vector to int (or keep x/z as string).

    int-first: pure-binary values (the vast majority of vector changes)
    convert in one C call; x/z detection uses four C-level containment
    scans instead of a per-character generator (measured ~2x faster on a
    975k-transition buzz1 dump, output identical).
    """
    try:
        return int(text, 2)
    except ValueError:
        pass
    if "x" in text or "X" in text or "z" in text or "Z" in text:
        return text.lower()
    try:
        return int(float(text))
    except ValueError:
        return text


def parse_vcd(path: str) -> VcdData:
    """Parse a VCD file by streaming it line by line.

    Large dumps (hundreds of MB) must not be materialised as one string, so
    the file handle is consumed incrementally; the parsed result is identical
    to :func:`parse_vcd_text`.
    """
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return _parse_vcd_lines(handle)


def parse_vcd_text(text: str) -> VcdData:
    """Parse a VCD from an in-memory string (kept for tests/compat)."""
    return _parse_vcd_lines(text.splitlines())


_VECTOR_CHANGE_RE = re.compile(r"^([bB])\s*([01xXzZhHuUwWlL-]+)\s*(\S+)$")
_REAL_CHANGE_RE = re.compile(r"^([rRsS])\s*([^\s]+)\s+(\S+)$")


def _parse_vcd_lines(lines: Iterable[str]) -> VcdData:
    timescale_ns = 1.0
    scope_stack: List[str] = []
    signals: Dict[str, VcdSignal] = {}
    aliases: Dict[str, List[VcdSignal]] = {}
    order: List[VcdSignal] = []

    def _record_transition(identifier: str, current_time: float, value: Any) -> None:
        sigs = aliases.get(identifier)
        if not sigs:
            return
        for sig in sigs:
            sig.transitions.append((current_time, value))

    # Tokenize incrementally without losing line-level speed on large VCDs:
    # We flatten lines only for header / multi-directive / multi-value lines.
    header_done = False
    current_time = 0.0
    duration = 0.0

    # Header state machine
    in_cmd: Optional[str] = None
    cmd_tokens: List[str] = []

    def _handle_header_cmd(cmd: str, args: List[str]) -> bool:
        nonlocal timescale_ns
        if cmd == "$timescale":
            joined = " ".join(args)
            match = _TIMESCALE_RE.search(joined)
            if match:
                factor = _TIME_UNIT_NS.get(match.group(2).lower(), 1.0)
                timescale_ns = int(match.group(1)) * factor
        elif cmd == "$scope" and len(args) >= 2:
            scope_stack.append(args[1])
        elif cmd == "$upscope":
            if scope_stack:
                scope_stack.pop()
        elif cmd == "$var" and len(args) >= 4:
            kind = args[0]
            try:
                width = int(args[1])
            except ValueError:
                width = 1
            identifier = args[2]
            reference = " ".join(args[3:])
            name = reference.split("[")[0].strip()
            signal = VcdSignal(
                identifier=identifier,
                name=name,
                scope=".".join(scope_stack),
                width=max(1, width),
                kind=kind,
                reference=reference,
            )
            signals.setdefault(identifier, signal)
            aliases.setdefault(identifier, []).append(signal)
            order.append(signal)
        elif cmd == "$enddefinitions":
            return True
        return False

    def _process_value_tokens(tokens: List[str]) -> None:
        nonlocal current_time, duration
        idx = 0
        n = len(tokens)
        while idx < n:
            tok = tokens[idx]
            idx += 1
            if not tok:
                continue
            if tok.startswith("$"):
                # $dumpvars / $dumpon / $dumpoff / $dumpall / $end / $comment ...
                if tok == "$comment":
                    while idx < n and tokens[idx] != "$end":
                        idx += 1
                    if idx < n and tokens[idx] == "$end":
                        idx += 1
                continue
            if tok.startswith("#"):
                try:
                    current_time = int(tok[1:]) * timescale_ns
                except ValueError:
                    continue
                duration = max(duration, current_time)
                continue
            first = tok[0]
            if first in "bBrRsS":
                if len(tok) > 1:
                    val_text = tok[1:]
                    if idx < n:
                        ident = tokens[idx]
                        idx += 1
                        _record_transition(ident, current_time, _convert_vector(val_text))
                        duration = max(duration, current_time)
                continue
            if first in _SCALAR_VALUES and len(tok) >= 2:
                _record_transition(tok[1:], current_time, first.lower())
                duration = max(duration, current_time)
                continue

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        if not header_done:
            for tok in line.split():
                if in_cmd is None:
                    if tok.startswith("$"):
                        if tok == "$enddefinitions":
                            # Wait for optional $end or finish immediately if none
                            in_cmd = "$enddefinitions"
                            cmd_tokens = []
                        else:
                            in_cmd = tok
                            cmd_tokens = []
                    continue
                if tok == "$end":
                    finished = _handle_header_cmd(in_cmd, cmd_tokens)
                    in_cmd = None
                    cmd_tokens = []
                    if finished:
                        header_done = True
                        break
                else:
                    cmd_tokens.append(tok)
            if in_cmd == "$enddefinitions" and not cmd_tokens:
                # Some minimal VCDs might write $enddefinitions without $end; wait for $end on same line first.
                pass
            continue

        # Fast-path common single-change lines generated by GHDL / ModelSim
        first = line[0]
        if first == "#" and " " not in line and "\t" not in line:
            try:
                current_time = int(line[1:]) * timescale_ns
            except ValueError:
                continue
            duration = max(duration, current_time)
            continue

        if first in "bB" and line.count(" ") <= 1 and "\t" not in line and "$" not in line and "#" not in line:
            match = _VECTOR_CHANGE_RE.match(line)
            if match:
                _record_transition(match.group(3), current_time, _convert_vector(match.group(2)))
                duration = max(duration, current_time)
                continue

        if first in _SCALAR_VALUES and len(line) >= 2 and " " not in line and "\t" not in line:
            _record_transition(line[1:], current_time, first.lower())
            duration = max(duration, current_time)
            continue

        # General tokenizer path for multi-token / inline $dumpvars / #time lines
        _process_value_tokens(line.split())

    return VcdData(
        timescale_ns=timescale_ns,
        signals=order,
        duration_ns=duration,
        raw_signals=signals,
    )


__all__ = ["VcdData", "VcdSignal", "parse_vcd", "parse_vcd_text"]