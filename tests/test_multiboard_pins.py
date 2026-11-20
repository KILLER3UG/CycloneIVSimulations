"""Multi-board pin-resolution regressions (audit minor fixes).

Covers two defects:
* board_pin_map() registered a spurious generic "PIN" port from the buzzer /
  infrared scalar "pin" metadata (the IR entry's PIN_100 silently overwrote
  the buzzer's PIN_110), so a design port literally named PIN bound to IR.
* switch bus/scalar aliases always resolved onto KEY, even on boards with a
  separate switch bank (DE0-Nano SW vs KEY).
"""
from __future__ import annotations

import pytest

from backend.device import board_pin_map, resolve_port_pins, select_board

DEFAULT = "rz-easyfpga-a2.2"
SECOND = "de0-nano-ep4ce22"


@pytest.fixture(autouse=True)
def _restore_default_board():
    select_board(DEFAULT)
    yield
    select_board(DEFAULT)


def test_no_spurious_pin_port_on_any_board():
    for board_id in (DEFAULT, SECOND):
        select_board(board_id)
        assert "PIN" not in board_pin_map()


def test_rz_switch_aliases_still_resolve_onto_shared_key_nets():
    select_board(DEFAULT)
    key_bus = board_pin_map()["KEY"]
    assert resolve_port_pins("sw", "switch") == key_bus
    assert resolve_port_pins("dip", "switch") == key_bus
    assert resolve_port_pins("buttons", "button") == key_bus
    assert resolve_port_pins("sw1") == [key_bus[0]]
    assert resolve_port_pins("s3") == [key_bus[2]]


def test_de0_switch_aliases_resolve_onto_the_switch_bank():
    select_board(SECOND)
    pins = board_pin_map()
    sw_bus, key_bus = pins["SW"], pins["KEY"]
    assert resolve_port_pins("sw", "switch") == sw_bus
    assert resolve_port_pins("dip", "switch") == sw_bus
    assert resolve_port_pins("sw1") == [sw_bus[0]]
    assert resolve_port_pins("sw4") == [sw_bus[3]]
    # button-ish names keep resolving onto the key bank
    assert resolve_port_pins("key", "button") == key_bus
    assert resolve_port_pins("btn2") == [key_bus[1]]
