"""Device and board profile for the simulator.

All pin numbers, polarities, pull-ups, drivers and part parameters come from
``board/board.json`` — the single source of truth compiled from
``board/board_spec.md`` (the reconciled, tagged spec), the vendor pin file
``board/vendor/Pinos_RZEasyFPGA.txt`` and the vendor schematic.

Nothing in this module may hard-code a pin number or a polarity: if the board
changes, edit ``board/board.json`` (and the spec it came from) and every layer
that consumes the profile follows automatically.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

BOARD_JSON = Path(__file__).resolve().parent.parent / "board" / "board.json"


class BackendConfigError(RuntimeError):
    """Raised when board/board.json is missing, corrupt or schema-broken."""


def load_board_json() -> dict:
    """Load the canonical board profile (pins, polarities, parts, tags).

    Raises :class:`BackendConfigError` with a clear message when the file is
    missing, invalid JSON or missing a required top-level key — never a raw
    ``JSONDecodeError``/``KeyError`` (audit m12).
    """
    try:
        with open(BOARD_JSON, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise BackendConfigError(
            f"board profile not found: {BOARD_JSON} — the repository checkout "
            "appears incomplete (expected board/board.json)"
        ) from exc
    except json.JSONDecodeError as exc:
        raise BackendConfigError(
            f"board profile {BOARD_JSON} is not valid JSON at line "
            f"{exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc
    if not isinstance(data, dict):
        raise BackendConfigError(f"board profile {BOARD_JSON} must be a JSON object")
    for key in ("board", "devices", "pinMap"):
        if key not in data:
            raise BackendConfigError(
                f"board profile {BOARD_JSON} is missing the required top-level key '{key}'"
            )
    return data


_DATA = load_board_json()

DEVICES: dict = _DATA["devices"]
DEFAULT_DEVICE = "ep4ce6"
_selected: str = DEFAULT_DEVICE


def set_device(key: str) -> dict:
    """Select the fitted chip (user setting; default EP4CE6E22C8N)."""
    global _selected
    key = (key or "").strip().lower()
    if key not in DEVICES:
        raise ValueError(f"unknown device '{key}'; expected one of {sorted(DEVICES)}")
    _selected = key
    return DEVICES[_selected]


def get_device() -> dict:
    return DEVICES[_selected]


def DEVICE() -> dict:
    """Datasheet figures for the currently selected chip."""
    device = DEVICES[_selected]
    return {
        "family": device["family"],
        "part": device["part"],
        "quartusDevice": device["quartusDevice"],
        "package": device["package"],
        "speedGrade": device["speedGrade"],
        "logicElements": device["logicElements"],
        "m9kBlocks": device["m9kBlocks"],
        "m9kKbit": device["memoryKbit"],
        "multipliers18x18": device["multipliers18x18"],
        "plls": device["plls"],
        "userIo": device["userIo"],
        "defaultIoStandard": device.get("ioStandard", "3.3 V LVTTL"),
        "coreVoltage": device.get("coreVoltage", "1.2 V"),
        "pinMap": None,
        "modelNotes": MODEL_NOTES,
        "selected": _selected,
    }


# ---------------------------------------------------------------------------
# Board: RZ-EasyFPGA A2.2.  Every value below is loaded from board.json and
# reshaped only where an older consumer expects the historical flat key.
# ---------------------------------------------------------------------------


def _build_board(raw: dict) -> dict:
    """Reshape the JSON board into the flat profile shape the code consumes.

    The reshape is structural only — no pin numbers, polarities or part
    numbers are introduced here; they all come from board.json.
    """
    b = raw["board"]
    board = dict(b)

    # Buzzer: JSON uses port/pin, consumers use FPGA_BUZZER.
    buzzer = dict(b["buzzer"])
    buzzer["FPGA_BUZZER"] = buzzer["pin"]
    board["buzzer"] = buzzer

    # VGA / PS2 / UART: JSON nests pins under "pins"; consumers use flat keys.
    board["vga"] = {**b["vga"]["pins"], "colors": b["vga"]["colors"],
                    "connector": b["vga"].get("connector"),
                    "resistors": b["vga"].get("resistors"),
                    "db15": b["vga"].get("db15")}
    board["ps2"] = {**b["ps2"]["pins"], "pullup": b["ps2"]["pullup"],
                    "openCollector": b["ps2"]["openCollector"],
                    "connector": b["ps2"].get("connector"),
                    "bus": b["ps2"].get("bus"),
                    "deviceTypeTag": b["ps2"].get("deviceTypeTag")}
    uart = dict(b["uart"])
    uart.update(b["uart"]["pins"])
    board["uart"] = uart

    # Infrared: JSON uses "pin".
    infrared = dict(b["infrared"])
    infrared["IR"] = infrared["pin"]
    board["infrared"] = infrared

    # I2C: JSON has a "buses" list; keep the legacy flat keys for consumers.
    i2c = dict(b["i2c"]["legacyFlatKeys"])
    i2c["buses"] = b["i2c"]["buses"]
    board["i2c"] = i2c

    # LCD: JSON nests pins under "pins".
    lcd = dict(b["lcd"]["pins"])
    lcd["contrastTrimmer"] = b["lcd"]["contrastTrimmer"]
    lcd["socket"] = b["lcd"].get("socket")
    lcd["backlightPins"] = b["lcd"].get("backlightPins")
    lcd["socketPinOrderTag"] = b["lcd"].get("socketPinOrderTag")
    board["lcd"] = lcd

    # Clock aliases live in the JSON, not in code.
    board["clockAliases"] = b.get("clockAliases", [])
    return board


try:
    BOARD = _build_board(_DATA)
except KeyError as exc:
    raise BackendConfigError(
        f"board profile {BOARD_JSON} is missing the required key {exc}"
    ) from exc
MODEL_NOTES = BOARD.get("modelNotes", [])

# SEG bit -> display segment, from board.json (the schematic Display sheet).
SEG_BIT_MAP = dict(BOARD["displays"]["segBitMap"])

_CLOCK_ALIASES = [BOARD["clockPort"]] + list(BOARD.get("clockAliases", [])) + ["CLK"]

# Textbook port-name aliases for this board family.  Student designs often
# name the display buses "seven_seg"/"dtube" and drive the keys with scalar
# "s1".."s4" instead of the vendor's SEG/DIG/KEY vectors; resolve those to
# the same profile pins so such designs run unmodified.
_SEGMENT_ALIASES = {"seg", "seg7", "sevenseg", "display", "hex"}
_DIGIT_ALIASES = {"dig", "dtube", "digit", "tube", "sel", "scan", "com", "anode"}
# unnumbered BUS aliases: a whole port named like the bus maps onto it
_SWITCHBUS_ALIASES = {"sw", "dip", "switches", "keys", "buttons"}
_SCALAR_ALIASES = {
    "s": "KEY", "key": "KEY", "sw": "KEY", "dip": "KEY",
    "btn": "KEY", "button": "KEY", "push": "KEY",
    "led": "LED",
}
_RESET_ALIASES = {"reset", "rst"}


def resolve_port_pins(name: str, kind: Optional[str] = None) -> Optional[List[str]]:
    """Resolve a design port name to board profile pins, aliases included.

    Exact profile names win (LED/KEY/SEG/DIG/CLOCK_50/...).  Otherwise a bus
    alias maps the whole port onto the profile bus (``seven_seg`` -> SEG,
    ``dtube`` -> DIG, ... -- port bit i drives profile bit i) and a numbered
    scalar maps onto one bit of a profile bus (``s3`` -> KEY bit 2, i.e. the
    third key net; ``led2`` -> LED bit 1).  ``kind`` is the waveform classifier
    result ("display"/"digit"/...) and only gates the bus aliases; scalar
    aliases work without it.  Returns the pin list ordered by port bit index,
    or None when the port has no board pin.
    """
    profile = board_pin_map()
    exact = profile.get(str(name).upper())
    if exact:
        return list(exact)
    norm = re.sub(r"[^a-z0-9]", "", str(name).lower())
    if kind == "display" and norm in _SEGMENT_ALIASES:
        pins = profile.get("SEG")
        return list(pins) if pins else None
    if kind == "digit" and norm in _DIGIT_ALIASES:
        pins = profile.get("DIG")
        return list(pins) if pins else None
    if kind in ("switch", "button") and norm in _SWITCHBUS_ALIASES:
        # the DIP shares the KEY nets on this board (board_spec §3)
        pins = profile.get("KEY")
        return list(pins) if pins else None
    if kind == "led" and norm in {"leds"}:
        pins = profile.get("LED")
        return list(pins) if pins else None
    if norm in _RESET_ALIASES:
        pins = profile.get(BOARD.get("resetPort", "FPGA_RST"))
        return list(pins) if pins else None
    match = re.fullmatch(r"([a-z]+)(\d+)", norm)
    if match:
        target = _SCALAR_ALIASES.get(match.group(1))
        index = int(match.group(2))
        if target:
            pins = profile.get(target)
            if pins and 1 <= index <= len(pins):
                return [pins[index - 1]]
    return None


def board_pin_map() -> dict:
    """Flat map of profile port name (upper case) -> list of package pins."""
    index: dict = {}

    def add(name: str, pins) -> None:
        if isinstance(pins, str):
            pins = [pins]
        index[name.upper()] = list(pins)

    for alias in _CLOCK_ALIASES:
        add(alias, BOARD["clockPin"])
    add(BOARD["resetPort"], BOARD["resetPin"])
    add(BOARD["leds"]["port"], BOARD["leds"]["pins"])
    add(BOARD["buttons"]["port"], BOARD["buttons"]["pins"])
    add(BOARD["switches"]["port"], BOARD["switches"]["pins"])
    for name, pins in BOARD["displays"]["pins"].items():
        add(name, pins)
    pin_re = re.compile(r"PIN_\d+$")

    def is_pin_value(value) -> bool:
        if isinstance(value, str):
            return bool(pin_re.match(value))
        if isinstance(value, list) and value:
            return all(isinstance(v, str) and pin_re.match(v) for v in value)
        return False

    for group in ("vga", "ps2", "uart", "buzzer", "infrared", "i2c", "lcd"):
        for name, pins in BOARD[group].items():
            if is_pin_value(pins):
                add(name, pins)
    sd = BOARD["sdram"]
    for name, pins in sd.items():
        if name in ("part", "bits", "dataBits", "banks"):
            continue
        if is_pin_value(pins):
            add(f"SDRAM_{name}", pins)

    # Vector-style port names used by designs (e.g. a design declares
    # "LCD_D : out std_logic_vector(7 downto 0)" while the profile lists
    # LCD_D0..LCD_D7): merge the per-bit pinMap entries into one ordered
    # list so the whole pinMap is reachable by its port name.
    by_base: dict = {}
    for key, pins in _DATA["pinMap"].items():
        match = re.match(r"^(.*)\[(\d+)\]$", key)
        if match:
            by_base.setdefault(match.group(1).upper(), {})[int(match.group(2))] = pins[0]
    for base, bits in by_base.items():
        if base not in index:
            add(base, [bits[b] for b in sorted(bits)])
    for key, pins in _DATA["pinMap"].items():
        base = re.sub(r"\[\d+\]$", "", key).upper()
        if base not in index:
            add(base, pins)
    return index


__all__ = [
    "BackendConfigError",
    "BOARD_JSON",
    "DEVICES",
    "DEVICE",
    "set_device",
    "get_device",
    "load_board_json",
    "BOARD",
    "board_pin_map",
    "resolve_port_pins",
    "SEG_BIT_MAP",
]
