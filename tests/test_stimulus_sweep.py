"""Slice 1.1 — pre-computed multi-vector stimulus sweep engine.

Every expectation here is a *design equation* checked against a real GHDL
sweep, not a restatement of the implementation:

* buzz_4tone latches 50_000 / 31_250 / 25_000 / 15_625 cycle half periods
  (500 / 800 / 1000 / 1600 Hz at 50 MHz) and a 25_000_000-cycle release note.
* buzz1 binds only its two keys but still publishes all 16 board masks.
* sevseg_4tube has no interactive input, so the fast path reuses the already
  captured board image (four tubes at ~25 % duty).
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


def test_sevseg_4tube_fast_path_reuses_captured_board_image(sim: Simulator) -> None:
    # A full 4-digit scan at 16,384 cycles/tube is 65,536 cycles (1.31072 ms).
    sweep = _sweep(
        sim, EXAMPLES / "sevseg_4tube.vhd", "sevseg_4tube",
        duration=1_311_000,
    )

    assert sweep["meta"]["boundChannels"] == []
    assert sweep["meta"]["partial"] is False
    assert sweep["releases"] == {}
    assert sorted(sweep["vectors"], key=int) == [str(i) for i in range(16)]

    # Every vector is the same pre-computed single entry.
    first = sweep["vectors"]["0"]
    assert all(entry == first for entry in sweep["vectors"].values())
    pov = first["pov"]
    assert len(pov) == 32
    for digit in range(4):
        lit = [pov[digit * 8 + bit] for bit in range(8) if first["povBits"][digit * 8 + bit]]
        assert lit, f"tube {digit} is dark"
        assert all(0.2 <= value <= 0.3 for value in lit), (digit, lit)


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
