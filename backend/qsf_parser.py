"""Quartus .qsf parser.

Parses the settings that matter for the simulator and validates them against
the fitted board (board_spec.md / backend.device):

* ``set_global_assignment -name TOP_LEVEL_ENTITY <t>``      -> top entity
* ``set_global_assignment -name DEVICE <d>``                -> device check
* ``set_global_assignment -name FAMILY "Cyclone IV E"``     -> family check
* ``set_global_assignment -name (VERILOG|VHDL|SYSTEMVERILOG)_FILE <f>`` -> file list
* ``set_location_assignment PIN_nn -to <port>``             -> pin assignment
* ``set_instance_assignment -name IO_STANDARD "..." -to <port>`` -> I/O standard
* ``set_global_assignment -name RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP ...`` -> unused-pin policy

Invalid pin numbers, pins outside the 144-pin package, duplicate pins and
assignments to ports that do not exist are reported as errors with line numbers.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

_LOCATION_RE = re.compile(r"^\s*set_location_assignment\s+(\S+)\s+-to\s+(\S+)\s*$", re.IGNORECASE)
_GLOBAL_RE = re.compile(r"^\s*set_global_assignment\s+-name\s+(\w+)\s+(.*\S)\s*$", re.IGNORECASE)
_INSTANCE_RE = re.compile(r"^\s*set_instance_assignment\s+-name\s+(\w+)\s+(.*\S)\s+-to\s+(\S+)\s*$", re.IGNORECASE)
_PIN_NUMBER_RE = re.compile(r"^PIN_(\d+)$", re.IGNORECASE)
_PIN_BUS_RE = re.compile(r"^(.*?)\[(\d+)\]$")

_EQFP144_PINS = set(range(1, 145))


@dataclass
class QsfResult:
    ok: bool = True
    top: Optional[str] = None
    family: Optional[str] = None
    device: Optional[str] = None
    files: List[Tuple[str, str]] = field(default_factory=list)  # (kind, name)
    pins: Dict[str, List[str]] = field(default_factory=dict)    # base port -> [PIN_nn, ...]
    io_standards: Dict[str, str] = field(default_factory=dict)
    unusedPolicy: Optional[str] = None
    errors: List[dict] = field(default_factory=list)
    warnings: List[dict] = field(default_factory=list)
    assignments: int = 0


def _strip_inline_comment(line: str) -> str:
    """Remove a trailing ``-- comment`` or ``# comment`` from a QSF line.

    Quartus allows comments after an assignment
    (``set_location_assignment PIN_87 -to LED[0] -- LED1``).  The comment
    marker is only recognised *outside* double-quoted values, so values such
    as ``"3.3-V LVTTL"`` survive untouched.
    """
    in_quote = False
    index = 0
    while index < len(line):
        char = line[index]
        if char == '"':
            in_quote = not in_quote
        elif not in_quote and char == "#":
            return line[:index]
        elif not in_quote and char == "-" and line.startswith("--", index):
            return line[:index]
        index += 1
    return line


def _error(line_no: int, message: str) -> dict:
    return {"file": "project.qsf", "line": line_no, "column": 1, "severity": "error", "message": message}


def _warn(line_no: int, message: str) -> dict:
    return {"file": "project.qsf", "line": line_no, "column": 1, "severity": "warning", "message": message}


def parse_qsf(text: str) -> QsfResult:
    result = QsfResult()
    seen_pins: Dict[Tuple[str, Optional[int]], str] = {}
    seen_slots: Dict[Tuple[str, Optional[int]], int] = {}
    seen_pin_targets: Dict[str, Tuple[str, Optional[int]]] = {}
    pin_key_map: Dict[str, str] = {}   # upper-case base -> first-seen spelling
    for line_no, raw in enumerate(text.splitlines(), start=1):
        line = _strip_inline_comment(raw).strip()
        if not line or line.startswith("#") or line.startswith("--"):
            continue

        loc = _LOCATION_RE.match(line)
        if loc:
            pin, target = loc.group(1).upper(), loc.group(2)
            result.assignments += 1
            number = _PIN_NUMBER_RE.match(pin)
            if not number or int(number.group(1)) not in _EQFP144_PINS:
                result.errors.append(_error(line_no, f"invalid pin '{pin}': the EP4CE6E22C8N is a 144-pin EQFP (pins 1..144)"))
                continue
            base = _PIN_BUS_RE.match(target)
            bit = None
            if base:
                base, bit = base.group(1), int(base.group(2))
            else:
                base = target
            key = base.upper()
            slot = (key, bit)
            if pin in seen_pin_targets and seen_pin_targets[pin] != slot:
                previous = seen_pin_targets[pin]
                result.errors.append(_error(
                    line_no,
                    f"duplicate pin assignment: {pin} is used by both "
                    f"'{previous[0]}[{previous[1]}]' and '{base}[{bit}]'",
                ))
                continue
            if slot in seen_pins and seen_pins[slot] != pin:
                result.errors.append(_error(
                    line_no,
                    f"duplicate pin assignment: '{base}' gets both {seen_pins[slot]} and {pin}"
                    f" (first at line {seen_slots[slot]})",
                ))
                continue
            # Merge case-insensitive duplicates under the first-seen spelling
            # (a .qsf may write KEY[0] and key[1] for the same vector).
            actual_key = pin_key_map.get(key, base)
            pin_key_map.setdefault(key, actual_key)
            result.pins.setdefault(actual_key, [])
            if pin not in result.pins[actual_key]:
                result.pins[actual_key].append(pin)
            seen_pins[slot] = pin
            seen_slots[slot] = line_no
            seen_pin_targets[pin] = slot
            continue

        inst = _INSTANCE_RE.match(line)
        if inst:
            name, value, target = inst.group(1), inst.group(2).strip(), inst.group(3)
            result.assignments += 1
            if name.upper() == "IO_STANDARD":
                result.io_standards[target.upper()] = value.strip('"')
            continue

        glob = _GLOBAL_RE.match(line)
        if glob:
            name, value = glob.group(1).upper(), glob.group(2).strip()
            result.assignments += 1
            if name == "TOP_LEVEL_ENTITY":
                result.top = value.strip('"')
            elif name == "FAMILY":
                result.family = value.strip('"')
            elif name == "DEVICE":
                result.device = value.strip('"')
            elif name in ("VERILOG_FILE", "VHDL_FILE", "SYSTEMVERILOG_FILE"):
                result.files.append((name.replace("_FILE", "").lower(), value.strip('"')))
            elif name == "RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP":
                result.unusedPolicy = value.strip('"')
            continue

        if line.lower().startswith(("set_", "define_global_assignment")):
            result.assignments += 1

    # device / family checks against the fitted board
    if result.device and not re.match(r"^EP4CE(6|10)E22C8N?$", result.device, re.IGNORECASE):
        result.errors.append(_error(
            0,
            f"device '{result.device}' does not match the fitted chip: the trainer carries "
            "EP4CE6E22C8N (or the drop-in EP4CE10E22C8N)",
        ))
    if result.family and result.family.lower() != "cyclone iv e":
        result.errors.append(_error(0, f"family '{result.family}' does not match the board (Cyclone IV E)"))

    result.ok = not result.errors
    return result


def load_qsf(path: Path) -> QsfResult:
    return parse_qsf(Path(path).read_text(encoding="utf-8", errors="replace"))


__all__ = ["parse_qsf", "load_qsf", "QsfResult"]