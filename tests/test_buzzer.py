"""Part B — buzzer (BEEP PIN_110) cycle-accurate audio + buzz1 acceptance.

Expected values are derived from the schematic drive (active-low PNP, passive
2-terminal speaker) and from buzz1's own equations:

    tone half period = audibles = 31,250 cycles  -> 800 Hz at 50 MHz
    note length      = fivesec  = 50,000,000 cycles -> 1.000 s

No wall-clock intervals are used anywhere in the assertions.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.peripherals import decode_buzzer
from backend.simulator import SimulationRequest, Simulator

ROOT = Path(__file__).resolve().parents[1]
BUZZ1 = ROOT / "examples" / "buzz1.vhd"


@pytest.fixture(scope="module")
def sim() -> Simulator:
    return Simulator()


def test_decode_buzzer_buzz1_800hz():
    # 31,250 cycles at 20 ns = 625,000 ns half period; full period 1.25 ms.
    edges = [
        (0.0, 1),
        (625_000.0, 0),
        (1_250_000.0, 1),
        (1_875_000.0, 0),
        (2_500_000.0, 1),
    ]
    decoded = decode_buzzer(edges, clock_ns=20.0, active_low=True)
    assert decoded["tone"] is True
    assert decoded["frequency"] == 800
    assert decoded["cyclesPerPeriod"] == pytest.approx(62_500.0)
    assert decoded["duty"] == pytest.approx(0.5, abs=0.01)
    assert decoded["activeLow"] is True
    assert decoded["edges"][0] == [0.0, 1]
    assert decoded["edges"][-1][1] == 1


def test_decode_buzzer_dc_levels_are_silent():
    # Steady HIGH = transistor off; steady LOW = DC on a passive speaker.
    assert decode_buzzer([(0.0, 1)], clock_ns=20.0)["tone"] is False
    assert decode_buzzer([(0.0, 0)], clock_ns=20.0)["tone"] is False
    assert decode_buzzer([(0.0, 0), (1_000_000.0, 0)], clock_ns=20.0)["tone"] is False


def test_reference_buzz1_note_is_one_second():
    """Independent cycle model of buzz1's down-counter (no GHDL)."""
    sec_counter = 49_999_999  # fivesec - 1, loaded on the release edge
    cycles = 0
    timer_active = True
    while timer_active:
        cycles += 1
        if sec_counter > 0:
            sec_counter -= 1
        else:
            timer_active = False
    assert cycles == 50_000_000
    assert cycles * 20 / 1e9 == pytest.approx(1.0)


def test_buzz1_backend_800hz(sim: Simulator):
    result = sim.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": BUZZ1.read_text(encoding="utf-8"),
                "top": "buzz1",
                "duration": 3_000_000,   # 150,000 cycles: >2 full 800 Hz periods
                "clockPeriod": 20,      # 50 MHz board clock
                "resetCycles": 0,
                "compactBoard": True,
                "maxCycles": 200,
                # btn1 held low (active-low key closed) -> timer permanently
                # reloaded -> continuous 800 Hz tone.
                "stimuli": [{"port": "btn1", "kind": "constant", "value": 0}],
            }
        )
    )
    assert result["ok"], result.get("errors")
    buzzer = result["peripherals"]["buzzer"]
    assert buzzer["tone"] is True, buzzer
    assert buzzer["frequency"] == 800, buzzer
    assert buzzer["cyclesPerPeriod"] == pytest.approx(62_500.0)
    assert buzzer["duty"] == pytest.approx(0.5, abs=0.02)


def test_buzz1_release_loads_one_second_countdown(sim: Simulator):
    """A one-cycle press then release must load sec_counter = 49,999,999.

    The capture stays short (200 sampled cycles); the note length is read from
    the design's own loaded counter, not from a 33 s GHDL run.
    """
    result = sim.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": BUZZ1.read_text(encoding="utf-8"),
                "top": "buzz1",
                "duration": 3_000_000,
                "clockPeriod": 20,
                "resetCycles": 0,
                "compactBoard": False,
                "maxCycles": 200,
                "stimuli": [
                    {
                        "port": "btn1",
                        "kind": "pulse_once",
                        "values": [0, 1],
                        "holdCycles": 1,
                    },
                    # The auto-testbench defaults unused inputs to 0; btn2 must
                    # be open (1) or orcombi stays 1 and reloads the timer.
                    {"port": "btn2", "kind": "constant", "value": 1},
                ],
            }
        )
    )
    assert result["ok"], result.get("errors")
    cycles = result["waveforms"]["cycles"]
    assert cycles, "no cycles captured"
    sec_values = [
        c["values"]["sec_counter"]
        for c in cycles
        if isinstance(c["values"].get("sec_counter"), int)
    ]
    assert sec_values, "sec_counter was not dumped"
    assert max(sec_values) >= 49_999_000, max(sec_values)
    countdown = result["waveforms"]["boardImage"]["countdown"]
    assert countdown and countdown["terminal"] >= 49_999_000, countdown
    buzzer = result["peripherals"]["buzzer"]
    assert buzzer["tone"] is True
    assert buzzer["frequency"] == 800


def test_buzz1_both_buttons_are_identical(sim: Simulator):
    """btn2 produces the same 800 Hz / 50% square as btn1."""
    for port in ("btn1", "btn2"):
        result = sim.simulate(
            SimulationRequest.from_dict(
                {
                    "vhdl": BUZZ1.read_text(encoding="utf-8"),
                    "top": "buzz1",
                    "duration": 3_000_000,
                    "clockPeriod": 20,
                    "resetCycles": 0,
                    "compactBoard": True,
                    "maxCycles": 100,
                    "stimuli": [
                        {"port": port, "kind": "constant", "value": 0},
                        # the other button must be open (1)
                        {"port": "btn2" if port == "btn1" else "btn1", "kind": "constant", "value": 1},
                    ],
                }
            )
        )
        assert result["ok"], result.get("errors")
        buzzer = result["peripherals"]["buzzer"]
        assert buzzer["frequency"] == 800, (port, buzzer)
        assert buzzer["duty"] == pytest.approx(0.5, abs=0.02)


def test_buzz1_idle_is_silent(sim: Simulator):
    result = sim.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": BUZZ1.read_text(encoding="utf-8"),
                "top": "buzz1",
                "duration": 1000,
                "clockPeriod": 20,
                "resetCycles": 0,
                "compactBoard": True,
                "maxCycles": 100,
                # btn1/btn2 open (logic 1) -> orcombi = 0, timer_active = 0.
                "stimuli": [
                    {"port": "btn1", "kind": "constant", "value": 1},
                    {"port": "btn2", "kind": "constant", "value": 1},
                ],
            }
        )
    )
    assert result["ok"], result.get("errors")
    buzzer = result["peripherals"]["buzzer"]
    assert buzzer["tone"] is False
    assert buzzer["frequency"] == 0
    assert buzzer["level"] == 1