"""VCD (Value Change Dump) parser.

GHDL writes a standard VCD file when invoked with ``--vcd=...``.  The parser
converts it into a compact, JSON-friendly structure: a list of signals, each
with a list of ``(time_ns, value)`` transitions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

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
    """Convert a VCD binary/real vector to int (or keep x/z as string)."""
    if any(ch in "xXzZ" for ch in text):
        return text.lower()
    try:
        return int(text, 2)
    except ValueError:
        try:
            return int(float(text))
        except ValueError:
            return text


def parse_vcd(path: str) -> VcdData:
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return parse_vcd_text(handle.read())


def parse_vcd_text(text: str) -> VcdData:
    lines = text.splitlines()

    timescale_ns = 1.0
    scope_stack: List[str] = []
    signals: Dict[str, VcdSignal] = {}
    order: List[str] = []

    # ---- header ---------------------------------------------------------
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        index += 1
        if not line:
            continue
        if line.startswith("$timescale"):
            match = _TIMESCALE_RE.search(line)
            if not match:
                # GHDL writes the value on the following line:
                #   $timescale
                #     1 fs
                #   $end
                while index < len(lines) and not lines[index].strip():
                    index += 1
                if index < len(lines):
                    match = _TIMESCALE_RE.search(lines[index])
                    index += 1
            if match:
                factor = _TIME_UNIT_NS.get(match.group(2).lower(), 1.0)
                timescale_ns = int(match.group(1)) * factor
            continue
        if line.startswith("$scope"):
            parts = line.split()
            if len(parts) >= 3:
                scope_stack.append(parts[2])
            continue
        if line.startswith("$upscope"):
            if scope_stack:
                scope_stack.pop()
            continue
        if line.startswith("$var"):
            parts = line.split()
            if len(parts) >= 5:
                kind = parts[1]
                width = int(parts[2])
                identifier = parts[3]
                reference = parts[4]
                if reference.endswith("$end"):
                    reference = reference[:-4].strip()
                name = reference.split("[")[0].strip()
                signal = VcdSignal(
                    identifier=identifier,
                    name=name,
                    scope=".".join(scope_stack),
                    width=max(1, width),
                    kind=kind,
                )
                signals[identifier] = signal
                order.append(identifier)
            continue
        if line.startswith("$enddefinitions"):
            break
        # $date/$version/$comment blocks and everything else: skip
        if line.startswith("$"):
            continue

    # ---- value changes --------------------------------------------------
    current_time = 0.0
    duration = 0.0

    for raw_line in lines[index:]:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("$"):
            continue
        if line.startswith("#"):
            try:
                current_time = int(line[1:]) * timescale_ns
            except ValueError:
                continue
            duration = max(duration, current_time)
            continue

        # Vector value:  b1010 !   /  B1010 "   (space is optional)
        first = line[0]
        if first in _VECTOR_PREFIXES:
            body = line[1:].strip()
            parts = body.split()
            if len(parts) != 2:
                continue
            value_text, identifier = parts
            signal = signals.get(identifier)
            if signal is None:
                continue
            value = _convert_vector(value_text)
            signal.transitions.append((current_time, value))
            duration = max(duration, current_time)
            continue

        # Scalar value:  0!  1"  x#
        if first in _SCALAR_VALUES and len(line) >= 2:
            value = first.lower()
            identifier = line[1:].strip()
            signal = signals.get(identifier)
            if signal is None:
                continue
            signal.transitions.append((current_time, value))
            duration = max(duration, current_time)
            continue

    ordered = [signals[identifier] for identifier in order if identifier in signals]
    return VcdData(
        timescale_ns=timescale_ns,
        signals=ordered,
        duration_ns=duration,
        raw_signals=signals,
    )


__all__ = ["VcdData", "VcdSignal", "parse_vcd", "parse_vcd_text"]