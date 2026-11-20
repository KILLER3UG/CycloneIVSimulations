"""Declarative multi-board registry for Cyclone IV Studio.

Boards are discovered at import time from two places:

* ``<bundle_root>/board/board.json`` -- the authoritative canonical profile for
  the default board (``rz-easyfpga-a2.2``).  Pin numbers, polarities, device
  figures and facts live only in that JSON file, never in Python source.
* ``<bundle_root>/boards/*/board.json`` -- additional built-in board profiles.

Each directory manifest may use either the canonical nested schema used by
``board/board.json`` (``{"board": ..., "devices": ..., "pinMap": ...}``) or the
simplified declarative SDK schema::

    {
      "id": "my-board", "name": "...", "vendor": "...",
      "fpga_part": "EP4CE...", "clock_hz": 50000000,
      "clock_pin": "...", "reset_pin": "...", "reset_active_low": true,
      "pins": [{"number": ..., "name": "...", "role": "...",
                "input_only": false, "pull": "...", "shared_group": "..."}],
      "peripherals": {"leds": ..., "buttons": ..., "switches": ...,
                      "seven_segment": ..., "buzzer": ..., "i2c_devices": ...},
      "layout3d": {...}
    }

``normalize_manifest`` validates and expands either shape into the full
canonical structure that ``backend.device._build_board`` and the frontend pin
catalog already consume.  Pin numbers are never written here: they are copied
verbatim from the JSON manifests.
"""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from .paths import bundle_root

#: The canonical board directory is the authoritative default profile.
DEFAULT_BOARD_ID = "rz-easyfpga-a2.2"

# Typical segment bit map; board manifests always override it when present.
_DEFAULT_SEG_BIT_MAP = {
    "a": 0, "b": 1, "c": 2, "d": 3, "e": 4, "f": 5, "g": 6, "dp": 7,
}


class BoardManifestError(ValueError):
    """Raised when a board manifest is missing required data or malformed."""


def _read_json(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise BoardManifestError(f"cannot read board manifest {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise BoardManifestError(f"board manifest {path} must be a JSON object")
    return data


def _infer_id(raw: dict, fallback: str = "") -> str:
    for candidate in (raw.get("id"), (raw.get("board") or {}).get("id"), fallback):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip().lower()
    # The canonical schema name identifies the in-tree default board.
    schema = str(raw.get("schema") or "")
    if schema.startswith("rz-easyfpga-board"):
        return DEFAULT_BOARD_ID
    name = str(raw.get("name") or (raw.get("board") or {}).get("name") or "")
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "custom-board"


# Cyclone IV E resource figures (device handbook): family part -> the
# package-independent resources.  User I/O is package-dependent and resolved
# by _user_io below.  A known part is NEVER zeroed, so imported boards get
# the same quality of resource warnings as the built-in profiles.
_CYCLONE_IV_E_FIGURES = {
    "EP4CE6": {"logicElements": 6272, "m9kBlocks": 30, "memoryKbit": 270,
               "multipliers18x18": 15, "plls": 2},
    "EP4CE10": {"logicElements": 10320, "m9kBlocks": 46, "memoryKbit": 414,
                "multipliers18x18": 23, "plls": 2},
    "EP4CE15": {"logicElements": 15408, "m9kBlocks": 56, "memoryKbit": 504,
                "multipliers18x18": 56, "plls": 4},
    "EP4CE20": {"logicElements": 19970, "m9kBlocks": 64, "memoryKbit": 576,
                "multipliers18x18": 64, "plls": 4},
    "EP4CE22": {"logicElements": 22320, "m9kBlocks": 66, "memoryKbit": 594,
                "multipliers18x18": 66, "plls": 4},
    "EP4CE28": {"logicElements": 27648, "m9kBlocks": 84, "memoryKbit": 756,
                "multipliers18x18": 84, "plls": 4},
    "EP4CE30": {"logicElements": 28848, "m9kBlocks": 126, "memoryKbit": 1134,
                "multipliers18x18": 126, "plls": 4},
    "EP4CE40": {"logicElements": 39600, "m9kBlocks": 126, "memoryKbit": 1134,
                "multipliers18x18": 126, "plls": 4},
    "EP4CE55": {"logicElements": 55856, "m9kBlocks": 260, "memoryKbit": 2340,
                "multipliers18x18": 156, "plls": 4},
    "EP4CE75": {"logicElements": 75408, "m9kBlocks": 305, "memoryKbit": 2745,
                "multipliers18x18": 220, "plls": 4},
    "EP4CE115": {"logicElements": 114480, "m9kBlocks": 423, "memoryKbit": 3807,
                 "multipliers18x18": 266, "plls": 4},
}

# Altera package code (the digits after the package letter in the part
# number) -> (package name, pin/ball count).  F17 is FBGA-256, E22 is
# EQFP-144, ... the number is a code, not the ball count.
_PART_PACKAGE_CODES = {
    "E22": ("EQFP-144", 144),
    "M164": ("MBGA-164", 164),
    "F17": ("FBGA-256", 256),
    "F23": ("FBGA-484", 484),
    "F29": ("FBGA-780", 780),
}


def _package_from_part(text: str) -> tuple:
    """'EP4CE22F17C6N' -> ('FBGA-256', 'F17'); ('', code) when the code is
    unknown and ('', '') when the part is not parseable."""
    match = re.match(r"^EP4CE\d+([A-Z]\d+)", text, re.IGNORECASE)
    if not match:
        return "", ""
    code = match.group(1).upper()
    entry = _PART_PACKAGE_CODES.get(code)
    if entry is None:
        return "", code
    return entry[0], code


def _user_io(family_part: str, package_code: str) -> int:
    """User I/O pins for the known part/package combinations (handbook).

    Every Cyclone IV E part in an EQFP-144 exposes the same 91 user I/O; the
    F17 FBGA-256 parts expose 153.  Unknown combinations return 0 (honest
    'not known' rather than a guessed figure).
    """
    part = family_part.upper()
    package = package_code.upper()
    if package == "E22":
        return 91
    if part in ("EP4CE15", "EP4CE20", "EP4CE22", "EP4CE28") and package == "F17":
        return 153
    return 0


def _device_from_part(part: str) -> dict:
    """Build a device entry from a part number such as EP4CE22F17C6N.

    Resource figures come from the Cyclone IV E handbook table, the package
    and speed grade are decoded from the part string, and user I/O follows
    the package.  Only a truly unknown part falls back to zeroed figures so
    an imported board never silently claims resources it does not have.
    """
    text = str(part or "").strip()
    match = re.match(r"^(EP4CE\d+)([A-Z]\d+)(C\d+)", text, re.IGNORECASE)
    if match:
        family_part = match.group(1).upper()
        package_part = match.group(2).upper()
        speed = match.group(3)[1:]
        key = family_part.lower()
        package, package_code = _package_from_part(text)
        figures = _CYCLONE_IV_E_FIGURES.get(family_part, {})
        quartus = f"{family_part}{package_part}C{speed}"
    else:
        family_part = text.upper()
        package, package_code = "", ""
        speed = ""
        key = re.sub(r"[^a-z0-9]", "", text.lower()) or "custom"
        figures = {}
        quartus = text
    return {
        "key": key,
        "family": "Cyclone IV E",
        "part": text,
        "quartusDevice": quartus,
        "package": package or "unknown",
        "speedGrade": speed or "6",
        "logicElements": figures.get("logicElements", 0),
        "m9kBlocks": figures.get("m9kBlocks", 0),
        "memoryKbit": figures.get("memoryKbit", 0),
        "multipliers18x18": figures.get("multipliers18x18", 0),
        "plls": figures.get("plls", 0),
        "userIo": _user_io(family_part, package_code),
        "coreVoltage": "1.2 V",
        "ioStandard": "3.3 V LVTTL",
    }


def _default_board_shell(name: str, vendor: str, fpga: str, clock_hz: Any,
                         clock_pin: str, clock_port: str, reset_port: str,
                         reset_pin: str, reset_active_low: bool) -> dict:
    """Structural defaults so that downstream reshape code never sees a KeyError."""
    return {
        "name": name,
        "vendor": vendor,
        "fpga": fpga,
        "clockHz": clock_hz,
        "clockPort": clock_port,
        "clockAliases": [],
        "clockPin": clock_pin,
        "resetPort": reset_port,
        "resetPin": reset_pin,
        "resetActiveLow": bool(reset_active_low),
        "leds": {"port": "LED", "count": 0, "pins": [], "activeLow": True, "diodes": []},
        "buttons": {"port": "KEY", "count": 0, "pins": [], "activeLow": True},
        "switches": {
            "port": "SW", "count": 0, "pins": [],
            "sharedWithButtons": False, "activeLow": False, "onValue": 1,
        },
        "displays": {
            "port": "SEG", "ports": ["SEG"], "digitPort": "DIG", "count": 0,
            "segmentsPerDigit": 8, "multiplexed": True,
            "segmentActiveLow": True, "digitActiveLow": True,
            "segBitMap": dict(_DEFAULT_SEG_BIT_MAP),
            "pins": {"SEG": [], "DIG": []},
        },
        "buzzer": {"port": "FPGA_BUZZER", "pin": "", "type": "passive", "activeLow": True},
        "vga": {"pins": {}, "colors": 0},
        "ps2": {"pins": {}, "pullup": "", "openCollector": True},
        "uart": {"pins": {}, "transceiver": ""},
        "infrared": {"pin": ""},
        "i2c": {"legacyFlatKeys": {}, "buses": []},
        "lcd": {"pins": {}, "contrastTrimmer": ""},
        "sdram": {},
        "config": {},
        "rails": {},
        "headers": {},
        "modelNotes": [],
        "layout3d": {},
    }


def _merge_defaults(board: dict, shell: dict) -> None:
    """Fill missing structural keys (and nested reshape keys) in place."""
    for key, value in shell.items():
        board.setdefault(key, copy.deepcopy(value))

    for group, required in (
        ("vga", {"pins": {}, "colors": 0}),
        ("ps2", {"pins": {}, "pullup": "", "openCollector": True}),
        ("uart", {"pins": {}, "transceiver": ""}),
        ("i2c", {"legacyFlatKeys": {}, "buses": []}),
        ("lcd", {"pins": {}, "contrastTrimmer": ""}),
    ):
        node = board.setdefault(group, {})
        if not isinstance(node, dict):
            board[group] = {}
            node = board[group]
        for nested, default in required.items():
            node.setdefault(nested, copy.deepcopy(default))

    buzzer = board.setdefault("buzzer", {})
    if isinstance(buzzer, dict):
        buzzer.setdefault("pin", "")
        buzzer.setdefault("port", "FPGA_BUZZER")
        buzzer.setdefault("activeLow", True)

    displays = board.setdefault("displays", {})
    if isinstance(displays, dict):
        displays.setdefault("segBitMap", dict(_DEFAULT_SEG_BIT_MAP))
        displays.setdefault("pins", {"SEG": [], "DIG": []})
        displays["pins"].setdefault("SEG", [])
        displays["pins"].setdefault("DIG", [])


def _normalize_canonical(raw: dict, id_hint: str = "") -> dict:
    """Validate and finalize an already-nested board manifest."""
    data = copy.deepcopy(raw)
    board = data.get("board")
    if not isinstance(board, dict):
        raise BoardManifestError("manifest requires a 'board' object")

    board_id = _infer_id(data, id_hint)
    data["id"] = board_id
    board["id"] = board_id
    data.setdefault("schema", "rz-easyfpga-board/1")
    data.setdefault("title", f"{board.get('name', board_id)} board profile")

    if not isinstance(data.get("devices"), dict) or not data["devices"]:
        data["devices"] = {_device_from_part(board.get("fpga", ""))["key"]:
                           _device_from_part(board.get("fpga", ""))}
    if not isinstance(data.get("pinMap"), dict):
        data["pinMap"] = {}
    if not isinstance(data.get("facts"), list):
        data["facts"] = []

    name = str(board.get("name") or board_id)
    shell = _default_board_shell(
        name=name,
        vendor=str(board.get("vendor") or ""),
        fpga=str(board.get("fpga") or ""),
        clock_hz=board.get("clockHz", 0),
        clock_pin=str(board.get("clockPin") or ""),
        clock_port=str(board.get("clockPort") or "CLOCK"),
        reset_port=str(board.get("resetPort") or "RESET"),
        reset_pin=str(board.get("resetPin") or ""),
        reset_active_low=board.get("resetActiveLow", True),
    )
    _merge_defaults(board, shell)

    layout = data.get("layout3d")
    if not isinstance(layout, dict) or not layout:
        layout = board.get("layout3d")
    if not isinstance(layout, dict):
        layout = {}
    data["layout3d"] = layout
    board["layout3d"] = layout
    return data


def _peripheral_dict(peripherals: dict, key: str, defaults: dict) -> dict:
    value = peripherals.get(key)
    out = copy.deepcopy(defaults)
    if isinstance(value, dict):
        out.update(value)
    elif isinstance(value, list):
        out["pins"] = list(value)
        out.setdefault("count", len(value))
    return out


def _devices_from_manifest(raw: dict, part: str) -> Dict[str, dict]:
    """Device entries for an imported board.

    A manifest may carry its own ``devices`` metadata (the canonical schema
    shape); those figures are honored verbatim on top of the part-derived
    defaults, so a valid spec supplied by the importer is never zeroed.
    Otherwise the Cyclone IV E figures table fills in known parts.
    """
    provided = raw.get("devices")
    devices: Dict[str, dict] = {}
    if isinstance(provided, dict):
        for dev_key, entry in provided.items():
            if not isinstance(entry, dict):
                continue
            base = _device_from_part(str(entry.get("part") or part))
            base.update({k: v for k, v in entry.items() if v is not None})
            base["key"] = str(entry.get("key") or dev_key)
            devices[str(dev_key)] = base
    if not devices:
        device = _device_from_part(part)
        devices[device["key"]] = device
    return devices


def _normalize_sdk_manifest(raw: dict) -> dict:
    """Expand the simplified declarative SDK schema into canonical form."""
    if not str(raw.get("id") or "").strip():
        raise BoardManifestError("manifest requires a non-empty 'id'")
    board_id = _infer_id(raw)
    name = str(raw.get("name") or "").strip()
    if not name:
        raise BoardManifestError("manifest requires a non-empty 'name'")
    pins = raw.get("pins")
    if not isinstance(pins, list) or not pins:
        raise BoardManifestError("manifest requires a non-empty 'pins' list")
    for index, pin in enumerate(pins):
        if not isinstance(pin, dict) or not pin.get("number") or not pin.get("name"):
            raise BoardManifestError(f"pins[{index}] requires 'number' and 'name'")

    clock_pin = str(raw.get("clock_pin") or "")
    reset_pin = str(raw.get("reset_pin") or "")
    if not clock_pin:
        clock_pin = next((str(p["number"]) for p in pins
                          if str(p.get("role") or "").lower() == "clock"), "")
    if not reset_pin:
        reset_pin = next((str(p["number"]) for p in pins
                          if str(p.get("role") or "").lower() == "reset"), "")
    if not clock_pin:
        raise BoardManifestError("manifest requires 'clock_pin' or a clock-role pin")

    peripherals = raw.get("peripherals")
    if not isinstance(peripherals, dict):
        peripherals = {}

    pin_map: Dict[str, List[str]] = {}
    for pin in pins:
        pin_map.setdefault(str(pin["name"]), []).append(str(pin["number"]))

    clock_port = str(raw.get("clock_port") or "")
    if not clock_port:
        clock_port = next((str(p["name"]) for p in pins
                           if str(p.get("role") or "").lower() == "clock"), "CLOCK")
    reset_port = str(raw.get("reset_port") or "")
    if not reset_port:
        reset_port = next((str(p["name"]) for p in pins
                           if str(p.get("role") or "").lower() == "reset"), "RESET")
    if clock_port and clock_pin and clock_port not in pin_map:
        pin_map[clock_port] = [clock_pin]
    if reset_port and reset_pin and reset_port not in pin_map:
        pin_map[reset_port] = [reset_pin]

    leds = _peripheral_dict(peripherals, "leds", {
        "port": "LED", "count": 0, "pins": [], "activeLow": True, "diodes": [],
    })
    buttons = _peripheral_dict(peripherals, "buttons", {
        "port": "KEY", "count": 0, "pins": [], "activeLow": True,
    })
    switches = _peripheral_dict(peripherals, "switches", {
        "port": "SW", "count": 0, "pins": [],
        "sharedWithButtons": False, "activeLow": False, "onValue": 1,
    })
    seven_seg = peripherals.get("seven_segment")
    if not isinstance(seven_seg, dict):
        seven_seg = {}
    seg_pins = seven_seg.get("pins") or {}
    if not isinstance(seg_pins, dict):
        seg_pins = {"SEG": list(seven_seg.get("segPins") or []),
                    "DIG": list(seven_seg.get("digitPins") or [])}
    displays = {
        "port": "SEG", "ports": ["SEG"], "digitPort": "DIG",
        "count": int(seven_seg.get("count", len(seg_pins.get("DIG") or []))),
        "segmentsPerDigit": 8, "multiplexed": True,
        "segmentActiveLow": bool(seven_seg.get("segmentActiveLow", True)),
        "digitActiveLow": bool(seven_seg.get("digitActiveLow", True)),
        "segBitMap": dict(seven_seg.get("segBitMap") or _DEFAULT_SEG_BIT_MAP),
        "pins": {"SEG": list(seg_pins.get("SEG") or []), "DIG": list(seg_pins.get("DIG") or [])},
    }
    buzzer = _peripheral_dict(peripherals, "buzzer", {
        "port": "FPGA_BUZZER", "pin": "", "type": "passive", "activeLow": True,
    })

    i2c_devices = peripherals.get("i2c_devices") or []
    i2c = {
        "legacyFlatKeys": {},
        "buses": [dict(device) for device in i2c_devices] if isinstance(i2c_devices, list) else [],
    }

    board = {
        "id": board_id,
        "name": name,
        "vendor": str(raw.get("vendor") or ""),
        "fpga": str(raw.get("fpga_part") or raw.get("fpga") or ""),
        "clockHz": raw.get("clock_hz", 0),
        "clockPort": clock_port,
        "clockPin": clock_pin,
        "resetPort": reset_port,
        "resetPin": reset_pin,
        "resetActiveLow": bool(raw.get("reset_active_low", True)),
        "leds": leds,
        "buttons": buttons,
        "switches": switches,
        "displays": displays,
        "buzzer": buzzer,
        "i2c": i2c,
        "layout3d": copy.deepcopy(raw.get("layout3d") or {}),
    }
    part = str(raw.get("fpga_part") or raw.get("fpga") or "")
    devices = _devices_from_manifest(raw, part)
    facts = raw.get("facts")
    if not isinstance(facts, list) or not facts:
        facts = [
            {"id": "SDK-01", "statement": f"{name} is a user-imported board profile",
             "tag": "INFERRED", "sources": ["user-provided SDK manifest"]},
            {"id": "SDK-02", "statement": f"Clock {clock_port} is the board clock input",
             "tag": "INFERRED", "sources": ["user-provided SDK manifest"]},
        ]
    canonical = {
        "schema": "cyclone-sdk-board/1",
        "title": f"{name} board profile",
        "id": board_id,
        "devices": devices,
        "board": board,
        "pinMap": pin_map,
        "facts": facts,
        "layout3d": copy.deepcopy(raw.get("layout3d") or {}),
    }
    return _normalize_canonical(canonical)


def normalize_manifest(raw: dict) -> dict:
    """Validate and normalize a board manifest into the canonical structure.

    Accepts either the nested ``board``/``devices``/``pinMap`` schema or the
    simplified declarative SDK schema.  Raises :class:`BoardManifestError`
    (a ``ValueError`` subclass) for invalid input.
    """
    if not isinstance(raw, dict):
        raise BoardManifestError("board manifest must be a JSON object")

    if isinstance(raw.get("board"), dict) and isinstance(raw.get("pinMap"), dict):
        return _normalize_canonical(raw)

    if "id" not in raw and "name" not in raw:
        raise BoardManifestError("manifest requires at least 'id' and 'name'")
    return _normalize_sdk_manifest(raw)


# ---------------------------------------------------------------------------
# Discovery / registry
# ---------------------------------------------------------------------------

_REGISTRY: Dict[str, dict] = {}


def _discover() -> Dict[str, dict]:
    registry: Dict[str, dict] = {}
    root = bundle_root()

    canonical = root / "board" / "board.json"
    if canonical.is_file():
        raw = _read_json(canonical)
        # The in-tree canonical file is the authoritative default profile.
        raw["id"] = DEFAULT_BOARD_ID
        raw.setdefault("board", {})["id"] = DEFAULT_BOARD_ID
        registry[DEFAULT_BOARD_ID] = normalize_manifest(raw)

    boards_dir = root / "boards"
    if boards_dir.is_dir():
        for path in sorted(boards_dir.glob("*/board.json")):
            if not path.is_file():
                continue
            raw = _read_json(path)
            hint = path.parent.name
            try:
                normalized = normalize_manifest(raw)
            except BoardManifestError:
                # A malformed optional manifest must not break startup; the
                # canonical board remains usable and the file is just skipped.
                continue
            board_id = normalized["id"]
            if board_id in registry:
                # The canonical board.json wins for hardware facts, but the
                # declarative directory copy may contribute layout3d/id.
                incoming_layout = normalized.get("layout3d") or {}
                if incoming_layout:
                    registry[board_id]["layout3d"] = incoming_layout
                    registry[board_id]["board"]["layout3d"] = incoming_layout
            else:
                registry[board_id] = normalized
    return registry


def refresh_boards() -> None:
    """Re-scan the bundle for board manifests."""
    global _REGISTRY
    _REGISTRY = _discover()


refresh_boards()


def list_boards() -> List[dict]:
    """Return a summary for every registered board (default board first)."""
    summaries: List[dict] = []
    ordered = sorted(
        _REGISTRY.values(),
        key=lambda item: (0 if item["id"] == DEFAULT_BOARD_ID else 1, item["id"]),
    )
    for item in ordered:
        board = item["board"]
        devices = item.get("devices") or {}
        part = ""
        if devices:
            first = next(iter(devices.values()))
            part = str(first.get("part") or "")
        summaries.append({
            "id": item["id"],
            "name": board.get("name", item["id"]),
            "vendor": board.get("vendor", ""),
            "fpga": board.get("fpga", part),
            "part": part,
            "clockHz": board.get("clockHz", 0),
            "leds": len((board.get("leds") or {}).get("pins") or []),
            "buttons": len((board.get("buttons") or {}).get("pins") or []),
            "switches": len((board.get("switches") or {}).get("pins") or []),
            "hasLayout3d": bool(item.get("layout3d")),
            "default": item["id"] == DEFAULT_BOARD_ID,
        })
    return summaries


def get_board(board_id: str) -> Optional[dict]:
    """Return a normalized copy of a registered board, or ``None`` if unknown."""
    item = _REGISTRY.get(str(board_id or "").strip().lower())
    return copy.deepcopy(item) if item is not None else None


def register_board(raw: dict) -> dict:
    """Validate, normalize and register a board manifest by id."""
    normalized = normalize_manifest(raw)
    _REGISTRY[normalized["id"]] = normalized
    return copy.deepcopy(normalized)


def unregister_board(board_id: str) -> bool:
    """Remove an imported board from the registry (test/hot-reload cleanup)."""
    return _REGISTRY.pop(str(board_id or "").strip().lower(), None) is not None


def has_board(board_id: str) -> bool:
    return str(board_id or "").strip().lower() in _REGISTRY


__all__ = [
    "DEFAULT_BOARD_ID",
    "BoardManifestError",
    "normalize_manifest",
    "list_boards",
    "get_board",
    "register_board",
    "unregister_board",
    "refresh_boards",
    "has_board",
]
