"""Section 24: 7-segment multiplexing, buzzer and tri-state behaviour.

Expectations are derived from board/board.json at runtime (segBitMap,
segment/digit polarity, buzzer polarity).
"""
from __future__ import annotations

import json

from harness import (
    case,
    check,
    cycle_values,
    errors_text,
    must_run,
    run_text,
    signal,
    simulator,
    value,
)
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def _load():
    return json.loads((ROOT / "board" / "board.json").read_text(encoding="utf-8"))


def _seg_pattern(digit: int, seg_map: dict) -> int:
    """Active-low SEG byte for a hex digit, derived from segBitMap."""
    table = {
        0: set("abcdef"), 1: set("bc"), 2: set("abged"), 3: set("abgcd"),
        4: set("fgbc"), 5: set("afgcd"), 6: set("afgedc"), 7: set("abc"),
        8: set("abcdefg"), 9: set("abcfgd"), 10: set("abcefg"), 11: set("fegdc"),
        12: set("afed"), 13: set("bcdeg"), 14: set("afged"), 15: set("afge"),
    }
    mask = 0
    for segment in table[digit]:
        mask |= 1 << seg_map[segment]
    return (~mask) & 0xFF


SEG_MUX_SRC = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity seg_mux is
    generic (SCAN_DIV : natural := 2);
    port (clk   : in  std_logic;
          value : in  std_logic_vector(15 downto 0);
          SEG   : out std_logic_vector(7 downto 0);
          DIG   : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of seg_mux is
    signal scan   : natural range 0 to SCAN_DIV - 1 := 0;
    signal digit  : natural range 0 to 3 := 0;
    signal hexn   : integer range 0 to 15 := 0;
    type seg_lut_t is array (0 to 15) of std_logic_vector(7 downto 0);
    signal seg_lut : seg_lut_t := (
        0 => "11000000", 1 => "11111001", 2 => "10100100", 3 => "10110000",
        4 => "10011001", 5 => "10010010", 6 => "10000010", 7 => "11111000",
        8 => "10000000", 9 => "10010000", 10 => "10001000", 11 => "10000011",
        12 => "11000110", 13 => "10100001", 14 => "10000110", 15 => "10001110");
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if scan = SCAN_DIV - 1 then
                scan   <= 0;
                digit  <= (digit + 1) mod 4;
            else
                scan <= scan + 1;
            end if;
        end if;
    end process;
    process (value, digit)
    begin
        case digit is
            when 0 => hexn <= to_integer(unsigned(value(3 downto 0)));
            when 1 => hexn <= to_integer(unsigned(value(7 downto 4)));
            when 2 => hexn <= to_integer(unsigned(value(11 downto 8)));
            when others => hexn <= to_integer(unsigned(value(15 downto 12)));
        end case;
    end process;
    SEG <= seg_lut(hexn);
    DIG <= "1110" when digit = 0 else
           "1101" when digit = 1 else
           "1011" when digit = 2 else
           "0111";
end architecture;
"""


@case("SEG7-01", "24", "Segment and digit polarity are active-low per board.json", "VHDL",
      "displayConfig.segmentActiveLow/digitActiveLow true; a driven 0 selects, 1 releases")
def seg7_01() -> str:
    data = _load()
    from backend.waveform import map_board
    from backend.vhdl_parser import VHDLParser
    entity = VHDLParser().parse(SEG_MUX_SRC).entities[0]
    cfg = map_board(entity).display_config
    check(cfg["segmentActiveLow"] is True, f"segmentActiveLow={cfg}")
    check(cfg["digitActiveLow"] is True, f"digitActiveLow={cfg}")
    check(cfg["segBitMap"] == data["board"]["displays"]["segBitMap"], "segBitMap metadata")
    result = run_text(SEG_MUX_SRC, top="seg_mux", duration=400, clockPeriod=10, resetCycles=0,
                      generics={"SCAN_DIV": 2}, constantInputs={"value": 0})
    dig = int(value(result, "DIG"))
    check(dig != 0b1111, f"DIG idle-high {dig:04b}; active-low select expected")
    return "segment/digit active-low confirmed from the profile and a driven scan"


@case("SEG7-02", "24", "Fast scan: all four digits appear lit across sampled cycles", "VHDL",
      "scan period << sample window: DIG cycles through all four digits and SEG follows each nibble")
def seg7_02() -> str:
    data = _load()
    seg_map = data["board"]["displays"]["segBitMap"]
    value_word = 0x3210
    result = run_text(SEG_MUX_SRC, top="seg_mux", duration=2000, clockPeriod=10, resetCycles=0,
                      generics={"SCAN_DIV": 2}, constantInputs={"value": value_word})
    cycles = result["waveforms"]["cycles"]
    digits_seen = set()
    matched = 0
    one_cold = {0b1110: 0, 0b1101: 1, 0b1011: 2, 0b0111: 3}  # active-low digit select
    for cycle in cycles:
        dig = int(cycle["values"]["DIG"]) & 0xF
        seg = int(cycle["values"]["SEG"])
        if dig in one_cold:
            idx = one_cold[dig]
            digits_seen.add(idx)
            want = _seg_pattern((value_word >> (4 * idx)) & 0xF, seg_map)
            if seg == want:
                matched += 1
    check(len(digits_seen) == 4, f"only digits {digits_seen} seen; expected all four")
    check(matched >= 4, f"SEG followed the nibble in only {matched} cycles")
    return (f"fast scan: DIG visited {[hex(d) for d in sorted(digits_seen)]}; "
            f"SEG matched the selected nibble in {matched} sampled cycles")


@case("SEG7-03", "24", "Slow scan: sampled cycles show a single held digit", "VHDL",
      "scan period >> sample window: every sampled cycle in a hold shows the same digit")
def seg7_03() -> str:
    result = run_text(SEG_MUX_SRC, top="seg_mux", duration=4000, clockPeriod=10, resetCycles=0,
                      generics={"SCAN_DIV": 200}, constantInputs={"value": 0x000A})
    cycles = result["waveforms"]["cycles"]
    dig_values = {int(c["values"]["DIG"]) for c in cycles}
    check(len(dig_values) <= 2, f"slow scan showed {len(dig_values)} digits in 400 sampled cycles: {dig_values}")
    return f"slow scan: sampled cycles held only {len(dig_values)} digit state(s) ({[hex(d) for d in sorted(dig_values)]})"


@case("SEG7-04", "24", "Non-simultaneous digit+segment change shows a visible ghosting window", "VHDL",
      "documented model behaviour: for a few cycles after the segment changes, the old digit still shows the new segments")
def seg7_04() -> str:
    # Drive SEG directly: change segments, then change the digit a few cycles
    # later.  The intermediate sampled cycles are the ghosting window (real
    # multiplexed displays show the same artefact).
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity seg_ghost is
    port (clk : in std_logic; SEG : out std_logic_vector(7 downto 0); DIG : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of seg_ghost is
    signal step : natural range 0 to 7 := 0;
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if step < 7 then step <= step + 1; end if;
        end if;
    end process;
    SEG <= x"FF" when step < 2 else x"C0";       -- blank, then digit-0 glyph
    DIG <= "1111" when step < 5 else "1110";     -- none, then digit 0 (late)
end architecture;
"""
    result = run_text(src, top="seg_ghost", duration=200, clockPeriod=10, resetCycles=0)
    cycles = result["waveforms"]["cycles"]
    ghost = [c["cycle"] for c in cycles
             if int(c["values"]["SEG"]) == 0xC0 and int(c["values"]["DIG"]) == 0b1111]
    check(ghost, "no ghosting window observed (segment changed while digit still off)")
    return (f"documented: segments show the new glyph for {len(ghost)} sampled cycles "
            f"(cycles {ghost}) before the digit select arrives — matches the multiplexed-display ghosting effect")


@case("BUZ-01", "24", "Buzzer toggle frequency matches the driven square wave", "VHDL",
      "a square wave with a 500 ns half period decodes at 1 MHz (within 1%)")
def buz_01() -> str:
    from backend.peripherals import decode_buzzer
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity buzzer_square is
    port (clk : in std_logic; FPGA_BUZZER : out std_logic);
end entity;
architecture rtl of buzzer_square is
    signal lvl : std_logic := '0';
begin
    process (clk)
        variable cnt : integer := 0;
    begin
        if rising_edge(clk) then
            if cnt = 49 then          -- 50 cycles * 10 ns = 500 ns half period
                cnt := 0;
                lvl <= not lvl;
            else
                cnt := cnt + 1;
            end if;
        end if;
    end process;
    FPGA_BUZZER <= lvl;
end architecture;
"""
    result = run_text(src, top="buzzer_square", duration=30000, clockPeriod=10, resetCycles=0)
    trans = signal(result, "FPGA_BUZZER")["transitions"]
    decoded = decode_buzzer(trans)
    freq = decoded.get("frequency") or 0
    check(abs(freq - 1_000_000) / 1_000_000 < 0.01, f"decoded {freq} Hz; expected ~1 MHz")
    check(decoded.get("tone") is True, f"no tone decoded: {decoded}")
    return f"buzzer square wave decoded at {freq} Hz (driven 1 MHz), tone=True"


@case("TRI-01", "24", "Released (high-Z) outputs read Z: LEDs off, buzzer silent", "VHDL",
      "tri-stated LED/buzzer pins capture Z; the buzzer decoder reports silence; active-low profile means Z is off")
def tri_01() -> str:
    from backend.peripherals import decode_buzzer
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity released is
    port (FPGA_BUZZER : out std_logic; LED : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of released is
begin
    FPGA_BUZZER <= 'Z';
    LED <= (others => 'Z');
end architecture;
"""
    result = run_text(src, top="released", duration=100, resetCycles=0)
    check(str(value(result, "LED")) == "ZZZZ" or value(result, "LED") == "Z",
          f"LED={value(result, 'LED')!r}; expected high-Z")
    check(value(result, "FPGA_BUZZER") in ("Z", "z"), f"buzzer={value(result, 'FPGA_BUZZER')!r}")
    trans = signal(result, "FPGA_BUZZER")["transitions"]
    check(decode_buzzer(trans)["tone"] is False, "high-Z buzzer decoded as a tone")
    return "released pins read Z; buzzer silent; per the active-low profile Z lights nothing"
