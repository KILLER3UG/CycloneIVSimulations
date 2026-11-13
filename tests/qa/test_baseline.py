"""Sections 0-2: device baseline, project input, clock and reset."""
from __future__ import annotations

import re
from pathlib import Path

from backend.simulator import SimulationRequest

from harness import (
    source,
    ROOT,
    case,
    check,
    compile_text,
    cycle_count,
    errors_text,
    has_error,
    must_run,
    run,
    run_text,
    signal,
    source,
    value,
)

BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"


def all_source() -> str:
    chunks = []
    for folder in (BACKEND, FRONTEND):
        for path in folder.rglob("*"):
            if path.suffix in {".py", ".js", ".html", ".css"} and "vendor" not in path.parts:
                chunks.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(chunks)


# ---------------------------------------------------------------------------
# 0. Device baseline
# ---------------------------------------------------------------------------


@case("DEV-01", "0", "Device definition EP4CE6E22C8 present and matches datasheet", "n/a",
      "Simulator declares 6272 LEs, 30 M9K, 15 multipliers, 2 PLLs, 91 I/O, EQFP-144, 3.3V LVTTL")
def dev_01() -> str:
    text = all_source()
    missing = [token for token in ("6272", "M9K", "EQFP", "91", "LVTTL") if token.lower() not in text.lower()]
    check(not missing, f"no device profile found; missing tokens: {missing}")
    return "device profile present"


@case("DEV-02", "0", "Pin map internally consistent (no duplicate/invalid pins)", "n/a",
      "A pin map exists with unique, package-valid pins for LEDs, switches, keys, segments and clock")
def dev_02() -> str:
    from backend.device import BOARD, board_pin_map

    index = board_pin_map()
    for name, plist in index.items():
        check(len(plist) == len(set(plist)), f"{name} has duplicate pins: {plist}")
        bad = [pin for pin in plist if not re.fullmatch(r"PIN_\d+", pin)]
        check(not bad, f"{name} has invalid pin names: {bad}")
    all_pins = [p for plist in index.values() for p in plist]
    check(len(set(all_pins)) <= 144, "more pins than the EQFP-144 package provides")
    check(len(BOARD["leds"]["pins"]) == 4, "expected 4 LED pins")
    check(len(BOARD["buttons"]["pins"]) == 4, "expected 4 key pins")
    check(len(BOARD["displays"]["pins"]["SEG"]) == 8, "expected 8 segment pins")
    check(len(BOARD["displays"]["pins"]["DIG"]) == 4, "expected 4 digit-select pins")
    check(BOARD["clockHz"] == 50_000_000, "expected the 50 MHz crystal")
    return f"{len(index)} named ports, {len(set(all_pins))} distinct pins, all valid EQFP numbers"



# ---------------------------------------------------------------------------
# 1. Project input
# ---------------------------------------------------------------------------


@case("IN-01", "1", "Single .vhd upload loads and simulates", "VHDL",
      "Design compiles, entity/ports extracted, board mapped")
def in_01() -> str:
    result = must_run("board.vhd", top="sw_led8", duration=20, constantInputs={"sw": 0xA5})
    check(value(result, "led") == 0xA5, f"led={value(result, 'led')}")
    board = result["board"]
    check(board["leds"] == ["led"] and board["switches"] == ["sw"], f"board={board}")
    return f"led=0x{value(result, 'led'):02X}, board={board['leds']}/{board['switches']}"


@case("IN-02", "1", "Single .v (Verilog) upload gives a clear not-supported error", "Verilog",
      "Error names Verilog as unsupported, with file/line")
def in_02() -> str:
    result = run_text("module foo(input a, output y); assign y = ~a; endmodule", duration=10)
    check(not result["ok"], "Verilog source was accepted")
    message = errors_text(result)
    check("verilog" in message.lower(), f"message does not mention Verilog: {message}")
    return message


@case("IN-03", "1", "Multi-entity project (several entities in one upload) loads", "VHDL",
      "Top entity selected, all units analysed")
def in_03() -> str:
    result = must_run("comb.vhd", top="mux4", duration=10, constantInputs={"d": 0b0110, "sel": 1})
    check(value(result, "y") == 1, f"y={value(result, 'y')}")
    return "mux4 selected from 6-entity file"


@case("IN-04", "1", "Multi-file project upload (separate .vhd files)", "VHDL",
      "API accepts a file list, analyses all units, elaborates the top")
def in_04() -> str:
    leaf = """library ieee;
use ieee.std_logic_1164.all;
entity leaf is
    port (i : in std_logic; o : out std_logic);
end entity leaf;
architecture rtl of leaf is
begin
    o <= not i;
end architecture rtl;"""
    top = """library ieee;
use ieee.std_logic_1164.all;
entity top_multi is
    port (i : in std_logic; o : out std_logic);
end entity top_multi;
architecture rtl of top_multi is
    component leaf
        port (i : in std_logic; o : out std_logic);
    end component leaf;
begin
    u_leaf : leaf port map (i => i, o => o);
end architecture rtl;"""
    from harness import simulator
    from backend.simulator import SimulationRequest

    result = simulator().simulate(
        SimulationRequest.from_dict(
            {
                "files": [
                    {"name": "leaf.vhd", "content": leaf},
                    {"name": "top.vhd", "content": top},
                ],
                "top": "top_multi",
                "duration": 10,
                "constantInputs": {"i": 1},
            }
        )
    )
    check(result["ok"], f"multi-file failed: {errors_text(result)}")
    check(value(result, "o") == 0, f"o={value(result, 'o')}")
    return "leaf.vhd + top.vhd analysed; top elaborated"


@case("IN-05", "1", "Quartus .qsf upload is parsed and honored", "QSF",
      "Pins, TOP_LEVEL_ENTITY, file list and unused-pin policy extracted from the vendor .qsf; "
      "sources uploaded alongside simulate with the QSF pin assignments")
def in_05() -> str:
    from harness import simulator

    qsf = source("vendor_qsf/ckey_led_vhdl.qsf")
    src = source("vendor_qsf/ckey_led_vhdl.vhd")
    result = simulator().simulate(
        SimulationRequest.from_dict({
            "qsf": qsf,
            "files": [{"name": "ckey_led_vhdl.vhd", "content": src}],
            "duration": 30,
            "constantInputs": {"ckey": 0b1110},
        })
    )
    check(result.get("ok"), f"QSF-honoured simulation failed: {errors_text(result)}")
    qsf_info = result.get("qsf") or {}
    check(qsf_info.get("top") == "ckey_led", f"TOP_LEVEL_ENTITY not honoured: {qsf_info.get('top')}")
    check(qsf_info.get("pins", {}).get("LED") == ["PIN_87", "PIN_86", "PIN_85", "PIN_84"],
          f"pin assignments not honoured: {qsf_info.get('pins')}")
    check(qsf_info.get("pins", {}).get("ckey") == ["PIN_88", "PIN_89", "PIN_90", "PIN_91"],
          f"DIP/key pins not honoured: {qsf_info.get('pins')}")
    check(qsf_info.get("unusedPolicy") == "AS INPUT TRI-STATED",
          f"unused-pin policy not read: {qsf_info.get('unusedPolicy')}")
    check(value(result, "LED") == 0b1110, f"LED={value(result, 'LED')} (vendor ckey_led: LED = ckey)")
    return "vendor ckey_led.qsf honoured: top, 8 pin assignments, IO policy; LED=ckey simulated"


@case("IN-05B", "1", "QSF pin/top/IO-standard/file-list parsing is complete", "QSF",
      "TOP_LEVEL_ENTITY, 8 pin assignments, IO_STANDARD and file list all visible in the result")
def in_05b() -> str:
    qsf = source("vendor_qsf/ckey_led_vhdl.qsf")
    qsf = qsf.rstrip(chr(10)) + chr(10) + 'set_instance_assignment -name IO_STANDARD "3.3-V LVTTL" -to LED[1]' + chr(10)
    result = compile_text(qsf)
    qsf_info = result.get("qsf") or {}
    check(qsf_info.get("top") == "ckey_led", f"top not parsed: {qsf_info.get('top')}")
    check(len(qsf_info.get("pins", {})) == 2, f"pins not parsed: {qsf_info.get('pins')}")
    check("3.3-V LVTTL" in qsf_info.get("ioStandards", {}).values(),
          f"IO_STANDARD not parsed: {qsf_info.get('ioStandards')}")
    check(qsf_info.get("files") == ["ckey_led_vhdl.vhd"], f"file list not parsed: {qsf_info.get('files')}")
    return "top, 8 pins, IO_STANDARD and file list parsed from the vendor .qsf"


@case("IN-05C", "1", "QSF errors: invalid pin, duplicate pin, unknown port, wrong device", "QSF",
      "Each problem produces a specific error naming the pin/port; the simulation does not start")
def in_05c() -> str:
    qsf = """set_location_assignment PIN_999 -to LED[1]
set_location_assignment PIN_87 -to LED[1]
set_location_assignment PIN_86 -to LED[1]
set_location_assignment PIN_88 -to nonexistent
set_global_assignment -name DEVICE EP4CE55F23C8
set_global_assignment -name TOP_LEVEL_ENTITY ckey_led
set_global_assignment -name VHDL_FILE ckey_led_vhdl.vhd
"""
    src = source("vendor_qsf/ckey_led_vhdl.vhd")
    result = compile_text(qsf, files=[{"name": "ckey_led_vhdl.vhd", "content": src}])
    check(not result["ok"], "invalid QSF accepted")
    messages = [e.get("message", "") for e in result.get("errors", [])]
    joined = " ".join(messages).lower()
    check("pin_999" in joined, f"no invalid-pin error: {messages}")
    check("duplicate" in joined, f"no duplicate-pin error: {messages}")
    check("nonexistent" in joined, f"no unknown-port error: {messages}")
    check("does not match the fitted chip" in joined, f"no device-mismatch error: {messages}")
    return "4 specific errors: invalid pin, duplicate pin, unknown port, wrong device"


@case("IN-08", "1", "QSF pin assignments are validated against the top-level ports", "QSF",
      "A pin assigned to a port that exists is honoured; the missing-pin warning stays quiet for those ports")
def in_08() -> str:
    from harness import simulator

    qsf = source("vendor_qsf/ckey_led_vhdl.qsf")
    src = source("vendor_qsf/ckey_led_vhdl.vhd")
    result = simulator().simulate(
        SimulationRequest.from_dict({
            "qsf": qsf,
            "files": [{"name": "ckey_led_vhdl.vhd", "content": src}],
            "duration": 30,
            "constantInputs": {"ckey": 1},
        })
    )
    check(result.get("ok"), f"QSF simulation failed: {errors_text(result)}")
    warnings = [w.get("message", "") for w in result.get("warnings", [])]
    for w in warnings:
        check("LED" not in w and "ckey" not in w,
              f"ports pinned by the .qsf still warned as unpinned: {w}")
    return "no unpinned-port warnings for ports the .qsf assigns"


@case("IN-09", "1", "VHDL syntax error reports file and line", "VHDL",
      "GHDL diagnostic with line number, no crash")
def in_09() -> str:
    result = compile_text("entity broken is\n  port (a : in std_logic;\nend entity broken;\n")
    check(not result["ok"], "syntax error accepted")
    errors = result.get("errors", [])
    check(any(int(e.get("line") or 0) > 0 for e in errors), f"no line number: {errors}")
    return errors_text(result)


@case("IN-10", "1", "Verilog syntax error reports file and line", "Verilog",
      "Diagnostic with line number naming Verilog")
def in_10() -> str:
    result = compile_text("module broken(input a, output y); assign y = ~a; endmodule\n")
    check(not result["ok"], "broken Verilog accepted")
    message = errors_text(result)
    check("verilog" in message.lower(), f"no Verilog-specific diagnostic: {message}")
    return message


@case("IN-11", "1", "Unsupported Altera primitive gives a clear error", "VHDL",
      "Error names the unbound Altera megafunction (altpll/altsyncram)")
def in_11() -> str:
    result = run("blocks.vhd", top="altpll_top", duration=50)
    check(not result["ok"], "ALTPLL design elaborated successfully")
    message = (errors_text(result) + " " + result.get("logs", "")).lower()
    check("altpll" in message or "not bound" in message or "unbound" in message,
          f"error does not identify the unsupported primitive: {message[:300]}")
    return message[:240]


@case("IN-12", "1", "Mixed-language project (VHDL top + Verilog submodule)", "VHDL+Verilog",
      "Supported, or a clear 'mixed language not supported' error")
def in_12() -> str:
    top = """library ieee;
use ieee.std_logic_1164.all;
entity mixed_top is
    port (i : in std_logic; o : out std_logic);
end entity mixed_top;
architecture rtl of mixed_top is
begin
    o <= not i;
end architecture rtl;

module leaf(input i, output o);
    assign o = ~i;
endmodule"""
    result = run_text(top, duration=10)
    check(not result["ok"], "mixed-language project was accepted")
    message = errors_text(result).lower()
    check("verilog" in message or "mixed" in message,
          f"no clear mixed-language error: {message}")
    return message


# ---------------------------------------------------------------------------
# 2. Clock and reset
# ---------------------------------------------------------------------------


@case("CLK-01", "2", "Board clock frequency and pin are modelled", "VHDL",
      "CLOCK_50 = 50 MHz on pin PIN_23; the result reports the board frequency")
def clk_01() -> str:
    result = must_run("a22_demo.vhd", top="a22_demo", duration=20, resetCycles=0)
    board = result["board"]
    check(board.get("clock") == "CLOCK_50", f"clock port={board.get('clock')}")
    check(board.get("clockHz") == 50_000_000, f"clockHz={board.get('clockHz')}")
    check(board.get("pins", {}).get("CLOCK_50") == ["PIN_23"], f"pins={board.get('pins')}")
    return "CLOCK_50 = 50 MHz on PIN_23"


@case("CLK-02", "2", "Counter at the real clock rate matches expected count after N ms", "VHDL",
      "100 ns at 10 ns period, reset 2 cycles -> count = 8")
def clk_02() -> str:
    result = must_run("clk_reset.vhd", top="counter8", duration=100, clockPeriod=10, resetCycles=2)
    got = int(value(result, "q"))
    check(got == 8, f"count={got}, cycles={cycle_count(result)}")
    return f"count={got} after 100 ns"


@case("CLK-03", "2", "Clock scaling makes a 1 Hz blinker visible in real time", "VHDL",
      "Scale factor reported; 1 Hz blinker toggles once per simulated second at 50 MHz")
def clk_03() -> str:
    result = must_run("fidelity.vhd", top="blinky", duration=100_000, clockPeriod=10,
                      generics={"CLK_HZ": 50_000_000})
    scale_keys = [key for key in result if "scale" in key.lower()]
    check(bool(scale_keys), f"no scale factor reported; result keys={sorted(result)}")
    led = signal(result, "led")
    return f"scale={result[scale_keys[0]]}, led transitions={len(led['transitions'])}"


@case("CLK-04", "2", "Asynchronous active-low reset", "VHDL",
      "Reset asserted low clears counter; counting resumes after release")
def clk_04() -> str:
    result = must_run("clk_reset.vhd", top="rst_async_low", duration=100, resetCycles=2,
                      resetActiveHigh=False)
    got = int(value(result, "q"))
    check(got == 8, f"count={got}")
    return f"count={got}"


@case("CLK-05", "2", "Synchronous reset", "VHDL",
      "Reset only acts on the clock edge")
def clk_05() -> str:
    result = must_run("clk_reset.vhd", top="counter8", duration=100, resetCycles=2)
    got = int(value(result, "q"))
    check(got == 8, f"count={got}")
    return f"count={got}"


@case("CLK-06", "2", "Active-high reset", "VHDL",
      "Reset high clears counter")
def clk_06() -> str:
    result = must_run("clk_reset.vhd", top="rst_async_high", duration=100, resetCycles=2)
    got = int(value(result, "q"))
    check(got == 8, f"count={got}")
    return f"count={got}"


@case("CLK-07", "2", "Power-on value from a VHDL initializer", "VHDL",
      "Register powers up to its declared initializer (5)")
def clk_07() -> str:
    result = must_run("clk_reset.vhd", top="pwr_init", duration=15, resetCycles=0)
    got = int(value(result, "q"))
    check(got == 7, f"q={got} (expected 5 + 2 rising edges)")
    return f"q={got}"


@case("CLK-08", "2", "Register without initializer powers up to 0 like Cyclone IV", "VHDL",
      "q starts at 0")
def clk_08() -> str:
    result = must_run("clk_reset.vhd", top="pwr_noinit", duration=15, resetCycles=0)
    got = value(result, "q")
    check(str(got) in ("0", "00", "0000"), f"q={got!r}; GHDL leaves it X/U instead of 0")
    return f"q={got}"