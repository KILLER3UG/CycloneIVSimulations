"""Section 11: .qsf parsing edge cases (TOP entity, pins, IO standards, files).

The simulator reads Quartus .qsf files for pin/top/IO-standard decisions; the
vendor examples are the primary fixtures.
"""
from __future__ import annotations

from pathlib import Path

from harness import case, check, compile_text, errors_text

ROOT = Path(__file__).resolve().parent.parent.parent
VENDOR_QSF = sorted((ROOT / "board" / "vendor" / "examples").glob("*/*.qsf"))

DESIGN = """
library ieee;
use ieee.std_logic_1164.all;
entity qsf_top is
    port (CLOCK_50 : in std_logic;
          LED      : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of qsf_top is
begin
    LED <= (others => '0');
end architecture;
"""


@case("QF-01", "11", "All four vendor .qsf files parse without errors", "QSF",
      "my_and, key_led, ckey_led, led_twinkle each yield pins and no errors")
def qf_01() -> str:
    from backend.qsf_parser import parse_qsf
    check(len(VENDOR_QSF) == 4, f"expected 4 vendor qsf files, found {len(VENDOR_QSF)}")
    for path in VENDOR_QSF:
        result = parse_qsf(path.read_text(encoding="utf-8"))
        check(result.ok, f"{path.parent.name}: {result.errors}")
        check(result.pins, f"{path.parent.name}: no pins parsed")
    return "4 vendor .qsf files parse cleanly"


@case("QF-02", "11", "TOP_LEVEL_ENTITY, DEVICE, IO_STANDARD and file lists are parsed", "QSF",
      "top=my_top, device=EP4CE6E22C8, IO_STANDARD 3.3-V LVTTL, vhdl+verilog files")
def qf_02() -> str:
    from backend.qsf_parser import parse_qsf
    text = """
-- comment
set_global_assignment -name TOP_LEVEL_ENTITY "my_top"
set_global_assignment -name DEVICE EP4CE6E22C8
set_global_assignment -name FAMILY "Cyclone IV E"
set_global_assignment -name VHDL_FILE src/a.vhd
set_global_assignment -name VERILOG_FILE src/b.v
set_instance_assignment -name IO_STANDARD "3.3-V LVTTL" -to LED[0]
set_location_assignment PIN_87 -to LED[0]
"""
    result = parse_qsf(text)
    check(result.ok, f"errors: {result.errors}")
    check(result.top == "my_top", f"top={result.top}")
    check(result.device == "EP4CE6E22C8", f"device={result.device}")
    check(result.io_standards.get("LED[0]") == "3.3-V LVTTL", f"io={result.io_standards}")
    check(("vhdl", "src/a.vhd") in result.files, f"files={result.files}")
    check(("verilog", "src/b.v") in result.files, f"files={result.files}")
    return "top/device/IO_STANDARD/file lists parsed"


@case("QF-03", "11", "Comments, whitespace, tabs and mixed case are tolerated", "QSF",
      "pins parsed from lines with extra whitespace and comments")
def qf_03() -> str:
    from backend.qsf_parser import parse_qsf
    text = """
# hash comment
   -- dash comment
   set_location_assignment   PIN_88   -to   KEY[0]
\tset_location_assignment pin_89 -to key[1]
"""
    result = parse_qsf(text)
    check(result.ok, f"errors: {result.errors}")
    check(result.pins.get("KEY") == ["PIN_88", "PIN_89"], f"pins={result.pins}")
    return "comments/whitespace/case handled"


@case("QF-04", "11", "A pin used by two different ports is an error", "QSF",
      "PIN_88 assigned to LED[0] and KEY[0] -> duplicate-pin error")
def qf_04() -> str:
    from backend.qsf_parser import parse_qsf
    result = parse_qsf("set_location_assignment PIN_88 -to LED[0]\n"
                       "set_location_assignment PIN_88 -to KEY[0]\n")
    check(not result.ok, "cross-port duplicate pin accepted")
    check(any("duplicate" in error["message"].lower() for error in result.errors),
          f"errors={result.errors}")
    return "cross-port duplicate pin rejected"


@case("QF-05", "11", "Invalid pin tokens are rejected (0, 145, 999, malformed)", "QSF",
      "PIN_0, PIN_145, PIN_999, PIN_AB all produce errors")
def qf_05() -> str:
    from backend.qsf_parser import parse_qsf
    for pin in ("PIN_0", "PIN_145", "PIN_999", "PIN_AB", "PIN_"):
        result = parse_qsf(f"set_location_assignment {pin} -to LED[0]\n")
        check(not result.ok, f"{pin} accepted")
        check(result.errors, f"{pin} produced no error")
    return "invalid pin tokens rejected"


@case("QF-06", "11", "The same port bit given two pins is an error", "QSF",
      "LED[0] = PIN_87 then PIN_86 -> duplicate error")
def qf_06() -> str:
    from backend.qsf_parser import parse_qsf
    result = parse_qsf("set_location_assignment PIN_87 -to LED[0]\n"
                       "set_location_assignment PIN_86 -to LED[0]\n")
    check(not result.ok, "duplicate slot accepted")
    check(any("duplicate" in error["message"].lower() for error in result.errors), f"{result.errors}")
    return "duplicate port slot rejected"


@case("QF-07", "11", "A device mismatch is reported", "QSF",
      "DEVICE EP4CE10F17C6 -> error naming the fitted chip")
def qf_07() -> str:
    from backend.qsf_parser import parse_qsf
    result = parse_qsf("set_global_assignment -name DEVICE EP4CE10F17C6\n")
    check(not result.ok, "wrong device accepted")
    check(any("device" in error["message"].lower() for error in result.errors), f"{result.errors}")
    return "wrong device rejected"


@case("QF-08", "11", "compile_source uses the .qsf top and reports unknown ports", "VHDL+QSF",
      "qsf top overrides the entity; assignment to a missing port is an error")
def qf_08() -> str:
    qsf = """
set_global_assignment -name TOP_LEVEL_ENTITY qsf_top
set_location_assignment PIN_23 -to CLOCK_50
set_location_assignment PIN_87 -to LED[0]
set_location_assignment PIN_99 -to NO_SUCH_PORT
"""
    result = compile_text(DESIGN, qsf=qsf)
    check(not result.get("ok"), f"compile should fail: {result.get('errors')}")
    text = " ".join(error["message"] for error in result.get("errors", []))
    check("NO_SUCH_PORT" in text, f"unknown port not reported: {text}")
    check(result.get("qsf", {}).get("top") == "qsf_top", f"qsf info {result.get('qsf')}")
    return "qsf top override + unknown-port error"
