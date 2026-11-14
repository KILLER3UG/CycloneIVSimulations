"""Section 26: time scaling — protocol rates must scale with the clock period.

When the simulated clock period doubles, every derived rate (UART baud,
buzzer frequency, VGA line rate, 7-segment scan rate) must halve, and the
reported timeScale factor must be accurate.
"""
from __future__ import annotations

from harness import case, check, errors_text, must_run, run_text, signal, value


@case("TSC-01", "26", "The reported time scale factor is accurate", "VHDL",
      "timeScale.simClockHz = 1e9/clockPeriod and scale = simClockHz/boardClockHz")
def tsc_01() -> str:
    src = ("library ieee; use ieee.std_logic_1164.all; "
           "entity scale_probe is port (clk : in std_logic; y : out std_logic); "
           "end entity; architecture rtl of scale_probe is begin y <= '0'; end architecture;")
    for period, sim_hz, scale in ((10.0, 100_000_000, 2.0), (20.0, 50_000_000, 1.0),
                                  (40.0, 25_000_000, 0.5)):
        result = run_text(src, top="scale_probe", duration=100, clockPeriod=period, resetCycles=0)
        check(result.get("ok"), f"simulation failed: {errors_text(result)}")
        ts = result.get("timeScale") or {}
        check(ts.get("simClockHz") == sim_hz, f"period {period}: simClockHz={ts.get('simClockHz')}; expected {sim_hz}")
        check(abs((ts.get("scale") or 0) - scale) < 1e-9, f"period {period}: scale={ts.get('scale')}; expected {scale}")
        check(ts.get("boardClockHz") == 50_000_000, "boardClockHz must come from the board profile")
    return "timeScale reported accurately for 10/20/40 ns clock periods (scale 2.0/1.0/0.5)"


@case("TSC-02", "26", "UART baud scales with the clock period", "VHDL",
      "the same BAUD_DIV design decodes ~115200 baud at 20 ns and ~57600 baud at 40 ns")
def tsc_02() -> str:
    from harness import run
    bauds = []
    for period in (20.0, 40.0):
        result = run("board/uart_tx.vhd", duration=400_000, clockPeriod=period, resetCycles=0)
        check(result.get("ok"), f"simulation failed at {period} ns: {errors_text(result)}")
        uart = (result.get("peripherals") or {}).get("uart", {})
        baud = int(uart.get("baud") or 0)
        check(baud > 0, f"no UART frames decoded at {period} ns: {uart}")
        bauds.append(baud)
    ratio = bauds[0] / bauds[1]
    check(abs(ratio - 2.0) < 0.05, f"baud ratio {ratio:.3f}; expected 2.0 when the period doubles")
    check(abs(bauds[0] - 115_200) / 115_200 < 0.01, f"20 ns baud {bauds[0]} not ~115200")
    return f"UART decoded {bauds[0]} baud at 20 ns and {bauds[1]} baud at 40 ns (ratio {ratio:.2f})"


@case("TSC-03", "26", "Buzzer frequency scales with the clock period", "VHDL",
      "the same divider design decodes ~1 MHz at 10 ns and ~500 kHz at 20 ns")
def tsc_03() -> str:
    from backend.peripherals import decode_buzzer
    from harness import run
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
            if cnt = 49 then
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
    freqs = []
    for period in (10.0, 20.0):
        result = run_text(src, top="buzzer_square", duration=60_000, clockPeriod=period, resetCycles=0)
        check(result.get("ok"), f"simulation failed at {period} ns: {errors_text(result)}")
        trans = signal(result, "FPGA_BUZZER")["transitions"]
        decoded = decode_buzzer(trans)
        freq = int(decoded.get("frequency") or 0)
        check(freq > 0, f"no tone decoded at {period} ns: {decoded}")
        freqs.append(freq)
    ratio = freqs[0] / freqs[1]
    check(abs(ratio - 2.0) < 0.02, f"buzzer frequency ratio {ratio:.3f}; expected 2.0")
    return f"buzzer decoded {freqs[0]} Hz at 10 ns and {freqs[1]} Hz at 20 ns (ratio {ratio:.2f})"


@case("TSC-04", "26", "VGA line timing scales with the clock period", "VHDL",
      "the hsync line period doubles when the pixel clock period doubles (800 pixels/line)")
def tsc_04() -> str:
    from harness import run
    periods = []
    for clock in (40.0, 80.0):
        result = run("board/vga_bars.vhd", duration=6_000_000, clockPeriod=clock, resetCycles=0)
        check(result.get("ok"), f"simulation failed at {clock} ns: {errors_text(result)}")
        hs = signal(result, "VGA_HSYNC")["transitions"]
        falls = [hs[i][0] for i in range(1, len(hs)) if hs[i - 1][1] in ("1", 1) and hs[i][1] in ("0", 0)]
        check(len(falls) >= 4, f"only {len(falls)} hsync pulses at {clock} ns")
        spans = [b - a for a, b in zip(falls, falls[1:])][:3]
        avg = sum(spans) / len(spans)
        periods.append(avg)
    ratio = periods[1] / periods[0]
    check(abs(ratio - 2.0) < 0.01, f"hsync period ratio {ratio:.3f}; expected 2.0")
    check(abs(periods[0] - 800 * 40.0) / (800 * 40.0) < 0.02,
          f"hsync period {periods[0]:.0f} ns; expected ~{800 * 40.0} (800 pixels at 40 ns)")
    return f"VGA line period {periods[0]:.0f} ns at 40 ns clock vs {periods[1]:.0f} ns at 80 ns (ratio {ratio:.2f})"


@case("TSC-05", "26", "7-segment scan rate scales with the clock period", "VHDL",
      "the digit-select toggle period doubles when the clock period doubles")
def tsc_05() -> str:
    design = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity seg_scan_probe is
    port (clk : in std_logic; DIG : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of seg_scan_probe is
    signal digit : natural range 0 to 3 := 0;
begin
    process (clk)
        variable cnt : natural := 0;
    begin
        if rising_edge(clk) then
            if cnt = 1 then
                cnt := 0;
                digit <= (digit + 1) mod 4;
            else
                cnt := cnt + 1;
            end if;
        end if;
    end process;
    DIG <= "1110" when digit = 0 else "1101" when digit = 1 else "1011" when digit = 2 else "0111";
end architecture;
"""
    toggles = []
    for period in (10.0, 20.0):
        result = run_text(design, top="seg_scan_probe", duration=4000, clockPeriod=period, resetCycles=0)
        check(result.get("ok"), f"simulation failed at {period} ns: {errors_text(result)}")
        dig = signal(result, "DIG")["transitions"]
        check(len(dig) >= 6, f"too few DIG transitions at {period} ns: {len(dig)}")
        spans = [b[0] - a[0] for a, b in zip(dig, dig[1:]) if b[0] > a[0]]
        steady = spans[1:] if len(spans) > 1 else spans  # skip the startup phase
        avg = sum(steady) / len(steady)
        toggles.append(avg)
    ratio = toggles[1] / toggles[0]
    check(abs(ratio - 2.0) < 0.01, f"scan toggle ratio {ratio:.3f}; expected 2.0")
    check(abs(toggles[0] - 20.0) < 0.5, f"scan toggle {toggles[0]:.1f} ns at 10 ns clock; expected 20 ns (2 clocks)")
    return f"7-seg digit toggle {toggles[0]:.1f} ns at 10 ns clock vs {toggles[1]:.1f} ns at 20 ns (ratio {ratio:.2f})"
