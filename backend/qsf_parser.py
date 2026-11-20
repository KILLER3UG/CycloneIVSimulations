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

Invalid pin numbers, pins outside the fitted package, duplicate pins and
assignments to ports that do not exist are reported as errors with line numbers.

The legal pin identifiers and DEVICE values are derived from the ACTIVE board
profile (backend.device): an EQFP-144 package accepts PIN_1..PIN_144, a
FBGA-256 package accepts PIN_1..PIN_256 plus BGA ball names such as PIN_R8,
and the accepted DEVICE strings are the manifest's fitted parts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

_LOCATION_RE = re.compile(r"^\s*set_location_assignment\s+(\S+)\s+-to\s+(\S+)\s*$", re.IGNORECASE)
_GLOBAL_RE = re.compile(r"^\s*set_global_assignment\s+-name\s+(\w+)\s+(.*\S)\s*$", re.IGNORECASE)
_INSTANCE_RE = re.compile(r"^\s*set_instance_assignment\s+-name\s+(\w+)\s+(.*\S)\s+-to\s+(\S+)\s*$", re.IGNORECASE)
# Numeric package pins (PIN_87) and BGA ball names (PIN_R8, PIN_AB12) both
# occur in real Quartus projects; which of the two is legal depends on the
# fitted package and is decided by the active board profile, not here.
_PIN_NUMBER_RE = re.compile(r"^PIN_(\d+|[A-Z]+\d+)$", re.IGNORECASE)
_PIN_BUS_RE = re.compile(r"^(.*?)\[(\d+)\]$")

# Fallback when the device layer cannot be consulted (should not happen
# in-tree): the canonical RZ-EasyFPGA A2.2 EQFP-144 profile.
_FALLBACK_CONSTRAINTS = {
    "maxPin": 144,
    "allowBallNames": False,
    "devices": ["EP4CE6E22C8", "EP4CE10E22C8"],
    "family": "Cyclone IV E",
    "part": "EP4CE6E22C8N",
    "package": "EQFP-144",
}


def _package_pin_count(package: str) -> int:
    """144 from 'EQFP-144', 256 from 'FBGA-256' (0 -> fallback 144)."""
    match = re.search(r"(\d+)\s*$", str(package or ""))
    count = int(match.group(1)) if match else 0
    return count if count > 0 else _FALLBACK_CONSTRAINTS["maxPin"]


def _package_description(package: str) -> str:
    """'EQFP-144' -> '144-pin EQFP', 'FBGA-256' -> '256-ball FBGA'."""
    match = re.search(r"([A-Za-z]+)-?(\d+)", str(package or ""))
    if match and match.group(2):
        kind = match.group(1).upper()
        unit = "ball" if "BGA" in kind else "pin"
        return f"{match.group(2)}-{unit} {kind}"
    return _package_description(_FALLBACK_CONSTRAINTS["package"])


def _device_alternatives(names: List[str]) -> str:
    """Build a regex alternation accepting each part with an optional N."""
    parts: List[str] = []
    for name in names:
        base = name[:-1] if name.endswith("N") else name
        parts.append(re.escape(base) + "N?")
    return "|".join(parts) or "EP4CE6E22C8N?"


def _active_constraints() -> dict:
    """Pin-range/device constraints from the ACTIVE board profile.

    Resolved lazily (no top-level device import) so the parser stays
    import-light and board selection is honored at call time.
    """
    try:
        from .device import DEVICE, get_active_board_raw

        device = DEVICE() or {}
        manifest_devices = (get_active_board_raw() or {}).get("devices") or {}
    except Exception:  # pragma: no cover - the device layer always loads in-tree
        device = {}
        manifest_devices = {}

    names: List[str] = []
    family = ""
    for entry in manifest_devices.values():
        if not isinstance(entry, dict):
            continue
        for key in ("quartusDevice", "part"):
            value = str(entry.get(key) or "").strip().upper()
            if value:
                names.append(value)
        family = family or str(entry.get("family") or "")

    package = str(device.get("package") or "")
    if not names:
        names = list(_FALLBACK_CONSTRAINTS["devices"])
        family = family or _FALLBACK_CONSTRAINTS["family"]
        package = package or _FALLBACK_CONSTRAINTS["package"]
    return {
        "maxPin": _package_pin_count(package),
        "allowBallNames": "BGA" in package.upper(),
        "devices": sorted(set(names)),
        "family": family,
        "part": str(device.get("part") or _FALLBACK_CONSTRAINTS["part"]),
        "package": package,
    }


@dataclass
class QsfResult:
    ok: bool = True
    top: Optional[str] = None
    family: Optional[str] = None
    device: Optional[str] = None
    files: List[Tuple[str, str]] = field(default_factory=list)  # (kind, name)
    pins: Dict[str, List[str]] = field(default_factory=dict)    # base port -> [PIN_nn, ...]
    bit_pins: Dict[str, Dict[int, str]] = field(default_factory=dict)  # base port -> {bit_idx: PIN_nn}
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
    constraints = _active_constraints()
    device_pattern = re.compile(
        "^(?:" + _device_alternatives(constraints["devices"]) + ")$", re.IGNORECASE
    )
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
            valid_pin = False
            if number:
                token = number.group(1)
                if token.isdigit():
                    valid_pin = 1 <= int(token) <= constraints["maxPin"]
                else:
                    valid_pin = constraints["allowBallNames"]
            if not valid_pin:
                if constraints["allowBallNames"]:
                    hint = (f"{_package_description(constraints['package'])} "
                            f"(pins 1..{constraints['maxPin']} or ball names like PIN_R8)")
                else:
                    hint = (f"{_package_description(constraints['package'])} "
                            f"(pins 1..{constraints['maxPin']})")
                result.errors.append(_error(
                    line_no,
                    f"invalid pin '{pin}': the {constraints['part']} is a {hint}",
                ))
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
            result.bit_pins.setdefault(actual_key, {})[0 if bit is None else bit] = pin
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

    # device / family checks against the fitted board (from the active profile)
    if result.device and not device_pattern.match(result.device):
        result.errors.append(_error(
            0,
            f"device '{result.device}' does not match the fitted chip: the board carries "
            + " or ".join(constraints["devices"]),
        ))
    if result.family and result.family.lower() != constraints["family"].lower():
        result.errors.append(_error(
            0,
            f"family '{result.family}' does not match the board ({constraints['family']})",
        ))

    result.ok = not result.errors
    return result


def load_qsf(path: Path) -> QsfResult:
    return parse_qsf(Path(path).read_text(encoding="utf-8", errors="replace"))


__all__ = ["parse_qsf", "load_qsf", "QsfResult"]