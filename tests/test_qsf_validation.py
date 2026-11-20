"""Board-driven QSF validation (multi-board audit fix 3).

The legal pin identifiers and DEVICE values come from the ACTIVE board
profile, not from hardcoded constants: EQFP-144 (RZ-EasyFPGA A2.2) accepts
PIN_1..PIN_144 only, while FBGA-256 (Terasic DE0-Nano) accepts PIN_1..PIN_256
plus BGA ball names such as PIN_R8, and the accepted DEVICE strings are the
manifest's fitted parts.
"""
from __future__ import annotations

import pytest

from backend.device import select_board
from backend.qsf_parser import parse_qsf

DEFAULT = "rz-easyfpga-a2.2"
SECOND = "de0-nano-ep4ce22"


@pytest.fixture(autouse=True)
def _restore_default_board():
    select_board(DEFAULT)
    yield
    select_board(DEFAULT)


def test_rz_eqfp144_rejects_out_of_range_and_ball_pins():
    for pin in ("PIN_0", "PIN_145", "PIN_999", "PIN_AB", "PIN_R8", "PIN_"):
        result = parse_qsf(f"set_location_assignment {pin} -to LED[0]\n")
        assert not result.ok, f"{pin} accepted on EQFP-144"
        assert any("invalid pin" in e["message"] for e in result.errors)
        assert any("144-pin EQFP" in e["message"] for e in result.errors), result.errors


def test_rz_eqfp144_still_accepts_its_own_pins_and_devices():
    result = parse_qsf(
        "set_location_assignment PIN_87 -to LED[0]\n"
        'set_global_assignment -name DEVICE EP4CE6E22C8\n'
        'set_global_assignment -name FAMILY "Cyclone IV E"\n'
    )
    assert result.ok, result.errors
    assert result.pins["LED"] == ["PIN_87"]
    # the drop-in variant stays accepted on the A2.2
    result = parse_qsf("set_global_assignment -name DEVICE EP4CE10E22C8N\n")
    assert result.ok, result.errors


def test_rz_rejects_de0_device():
    result = parse_qsf("set_global_assignment -name DEVICE EP4CE22F17C6N\n")
    assert not result.ok
    assert any("does not match the fitted chip" in e["message"] for e in result.errors)


def test_de0_nano_fbga256_accepts_numeric_pins_up_to_256():
    select_board(SECOND)
    result = parse_qsf("set_location_assignment PIN_145 -to LED[0]\n")
    assert result.ok, result.errors
    assert result.pins["LED"] == ["PIN_145"]


def test_de0_nano_fbga256_accepts_ball_names():
    select_board(SECOND)
    result = parse_qsf("set_location_assignment PIN_R8 -to CLOCK_50\n")
    assert result.ok, result.errors
    assert result.pins["CLOCK_50"] == ["PIN_R8"]


def test_de0_nano_still_rejects_out_of_range_and_malformed_pins():
    select_board(SECOND)
    for pin in ("PIN_0", "PIN_257", "PIN_999", "PIN_AB", "PIN_"):
        result = parse_qsf(f"set_location_assignment {pin} -to LED[0]\n")
        assert not result.ok, f"{pin} accepted on FBGA-256"
        assert any("256-ball FBGA" in e["message"] for e in result.errors), result.errors


def test_de0_nano_accepts_its_fitted_device():
    select_board(SECOND)
    result = parse_qsf(
        "set_global_assignment -name DEVICE EP4CE22F17C6N\n"
        'set_global_assignment -name FAMILY "Cyclone IV E"\n'
    )
    assert result.ok, result.errors


def test_de0_nano_rejects_foreign_devices():
    select_board(SECOND)
    result = parse_qsf("set_global_assignment -name DEVICE EP4CE6E22C8\n")
    assert not result.ok
    assert any("does not match the fitted chip" in e["message"] for e in result.errors)


def test_de0_nano_rejects_wrong_family():
    select_board(SECOND)
    result = parse_qsf('set_global_assignment -name FAMILY "Cyclone V"\n')
    assert not result.ok
    assert any("family" in e["message"].lower() for e in result.errors)
