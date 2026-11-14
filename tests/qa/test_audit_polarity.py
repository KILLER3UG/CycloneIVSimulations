"""Section 10: polarity is applied exactly once, end to end.

Board facts (board.json): LEDs, keys, DIP, 7-segment segments/digits and the
buzzer are all active-low; the DIP is wired across the key nets.
"""
from __future__ import annotations

from pathlib import Path

from harness import case, check, errors_text, frontend_dir, run_text, simulator, value

ROOT = Path(__file__).resolve().parent.parent.parent


def _run_inline(design: str, testbench: str, top: str, duration: float = 200, **options) -> dict:
    from backend.simulator import SimulationRequest
    payload = {"vhdl": design, "testbench": testbench, "top": top, "duration": duration, "resetCycles": 0}
    payload.update(options)
    return simulator().simulate(SimulationRequest.from_dict(payload))


# ---------------------------------------------------------------------------
# POL-01: LEDs
# ---------------------------------------------------------------------------


@case("POL-01", "10", "LEDs are active-low: driving 0 lights, driving 1 is off", "VHDL",
      "LED=0x0 -> all four LEDs lit; LED=0xF -> all off; profile activeLow=true")
def pol_01() -> str:
    from backend.device import BOARD
    check(BOARD["leds"]["activeLow"] is True, "LED polarity not active-low in the profile")
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity led_level is
    port (SEL : in std_logic;
          LED : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of led_level is
begin
    LED <= (others => '0') when SEL = '0' else (others => '1');
end architecture;
"""
    off = run_text(src, top="led_level", duration=20, resetCycles=0, constantInputs={"SEL": 0})
    check(off.get("ok"), f"simulation failed: {errors_text(off)}")
    check(int(value(off, "LED")) == 0, f"driving 0 should light the LEDs, got {value(off, 'LED')}")
    on = run_text(src, top="led_level", duration=20, resetCycles=0, constantInputs={"SEL": 1})
    check(int(value(on, "LED")) == 0xF, f"driving 1 should turn LEDs off, got {value(on, 'LED')}")
    board = off["board"]
    check(board.get("ledConfig", {}).get("activeLow") is True,
          f"board payload missing ledConfig.activeLow: {board.get('ledConfig')}")
    return "active-low confirmed: 0 = lit, 1 = off; ledConfig.activeLow=true"


# ---------------------------------------------------------------------------
# POL-02: KEY/DIP shared nets (wired-AND, active low)
# ---------------------------------------------------------------------------

KEY_DIP_DESIGN = """
library ieee;
use ieee.std_logic_1164.all;
entity key_dip_net is
    port (KEY, DIP : in std_logic;
          NET     : out std_logic);
end entity;
architecture rtl of key_dip_net is
begin
    NET <= KEY and DIP;   -- wired-AND: either switch closed pulls the net low
end architecture;
"""

KEY_DIP_TB = """
library ieee;
use ieee.std_logic_1164.all;
entity tb_keydip is
end entity;
architecture sim of tb_keydip is
    signal KEY, DIP : std_logic := '1';
    signal NET      : std_logic;
    signal RESULT   : std_logic_vector(3 downto 0) := (others => '0');
begin
    uut : entity work.key_dip_net port map (KEY => KEY, DIP => DIP, NET => NET);
    process
    begin
        KEY <= '1'; DIP <= '1'; wait for 5 ns;
        result(0) <= '1' when NET = '1' else '0';
        KEY <= '0'; DIP <= '1'; wait for 5 ns;
        result(1) <= '1' when NET = '0' else '0';
        KEY <= '1'; DIP <= '0'; wait for 5 ns;
        result(2) <= '1' when NET = '0' else '0';
        KEY <= '0'; DIP <= '0'; wait for 5 ns;
        result(3) <= '1' when NET = '0' else '0';
        wait;
    end process;
end architecture;
"""


@case("POL-02", "10", "KEY and DIP share the net: reads 0 if either is closed", "VHDL",
      "NET = KEY AND DIP: 11->1, 01->0, 10->0, 00->0 (RESULT=0xF)")
def pol_02() -> str:
    result = _run_inline(KEY_DIP_DESIGN, KEY_DIP_TB, "tb_keydip", duration=100)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "result"))
    check(got == 0xF, f"RESULT={got:01X}; expected all four combinations to read low when either is closed")
    return "KEY/DIP wired-AND confirmed: 11->1, 01/10/00->0"


# ---------------------------------------------------------------------------
# POL-03: 7-segment map and polarity
# ---------------------------------------------------------------------------


def _segments_for_digit(digit: int) -> set:
    table = {
        0: set("abcdef"), 1: set("bc"), 2: set("abged"), 3: set("abgcd"),
        4: set("fgbc"), 5: set("afgcd"), 6: set("afgedc"), 7: set("abc"),
        8: set("abcdefg"), 9: set("abcfgd"), 10: set("abcefg"), 11: set("fegdc"),
        12: set("afed"), 13: set("bcdeg"), 14: set("afged"), 15: set("afge"),
    }
    return table[digit]


@case("POL-03", "10", "7-segment SEG bit map and active-low polarity render correct glyphs", "VHDL",
      "digit 0 -> 0xC0, 1 -> 0xF9, 7 -> 0xF8, 8 -> 0x00 (active-low, SEG0=a..SEG7=dp per board.json)")
def pol_03() -> str:
    from backend.device import BOARD
    seg_map = BOARD["displays"]["segBitMap"]
    check(seg_map == {"a": 0, "b": 1, "c": 2, "d": 3, "e": 4, "f": 5, "g": 6, "dp": 7},
          f"SEG map {seg_map}")
    expected = {0: 0xC0, 1: 0xF9, 7: 0xF8, 8: 0x80, 9: 0x90, 10: 0x88}
    for digit, want in expected.items():
        mask = 0
        for segment in _segments_for_digit(digit):
            mask |= 1 << seg_map[segment]
        got = (~mask) & 0xFF
        check(got == want, f"digit {digit}: {got:#04x} != {want:#04x}")
    return "SEG0=a, SEG1=b ... SEG7=dp with active-low drive renders 0/1/7/8/9/A correctly"


# ---------------------------------------------------------------------------
# POL-04: buzzer
# ---------------------------------------------------------------------------


@case("POL-04", "10", "Buzzer is active-low: ON = FPGA_BUZZER 0, idle 1 is silent", "VHDL",
      "profile activeLow=true; constant 0 and constant 1 both decode as no tone")
def pol_04() -> str:
    from backend.device import BOARD
    from backend.peripherals import decode_buzzer
    check(BOARD["buzzer"]["activeLow"] is True, "buzzer polarity wrong")
    idle_high = run_text(
        "library ieee; use ieee.std_logic_1164.all; "
        "entity buzzer_idle_hi is port (FPGA_BUZZER : out std_logic); end entity; "
        "architecture rtl of buzzer_idle_hi is begin FPGA_BUZZER <= '1'; end architecture;",
        top="buzzer_idle_hi", duration=100, resetCycles=0)
    check(idle_high.get("ok"), f"simulation failed: {errors_text(idle_high)}")
    idle_low = run_text(
        "library ieee; use ieee.std_logic_1164.all; "
        "entity buzzer_idle_lo is port (FPGA_BUZZER : out std_logic); end entity; "
        "architecture rtl of buzzer_idle_lo is begin FPGA_BUZZER <= '0'; end architecture;",
        top="buzzer_idle_lo", duration=100, resetCycles=0)
    check(idle_low.get("ok"), f"simulation failed: {errors_text(idle_low)}")
    check(decode_buzzer([(0.0, 1)])["tone"] is False, "idle-high decoded as a tone")
    check(decode_buzzer([(0.0, 0)])["tone"] is False, "constant-low decoded as a tone")
    check(BOARD["buzzer"]["activeLow"] is True, "profile does not mark the buzzer active-low")
    return "buzzer active-low: 0 = ON, 1 = silent; DC levels decode as no tone"


# ---------------------------------------------------------------------------
# POL-05: exactly one conversion end to end
# ---------------------------------------------------------------------------


@case("POL-05", "10", "Active-low conversion happens exactly once (no double/zero inversion)", "infra",
      "stimulus value reaches the design unchanged; only the renderer inverts")
def pol_05() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity led_passthrough is
    port (KEY : in std_logic_vector(3 downto 0);
          LED : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of led_passthrough is
begin
    LED <= KEY;
end architecture;
"""
    for key_value, expected in ((0, 0), (0b0101, 0b0101), (0xF, 0xF)):
        result = run_text(src, top="led_passthrough", duration=20, resetCycles=0,
                          constantInputs={"KEY": key_value})
        check(result.get("ok"), f"simulation failed: {errors_text(result)}")
        got = int(value(result, "LED"))
        check(got == expected, f"KEY={key_value:01X} -> LED={got:01X}, expected {expected:01X}")
    # The UI press handler clears the bit (press = 0) and the renderer lights
    # on 0 when the profile says active-low. Both come from board.json.
    app_js = (frontend_dir() / "app.js").read_text(encoding="utf-8")
    check("value &= ~(1 << bit)" in app_js, "UI press handler no longer sets the bit low")
    check("ledConfig" in app_js and "activeLow" in app_js, "UI does not use the profile polarity")
    board3d = (frontend_dir() / "board3d.js").read_text(encoding="utf-8")
    check("ledConfig" in board3d, "3D board does not use the profile polarity")
    return "stimulus reaches the design unchanged; only the renderer inverts (activeLow from board.json)"
