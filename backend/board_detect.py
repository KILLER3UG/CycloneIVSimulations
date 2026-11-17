"""Map top-level ports onto the RZ-EasyFPGA A2.2 on-board devices.

Used by the testbench generator to attach the VHDL device models in
board/models/ to a design that exposes the matching board pins.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from .device import BOARD


def _port_list(entity) -> List[Dict[str, Any]]:
    return [{"name": p.name, "upper": p.name.upper(), "width": p.width or 1,
             "direction": p.direction, "type": p.type_name.lower()} for p in entity.ports]


def _find(ports: List[Dict[str, Any]], names: List[str]) -> Any:
    wanted = {n.upper() for n in names}
    for port in ports:
        if port["upper"] in wanted:
            return port
    return None


def board_models(entity) -> List[Dict[str, Any]]:
    """Return the device models that connect to this design's ports."""
    ports = _port_list(entity)
    models: List[Dict[str, Any]] = []

    # I2C — the A2.2 has TWO SEPARATE buses (board_spec.md §0c):
    #   AT24C08 EEPROM on I2C_SCL(99)/I2C_SDA(98)  — pull-ups R25/R26
    #   LM75 sensor on FPGA_SCL(112)/FPGA_SDA(113) — pull-ups R27/R28
    # A design must drive them independently; generic SCL/SDA port names are
    # treated as the EEPROM (I2C_*) bus, the vendor's "I2C" naming.
    eeprom_scl = _find(ports, ["I2C_SCL"])
    eeprom_sda = _find(ports, ["I2C_SDA"])
    lm75_scl = _find(ports, ["FPGA_SCL"])
    lm75_sda = _find(ports, ["FPGA_SDA"])
    if eeprom_scl is None or eeprom_sda is None:
        # generic SCL/SDA port names name the EEPROM (I2C_*) bus, the vendor's
        # "I2C" naming, whenever the board's I2C_* names are absent
        g_scl = _find(ports, ["SCL"])
        g_sda = _find(ports, ["SDA"])
        if eeprom_scl is None and g_scl is not None:
            eeprom_scl = g_scl
        if eeprom_sda is None and g_sda is not None:
            eeprom_sda = g_sda
    if eeprom_scl and eeprom_sda and eeprom_scl["name"].lower() != eeprom_sda["name"].lower():
        models.append({
            "kind": "i2c_eeprom",
            "scl": eeprom_scl["name"],
            "sda": eeprom_sda["name"],
            "eeprom": {"address": BOARD["i2c"]["eeprom"]["address"],
                       "bytes": BOARD["i2c"]["eeprom"]["bytes"],
                       "page": BOARD["i2c"]["eeprom"]["pageSize"]},
        })
    if lm75_scl and lm75_sda and lm75_scl["name"].lower() != lm75_sda["name"].lower():
        models.append({
            "kind": "i2c_lm75",
            "scl": lm75_scl["name"],
            "sda": lm75_sda["name"],
            "lm75": {"address": BOARD["i2c"]["tempSensor"]["address"],
                     # Ambient temperature is a simulation parameter: the
                     # board profile may override it, otherwise 25.0 C is the
                     # documented classroom default (LM75 power-up 0x1900 (9-bit, 0.5 C LSB)).
                     "temperature": BOARD["i2c"]["tempSensor"].get("temperatureC", 25.0)},
        })

    # PS/2 keyboard.
    psc = _find(ports, ["PS_CLOCK", "PS_CLK"])
    psd = _find(ports, ["PS_DATA"])
    if psc and psd and psc["name"].lower() != psd["name"].lower():
        models.append({"kind": "ps2", "clock": psc["name"], "data": psd["name"],
                       "scancoders": [0x5A]})

    # Character LCD socket.
    rs = _find(ports, ["LCD_RS", "RS"])
    rw = _find(ports, ["LCD_RW", "RW"])
    en = _find(ports, ["LCD_E", "E"])
    data = _find(ports, ["LCD_D", "LCD_D0"])
    if rs and rw and en and data:
        models.append({"kind": "lcd", "rs": rs["name"], "rw": rw["name"],
                       "e": en["name"], "data": data["name"],
                       "width": data["width"]})

    # IR receiver input (the model drives it with an NEC frame).  The NEC
    # address/command are simulation parameters: the board profile may
    # override them, otherwise 0x00/0x01 is the documented default frame.
    ir = _find(ports, ["IR"])
    if ir:
        infrared = BOARD.get("infrared", {})
        models.append({"kind": "ir", "ir": ir["name"],
                       "command": infrared.get("necCommand", 0x01),
                       "address": infrared.get("necAddress", 0x00)})

    return models


def model_files(models: List[Dict[str, Any]]) -> List[str]:
    """The VHDL sources that must be analysed for these device models."""
    base = "board/models"
    files: List[str] = []
    kinds = {m["kind"] for m in models}
    if "i2c_eeprom" in kinds:
        files += [f"{base}/at24c08.vhd"]
    if "i2c_lm75" in kinds:
        files += [f"{base}/lm75.vhd"]
    if "ps2" in kinds:
        files += [f"{base}/ps2_keyboard.vhd"]
    if "lcd" in kinds:
        files += [f"{base}/hd44780.vhd"]
    if "ir" in kinds:
        files += [f"{base}/ir_nec.vhd"]
    if "altpll" in kinds:
        files += [f"{base}/altpll.vhd"]
    return files


__all__ = ["board_models", "model_files"]
