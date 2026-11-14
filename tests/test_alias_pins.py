"""Textbook port-name alias resolution (seven_seg/dtube/s1..s4 -> board pins).

Expected pin values are read from board/board.json (the single source of
truth) BEFORE the resolver runs, and each assertion compares the resolver's
result against that expectation -- the same evidence chain the QA harness
uses for its cases.
"""

import pytest

from backend.device import board_pin_map, resolve_port_pins


def _pins(*names):
    pm = board_pin_map()
    out = []
    for n in names:
        v = pm[n.upper()]
        out.extend(v if isinstance(v, list) else [v])
    return out


# ---- declared expectations (from board.json, before running the resolver) ---
# board_pin_map() exposes the merged per-bit buses in bit order (SEG[0..7] etc.)
SEG_BUS = _pins("SEG")
DIG_BUS = _pins("DIG")
KEY_BUS = _pins("KEY")
LED_BUS = _pins("LED")
RESET_PIN = _pins("FPGA_RST")[0]


@pytest.mark.parametrize(
    "name,kind,expected",
    [
        ("seven_seg", "display", SEG_BUS),
        ("SEVEN_SEG", "display", SEG_BUS),
        ("seg7", "display", SEG_BUS),
        ("display", "display", SEG_BUS),
        ("dtube", "digit", DIG_BUS),
        ("DTUBE", "digit", DIG_BUS),
        ("tube", "digit", DIG_BUS),
        ("dig", "digit", DIG_BUS),
    ],
)
def test_bus_aliases_map_whole_port_onto_profile_bus(name, kind, expected):
    # port bit i drives profile bit i (seven_seg(0) is segment 'a' = SEG0)
    assert resolve_port_pins(name, kind) == expected


def test_bus_alias_requires_the_classifier_kind():
    # without the waveform classification the bus alias must not fire
    # (prevents bare "display"-ish names hijacking unrelated ports)
    assert resolve_port_pins("seven_seg", None) is None
    assert resolve_port_pins("dtube", None) is None


@pytest.mark.parametrize(
    "name,expected",
    [
        ("s1", [KEY_BUS[0]]),
        ("s2", [KEY_BUS[1]]),
        ("s3", [KEY_BUS[2]]),
        ("s4", [KEY_BUS[3]]),
        ("key2", [KEY_BUS[1]]),
        ("sw1", [KEY_BUS[0]]),   # DIP shares the KEY nets on the A2.2
        ("btn4", [KEY_BUS[3]]),
        ("led2", [LED_BUS[1]]),
        ("LED1", [LED_BUS[0]]),
    ],
)
def test_numbered_scalars_map_onto_one_bus_bit(name, expected):
    assert resolve_port_pins(name) == expected


def test_out_of_range_scalar_has_no_pin():
    assert resolve_port_pins("s9") is None
    assert resolve_port_pins("led7") is None


def test_reset_alias_maps_to_the_reset_key():
    assert resolve_port_pins("reset") == [RESET_PIN]
    assert resolve_port_pins("rst") == [RESET_PIN]


def test_exact_profile_names_win_over_aliases():
    assert resolve_port_pins("SEG") == SEG_BUS          # exact, not via alias
    assert resolve_port_pins("KEY") == KEY_BUS
    assert resolve_port_pins("CLOCK_50") == [_pins("CLOCK_50")[0]]


def test_unrelated_names_still_resolve_to_nothing():
    assert resolve_port_pins("foo_bar") is None
    assert resolve_port_pins("my_data", "display") is None  # 'display' kind but name not an alias


def test_sevseg_style_design_resolves_every_port():
    """The user's sevseg example: clk/s1..s4/dtube/seven_seg all get pins."""
    assert resolve_port_pins("dtube", "digit") == DIG_BUS
    assert resolve_port_pins("seven_seg", "display") == SEG_BUS
    for i, name in enumerate(("s1", "s2", "s3", "s4"), start=1):
        assert resolve_port_pins(name) == [KEY_BUS[i - 1]]
