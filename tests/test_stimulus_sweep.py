"""Slice 1.1 — pre-computed multi-vector stimulus sweep engine.

Every expectation here is a *design equation* checked against a real GHDL
sweep, not a restatement of the implementation:

* buzz_4tone latches 50_000 / 31_250 / 25_000 / 15_625 cycle half periods
  (500 / 800 / 1000 / 1600 Hz at 50 MHz) and a 25_000_000-cycle release note.
* buzz1 binds only its two keys but still publishes all 16 board masks.
* sevseg_4tube binds all four keys: idle multiplexes 1/2/3/4 across the
  tubes (each at ~25 % duty) and a held key forces that digit on ALL four
  tubes at full duty.
* sevseg_keys lights every tube only when S1 and at least one of S2..S4 close.
* key_led4 mirrors active-low keys onto active-low LEDs.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.simulator import SimulationRequest, Simulator

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
KEY_LED4 = ROOT / "tests" / "qa" / "designs" / "board" / "key_led4.vhd"


@pytest.fixture(scope="module")
def sim() -> Simulator:
    try:
        GhdlTool()
    except GhdlNotFoundError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"GHDL not available: {exc}")
    return Simulator()


def _sweep(sim: Simulator, path: Path, top: str, **overrides) -> dict:
    payload = {
        "vhdl": path.read_text(encoding="utf-8"),
        "top": top,
        "clockPeriod": 20,
        "resetCycles": 2,
        "maxCycles": 32,
        "compactBoard": True,
        "includeStimulusMap": True,
    }
    payload.update(overrides)
    result = sim.simulate(SimulationRequest.from_dict(payload))
    assert result["ok"], result.get("errors")
    assert result.get("stimulusMap") is not None, "stimulusMap was not attached"
    return result["stimulusMap"]


def _freq(entry: dict) -> int:
    return int(entry["buzzerDecode"]["frequency"])


def test_buzz_4tone_all_four_keys_and_release_notes(sim: Simulator) -> None:
    sweep = _sweep(sim, EXAMPLES / "buzz_4tone.vhd", "buzz_4tone")

    assert sweep["meta"]["channelCount"] == 4
    assert sweep["meta"]["boundChannels"] == [0, 1, 2, 3]
    assert sweep["meta"]["partial"] is False
    assert sorted(sweep["vectors"], key=int) == [str(i) for i in range(16)]

    # bit b of the board mask is the logic level of KEY(b+1): 0 = pressed.
    assert _freq(sweep["vectors"]["14"]) == 500    # KEY1 only
    assert _freq(sweep["vectors"]["13"]) == 800    # KEY2 only
    assert _freq(sweep["vectors"]["11"]) == 1000   # KEY3 only
    assert _freq(sweep["vectors"]["7"]) == 1600    # KEY4 only
    assert _freq(sweep["vectors"]["15"]) == 0      # all keys open -> silent

    for index, expected_hz in enumerate((500, 800, 1000, 1600)):
        release = sweep["releases"][str(index)]
        assert release["releaseCycles"] == 25_000_000, release
        assert _freq(release) == expected_hz, release
        assert release["buzzerDecode"]["duty"] == pytest.approx(0.5, abs=0.01)


def test_buzz1_two_bound_keys_still_cover_sixteen_masks(sim: Simulator) -> None:
    sweep = _sweep(sim, EXAMPLES / "buzz1.vhd", "buzz1")

    assert sweep["meta"]["boundChannels"] == [0, 1]
    assert sweep["meta"]["partial"] is False
    assert sorted(sweep["vectors"], key=int) == [str(i) for i in range(16)]

    for mask in range(16):
        hz = _freq(sweep["vectors"][str(mask)])
        either_pressed = (mask & 0b0011) != 0b0011
        assert hz == (800 if either_pressed else 0), (mask, hz)

    for index in ("0", "1"):
        assert sweep["releases"][index]["releaseCycles"] == 50_000_000
        assert _freq(sweep["releases"][index]) == 800


def test_sevseg_4tube_keys_select_the_displayed_digit(sim: Simulator) -> None:
    # A full 4-digit scan at 16,384 cycles/tube is 65,536 cycles (1.31072 ms).
    sweep = _sweep(
        sim, EXAMPLES / "sevseg_4tube.vhd", "sevseg_4tube",
        duration=1_311_000,
    )

    assert sweep["meta"]["boundChannels"] == [0, 1, 2, 3]
    assert sweep["meta"]["partial"] is False
    assert sorted(sweep["vectors"], key=int) == [str(i) for i in range(16)]

    # Segment bit sets per glyph (bit 0 = 'a' ... bit 6 = 'g'; bit 7 = dp off).
    seg = {"1": {1, 2}, "2": {0, 1, 3, 4, 6}, "3": {0, 1, 2, 3, 6}, "4": {1, 2, 5, 6}}

    def lit_sets(entry: dict) -> list[set[int]]:
        out = []
        for digit in range(4):
            bits = {bit for bit in range(8) if entry["povBits"][digit * 8 + bit]}
            out.append({bit for bit in bits if bit != 7})
        return out

    # Idle (all keys open, mask 15): D1..D4 show 1/2/3/4, each tube lit only
    # during its quarter of the scan -> ~25% duty per lit segment.
    idle = sweep["vectors"]["15"]
    idle_sets = lit_sets(idle)
    assert idle_sets[3] == seg["1"]  # tube 3 = leftmost = D1
    assert idle_sets[2] == seg["2"]  # tube 2 = D2
    assert idle_sets[1] == seg["3"]  # tube 1 = D3
    assert idle_sets[0] == seg["4"]  # tube 0 = rightmost = D4
    for digit in range(4):
        duties = [idle["pov"][digit * 8 + b] for b in sorted(idle_sets[digit])]
        assert all(0.2 <= v <= 0.3 for v in duties), (digit, duties)

    # Held key (bit b of the mask is the level of KEY(b+1): 0 = pressed)
    # forces that digit on ALL four tubes. The tubes stay multiplexed (each
    # driven 1/4 of the scan), so the lit duty stays ~0.25 per tube -- the
    # GLYPH is what changes, on all four tubes at once.
    for mask, glyph in (("14", "1"), ("13", "2"), ("11", "3"), ("7", "4")):
        vec = sweep["vectors"][mask]
        assert lit_sets(vec) == [seg[glyph]] * 4, (mask, lit_sets(vec))
        for digit in range(4):
            duties = [vec["pov"][digit * 8 + b] for b in sorted(seg[glyph])]
            assert all(0.2 <= v <= 0.3 for v in duties), (mask, digit, duties)


def test_sevseg_keys_pov_depends_on_switch_pattern(sim: Simulator) -> None:
    sweep = _sweep(sim, EXAMPLES / "sevseg_keys.vhd", "sevseg")

    assert sweep["meta"]["boundChannels"] == [0, 1, 2, 3]
    assert sorted(sweep["vectors"], key=int) == [str(i) for i in range(16)]

    # 15 = all switches open: ge = 0 -> no digit selected -> every tube dark.
    assert not any(sweep["vectors"]["15"]["povBits"])

    # 12 = 1100 -> S1 closed, S2 closed, S3/S4 open -> ge = 1, rotating glyph.
    lit = sweep["vectors"]["12"]
    for digit in range(4):
        values = [lit["pov"][digit * 8 + b] for b in range(8) if lit["povBits"][digit * 8 + b]]
        assert values, f"tube {digit} dark with S1+S2 closed"
        assert all(0.2 <= v <= 0.3 for v in values), (digit, values)

    # 14 = 1110 -> only S1 closed -> ge = 0 -> dark.
    assert not any(sweep["vectors"]["14"]["povBits"])


def test_key_led4_active_low_mirroring(sim: Simulator) -> None:
    sweep = _sweep(sim, KEY_LED4, "key_led4")

    assert sweep["meta"]["boundChannels"] == [0, 1, 2, 3]
    assert sweep["vectors"]["14"]["leds"] == [1, 0, 0, 0]  # KEY1 pressed
    assert sweep["vectors"]["15"]["leds"] == [0, 0, 0, 0]  # all open
    assert sweep["vectors"]["0"]["leds"] == [1, 1, 1, 1]   # all pressed


def test_sweep_handles_typed_scalar_inputs(sim: Simulator, tmp_path) -> None:
    """Integer/boolean inputs must not break the generated stimulus driver."""
    design = tmp_path / "mixio.vhd"
    design.write_text(
        """library ieee;
use ieee.std_logic_1164.all;
entity mixio is
  port (
    clk  : in  std_logic;
    btn1 : in  std_logic;
    cfg  : in  integer := 0;
    flag : in  boolean := false;
    led  : out std_logic_vector(3 downto 0)
  );
end entity;
architecture rtl of mixio is
begin
  led <= "0000";
end architecture;
""",
        encoding="utf-8",
    )
    sweep = _sweep(sim, design, "mixio")
    assert sweep["meta"]["boundChannels"] == [0]
    assert sorted(sweep["vectors"], key=int) == [str(i) for i in range(16)]


def test_include_stimulus_map_is_part_of_the_request_and_cache_key() -> None:
    payload = {"vhdl": "entity x is end entity;", "includeStimulusMap": True}
    request = SimulationRequest.from_dict(payload)
    assert request.include_stimulus_map is True
    other = SimulationRequest.from_dict({"vhdl": "entity x is end entity;"})
    assert other.include_stimulus_map is False
    assert request.cache_key() != other.cache_key()
    # snake_case spelling is accepted too.
    snake = SimulationRequest.from_dict({"vhdl": "entity x is end entity;", "include_stimulus_map": True})
    assert snake.include_stimulus_map is True
