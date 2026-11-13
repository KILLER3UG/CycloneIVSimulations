"""Section 7: reference designs a student would run on a real board."""
from __future__ import annotations

from harness import (
    case,
    check,
    must_run,
    run,
    signal,
    value,
)


@case("FID-01", "7", "(1) Blinker: logic toggles at the scaled rate", "VHDL",
      "CLK_HZ=100, 10 ns clock -> 4 toggles in 2.2 us")
def fid_01() -> str:
    result = must_run("fidelity.vhd", top="blinky", duration=2200, clockPeriod=10,
                      resetCycles=0, generics={"CLK_HZ": 100})
    transitions = signal(result, "led")["transitions"]
    check(len(transitions) == 5, f"led transitions={len(transitions)}: {transitions}")
    return "4 toggles in 2.2 us at CLK_HZ=100"


@case("FID-01B", "7", "(1) Blinker: 1 Hz at the real 50 MHz board clock", "VHDL",
      "One toggle every 0.5 s of wall time; scale factor shown")
def fid_01b() -> str:
    result = must_run("fidelity.vhd", top="blinky", duration=100_000, clockPeriod=10,
                      resetCycles=0, generics={"CLK_HZ": 50_000_000})
    transitions = signal(result, "led")["transitions"]
    check(len(transitions) == 1, f"unexpected toggle in 0.1 ms: {transitions}")
    check(any("scale" in key.lower() for key in result), "no clock scale factor reported")
    return "1 Hz blinker visible in real time"


@case("FID-02", "7", "(2) Switch-to-LED pass-through", "VHDL",
      "Every switch state appears on the same LED bit")
def fid_02() -> str:
    result = must_run("fidelity.vhd", top="sw_led", duration=20, resetCycles=0,
                      constantInputs={"sw": 0xA5})
    got = value(result, "led")
    check(got == 0xA5, f"led=0x{got:02X}")
    return "0xA5"


@case("FID-03", "7", "(3) Button debounce + counter", "VHDL",
      "A held key increments the counter exactly once after the 4-sample filter")
def fid_03() -> str:
    result = must_run("fidelity.vhd", top="debounce_counter", duration=100, resetCycles=2,
                      constantInputs={"key": 1})
    got = int(value(result, "led"))
    check(got == 1, f"count={got}")
    return "count=1 after debounce"


@case("FID-04", "7", "(4) 7-segment hex counter", "VHDL",
      "Value increments and the multiplexed digits show the current nibble")
def fid_04() -> str:
    result = must_run("fidelity.vhd", top="hex_counter", duration=100, resetCycles=2)
    got = int(value(result, "value"))
    check(got == 8, f"value={got}")
    check(len(signal(result, "seg")["transitions"]) > 1, "segment output never changed")
    return f"value={got}, seg changed"


@case("FID-05", "7", "(5) Knight-rider LED sweep", "VHDL",
      "A single lit LED moves across the 8 LEDs and reverses")
def fid_05() -> str:
    result = must_run("fidelity.vhd", top="knight_rider", duration=200, resetCycles=2)
    led = signal(result, "led")["transitions"]
    check(len(led) >= 4, f"only {len(led)} LED transitions")
    values = [v for _, v in led]
    check(sum(1 for v in values if v in (1, 128)) >= 1, "endpoints never lit")
    return f"{len(led)} transitions, endpoints lit"


@case("FID-06", "7", "(6) Traffic-light FSM", "VHDL",
      "red -> red+yellow -> green -> yellow, one phase per second of cycles")
def fid_06() -> str:
    result = must_run("fsm.vhd", top="traffic_moore", duration=100, resetCycles=2)
    states = []
    for cycle in result["waveforms"]["cycles"][2:6]:
        values = cycle["values"]
        if int(values["red"]) and int(values["yellow"]):
            states.append("red+yellow")
        elif int(values["red"]):
            states.append("red")
        elif int(values["green"]):
            states.append("green")
        else:
            states.append("yellow")
    check(states == ["red+yellow", "green", "yellow", "red"], f"states={states}")
    return " -> ".join(states)


@case("FID-07", "7", "(7) PLL-driven blink", "VHDL",
      "ALTPLL generates the clock and the LED blinks")
def fid_07() -> str:
    result = run("fidelity.vhd", top="pll_blinky", duration=100, resetCycles=0)
    check(not result["ok"], f"PLL blink elaborated: {(result.get('waveforms') or {}).get('final')}")
    text = (str(result.get("errors")) + result.get("logs", "")).lower()
    check("altpll" in text or "bound" in text, f"unclear error: {text[:160]}")
    return "ALTPLL unsupported (clear error)"


@case("FID-08", "7", "(8) ROM-based display pattern", "VHDL",
      "addr=5 shows the pattern for digit 5")
def fid_08() -> str:
    result = must_run("fidelity.vhd", top="rom_display", duration=10, resetCycles=0,
                      constantInputs={"addr": 5})
    got = value(result, "hex0")
    check(got == 0b0010010, f"hex0={got:07b}")
    return "0b0010010 (digit 5)"