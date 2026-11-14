"""Section 12: open-drain / wired-AND bus behaviour at the electrical level.

The A2.2 I2C and PS/2 buses are open-drain with pull-ups: any driver low wins,
a released line returns high through the pull-up, and a floating line reads H.
"""
from __future__ import annotations

from harness import case, check, errors_text, run_tb, simulator, value


def _run_inline(testbench: str, top: str = "tb_od", duration: float = 200) -> dict:
    from backend.simulator import SimulationRequest
    design = ("library ieee; use ieee.std_logic_1164.all; "
              "entity od_dummy is end entity; "
              "architecture sim of od_dummy is begin end architecture;")
    return simulator().simulate(SimulationRequest.from_dict({
        "vhdl": design, "testbench": testbench, "top": top,
        "duration": duration, "resetCycles": 0,
    }))


OD_TB = """
library ieee;
use ieee.std_logic_1164.all;
entity tb_od is
end entity;
architecture sim of tb_od is
    signal bus_low  : std_logic := 'Z';
    signal bus_high : std_logic := 'Z';
    signal scl      : std_logic := 'Z';
    signal sda      : std_logic := 'Z';
    signal pushpull : std_logic := 'Z';
    signal stretch  : std_logic := '0';
    signal contend  : std_logic := '0';
    signal result   : std_logic_vector(5 downto 0) := (others => '0');
begin
    -- wired-AND: one low driver wins over two released (pulled-up) drivers
    bus_low  <= '0';
    bus_low  <= 'H';
    bus_low  <= 'H';
    -- all drivers released: the pull-ups hold the line high
    bus_high <= 'H';
    bus_high <= 'H';
    bus_high <= 'H';
    -- clock stretching: the slave holds SCL low after the master releases it
    scl <= 'H';
    scl <= '0' when stretch = '1' else 'Z';
    -- open-drain contention: two devices pulling low still give low
    sda <= 'H';
    sda <= '0' when contend = '1' else 'Z';
    sda <= '0' when contend = '1' else 'Z';
    -- push-pull contention fault: 0 vs 1 resolves to X
    pushpull <= '0';
    pushpull <= '1' when contend = '1' else 'Z';
    process
    begin
        wait for 10 ns;
        result(0) <= '1' when bus_low = '0' else '0';
        result(1) <= '1' when bus_high = 'H' else '0';
        stretch <= '1'; wait for 10 ns;
        result(2) <= '1' when scl = '0' else '0';
        stretch <= '0'; wait for 10 ns;
        result(3) <= '1' when scl = 'H' else '0';
        contend <= '1'; wait for 10 ns;
        result(4) <= '1' when sda = '0' else '0';
        result(5) <= '1' when pushpull = 'X' else '0';
        wait for 10 ns;
        wait;
    end process;
end architecture;
"""


@case("OD-01", "12", "Open-drain wired-AND: any low wins, release returns high", "VHDL",
      "0&H&H -> 0; H&H&H -> H; two open-drain lows -> 0; push-pull 0 vs 1 -> X (RESULT=0x3F)")
def od_01() -> str:
    result = _run_inline(OD_TB)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "result"))
    check(got == 0x3F, f"RESULT={got:02X}; expected 111111 (wired-AND + contention)")
    return "wired-AND confirmed: low wins, released line is high, two lows stay low, 0 vs 1 -> X"


@case("OD-02", "12", "I2C clock stretching: a slave holding SCL low keeps it low", "VHDL",
      "master releases SCL, slave pulls low -> bus stays 0; slave releases -> H")
def od_02() -> str:
    result = _run_inline(OD_TB)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "result"))
    check((got >> 2) & 1 == 1, f"SCL not held low during stretch: RESULT={got:02X}")
    check((got >> 3) & 1 == 1, f"SCL did not return high after release: RESULT={got:02X}")
    return "clock stretching confirmed: bus low while slave holds it, high after release"


@case("OD-03", "12", "A floating bus with only a pull-up reads H (not X/Z)", "VHDL",
      "bus driven only by 'H' resolves to H; undriven inout resolves to Z")
def od_03() -> str:
    tb = """
library ieee;
use ieee.std_logic_1164.all;
entity tb_float is
end entity;
architecture sim of tb_float is
    signal pulled : std_logic := 'Z';
    signal nodrv  : std_logic := 'Z';
    signal result : std_logic_vector(1 downto 0) := (others => '0');
begin
    pulled <= 'H';
    process
    begin
        wait for 10 ns;
        result(0) <= '1' when pulled = 'H' else '0';
        result(1) <= '1' when nodrv = 'Z' else '0';
        wait;
    end process;
end architecture;
"""
    result = _run_inline(tb, top="tb_float")
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "result"))
    check(got == 0b11, f"RESULT={got:02X}; expected pulled=H and undriven=Z")
    return "pull-up gives H; an undriven line stays Z (high-impedance)"


@case("OD-05", "12", "AT24C08 block select: all four control bytes 0xA0-0xA7 ACK", "VHDL",
      "block 0 -> 0x11, block 1 -> 0x00, block 2 -> 0x22, block 3 -> 0x00 (RESULT=0x0F)")
def od_05() -> str:
    result = run_tb("board/eeprom_model_dummy.vhd", "board/tb_eeprom_blocks.vhd",
                    "tb_eeprom_blocks", duration=20_000_000, clockPeriod=10, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "result"))
    check(got == 0x0F, f"RESULT={got:02X}; expected 0x0F (four independent 256-byte blocks)")
    return "AT24C08 block-select bits map to word addresses 0/256/512/768"
@case("OD-04", "12", "AT24C08 model: 5 ms write-cycle NACK and 16-byte page wrap", "VHDL",
      "ACK, busy-NACK, ACK after 6 ms, readback 0x5A, page wrap correct (RESULT=0x0A)")
def od_04() -> str:
    result = run_tb("board/eeprom_model_dummy.vhd", "board/tb_eeprom_model.vhd",
                    "tb_eeprom_model", duration=20_000_000, clockPeriod=10, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "result"))
    check(got == 0x0A, f"RESULT={got:02X}; expected 0b001010 (busy NACK + readback 0x5A + wrap)")
    dump = (result.get("peripherals") or {}).get("eeprom", "")
    check("size=1024" in dump, f"EEPROM dump missing/size wrong: {dump[:80]!r}")
    return "write cycle NACKs while busy, ACKs after 5 ms; page write wraps inside 16 bytes"
