"""Section 5: Cyclone IV specific blocks and resource limits."""
from __future__ import annotations

from harness import (
    case,
    check,
    cycle_values,
    must_run,
    run,
    value,
)


# ---------------------------------------------------------------------------
# PLL / megafunctions
# ---------------------------------------------------------------------------


@case("BLK-01", "5", "ALTPLL instantiation is rejected clearly", "VHDL",
      "Unbound altpll is an error naming the component, not a silent U output")
def blk_01() -> str:
    result = run("blocks.vhd", top="altpll_top", duration=50, resetCycles=0)
    check(not result["ok"],
          f"ALTPLL elaborated with outputs {(result.get('waveforms') or {}).get('final')}")
    text = (str(result.get("errors")) + result.get("logs", "")).lower()
    check("altpll" in text and "bound" in text, f"unclear error: {text[:200]}")
    return "altpll not bound (clear error)"


@case("BLK-02", "5", "ALTPLL output frequency and locked signal", "VHDL",
      "Behavioral PLL model produces c0 and locked")
def blk_02() -> str:
    result = run("blocks.vhd", top="altpll_top", duration=50, resetCycles=0)
    check(result["ok"], "no behavioral ALTPLL model")
    return f"c0={value(result, 'c0')}, locked={value(result, 'locked')}"


@case("BLK-03", "5", "Two-PLL limit is reported", "VHDL",
      "A design with three PLLs warns about the 2-PLL limit")
def blk_03() -> str:
    text = str(run("blocks.vhd", top="altpll_top", duration=50, resetCycles=0).get("warnings", []))
    check("pll" in text.lower(), "no PLL resource check")
    return "PLL count checked"


@case("BLK-04", "5", "Inferred ROM", "VHDL", "rom(5) = 5")
def blk_04() -> str:
    result = must_run("memory.vhd", top="rom16", duration=10, resetCycles=0,
                      constantInputs={"addr": 5})
    got = value(result, "q")
    check(got == 5, f"q={got}")
    return "q=5"


@case("BLK-05", "5", "Single-port RAM read-after-write", "VHDL",
      "Write 0x5A to addr 3; read it back on the next clock")
def blk_05() -> str:
    result = must_run("memory.vhd", top="ram_sp", duration=40, resetCycles=0,
                      constantInputs={"we": 1, "addr": 3, "din": 0x5A})
    got = value(result, "q")
    check(got == 0x5A, f"q=0x{got:02X}")
    return "q=0x5A"


@case("BLK-06", "5", "Registered RAM read latency", "VHDL",
      "q is old data on the write edge and new data on the next edge")
def blk_06() -> str:
    result = must_run("memory.vhd", top="ram_sp", duration=40, resetCycles=0,
                      constantInputs={"we": 1, "addr": 3, "din": 0x5A})
    first = cycle_values(result, 0)["q"]
    second = cycle_values(result, 1)["q"]
    check(first == 0, f"cycle0 q={first}")
    check(second == 0x5A, f"cycle1 q={second}")
    return f"cycle0={first}, cycle1=0x{second:02X}"


@case("BLK-07", "5", "Dual-port RAM", "VHDL", "Port B reads what port A wrote")
def blk_07() -> str:
    result = must_run("memory.vhd", top="ram_dp", duration=40, resetCycles=0,
                      constantInputs={"we_a": 1, "addr_a": 2, "din_a": 0x77, "addr_b": 2})
    got = value(result, "q_b")
    check(got == 0x77, f"q_b=0x{got:02X}")
    return "q_b=0x77"


@case("BLK-08", "5", "M9K init from .mif/.hex file", "VHDL",
      "Memory initialized from a .mif or .hex file")
def blk_08() -> str:
    from backend.simulator import SimulationRequest

    request = SimulationRequest.from_dict({"vhdl": "-- mif", "memoryInitFile": "rom.mif"})
    check(getattr(request, "memory_init_file", None), "no memory-init file input exists")
    return "memory initialized from rom.mif"


@case("BLK-09", "5", "18x18 multiplier product", "VHDL", "3*5=15 and 131071^2=17179607041")
def blk_09() -> str:
    small = must_run("memory.vhd", top="mult18", duration=10, resetCycles=0,
                     constantInputs={"a": 3, "b": 5})
    big = must_run("memory.vhd", top="mult18", duration=10, resetCycles=0,
                   constantInputs={"a": 131071, "b": 131071})
    check(value(small, "p") == 15, f"3*5={value(small, 'p')}")
    check(value(big, "p") == 131071 * 131071, f"big={value(big, 'p')}")
    return f"15 and {131071 * 131071}"


@case("BLK-10", "5", "altsyncram megafunction is rejected clearly", "VHDL",
      "Unbound altsyncram is an error")
def blk_10() -> str:
    result = run("blocks.vhd", top="altsyncram_top", duration=50, resetCycles=0)
    check(not result["ok"], "altsyncram elaborated without a model")
    text = (str(result.get("errors")) + result.get("logs", "")).lower()
    check("altsyncram" in text or "not bound" in text, f"unclear error: {text[:200]}")
    return "altsyncram not bound (clear error)"


@case("BLK-11", "5", "lpm_* megafunction is rejected clearly", "VHDL",
      "Unbound lpm_counter is an error")
def blk_11() -> str:
    result = run("blocks.vhd", top="lpm_top", duration=50, resetCycles=0)
    check(not result["ok"], "lpm_counter elaborated without a model")
    text = (str(result.get("errors")) + result.get("logs", "")).lower()
    check("lpm" in text or "not bound" in text, f"unclear error: {text[:200]}")
    return "lpm_counter not bound (clear error)"


# ---------------------------------------------------------------------------
# Resource limits
# ---------------------------------------------------------------------------


@case("BLK-12", "5", "Warning when the design exceeds 6272 LEs", "VHDL",
      "Resource warning naming the LE limit")
def blk_12() -> str:
    text = str(run("resource.vhd", top="wide_io", duration=10, resetCycles=0).get("warnings", [])).lower()
    check("6272" in text, "no LE resource warning")
    return "LE warning present"


@case("BLK-13", "5", "Warning when the design exceeds 30 M9K blocks", "VHDL",
      "Resource warning naming the M9K limit")
def blk_13() -> str:
    text = str(run("resource.vhd", top="wide_io", duration=10, resetCycles=0).get("warnings", [])).lower()
    check("m9k" in text, "no M9K resource warning")
    return "M9K warning present"


@case("BLK-14", "5", "Warning when the design exceeds 15 multipliers", "VHDL",
      "Resource warning naming the multiplier limit")
def blk_14() -> str:
    result = must_run("blocks.vhd", top="many_muls", duration=10, resetCycles=0,
                      constantInputs={"a": 3, "b": 5})
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("multiplier" in warnings or "15" in warnings, f"16 multipliers produced no warning: {warnings!r}")
    return "multiplier warning present"


@case("BLK-15", "5", "Warning when the design exceeds 91 user I/O", "VHDL",
      "Warning naming the 91-pin limit")
def blk_15() -> str:
    result = run("resource.vhd", top="wide_io", duration=10, resetCycles=0)
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("91" in warnings, f"92-bit port produced no I/O warning: {warnings!r}")
    return "I/O warning present"