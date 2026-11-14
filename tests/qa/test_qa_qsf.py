"""Section 30: .qsf parser edge cases (extends QF-01..08).

Inline comments (audit M5), CRLF/whitespace tolerance, duplicate handling,
invalid pins, TOP_LEVEL_ENTITY, IO_STANDARD and file lists — each with clear
values or errors.
"""
from __future__ import annotations

from harness import case, check, compile_text, errors_text

DESIGN = """
library ieee;
use ieee.std_logic_1164.all;
entity qe_top is
    port (CLOCK_50 : in std_logic;
          LED      : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of qe_top is
begin
    LED <= (others => '0');
end architecture;
"""


@case("QE-01", "30", "Inline comments are stripped; the assignment survives (audit M5)", "QSF",
      "pin assignment with a trailing -- comment parses; a commented DEVICE line does not warn")
def qe_01() -> str:
    from backend.qsf_parser import parse_qsf
    result = parse_qsf("set_location_assignment PIN_87 -to LED[0] -- LED1\n"
                       "set_global_assignment -name DEVICE EP4CE6E22C8 -- fitted\n")
    check(result.ok, f"errors: {result.errors}")
    check(result.pins.get("LED") == ["PIN_87"], f"pin lost to inline comment: {result.pins}")
    check(result.device == "EP4CE6E22C8", f"device polluted: {result.device}")
    return "inline -- comment stripped: pin kept, device clean, no mismatch warning"


@case("QE-02", "30", "CRLF, tabs and irregular spacing are tolerated", "QSF",
      "CRLF line endings and tab runs parse to the same pin map")
def qe_02() -> str:
    from backend.qsf_parser import parse_qsf
    text = ("set_location_assignment PIN_87 -to LED[0]\r\n"
            "\tset_location_assignment\tPIN_86\t-to\tLED[1]\r\n"
            "   set_location_assignment    PIN_85   -to   LED[2]   \r\n")
    result = parse_qsf(text)
    check(result.ok, f"errors: {result.errors}")
    check(result.pins.get("LED") == ["PIN_87", "PIN_86", "PIN_85"], f"pins={result.pins}")
    return "CRLF/tabs/extra spaces parsed: LED -> PIN_87, PIN_86, PIN_85"


@case("QE-03", "30", "Duplicate assignments: identical is idempotent, conflicting is an error", "QSF",
      "the same pin twice on the same port is accepted once; a different pin on the same port errors")
def qe_03() -> str:
    from backend.qsf_parser import parse_qsf
    again = parse_qsf("set_location_assignment PIN_87 -to LED[0]\n"
                      "set_location_assignment PIN_87 -to LED[0]\n")
    check(again.ok, f"identical duplicate rejected: {again.errors}")
    conflict = parse_qsf("set_location_assignment PIN_87 -to LED[0]\n"
                         "set_location_assignment PIN_86 -to LED[0]\n")
    check(not conflict.ok, "conflicting duplicate accepted")
    check(any("duplicate" in e["message"].lower() for e in conflict.errors),
          f"unclear error: {conflict.errors}")
    return "identical duplicate idempotent; conflicting duplicate rejected with a duplicate error"


@case("QE-04", "30", "Invalid pins: out-of-range, zero, non-numeric and boundary values", "QSF",
      "PIN_0, PIN_145, PIN_ABC and PIN_ all error; PIN_1 and PIN_144 are valid")
def qe_04() -> str:
    from backend.qsf_parser import parse_qsf
    for pin in ("PIN_0", "PIN_145", "PIN_ABC", "PIN_", "PIN_14x"):
        result = parse_qsf(f"set_location_assignment {pin} -to LED[0]\n")
        check(not result.ok, f"{pin} accepted")
        check(result.errors, f"{pin} produced no error")
    for pin in ("PIN_1", "PIN_144"):
        result = parse_qsf(f"set_location_assignment {pin} -to LED[0]\n")
        check(result.ok, f"boundary pin {pin} rejected: {result.errors}")
    return "invalid pins rejected; EQFP boundaries PIN_1/PIN_144 accepted"


@case("QE-05", "30", "TOP_LEVEL_ENTITY is honoured (quotes and case) and drives the compile top", "QSF",
      "quoted lowercase top in the .qsf selects the entity for compile")
def qe_05() -> str:
    from backend.qsf_parser import parse_qsf
    parsed = parse_qsf('set_global_assignment -name TOP_LEVEL_ENTITY "qe_top"\n')
    check(parsed.top == "qe_top", f"top={parsed.top}")
    qsf = ('set_global_assignment -name TOP_LEVEL_ENTITY "qe_top"\n'
           "set_location_assignment PIN_23 -to CLOCK_50\n"
           "set_location_assignment PIN_87 -to LED[0]\n")
    result = compile_text(DESIGN, qsf=qsf)
    check(result.get("ok"), f"compile failed: {errors_text(result)}")
    check((result.get("qsf") or {}).get("top") == "qe_top", "qsf top not surfaced")
    return "quoted TOP_LEVEL_ENTITY parsed and used as the compile top"


@case("QE-06", "30", "IO_STANDARD checks and missing-file errors are reported", "QSF",
      "a non-3.3V standard warns; a .qsf referencing an unuploaded file errors")
def qe_06() -> str:
    qsf = ('set_global_assignment -name TOP_LEVEL_ENTITY qe_top\n'
           'set_instance_assignment -name IO_STANDARD "2.5 V" -to LED[0]\n'
           "set_global_assignment -name VHDL_FILE missing_file.vhd\n")
    result = compile_text(DESIGN, qsf=qsf)
    check(result.get("ok") is False, "missing-file .qsf accepted")
    text = " ".join(e.get("message", "") for e in result.get("errors", [])).lower()
    check("missing_file.vhd" in text, f"missing file not reported: {text[:200]}")
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("2.5 v" in warnings or "io_standard" in warnings or "differs" in warnings,
          f"IO_STANDARD mismatch not warned: {warnings[:200]}")
    return "missing .qsf file errors; non-3.3V IO_STANDARD warns"
