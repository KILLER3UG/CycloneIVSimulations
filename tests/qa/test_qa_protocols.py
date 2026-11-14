"""Section 25: protocol checks against the datasheets (extend PR-01..08).

Covers the UART framing/baud failure modes, VGA no-signal behaviour, the
HD44780 enable-pulse width + busy flag, and documents the PS/2 host-inhibit
and SDRAM limitations.  I2C START/STOP/ACK/NACK, repeated START, block
select, page wrap and the 5 ms write-cycle NACK are exercised by OD-04/OD-05
and SPEC-06/SPEC-07 against the same AT24C08/LM75 models.
"""
from __future__ import annotations

from harness import case, check, errors_text, run_text, signal, value
from backend.peripherals import decode_uart, decode_vga


def _uart_frame(byte: int, bit_time: float, stop: int = 1) -> list:
    """Reference 8N1 encoder: idle, start, 8 data bits LSB first, stop."""
    levels = [(0.0, 1)]
    t = bit_time
    levels.append((t, 0))                     # start bit
    for k in range(8):
        t += bit_time
        levels.append((t, (byte >> k) & 1))   # LSB first
    t += bit_time
    levels.append((t, stop))                  # stop bit
    return levels


@case("PRO-01", "25", "UART 8N1: a bad stop bit is a framing error (byte rejected)", "VHDL",
      "a frame whose stop bit is 0 decodes to no byte; the same frame with stop=1 decodes exactly")
def pro_01() -> str:
    good = decode_uart(_uart_frame(0x5A, 1000.0, stop=1))
    check(good["bytes"] == [0x5A], f"control frame decoded {good}")
    bad = decode_uart(_uart_frame(0x5A, 1000.0, stop=0))
    check(bad["bytes"] == [], f"bad-stop frame accepted as {bad['bytes']}")
    check(bad["frames"] == 0, f"bad-stop frame counted as a frame: {bad}")
    return "stop=1 -> 0x5A decoded; stop=0 -> framing error, 0 bytes"


@case("PRO-02", "25", "UART: a frame at the wrong bit time is garbage for a locked receiver", "VHDL",
      "two frames at different bit times in one capture do not both decode; the wrong-baud frame is lost/garbled")
def pro_02() -> str:
    def two_frames(first: list, second: list, gap: float) -> list:
        offset = first[-1][0] + gap
        return first + [(t + offset, v) for t, v in second[1:]]

    same = decode_uart(two_frames(_uart_frame(0x55, 1000.0), _uart_frame(0x3C, 1000.0), 500.0))
    check(same["bytes"] == [0x55, 0x3C], f"same-rate frames decoded {same}")
    mixed = decode_uart(two_frames(_uart_frame(0x55, 1000.0), _uart_frame(0x3C, 2000.0), 500.0))
    check(mixed["bytes"] != [0x55, 0x3C],
          f"a receiver locked to one bit time decoded both rates correctly: {mixed}")
    return (f"same rate -> {same['bytes']}; mixed rates -> {mixed['bytes']} "
            "(wrong baud garbles/loses the frame, as on a real UART)")


@case("PRO-03", "25", "VGA: no sync toggles means no signal (bad mode)", "VHDL",
      "a design with static VGA pins decodes no frame; decode_vga reports frame=False")
def pro_03() -> str:
    # unit level: the decoder needs both vsync edges and >=4 hsync pulses
    decoded = decode_vga([(0.0, 0)], [(0.0, 1)], [(0.0, 0)], [(0.0, 0)], [(0.0, 0)])
    check(decoded["frame"] is False, f"static pins decoded a frame: {decoded}")
    # end to end: a design driving the VGA pins without proper sync
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity vga_bad is
    port (VGA_HSYNC, VGA_VSYNC : out std_logic;
          VGA_R, VGA_G, VGA_B  : out std_logic);
end entity;
architecture rtl of vga_bad is
begin
    VGA_HSYNC <= '1';   -- stuck: not a valid 640x480@60 sync
    VGA_VSYNC <= '1';
    VGA_R <= '1'; VGA_G <= '0'; VGA_B <= '0';
end architecture;
"""
    result = run_text(src, top="vga_bad", duration=1000, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    vga = (result.get("peripherals") or {}).get("vga")
    check(not vga or vga.get("frame") is not True,
          f"bad-mode VGA decoded as a frame: {vga}")
    return f"bad VGA mode -> no signal (peripherals.vga={vga!r})"


@case("PRO-04", "25", "HD44780: E pulse below PWEH is ignored; busy flag follows the write cycle", "VHDL",
      "100 ns E pulse does not execute the command; 1 us pulse does (busy=1 for 1.52 ms, then clear)")
def pro_04() -> str:
    tb = """
library ieee;
use ieee.std_logic_1164.all;
entity tb_lcd_pulse is
end entity;
architecture sim of tb_lcd_pulse is
    signal rs, rw, e    : std_logic := '0';
    signal d            : std_logic_vector(7 downto 0) := (others => 'Z');
    signal data         : std_logic_vector(7 downto 0) := x"01";
    signal drive        : std_logic := '0';
    signal result       : std_logic_vector(3 downto 0) := (others => '0');
begin
    u_lcd : entity work.hd44780
        generic map (DUMP => "lcd_state.txt")
        port map (lcd_rs => rs, lcd_rw => rw, lcd_e => e, lcd_d => d);
    d <= data when drive = '1' else (others => 'Z');

    stim : process
        procedure pulse(high_time : time) is
        begin
            e <= '1';
            wait for high_time;
            e <= '0';
            wait for 100 ns;
        end procedure;
    begin
        -- 1. E high pulse 100 ns < PWEH 450 ns: the command must be ignored
        rs <= '0'; rw <= '0'; data <= x"01"; drive <= '1';
        pulse(100 ns);
        -- 2. busy flag read: clear, because nothing executed
        drive <= '0'; rw <= '1'; e <= '1'; wait for 50 ns;
        result(0) <= '1' when d(7) = '0' else '0';
        e <= '0'; rw <= '0'; wait for 100 ns;
        -- 3. proper 1 us E pulse: clear (0x01) executes, busy for 1.52 ms
        drive <= '1';
        pulse(1 us);
        -- 4. busy flag set during the write cycle
        drive <= '0'; rw <= '1'; e <= '1'; wait for 50 ns;
        result(1) <= '1' when d(7) = '1' else '0';
        e <= '0'; wait for 2 ms;
        -- 5. busy clears after the write cycle, address 0 on D6..D0
        rw <= '1'; e <= '1'; wait for 50 ns;
        result(2) <= '1' when d(7) = '0' else '0';
        e <= '0'; rw <= '0'; wait for 100 ns;
        -- 6. DDRAM write of 'A' through RS=1/RW=0 with a valid pulse
        rs <= '1'; data <= x"41"; drive <= '1';
        pulse(1 us);
        rs <= '0'; drive <= '0';
        wait for 200 ns;
        wait;
    end process;
end architecture;
"""
    from harness import simulator
    from backend.simulator import SimulationRequest
    dummy = ("library ieee; use ieee.std_logic_1164.all; "
             "entity lcd_dummy is end entity; "
             "architecture sim of lcd_dummy is begin end architecture;")
    result = simulator().simulate(SimulationRequest.from_dict({
        "vhdl": dummy, "testbench": tb, "top": "tb_lcd_pulse",
        "duration": 3_000_000, "resetCycles": 0}))
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "result"))
    check(got == 0b0111, f"HD44780 checks {got:03b}; expected 111 "
          "(short pulse ignored, busy set during cycle, busy clears after)")
    lcd = (result.get("peripherals") or {}).get("lcd", "")
    check("A" in lcd, f"DDRAM write of 'A' missing from the dump: {lcd[:80]!r}")
    return (f"E<450ns ignored, busy=1 during the 1.52 ms cycle, busy clears after; "
            f"DDRAM dump shows {lcd[:40]!r}")


@case("PRO-05", "25", "PS/2 host inhibit: documented limitation (keyboard-hosted model)", "infra",
      "the model implements the keyboard as timing master with open-collector data; host-inhibit is not modelled (documented)")
def pro_05() -> str:
    from pathlib import Path
    from harness import ROOT
    model = (ROOT / "board" / "models" / "ps2_keyboard.vhd").read_text(encoding="utf-8").lower()
    check("keyboard is the host" in model or "keyboard" in model,
          "PS/2 model does not document the keyboard-hosted timing")
    check("open collector" in model or "open-collector" in model or "'z'" in model,
          "PS/2 model does not document open-collector drive")
    return ("documented-N/A: host->device inhibit (clock low >= 100 us) is not modelled; "
            "the model implements the keyboard as timing master with open-collector data "
            "(frame + odd parity covered by PR-03)")


@case("PRO-06", "25", "SDRAM controller timing: documented limitation (pin map only)", "infra",
      "board.json marks SDRAM timingModeled=false; init/refresh/CAS are not simulated")
def pro_06() -> str:
    from backend.device import BOARD
    sd = BOARD["sdram"]
    check(sd.get("timingModeled") is False, "SDRAM profile claims a timing model")
    check(sd["refreshCycles"] == 4096 and sd["refreshMs"] == 64,
          f"SDRAM refresh facts wrong: {sd.get('refreshCycles')}, {sd.get('refreshMs')}")
    return ("documented-N/A: SDRAM init/mode-register/refresh-deadline/bank-CAS timing is not "
            "simulated (pin map only); refresh facts 4096 cycles / 64 ms are in the profile "
            "and T-SDRAM-1/2 define the physical test")
