"""Device and board profile for the simulator.

Ground truth: /board/board_spec.md, compiled ONLY from
/board/vendor/Pinos_RZEasyFPGA.txt (the kit's own pin-assignment file),
/board/vendor/instructor_pin_table.png (instructor-provided, identical),
/board/schematic/*.pdf (kit schematic) and the vendor example projects in
/board/vendor/examples/.

DEVICE offers the two chips the trainer is sold with (user confirmed
EP4CE6E22C8N on the QFP; EP4CE10E22C8N is the drop-in bigger variant).
"""

from __future__ import annotations

import re

# Cyclone IV E device handbook figures for the two trainer chips.
DEVICES = {
    "ep4ce6": {
        "key": "ep4ce6",
        "family": "Cyclone IV E",
        "part": "EP4CE6E22C8N",
        "quartusDevice": "EP4CE6E22C8",
        "package": "EQFP-144",
        "speedGrade": "8",
        "logicElements": 6272,
        "m9kBlocks": 30,
        "memoryKbit": 270,
        "multipliers18x18": 15,
        "plls": 2,
        "userIo": 91,
    },
    "ep4ce10": {
        "key": "ep4ce10",
        "family": "Cyclone IV E",
        "part": "EP4CE10E22C8N",
        "quartusDevice": "EP4CE10E22C8",
        "package": "EQFP-144",
        "speedGrade": "8",
        "logicElements": 10320,
        "m9kBlocks": 46,
        "memoryKbit": 414,
        "multipliers18x18": 23,
        "plls": 2,
        "userIo": 91,
    },
}

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
        "defaultIoStandard": "3.3 V LVTTL",
        "coreVoltage": "1.2 V",
        "pinMap": None,
        "modelNotes": MODEL_NOTES,
        "selected": _selected,
    }


# ---------------------------------------------------------------------------
# Board: RZ-EasyFPGA A2.2.  Every number below comes from board_spec.md.
# ---------------------------------------------------------------------------

_LED_PINS = ["PIN_87", "PIN_86", "PIN_85", "PIN_84"]
_KEY_PINS = ["PIN_88", "PIN_89", "PIN_90", "PIN_91"]
_SEG_PINS = ["PIN_128", "PIN_121", "PIN_125", "PIN_129", "PIN_132", "PIN_126", "PIN_124", "PIN_127"]
_DIG_PINS = ["PIN_133", "PIN_135", "PIN_136", "PIN_137"]

# SEG bit -> display segment, per the schematic Display sheet
# (SEG0->b, SEG1->a, SEG2->c, SEG3->d, SEG4->e, SEG5->f, SEG6->g, SEG7->dp).
SEG_BIT_MAP = {"b": 0, "a": 1, "c": 2, "d": 3, "e": 4, "f": 5, "g": 6, "dp": 7}

BOARD = {
    "name": "RZ-EasyFPGA A2.2",
    "vendor": "RZRD (www.rzrd.net)",
    "fpga": "EP4CE6E22C8N",
    "clockHz": 50_000_000,
    "clockPort": "CLOCK_50",
    "clockPin": "PIN_23",
    "resetPort": "FPGA_RST",
    "resetPin": "PIN_25",
    "resetActiveLow": True,
    "resetPullup": "10 kΩ + 100 nF RC",
    "leds": {
        "port": "LED",
        "count": 4,
        # Schematic: anodes to 3.3 V, cathodes through 470 R to the pins.
        "activeLow": True,
        "pins": list(_LED_PINS),
    },
    "buttons": {
        "port": "KEY",
        "count": 4,
        # Keys close to GND through 220 R; 10 kΩ pull-ups to 3.3 V.
        "activeLow": True,
        "pullup": "10 kΩ to 3.3 V",
        "pins": list(_KEY_PINS),
    },
    "switches": {
        # The red 4-position DIP is wired to the same nets as the keys.
        "port": "KEY",
        "count": 4,
        "sharedWithButtons": True,
        "activeLow": True,
        "pullup": "10 kΩ to 3.3 V",
        # ON/closed shorts the net to GND -> reads 0.
        "onValue": 0,
        "pins": list(_KEY_PINS),
    },
    "displays": {
        "ports": ["SEG"],
        "digitPort": "DIG",
        "count": 4,
        "segmentsPerDigit": 8,
        "multiplexed": True,
        # Common anode behind 8550 PNP high-side drivers.
        "segmentActiveLow": True,
        "digitActiveLow": True,
        "segBitMap": dict(SEG_BIT_MAP),
        "pins": {"SEG": list(_SEG_PINS), "DIG": list(_DIG_PINS)},
    },
    "buzzer": {
        "FPGA_BUZZER": "PIN_110",
        # 2-terminal speaker behind an 8550 PNP: no on-board oscillator.
        # Schematic proves the drive (no oscillator -> design must toggle the
        # pin); whether the fitted part is active or passive is UNVERIFIED on
        # real hardware (physical test T-BUZZER-1 in board/real_board_results.md).
        "type": "passive",
        "typeConfidence": "unverified on real hardware",
        "activeLow": True,
        "pullup": "10 kΩ to 3.3 V",
    },
    "vga": {
        "VGA_R": "PIN_106",
        "VGA_G": "PIN_105",
        "VGA_B": "PIN_104",
        "VGA_HSYNC": "PIN_101",
        "VGA_VSYNC": "PIN_103",
        "colors": 8,
    },
    "ps2": {
        "PS_CLOCK": "PIN_119",
        "PS_DATA": "PIN_120",
        "pullup": "10 kΩ to 5 V + 470 Ω series",
        "openCollector": True,
    },
    "uart": {
        "UART_TXD": "PIN_114",
        "UART_RXD": "PIN_115",
        "transceiver": "MAX3232E",
    },
    "infrared": {
        "IR": "PIN_100",
        "activeLow": True,
        "pullup": "3.3 V via 100 Ω",
    },
    "i2c": {
        # Two SEPARATE I2C buses on the schematic (board_spec.md §0c):
        # EEPROM U8 on I2C_SCL/I2C_SDA (99/98), LM75 U9 on FPGA_SCL/FPGA_SDA (112/113).
        "I2C_SCL": "PIN_99",
        "I2C_SDA": "PIN_98",
        "FPGA_SCL": "PIN_112",
        "FPGA_SDA": "PIN_113",
        "pullup": "5.1 kΩ to 3.3 V",
        "eeprom": {"part": "AT24C08", "address": 0x50, "bytes": 1024, "pageSize": 16,
                   "writeCycleMs": 5,
                   # WP (U8 pin 7) is tied to VCC on the board -> writes blocked.
                   "writeProtected": True},
        "tempSensor": {"part": "LM75", "address": 0x48},
    },
    "lcd": {
        "LCD_RS": "PIN_141",
        "LCD_RW": "PIN_138",
        "LCD_E": "PIN_143",
        "LCD_D0": "PIN_142",
        "LCD_D1": "PIN_1",
        "LCD_D2": "PIN_144",
        "LCD_D3": "PIN_3",
        "LCD_D4": "PIN_2",
        "LCD_D5": "PIN_10",
        "LCD_D6": "PIN_7",
        "LCD_D7": "PIN_11",
        "contrastTrimmer": "10 kΩ",
    },
    "sdram": {
        "part": "HY57V641620",
        "bits": 64,
        "dataBits": 16,
        "banks": 4,
        "A": ["PIN_76", "PIN_77", "PIN_80", "PIN_83", "PIN_68", "PIN_67",
              "PIN_66", "PIN_65", "PIN_64", "PIN_60", "PIN_75", "PIN_59"],
        "DQ": ["PIN_28", "PIN_30", "PIN_31", "PIN_32", "PIN_33", "PIN_34", "PIN_38", "PIN_39",
               "PIN_54", "PIN_53", "PIN_52", "PIN_51", "PIN_50", "PIN_49", "PIN_46", "PIN_44"],
        "CKE": "PIN_58", "CLK": "PIN_43", "CS": "PIN_72", "RAS": "PIN_71",
        "CAS": "PIN_70", "WE": "PIN_69", "BS0": "PIN_73", "BS1": "PIN_74",
        "LDQM": "PIN_42", "UDQM": "PIN_55",
    },
    "config": {
        "flash": "EPCS16 (U7; footprint accepts EPCS4/EPCS16)",
        "jtag": "2×5 header",
        "as": "2×5 header",
        "sof": "volatile (lost on power cycle)",
        "pof": "persistent (auto-loads from EPCS at power-on)",
        "unusedPins": 'weak pull-up, "as input tri-stated" (vendor .qsf)',
    },
    "rails": {"input": "5 V", "rails": ["3.3 V", "2.5 V", "1.2 V"], "regulators": ["1117-3.3", "1117-2.5", "1117-1.2"]},
}

# Clock aliases seen in real designs for the on-board 50 MHz oscillator.
_CLOCK_ALIASES = ["CLOCK_50", "FPGA_CLK", "CLK"]

# UI-facing notes: what the simulator models per the reconciled schematic and
# which behaviours remain unverified on real hardware (board_spec.md §0/§16-18,
# physical tests in board/real_board_results.md).
MODEL_NOTES = [
    {"topic": "Buzzer", "status": "unverified on real hardware",
     "detail": "Modelled as a passive speaker: the schematic shows a 2-terminal SPEAKER behind a single 8550 transistor with no on-board oscillator, so a tone requires toggling pin 110. Whether the fitted part is active or passive needs physical test T-BUZZER-1."},
    {"topic": "AT24C08 EEPROM", "status": "per schematic (verified)",
     "detail": "WP pin tied to VCC on the board: writes are blocked, reads work. Address 0x50 on its own bus, I2C_SCL/I2C_SDA = pins 99/98."},
    {"topic": "LM75 temperature sensor", "status": "per schematic (verified); ambient value unverified",
     "detail": "Sits on the SECOND I2C bus, FPGA_SCL/FPGA_SDA = pins 112/113, address 0x48. The simulated temperature is a UI setting, not a measured value."},
    {"topic": "PS/2 port", "status": "unverified on real hardware",
     "detail": "Model sends keyboard-style scancodes (make/break) with open-collector timing; the fitted device type is not shown on the schematic (pull-ups are to 5 V, pins 119/120)."},
    {"topic": "IR receiver", "status": "unverified on real hardware",
     "detail": "Model emits NEC frames (active-low bursts, idle high) on pin 100; the receiver part number and protocol are not marked on the schematic."},
    {"topic": "RS232 DB9", "status": "per schematic (verified, non-standard)",
     "detail": "Board TX exits on DB9 pin 7 and RX enters on pin 8, GND pin 5 - a straight-through PC cable will NOT work; a crossover (7->2, 8->3, 5<->5) is needed."},
    {"topic": "7-segment display", "status": "per schematic (verified)",
     "detail": "Common anode behind 8550 PNP digit drivers: digits and segments are active-low. SEG0=b, SEG1=a, SEG2=c, SEG3=d, SEG4=e, SEG5=f, SEG6=g, SEG7=dp."},
    {"topic": "Keys and DIP switch", "status": "per schematic (verified)",
     "detail": "The DIP is wired across the same nets as the keys (pins 88-91): pressed/closed reads 0. They cannot be used independently."},
    {"topic": "SDRAM / VGA / LCD", "status": "per schematic (verified pin maps)",
     "detail": "SDRAM HY57V641620 pin map only (no timing model). VGA is 1 bit per channel (8 colours). LCD socket signals follow the vendor pin table."},
]


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
    return index


__all__ = ["DEVICES", "DEVICE", "set_device", "get_device", "BOARD", "board_pin_map", "SEG_BIT_MAP"]