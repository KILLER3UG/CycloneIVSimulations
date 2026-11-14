"""Section 14: end-to-end runs of the vendor example projects.

The vendor ships Verilog originals plus VHDL forms; the simulator is VHDL-only,
so the VHDL forms are run unmodified and their documented behaviour is
compared against the vendor description.
"""
from __future__ import annotations

from pathlib import Path

from harness import case, check, errors_text, run_text, value

ROOT = Path(__file__).resolve().parent.parent.parent
VENDOR = ROOT / "board" / "vendor" / "examples"


def _vendor_vhdl(example: str) -> str:
    name = "led_and_vhdl" if example == "my_and" else f"{example}_vhdl"
    path = VENDOR / example / f"{name}.vhd"
    return path.read_text(encoding="utf-8")


@case("E2E-01", "14", "Vendor example my_and (led_and): AND truth table", "VHDL",
      "c = a AND b for all four input combinations")
def e2e_01() -> str:
    src = _vendor_vhdl("my_and")
    rows = []
    for a, b in ((0, 0), (0, 1), (1, 0), (1, 1)):
        result = run_text(src, top="led_and", duration=20, resetCycles=0,
                          constantInputs={"a": a, "b": b})
        check(result.get("ok"), f"simulation failed: {errors_text(result)}")
        rows.append(int(value(result, "c")))
    check(rows == [0, 0, 0, 1], f"AND truth table {rows}")
    return "my_and/led_and: c = a AND b (0,0,0,1)"


@case("E2E-02", "14", "Vendor example key_led: case table for the four keys", "VHDL",
      "1110->1110, 1101->1100, 1011->1000, 0111->0000, otherwise 1111")
def e2e_02() -> str:
    src = _vendor_vhdl("key_led")
    cases = {"1110": 0b1110, "1101": 0b1100, "1011": 0b1000,
             "0111": 0b0000, "1111": 0b1111, "0000": 0b1111}
    for key, expected in cases.items():
        result = run_text(src, top="key_led", duration=20, resetCycles=0,
                          constantInputs={"key": int(key, 2)})
        check(result.get("ok"), f"simulation failed: {errors_text(result)}")
        got = int(value(result, "led"))
        check(got == expected, f"key={key}: led={got:04b}, expected {expected:04b}")
    return "key_led case table reproduced exactly"


@case("E2E-03", "14", "Vendor example ckey_led: LED = ckey (DIP shares KEY nets)", "VHDL",
      "ckey=0111 -> LED=0111 (DIP ON lights the LED, active low)")
def e2e_03() -> str:
    src = _vendor_vhdl("ckey_led")
    result = run_text(src, top="ckey_led", duration=20, resetCycles=0,
                      constantInputs={"ckey": 0b0111})
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "LED"))
    check(got == 0b0111, f"LED={got:04b}; expected 0111")
    return "ckey_led: LED follows the DIP (active-low), confirming the shared net"


@case("E2E-04", "14", "Vendor example led_twinkle unmodified: 25M-cycle counter, no early toggle", "VHDL",
      "over 200 clocks the LEDs stay 1111 (the toggle is at 25,000,000 clocks)")
def e2e_04() -> str:
    src = _vendor_vhdl("led_twinkle")
    result = run_text(src, top="led_twinkle", duration=2000, clockPeriod=10, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "led"))
    check(got == 0b1111, f"led={got:04b}; expected 1111 before the 25M-cycle toggle")
    return "unmodified led_twinkle: LEDs hold 1111 for the first 200 clocks"


@case("E2E-05", "14", "led_twinkle toggle logic (simulation-adapted 2500-cycle threshold)", "VHDL",
      "with the threshold scaled to 2500 clocks, the LEDs toggle to 0000")
def e2e_05() -> str:
    src = _vendor_vhdl("led_twinkle").replace("counter = 25_000_000", "counter = 2500")
    check("counter = 2500" in src, "adaptation did not apply")
    result = run_text(src, top="led_twinkle", duration=26_000, clockPeriod=10, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "led"))
    check(got == 0b0000, f"led={got:04b}; expected 0000 after the toggle")
    return "toggle logic verified with a scaled threshold (the full 25M-clock run exceeds the 60 s GHDL budget)"
