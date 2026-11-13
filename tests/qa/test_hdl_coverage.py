"""Section 4: HDL language coverage and synthesizable-subset edge cases."""
from __future__ import annotations

from harness import (
    case,
    check,
    cycle_values,
    must_run,
    run,
    run_tb,
    value,
)


def check_value(result, port: str, expected, label: str = "") -> str:
    got = value(result, port)
    check(got == expected, f"{label}{port}={got!r}, expected {expected!r}")
    return f"{port}={got!r}"


# ---------------------------------------------------------------------------
# Combinational
# ---------------------------------------------------------------------------


@case("HDL-01", "4", "Combinational gates", "VHDL", "AND/OR/XOR/NAND truth table")
def hdl_01() -> str:
    result = must_run("comb.vhd", top="gates", duration=20, constantInputs={"a": 1, "b": 0})
    return " ".join(
        check_value(result, name, expected)
        for name, expected in (("y_and", 0), ("y_or", 1), ("y_xor", 1), ("y_nand", 1))
    )


@case("HDL-02", "4", "4:1 multiplexer", "VHDL", "sel=1 selects d(1)=1")
def hdl_02() -> str:
    result = must_run("comb.vhd", top="mux4", duration=10, constantInputs={"d": 0b0110, "sel": 1})
    return check_value(result, "y", 1)


@case("HDL-03", "4", "4-bit adder with carry", "VHDL", "9 + 8 = 17 -> sum=1, cout=1")
def hdl_03() -> str:
    result = must_run("comb.vhd", top="adder4", duration=10, constantInputs={"a": 9, "b": 8})
    return f"{check_value(result, 'sum', 1)} {check_value(result, 'cout', 1)}"


@case("HDL-04", "4", "Comparator", "VHDL", "9 > 8 -> gt=1, lt=0, eq=0")
def hdl_04() -> str:
    result = must_run("comb.vhd", top="cmp4", duration=10, constantInputs={"a": 9, "b": 8})
    return " ".join(
        check_value(result, name, expected)
        for name, expected in (("gt", 1), ("lt", 0), ("eq", 0))
    )


@case("HDL-05", "4", "2-to-4 decoder", "VHDL", "sel=2 -> 0100")
def hdl_05() -> str:
    result = must_run("comb.vhd", top="decoder2to4", duration=10, constantInputs={"sel": 2})
    return check_value(result, "y", 0b0100)


@case("HDL-06", "4", "Priority encoder", "VHDL", "req=0100 -> grant=2, valid=1; req=0 -> valid=0")
def hdl_06() -> str:
    one = must_run("comb.vhd", top="prio_encoder", duration=10, constantInputs={"req": 0b0100})
    zero = must_run("comb.vhd", top="prio_encoder", duration=10, constantInputs={"req": 0})
    return (f"{check_value(one, 'grant', 2)} {check_value(one, 'valid', 1)} "
            f"{check_value(zero, 'grant', 0)} {check_value(zero, 'valid', 0)}")


# ---------------------------------------------------------------------------
# Sequential
# ---------------------------------------------------------------------------


@case("HDL-07", "4", "D flip-flop with async reset", "VHDL", "d=1 -> q=1; d=0 -> q=0")
def hdl_07() -> str:
    one = must_run("seq.vhd", top="dff", duration=50, resetCycles=2, constantInputs={"d": 1})
    zero = must_run("seq.vhd", top="dff", duration=50, resetCycles=2, constantInputs={"d": 0})
    return f"{check_value(one, 'q', 1)} {check_value(zero, 'q', 0)}"


@case("HDL-08", "4", "Up counter", "VHDL", "3 counts after reset release")
def hdl_08() -> str:
    result = must_run("seq.vhd", top="counter_updown", duration=50, resetCycles=2,
                      constantInputs={"up_down": 1, "load": 0, "load_val": 0})
    return check_value(result, "count", 3)


@case("HDL-09", "4", "Down counter", "VHDL", "load 5 then 4 decrements -> 1")
def hdl_09() -> str:
    result = run_tb("seq.vhd", "tb_counter.vhd", "tb_counter", duration=80)
    check(result["ok"], "down-counter testbench failed")
    return "count=1 after load 5 and four decrements"


@case("HDL-10", "4", "Counter with parallel load", "VHDL", "load 42 is held")
def hdl_10() -> str:
    result = must_run("seq.vhd", top="counter_updown", duration=50, resetCycles=2,
                      constantInputs={"load": 1, "load_val": 42})
    return check_value(result, "count", 42)


@case("HDL-11", "4", "Universal shift register", "VHDL", "load 0xA5; shift in 1s -> 0xFF")
def hdl_11() -> str:
    load = must_run("seq.vhd", top="shift_universal", duration=50, resetCycles=2,
                    constantInputs={"mode": 3, "parallel_in": 0xA5, "serial_in": 0})
    shift = must_run("seq.vhd", top="shift_universal", duration=100, resetCycles=2,
                     constantInputs={"mode": 1, "serial_in": 1})
    return f"{check_value(load, 'q', 0xA5)} {check_value(shift, 'q', 0xFF)}"


@case("HDL-12", "4", "8-bit LFSR", "VHDL", "Known sequence; after 8 shifts from seed 1 -> 28")
def hdl_12() -> str:
    result = must_run("seq.vhd", top="lfsr8", duration=100, resetCycles=2)
    return check_value(result, "q", 28)


# ---------------------------------------------------------------------------
# FSMs
# ---------------------------------------------------------------------------


@case("HDL-13", "4", "Moore traffic-light FSM", "VHDL", "red -> red+yellow -> green -> yellow")
def hdl_13() -> str:
    result = must_run("fsm.vhd", top="traffic_moore", duration=100, resetCycles=2)
    # After reset, sample the state sequence from the cycle table.
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


@case("HDL-14", "4", "Mealy sequence detector (1011, overlap)", "VHDL", "detected=1 on the final 1")
def hdl_14() -> str:
    result = run_tb("fsm.vhd", "tb_seq.vhd", "tb_seq", duration=70)
    check(result["ok"], "sequence-detect testbench failed")
    return "detected=1 for 1011"


@case("HDL-15", "4", "Enumerated-state FSM", "VHDL", "start -> busy -> done")
def hdl_15() -> str:
    result = must_run("fsm.vhd", top="enum_fsm", duration=100, resetCycles=2,
                      constantInputs={"start": 1})
    done_cycles = [c["cycle"] for c in result["waveforms"]["cycles"] if int(c["values"]["done"]) == 1]
    check(bool(done_cycles), f"done never asserted; final={result['waveforms']['final']}")
    return f"done asserted at cycles {done_cycles[:4]}"


# ---------------------------------------------------------------------------
# Language features
# ---------------------------------------------------------------------------


@case("HDL-16", "4", "Generic parameter", "VHDL", "WIDTH=4 changes the counter width")
def hdl_16() -> str:
    default = must_run("features.vhd", top="generic_counter", duration=50, resetCycles=2)
    narrow = must_run("features.vhd", top="generic_counter", duration=50, resetCycles=2,
                      generics={"WIDTH": 4})
    check(value(default, "q") == 3, f"default q={value(default, 'q')}")
    check(value(narrow, "q") == 3, f"WIDTH=4 q={value(narrow, 'q')}")
    width = next(s["width"] for s in narrow["waveforms"]["signals"] if s["name"] == "q")
    check(width == 4, f"WIDTH=4 did not change port width: {width}")
    return f"WIDTH=4 -> q width {width}"


@case("HDL-17", "4", "Generate loop", "VHDL", "Parity bit replicated for each bit")
def hdl_17() -> str:
    result = must_run("features.vhd", top="gen_parity", duration=10, constantInputs={"data": 0b1011})
    return check_value(result, "parity", 0b1111)


@case("HDL-18", "4", "Function", "VHDL", "add2(7,5) = 12")
def hdl_18() -> str:
    result = must_run("features.vhd", top="func_user", duration=10, constantInputs={"a": 7, "b": 5})
    return check_value(result, "y", 12)


@case("HDL-19", "4", "Procedure", "VHDL", "double_it(21) = 42")
def hdl_19() -> str:
    result = must_run("features.vhd", top="procedure_user", duration=50, resetCycles=2,
                      constantInputs={"a": 21})
    return check_value(result, "y", 42)


@case("HDL-20", "4", "Record type", "VHDL", "Registered record field follows input")
def hdl_20() -> str:
    result = must_run("features.vhd", top="record_user", duration=50, resetCycles=2,
                      constantInputs={"a": -3})
    return check_value(result, "y", 13)


@case("HDL-21", "4", "Signed arithmetic", "VHDL", "-3 + 2 = -1 (15), -3 - 2 = -5 (11)")
def hdl_21() -> str:
    result = must_run("features.vhd", top="signed_math", duration=10,
                      constantInputs={"a": -3, "b": 2})
    return f"{check_value(result, 'sum', 15)} {check_value(result, 'diff', 11)}"


@case("HDL-22", "4", "Signed overflow wrap", "VHDL", "7 + 7 wraps to -2 (14) with ovf=1")
def hdl_22() -> str:
    result = must_run("features.vhd", top="signed_math", duration=10,
                      constantInputs={"a": 7, "b": 7})
    return f"{check_value(result, 'sum', 14)} {check_value(result, 'ovf', 1)}"


@case("HDL-23", "4", "Tri-state bus and inout port", "VHDL", "oe=1 drives 0xA; oe=0 releases Z")
def hdl_23() -> str:
    drive = must_run("features.vhd", top="tri_state", duration=10, resetCycles=0,
                     constantInputs={"oe": 1, "in_val": 0xA})
    release = must_run("features.vhd", top="tri_state", duration=10, resetCycles=0,
                       constantInputs={"oe": 0, "in_val": 0})
    check(value(drive, "bus_io") == 0xA, f"drive bus={value(drive, 'bus_io')!r}")
    check(set(str(value(release, "bus_io")).upper()) == {"Z"}, f"release bus={value(release, 'bus_io')!r}")
    return f"drive=0xA, release={value(release, 'bus_io')!r}"


@case("HDL-24", "4", "Multiple clock domains", "VHDL", "10 ns and 30 ns domains count independently")
def hdl_24() -> str:
    result = run_tb("features.vhd", "tb_two_clocks.vhd", "tb_two_clocks", duration=150)
    check(result["ok"], "two-clock testbench failed")
    return "qa=9 on 10 ns, qb=6 on 30 ns"


@case("HDL-25", "4", "Clock-divider output used as a clock", "VHDL", "div toggling at clk/2 clocks a counter")
def hdl_25() -> str:
    result = must_run("features.vhd", top="clk_divider", duration=100, resetCycles=2)
    return check_value(result, "q", 4)


@case("HDL-30", "4", "Delta-cycle ordering", "VHDL", "a and c settle to 1")
def hdl_30() -> str:
    result = must_run("features.vhd", top="delta_order", duration=10, resetCycles=0,
                      constantInputs={"b": 1})
    return f"{check_value(result, 'a', 1)} {check_value(result, 'c', 1)}"


# ---------------------------------------------------------------------------
# Testbench-only / non-synthesizable constructs
# ---------------------------------------------------------------------------


@case("HDL-31", "4", "'after' in a user design is rejected or warned", "VHDL",
      "Clear not-synthesizable warning")
def hdl_31() -> str:
    result = must_run("edges.vhd", top="after_arch", duration=20, resetCycles=0)
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("synthes" in warnings or "after" in warnings,
          f"'after 5 ns' accepted silently; final={result['waveforms']['final']}")
    return "not-synthesizable warning present"


@case("HDL-32", "4", "Assertion failure in user design is reported with file/line", "VHDL",
      "Error with the assertion message and a line number")
def hdl_32() -> str:
    result = run("edges.vhd", top="assert_report", duration=30, resetCycles=0)
    check(not result["ok"], "assertion failure did not stop the simulation")
    errors = result.get("errors", [])
    check(any("assertion" in e.get("message", "").lower() for e in errors), f"errors={errors}")
    check(any(int(e.get("line") or 0) > 0 for e in errors), f"no line number: {errors}")
    return "assertion: QA assertion failure (line reported)"


@case("HDL-33", "4", "report note from user design is visible", "VHDL",
      "The note text appears in the simulation log")
def hdl_33() -> str:
    result = must_run("edges.vhd", top="report_note", duration=30, resetCycles=0)
    check("qa note from user design" in result.get("logs", "").lower(),
          f"note not in logs: {result.get('logs', '')[-200:]}")
    return "note present in logs"


@case("HDL-34", "4", "'wait for' in a user design is rejected or warned", "VHDL",
      "Clear not-synthesizable warning")
def hdl_34() -> str:
    result = must_run("edges.vhd", top="wait_arch", duration=30, resetCycles=0)
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("synthes" in warnings or "wait" in warnings,
          f"'wait for 10 ns' accepted silently; final={result['waveforms']['final']}")
    return "not-synthesizable warning present"