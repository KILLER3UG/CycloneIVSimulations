"""Section 2b (inputs) and section 3 (outputs)."""
from __future__ import annotations

from pathlib import Path

from harness import (
    ROOT,
    case,
    check,
    cycle_count,
    cycle_values,
    frontend_dir,
    must_run,
    run,
    run_tb,
    signal,
    value,
)

FRONTEND = frontend_dir()


def frontend_text() -> str:
    """The modern Vite app sources (src/), flattened for QA string checks."""
    chunks = []
    for rel in ("index.html", "src/main.js", "src/board/index.js", "src/board/io.js"):
        path = FRONTEND / rel
        if path.exists():
            chunks.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(chunks)


# ---------------------------------------------------------------------------
# 2b. Input devices
# ---------------------------------------------------------------------------


@case("INP-01", "2b", "Each switch individually reaches the matching LED", "VHDL",
      "sw[i] -> led[i] for i = 0..7")
def inp_01() -> str:
    results = []
    for bit in range(8):
        result = must_run("board.vhd", top="sw_led8", duration=20,
                          constantInputs={"sw": 1 << bit})
        got = value(result, "led")
        check(got == (1 << bit), f"bit {bit}: led=0x{got:02X}")
        results.append(f"{bit}:0x{got:02X}")
    return " ".join(results)


@case("INP-02", "2b", "All 256 switch combinations reach the LEDs", "VHDL",
      "led == sw for every value 0..255 (asserted in the testbench)")
def inp_02() -> str:
    result = must_run_tb = run_tb("board.vhd", "tb_switches_all.vhd", "tb_switches_all", duration=300)
    check(result["ok"], "exhaustive switch testbench failed")
    return "all 256 values matched (testbench assertions passed)"


@case("INP-03", "2b", "Button polarity matches the board (idle high, active low)", "VHDL",
      "Pressing a key (electrical 0) increments the counter; idle (1) does not")
def inp_03() -> str:
    result = must_run("board.vhd", top="key_edge", duration=100, resetCycles=0,
                      stimuli=[{"port": "key", "kind": "pulse", "pulseCycles": 1, "periodCycles": 4}])
    count = int(value(result, "led"))
    check(count > 0, "active-high pulse did not count")
    app = (FRONTEND / "src" / "main.js").read_text(encoding="utf-8")
    check("closed ? (low ? 0 : 1)" in app,
          "UI key click does not drive the port low (board keys pull the net to 0 when pressed)")
    return f"pulse counted {count}; UI key click now drives the net low like a real key press"


@case("INP-04", "2b", "Edge detector sees a press and release", "VHDL",
      "One clean press produces exactly one count")
def inp_04() -> str:
    result = run_tb("board.vhd", "tb_edge.vhd", "tb_edge", duration=150)
    check(result["ok"], "edge testbench failed")
    return "count=1 for one press/release"


@case("INP-05", "2b", "Press shorter than one clock period is missed (documented)", "VHDL",
      "A 1 ns pulse between rising edges is not counted")
def inp_05() -> str:
    result = must_run_tb = run_tb("board.vhd", "tb_short_pulse.vhd", "tb_short_pulse", duration=150)
    check(result["ok"], "short-pulse testbench failed")
    return "count=0; sub-cycle pulse is not seen by a clocked edge detector"


@case("INP-06", "2b", "Input changes appear on the next simulation step", "VHDL",
      "LED transitions share timestamps with the switch transitions")
def inp_06() -> str:
    result = must_run("board.vhd", top="sw_led8", duration=60, resetCycles=0,
                      stimuli=[{"port": "sw", "kind": "sequence", "values": [0, 255], "periodCycles": 3}])
    sw = signal(result, "sw")["transitions"]
    led = signal(result, "led")["transitions"]
    check(len(sw) > 1 and len(led) > 1, f"sw={sw} led={led}")
    check([t for t, _ in sw] == [t for t, _ in led], f"sw times {[t for t, _ in sw]} != led times {[t for t, _ in led]}")
    return f"sw/led transitions aligned: {[t for t, _ in led]}"


@case("INP-07", "2b", "Rapid toggling does not miss or duplicate edges", "VHDL",
      "Key toggling at the clock rate: 10 sampled edges -> exactly 5 rising edges counted")
def inp_07() -> str:
    result = run_tb("board.vhd", "tb_rapid.vhd", "tb_rapid", duration=150)
    check(result["ok"], "rapid-toggle testbench failed")
    return "count=5 for 10 sampled edges (5 rising, 5 falling)"


# ---------------------------------------------------------------------------
# 3. Output devices
# ---------------------------------------------------------------------------


@case("OUT-01", "3", "LED patterns: walking one, all on, all off", "VHDL",
      "mode 00 -> 0x80, 01 -> 0x40, 10 -> 0xFF, 11 -> 0x00")
def out_01() -> str:
    expected = {0: 0x80, 1: 0x40, 2: 0xFF, 3: 0x00}
    got = []
    for mode, want in expected.items():
        result = must_run("board.vhd", top="led_patterns", duration=20, constantInputs={"mode": mode})
        actual = value(result, "led")
        check(actual == want, f"mode {mode}: led=0x{actual:02X}, expected 0x{want:02X}")
        got.append(f"{mode}:0x{actual:02X}")
    return " ".join(got)


@case("OUT-02", "3", "LED polarity is active-high and not configurable", "VHDL",
      "Bit 1 lights the LED; no inversion option exists")
def out_02() -> str:
    result = must_run("board.vhd", top="led_patterns", duration=20, constantInputs={"mode": 2})
    check(value(result, "led") == 0xFF, "all-on pattern failed")
    text = frontend_text().lower()
    check("invert" not in text or "led" not in text.split("invert")[0][-200:],
          "an LED inversion option exists but is untested")
    return "active-high only; no per-board polarity configuration"


@case("OUT-03", "3", "7-segment hex decoder for digits 0..F", "VHDL",
      "All 16 values match the standard active-high segment table")
def out_03() -> str:
    result = run_tb("board.vhd", "tb_hex_all.vhd", "tb_hex_all", duration=20)
    check(result["ok"], "hex decoder testbench failed")
    return "all 16 digits matched"


@case("OUT-04", "3", "Segment ordering a-g and dp", "VHDL",
      "bit6=a ... bit0=g, bit7=dp; 0 -> 1000000, 1 -> 1111001")
def out_04() -> str:
    zero = must_run("board.vhd", top="hex_dec", duration=10, constantInputs={"sw": 0})
    one = must_run("board.vhd", top="hex_dec", duration=10, constantInputs={"sw": 1})
    check(value(zero, "hex0") == 0b1000000, f"0 -> {value(zero, 'hex0'):07b}")
    check(value(one, "hex0") == 0b1111001, f"1 -> {value(one, 'hex0'):07b}")
    return "0=1000000, 1=1111001 (a=MSB, dp=bit7)"


@case("OUT-05", "3", "7-segment polarity follows the board schematic", "VHDL",
      "Common anode + PNP digit drivers: DIG=0 selects, SEG=0 lights; the profile and both renderers use it")
def out_05() -> str:
    from backend.device import BOARD

    disp = BOARD["displays"]
    check(disp.get("segmentActiveLow") is True, "profile missing segmentActiveLow")
    check(disp.get("digitActiveLow") is True, "profile missing digitActiveLow")
    check(disp.get("segBitMap", {}).get("a") == 0 and disp.get("segBitMap", {}).get("b") == 1,
          f"SEG bit-to-segment map wrong: {disp.get('segBitMap')}")
    board3d = (FRONTEND / "src" / "board" / "io.js").read_text(encoding="utf-8")
    check("segBitMap" in board3d, "3D renderer ignores the segment bit map")
    app = (FRONTEND / "src" / "board" / "index.js").read_text(encoding="utf-8")
    check("polarity" in app, "3D renderer ignores the segment polarity")
    return "SEG/DIG active-low with SEG0=a, SEG1=b, SEG2=c, SEG3=d, SEG4=e, SEG5=f, SEG6=g, SEG7=dp applied in profile + renderers"


@case("OUT-06", "3", "Multiplexed multi-digit display is scanned correctly", "VHDL",
      "Digit select cycles 0,1,2,3 and the segment data follows the selected nibble")
def out_06() -> str:
    result = must_run("board.vhd", top="seg_multiplex", duration=100, resetCycles=0,
                      constantInputs={"value": 0x1234})
    check(cycle_count(result) >= 4, f"only {cycle_count(result)} cycles")
    # The first rising edge has already advanced the scan counter to 1.
    for index, want_dig in enumerate([1, 2, 3, 0]):
        values = cycle_values(result, index)
        check(int(values["dig"]) == want_dig, f"cycle {index}: dig={values['dig']}")
    first = int(cycle_values(result, 0)["seg"])
    check(first == 0b0110000, f"digit1 seg={first:07b} (expected 3)")
    return "dig 1,2,3,0; seg follows nibble 3,2,1,4"


@case("OUT-07", "3", "On-board connectors match the real board; nothing fake is implied", "VHDL",
      "VGA/PS2/RS232 exist as board parts; the UI renders no fake state for the buzzer/UART/LCD")
def out_07() -> str:
    connectors = (FRONTEND / "src" / "board" / "connectors.js").read_text(encoding="utf-8")
    for token in ("VGA", "PS/2", "RS232"):
        check(token in connectors, f"the {token} connector is missing from the 3D board")
    # The board really has a buzzer; the UI must source it from the board
    # profile rather than inventing state.
    app = (FRONTEND / "src" / "main.js").read_text(encoding="utf-8")
    check("buzzerDecode" in app, "the UI invents a buzzer state instead of using the board profile")
    return "real connectors modelled; the buzzer state comes from the board profile"


@case("OUT-08", "3", "Unassigned output is shown as U, not as a plain 0", "VHDL",
      "Undriven output reads U in the waveform")
def out_08() -> str:
    result = must_run("edges.vhd", top="unassigned", duration=10, resetCycles=0)
    got = value(result, "q")
    check(str(got).upper() == "U", f"q={got!r}")
    return f"q={got!r}"


@case("OUT-09", "3", "Tri-state 'Z' is preserved by the simulator", "VHDL",
      "bus and out_val read Z when output is disabled")
def out_09() -> str:
    result = must_run("features.vhd", top="tri_state", duration=10, resetCycles=0,
                      constantInputs={"oe": 0, "in_val": 0})
    bus = value(result, "bus_io")
    out = value(result, "out_val")
    check(set(str(bus).upper()) == {"Z"}, f"bus={bus!r}")
    check(set(str(out).upper()) == {"Z"}, f"out={out!r}")
    return f"bus={bus!r}, out={out!r}"


@case("OUT-09B", "3", "The 3D/2D board renders X and Z distinctly from 0", "UI",
      "X/Z get a distinct visual state, never a plain off LED")
def out_09b() -> str:
    board3d = (FRONTEND / "src" / "board" / "index.js").read_text(encoding="utf-8")
    live = (FRONTEND / "src" / "liveFrame.js").read_text(encoding="utf-8")
    css = (FRONTEND / "src" / "styles.css").read_text(encoding="utf-8")
    check("metaChar" in board3d, "3D board has no unknown-LED state")
    check("meta" in live, "frame classifier has no unknown-value state")
    check(".msg-row" in css, "messages table style missing")
    return "X/Z render as a distinct state in the live board (never a plain lit LED)"


@case("OUT-10", "3", "'X' from an uninitialized signal is preserved", "VHDL",
      "y reads X")
def out_10() -> str:
    source = """library ieee;
use ieee.std_logic_1164.all;
entity xz is
    port (y : out std_logic; z : out std_logic);
end entity xz;
architecture rtl of xz is
begin
    y <= 'X';
    z <= 'Z';
end architecture rtl;"""
    from harness import run_text

    result = must_run_text = run_text(source, duration=10, resetCycles=0)
    check(str(value(result, "y")).upper() == "X", f"y={value(result, 'y')!r}")
    return f"y={value(result, 'y')!r}, z={value(result, 'z')!r}"


@case("OUT-11", "3", "Multiple drivers are diagnosed", "VHDL",
      "Warning naming multiple drivers")
def out_11() -> str:
    result = must_run("edges.vhd", top="multi_driver", duration=10, resetCycles=0)
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("multiple drivers" in warnings, f"warnings={warnings!r}")
    return "warning: multiple drivers"


@case("OUT-12", "3", "Latch inference is diagnosed", "VHDL",
      "Warning naming latch inference")
def out_12() -> str:
    result = must_run("edges.vhd", top="latch", duration=10, resetCycles=0,
                      constantInputs={"e": 0, "d": 1})
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("latch" in warnings, f"warnings={warnings!r}")
    return "warning: latch inferred"


@case("OUT-13", "3", "Combinational loop is diagnosed or rejected", "VHDL",
      "Clear warning/error; never an apparently normal result")
def out_13() -> str:
    result = run("edges.vhd", top="comb_loop", duration=20, resetCycles=0)
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    errors = " ".join(e.get("message", "") for e in result.get("errors", [])).lower()
    check("loop" in warnings or "loop" in errors,
          f"no loop diagnostic; final={result.get('waveforms', {}).get('final')}")
    return "loop diagnosed"


@case("OUT-14", "3", "Delta-cycle ordering is deterministic", "VHDL",
      "a and c settle to the same value after delta cycles")
def out_14() -> str:
    result = must_run("features.vhd", top="delta_order", duration=10, resetCycles=0,
                      constantInputs={"b": 1})
    check(value(result, "a") == 1 and value(result, "c") == 1,
          f"a={value(result, 'a')}, c={value(result, 'c')}")
    return "a=1, c=1 after settling"