"""Live-stepping co-simulation integration tests (persistent GHDL process).

These prove the real-time pillar: a persistent ``ghdl -r`` textio wrapper
keeps DUT state across ``step`` commands (no restart from t=0), integrates
exact within-frame duty cycles, counts buzzer toggles, preserves U/X/Z
metavalues, and tears the subprocess down cleanly.
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.live_session import LiveController, build_live_controller
from backend.vhdl_parser import VHDLParser
from backend.waveform import map_board

COUNTER_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity live_counter is
  port (clk : in std_logic; reset : in std_logic; led : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of live_counter is
  signal cnt : unsigned(7 downto 0) := (others => '0');
begin
  process (clk, reset)
  begin
    if reset = '1' then
      cnt <= (others => '0');
    elsif rising_edge(clk) then
      cnt <= cnt + 1;
    end if;
  end process;
  led <= std_logic_vector(cnt);
end architecture;
"""

COUNTER_VERILOG = """
module live_vcounter(input clk, input reset, output reg [7:0] led);
always @(posedge clk or posedge reset) begin
  if (reset) led <= 0;
  else led <= led + 1;
end
endmodule
"""

TOGGLE_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
entity live_buzz is
  port (clk : in std_logic; beep : out std_logic);
end entity;
architecture rtl of live_buzz is
  signal t : std_logic := '0';
begin
  process (clk) begin
    if rising_edge(clk) then
      t <= not t;
    end if;
  end process;
  beep <= t;
end architecture;
"""

META_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
entity live_meta is
  port (clk : in std_logic; q : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of live_meta is
  signal u : std_logic_vector(3 downto 0);
begin
  q <= u;   -- never assigned: stays 'U' (hardware bug visibility)
end architecture;
"""


def _wait_for_frame(controller: LiveController, min_seq: int, timeout: float = 8.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if controller.frame_seq >= min_seq:
            return controller.last_frame
        time.sleep(0.01)
    raise AssertionError(f"no frame with seq >= {min_seq} arrived")


def _step_and_wait(controller: LiveController, cycles: int, timeout: float = 8.0) -> dict:
    seq = controller.frame_seq
    assert controller.session.step(cycles)
    return _wait_for_frame(controller, seq + 1, timeout)


@pytest.fixture(scope="module")
def ghdl_exe():
    try:
        return GhdlTool().executable
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")


def _make_controller(ghdl_exe: str, vhdl: str, reset_cycles: int = 2,
                     reset_active_high: bool = True) -> LiveController:
    entity = VHDLParser().parse(vhdl).entities[0]
    controller, _ = build_live_controller(
        ghdl_exe, entity, [(entity.name + ".vhd", vhdl)], map_board(entity),
        {"resetPin": "PIN_25", "resetActiveLow": True},
        "clk", 10.0, "reset", reset_cycles, reset_active_high)
    assert controller.session.start(), controller.session.start_error
    return controller


def test_live_state_retention_vhdl(ghdl_exe):
    controller = _make_controller(ghdl_exe, COUNTER_VHDL)
    try:
        controller.assert_reset()
        frame = _wait_for_frame(controller, 1)
        assert frame["values"]["led"] == 0, frame["values"]
        # THE critical property: stepping again CONTINUES the count (10, 20,
        # 30) — the design is never restarted from t=0.
        frame = _step_and_wait(controller, 10)
        assert frame["values"]["led"] == 10, frame["values"]
        frame = _step_and_wait(controller, 10)
        assert frame["values"]["led"] == 20, frame["values"]
        frame = _step_and_wait(controller, 10)
        assert frame["values"]["led"] == 30, frame["values"]
    finally:
        controller.session.close()


def test_live_state_retention_verilog(ghdl_exe):
    from backend.verilog_support import translate_verilog_sources
    sources, _maps, errors, _warn = translate_verilog_sources(
        [("live_vcounter.v", COUNTER_VERILOG)])
    assert not errors, errors
    entity = VHDLParser().parse("\n".join(c for _n, c in sources)).entities[0]
    controller, _ = build_live_controller(
        ghdl_exe, entity, sources, map_board(entity),
        {"resetPin": "PIN_25", "resetActiveLow": True}, "clk", 10.0, "reset", 2, True)
    try:
        assert controller.session.start(), controller.session.start_error
        controller.assert_reset()
        _wait_for_frame(controller, 1)
        frame = _step_and_wait(controller, 7)
        assert frame["values"]["led"] == 7, frame["values"]
        frame = _step_and_wait(controller, 7)
        assert frame["values"]["led"] == 14, frame["values"]
    finally:
        controller.session.close()


def test_live_duty_integration_exact(ghdl_exe):
    controller = _make_controller(ghdl_exe, COUNTER_VHDL)
    try:
        controller.assert_reset()
        _wait_for_frame(controller, 1)
        frame = _step_and_wait(controller, 10)
        # cnt walks 1..10 across the frame: bit0 high 5/10, bit1 5/10,
        # bit2 4/10, bit3 3/10 (permille, exact integer math).
        assert frame["duty"]["led"] == [500, 500, 400, 300, 0, 0, 0, 0], frame["duty"]
        frame = _step_and_wait(controller, 10)
        # Second frame: cnt 11..20 -> bit0..bit4 each high exactly 5/10
        # (the 5-bit window slides across the 16s boundary).
        assert frame["duty"]["led"] == [500, 500, 500, 500, 500, 0, 0, 0], frame["duty"]
    finally:
        controller.session.close()


def test_live_buzzer_toggle_hz(ghdl_exe):
    entity = VHDLParser().parse(TOGGLE_VHDL).entities[0]
    controller, _ = build_live_controller(
        ghdl_exe, entity, [(entity.name + ".vhd", TOGGLE_VHDL)], map_board(entity),
        {"buzzer": {"pin": "PIN_110", "activeLow": True}}, "clk", 10.0,
        None, 0, True)
    try:
        assert controller.session.start(), controller.session.start_error
        time.sleep(0.2)
        frame = _step_and_wait(controller, 100)
        buzz = frame.get("buzzer")
        assert buzz is not None, frame
        # A toggle-FF flips the pin once per cycle: 100 toggles in 100 cycles.
        assert buzz["toggles"] == 100, buzz
        # f = toggles / (2 * N * T_clk) = 100 / (2 * 100 * 10 ns) = 50 MHz
        freq = buzz["toggles"] / (2 * frame["cycles"] * (controller.clock_period_ns * 1e-9))
        assert abs(freq - 50e6) < 1e5, freq
    finally:
        controller.session.close()


def test_live_meta_values_preserved(ghdl_exe):
    controller = _make_controller(ghdl_exe, META_VHDL, reset_cycles=0)
    try:
        time.sleep(0.2)
        frame = _step_and_wait(controller, 4)
        # 'U' must survive to the UI layer, not be coerced to 0.
        assert frame["values"]["q"] == "UUUU", frame["values"]
    finally:
        controller.session.close()


def test_live_subprocess_cleanup(ghdl_exe):
    controller = _make_controller(ghdl_exe, COUNTER_VHDL)
    proc = controller.session.proc
    assert proc is not None and proc.poll() is None
    controller.session.close()
    time.sleep(0.3)
    assert proc.poll() is not None  # no zombie ghdl -r process
    assert not controller.session.alive


# ---------------------------------------------------------------------------
# Phase 5: wired-AND KEY/DIP bank, LCD mid-burst, bounce, peripherals
# ---------------------------------------------------------------------------

KEYSW_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
entity live_keysw is
  port (clk : in std_logic;
        key : in std_logic_vector(3 downto 0);
        sw : in std_logic_vector(3 downto 0);
        led : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of live_keysw is
begin
  -- active-low board: pin low -> LED lit
  led <= not key;
end architecture;
"""

GHOST_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity live_ghost is
  port (clk : in std_logic;
        seg : out std_logic_vector(6 downto 0);
        dig : out std_logic_vector(1 downto 0));
end entity;
architecture rtl of live_ghost is
  signal cnt : unsigned(2 downto 0) := (others => '0');
begin
  process (clk) begin
    if rising_edge(clk) then
      cnt <= cnt + 1;
    end if;
  end process;
  -- unblanked mux: digit and segment lines switch on the SAME edge
  dig <= "10" when cnt(1) = '0' else "01";
  seg <= "1111001" when cnt(0) = '0' else "0100100";
end architecture;
"""

LCD_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity live_lcd is
  port (clk : in std_logic;
        lcd_rs : out std_logic;
        lcd_rw : out std_logic;
        lcd_e : out std_logic;
        lcd_d : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of live_lcd is
  signal step : integer range 0 to 31 := 0;
  constant TEXT : std_logic_vector(39 downto 0) := x"48454C4C4F"; -- HELLO
begin
  lcd_rw <= '0';
  process (clk) begin
    if rising_edge(clk) then
      if step < 30 then
        step <= step + 1;
      end if;
    end if;
  end process;
  -- E strobes every 2 cycles; each falling edge writes one DDRAM character
  lcd_e <= '1' when (step mod 4) < 2 and step < 24 else '0';
  lcd_rs <= '1';                          -- data writes
  lcd_d <= x"48" when step < 4 else x"45" when step < 8 else x"4C"
           when step < 12 else x"4C" when step < 16 else x"4F";
end architecture;
"""

BOUNCE_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity live_bounce is
  port (clk : in std_logic; key : in std_logic; cnt : out unsigned(7 downto 0));
end entity;
architecture rtl of live_bounce is
  signal c : unsigned(7 downto 0) := (others => '0');
begin
  -- deliberately UN-debounced: the key net is used as a clock
  process (key) begin
    if rising_edge(key) then
      c <= c + 1;
    end if;
  end process;
  cnt <= c;
end architecture;
"""

PS2_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity live_ps2 is
  port (clk : in std_logic;
        ps_clock : in std_logic; ps_data : in std_logic; cnt : out unsigned(7 downto 0));
end entity;
architecture rtl of live_ps2 is
  signal c : unsigned(7 downto 0) := (others => '0');
begin
  process (ps_clock) begin
    if falling_edge(ps_clock) then
      c <= c + 1;   -- one count per PS/2 clock: a full frame has 11 clocks
    end if;
  end process;
  cnt <= c;
end architecture;
"""

IR_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity live_ir is
  port (clk : in std_logic; ir : in std_logic; cnt : out unsigned(15 downto 0));
end entity;
architecture rtl of live_ir is
  signal c : unsigned(15 downto 0) := (others => '0');
begin
  process (ir) begin
    if falling_edge(ir) then
      c <= c + 1;   -- NEC frame: 1 leader + 32 data falling edges = 33
    end if;
  end process;
  cnt <= c;
end architecture;
"""


def _make_from_source(ghdl_exe, vhdl, profile, reset_cycles=0, reset_active_high=True):
    entity = VHDLParser().parse(vhdl).entities[0]
    controller, _ = build_live_controller(
        ghdl_exe, entity, [(entity.name + ".vhd", vhdl)], map_board(entity),
        profile, "clk", 10.0, "reset", reset_cycles, reset_active_high)
    assert controller.session.start(), controller.session.start_error
    return controller


def test_live_wired_and_shared_bank(ghdl_exe):
    """DIP ON must hold the shared pin low no matter how KEY toggles."""
    controller = _make_from_source(ghdl_exe, KEYSW_VHDL, {
        "buttons": {"pins": ["PIN_88", "PIN_89", "PIN_90", "PIN_91"], "activeLow": True},
        "switches": {"pins": ["PIN_88", "PIN_89", "PIN_90", "PIN_91"], "activeLow": True,
                     "sharedWithButtons": True},
        "resetPin": "PIN_25", "resetActiveLow": True,
    })
    try:
        time.sleep(0.2)
        # DIP1 ON + KEY1 released -> pin low -> LED0 lit
        controller.apply_channel_state([False, False, False, False],
                                       [True, False, False, False], False)
        frame = _step_and_wait(controller, 4)
        assert frame["values"]["led"] & 1 == 1, frame["values"]
        # KEY1 pressed while DIP1 stays ON -> pin STILL low (wired-AND)
        controller.apply_channel_state([True, False, False, False],
                                       [True, False, False, False], False)
        frame = _step_and_wait(controller, 4)
        assert frame["values"]["led"] & 1 == 1, frame["values"]
        # DIP1 OFF + KEY1 released -> pin high -> LED0 dark
        controller.apply_channel_state([False, False, False, False],
                                       [False, False, False, False], False)
        frame = _step_and_wait(controller, 4)
        assert frame["values"]["led"] & 1 == 0, frame["values"]
    finally:
        controller.session.close()


def test_live_lcd_mid_burst_capture(ghdl_exe):
    controller = _make_from_source(ghdl_exe, LCD_VHDL, {
        "lcd": {"pins": {"LCD_RS": "PIN_141", "LCD_RW": "PIN_138", "LCD_E": "PIN_143",
                          "LCD_D0": "PIN_142", "LCD_D1": "PIN_1", "LCD_D2": "PIN_144",
                          "LCD_D3": "PIN_3", "LCD_D4": "PIN_2", "LCD_D5": "PIN_10",
                          "LCD_D6": "PIN_7", "LCD_D7": "PIN_11"}},
        "resetPin": "PIN_25", "resetActiveLow": True,
    })
    try:
        time.sleep(0.2)
        frame = _step_and_wait(controller, 40)
        events = frame.get("lcdEvents") or []
        # Six E falling edges (HELLO = 5 chars + the final held state).
        assert len(events) >= 5, events
        decoded = frame.get("lcd") or {}
        assert decoded.get("lines", [""])[0].startswith("HELLO"), decoded
    finally:
        controller.session.close()


def test_live_bounce_overcounts(ghdl_exe):
    """Bump AND release with contact chatter: an un-debounced design counts
    extra edges (6) vs. the exact single count of a clean press+release."""
    profile = {"buttons": {"pins": ["PIN_88", "PIN_89", "PIN_90", "PIN_91"], "activeLow": True},
               "resetPin": "PIN_25", "resetActiveLow": True}
    counts = {}
    for bounce in (False, True):
        controller = _make_from_source(ghdl_exe, BOUNCE_VHDL, profile)
        try:
            time.sleep(0.2)
            # bump (press) then release, with the bounce flag on/off
            controller.apply_channel_state([True, False, False, False],
                                           [False, False, False, False], False, bounce=bounce)
            controller.session.step(6)
            time.sleep(0.2)
            controller.apply_channel_state([False, False, False, False],
                                           [False, False, False, False], False, bounce=bounce)
            controller.session.step(6)
            time.sleep(0.2)
            frame = controller.last_frame
            counts[bounce] = int(frame["values"]["cnt"])
        finally:
            controller.session.close()
    # Chatter on BOTH edges produced extra rising edges (3 per edge) on the
    # un-debounced design; the clean run counts exactly once.
    assert counts[False] == 1, counts
    assert counts[True] == 6, counts


def test_live_ps2_frame(ghdl_exe):
    controller = _make_from_source(ghdl_exe, PS2_VHDL, {
        "ps2": {"pins": {"PS_CLOCK": "PIN_119", "PS_DATA": "PIN_120"}},
        "resetPin": "PIN_25", "resetActiveLow": True,
    })
    try:
        time.sleep(0.2)
        assert controller.session.ps2_inject(0x5A)
        frame = _step_and_wait(controller, 8)
        # 11 PS/2 clocks per frame (start + 8 data + parity + stop)
        assert int(frame["values"]["cnt"]) == 11, frame["values"]
    finally:
        controller.session.close()


def test_live_ir_frame(ghdl_exe):
    controller = _make_from_source(ghdl_exe, IR_VHDL, {
        "infrared": {"pin": "PIN_100"}, "resetPin": "PIN_25", "resetActiveLow": True,
    })
    try:
        time.sleep(0.2)
        assert controller.session.ir_trigger(0x00, 0xAA)
        frame = _step_and_wait(controller, 8, timeout=15.0)
        # 33 falling edges: 1 leader + 32 data bits
        assert int(frame["values"]["cnt"]) == 33, frame["values"]
    finally:
        controller.session.close()


def test_live_uart_loopback(ghdl_exe):
    echo = (Path(__file__).resolve().parent.parent / "tests" / "qa" / "designs" / "board" / "uart_echo.vhd").read_text(encoding="utf-8")
    entity = VHDLParser().parse(echo).entities[0]
    controller, _ = build_live_controller(
        ghdl_exe, entity, [(entity.name + ".vhd", echo)], map_board(entity),
        {"uart": {"pins": {"UART_TXD": "PIN_114", "UART_RXD": "PIN_115"}},
         "resetPin": "PIN_25", "resetActiveLow": True},
        "CLOCK_50", 20.0, "reset", 0, True)
    assert controller.session.start(), controller.session.start_error
    try:
        time.sleep(0.2)
        # Live UART TX: the wrapper bit-bangs an 8N1 byte onto UART_RXD; the
        # design echoes it. ECHO_COUNT=1 proves the live-injected byte was
        # received (the loopback path works end to end).
        assert controller.session.uart_tx(0x55, 115200)
        frame = _step_and_wait(controller, 30000, timeout=15.0)
        assert int(frame["values"]["ECHO_COUNT"]) == 1, frame["values"]
        assert len(frame.get("uartTransitions") or []) >= 9, frame.get("uartTransitions")
    finally:
        controller.session.close()


VGA_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity live_vga is
  port (clk : in std_logic;
        vga_hs : out std_logic;
        vga_vs : out std_logic;
        vga_r : out std_logic;
        vga_g : out std_logic;
        vga_b : out std_logic);
end entity;
architecture rtl of live_vga is
  signal hcount : unsigned(9 downto 0) := (others => '0');
  signal vline : unsigned(2 downto 0) := (others => '0');
begin
  process (clk) begin
    if rising_edge(clk) then
      hcount <= hcount + 1;
      if hcount = 500 then
        hcount <= (others => '0');
        vline <= vline + 1;
      end if;
    end if;
  end process;
  vga_hs <= '0' when hcount < 40 else '1';
  vga_vs <= '0' when vline = 7 else '1';
  vga_r <= hcount(3);
  vga_g <= hcount(2);
  vga_b <= hcount(1);
end architecture;
"""


def test_live_vga_decode(ghdl_exe):
    controller = _make_from_source(ghdl_exe, VGA_VHDL, {
        "vga": {"pins": {"VGA_HSYNC": "PIN_101", "VGA_VSYNC": "PIN_103",
                          "VGA_R": "PIN_106", "VGA_G": "PIN_105", "VGA_B": "PIN_104"}},
        "resetPin": "PIN_25", "resetActiveLow": True,
    })
    try:
        time.sleep(0.2)
        # 400 cycles is less than one 500-cycle VGA line: step enough for
        # several completed lines.
        frame = _step_and_wait(controller, 2500)
        vga = frame.get("vga") or {}
        lines = vga.get("lines") or {}
        assert len(lines) >= 4, lines
        for _line, packed in lines.items():
            assert 0 <= int(packed) <= 0xFFFFFF
    finally:
        controller.session.close()


LM75_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
entity live_lm75 is
  port (clk : in std_logic; fpga_scl : out std_logic; fpga_sda : inout std_logic;
        led : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of live_lm75 is
begin
  fpga_scl <= '1';
  led <= "1010";
end architecture;
"""


def test_live_lm75_temp_command(ghdl_exe):
    controller = _make_from_source(ghdl_exe, LM75_VHDL, {
        "i2c": {"buses": [{"scl": "PIN_112", "sda": "PIN_113",
                            "device": {"part": "LM75", "temperatureC": 25.0}}]},
        "resetPin": "PIN_25", "resetActiveLow": True,
    })
    try:
        time.sleep(0.2)
        # Mid-run ambient change: accepted by the wrapper, the LM75 model's
        # ambient port is wired (full I2C read-back is covered by the model).
        assert controller.session.set_temp(30)
        assert "lm75" in (controller.wrapper.get("models") or [])
        frame = _step_and_wait(controller, 4)
        assert frame["values"]["led"] == 10, frame["values"]
    finally:
        controller.session.close()
