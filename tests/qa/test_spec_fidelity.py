"""Section 8: simulator fidelity against the RECONCILED board spec.

Every case here is derived from board/board_spec.md (the reconciled version,
tagged VERIFIED/INFERRED/UNVERIFIED from the schematic) or from the vendor
pin file board/vendor/Pinos_RZEasyFPGA.txt.
"""
from __future__ import annotations

import re
from pathlib import Path

from harness import (
    case,
    check,
    errors_text,
    must_run,
    run,
    run_text,
    signal,
    value,
)

ROOT = Path(__file__).resolve().parent.parent.parent
VENDOR_PINS = ROOT / "board" / "vendor" / "Pinos_RZEasyFPGA.txt"


# ---------------------------------------------------------------------------
# SPEC-01: clock 23 / reset 25, active low (board_spec.md §0a, §3)
# ---------------------------------------------------------------------------

RESET_CHECK = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity board_reset_check is
    port (CLOCK_50 : in  std_logic;
          FPGA_RST : in  std_logic;
          LED      : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of board_reset_check is
    signal c : unsigned(7 downto 0) := (others => '0');
begin
    process (CLOCK_50, FPGA_RST)
    begin
        if FPGA_RST = '0' then
            c <= (others => '0');
        elsif rising_edge(CLOCK_50) then
            c <= c + 1;
        end if;
    end process;
    LED <= std_logic_vector(c(7 downto 4));
end architecture;
"""


@case("SPEC-01", "8", "Clock = pin 23, RESET key = pin 25 active-low (schematic §0a)", "VHDL",
      "board map pins CLOCK_50->23, FPGA_RST->25, resetActiveHigh=False; counter runs after release")
def spec_01() -> str:
    result = run_text(RESET_CHECK, top="board_reset_check", duration=2000,
                      clockPeriod=10, resetCycles=2, resetActiveHigh=False)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    board = result["board"]
    check(board.get("reset") == "FPGA_RST", f"reset port detected as {board.get('reset')!r}")
    check(board.get("resetActiveHigh") is False, f"resetActiveHigh={board.get('resetActiveHigh')!r}")
    pins = board.get("pins", {})
    check(pins.get("CLOCK_50") == ["PIN_23"], f"CLOCK_50 pins {pins.get('CLOCK_50')}")
    check(pins.get("FPGA_RST") == ["PIN_25"], f"FPGA_RST pins {pins.get('FPGA_RST')}")
    got = int(value(result, "LED"))
    check(got == 0xC, f"LED={got:X} (expected C: counter freed after 2 low reset cycles)")
    return "reset=PIN_25 active-low, clk=PIN_23; counter counts once released"


# ---------------------------------------------------------------------------
# SPEC-02: keys and DIP share nets 88-91, active low (board_spec.md §0b, §4)
# ---------------------------------------------------------------------------

KEY_CHECK = """
library ieee;
use ieee.std_logic_1164.all;
entity board_key_check is
    port (KEY : in  std_logic_vector(3 downto 0);
          LED : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of board_key_check is
begin
    LED <= KEY;
end architecture;
"""


@case("SPEC-02", "8", "KEY/DIP shared nets 88-91, active-low profile", "VHDL",
      "board.buttons.pins=PIN_88..91, switches share the KEY port, drive passes through")
def spec_02() -> str:
    from backend.device import BOARD
    check(BOARD["switches"]["sharedWithButtons"] is True, "DIP not marked shared with keys")
    check(BOARD["switches"]["pins"] == BOARD["buttons"]["pins"] == ["PIN_88", "PIN_89", "PIN_90", "PIN_91"],
          "key/DIP pins wrong")
    check(BOARD["buttons"]["activeLow"] is True and BOARD["switches"]["onValue"] == 0,
          "key/DIP polarity wrong")
    result = run_text(KEY_CHECK, top="board_key_check", duration=20, resetCycles=0,
                      constantInputs={"KEY": 0b0101})
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    board = result["board"]
    check(board.get("buttons") == ["KEY"], f"buttons={board.get('buttons')}")
    check(board.get("switches") == ["KEY"], f"switches={board.get('switches')} (DIP must share KEY)")
    check(int(value(result, "LED")) == 0b0101, "KEY drive did not pass to LED")
    return "DIP shares KEY nets 88-91; levels pass through"


# ---------------------------------------------------------------------------
# SPEC-03: 7-segment map and pin order (board_spec.md §5)
# ---------------------------------------------------------------------------


@case("SPEC-03", "8", "SEG bit map and SEG/DIG pins match the schematic sheet", "VHDL",
      "SEG0=a..SEG7=dp; SEG pins 128,121,125,129,132,126,124,127; DIG 133,135,136,137")
def spec_03() -> str:
    from backend.device import BOARD, SEG_BIT_MAP
    check(SEG_BIT_MAP == {"a": 0, "b": 1, "c": 2, "d": 3, "e": 4, "f": 5, "g": 6, "dp": 7},
          f"SEG_BIT_MAP={SEG_BIT_MAP}")
    disp = BOARD["displays"]
    check(disp["pins"]["SEG"] == ["PIN_128", "PIN_121", "PIN_125", "PIN_129",
                                  "PIN_132", "PIN_126", "PIN_124", "PIN_127"],
          f"SEG pins {disp['pins']['SEG']}")
    check(disp["pins"]["DIG"] == ["PIN_133", "PIN_135", "PIN_136", "PIN_137"],
          f"DIG pins {disp['pins']['DIG']}")
    check(disp["segmentActiveLow"] and disp["digitActiveLow"] and disp["multiplexed"],
          "7-seg polarity/multiplex flags wrong")
    check(BOARD["leds"]["pins"] == ["PIN_87", "PIN_86", "PIN_85", "PIN_84"]
          and BOARD["leds"]["activeLow"] is True, "LED pins/polarity wrong")
    return "SEG/DIG map + LED pins verified against the schematic"


# ---------------------------------------------------------------------------
# SPEC-04/05: buzzer drive (passive, active-low) on pin 110 (board_spec.md §6)
# ---------------------------------------------------------------------------


@case("SPEC-04", "8", "Buzzer toggling produces a decoded tone on FPGA_BUZZER", "VHDL",
      "buzzer_tone at 10 ns clock -> ~2 kHz square wave decoded from pin 110")
def spec_04() -> str:
    result = must_run("board/buzzer_tone.vhd", duration=1_500_000, clockPeriod=10, resetCycles=0)
    buzzer = (result.get("peripherals") or {}).get("buzzer", {})
    check(buzzer.get("tone") is True, f"no tone decoded: {buzzer}")
    freq = int(buzzer.get("frequency", 0))
    check(1500 <= freq <= 2500, f"frequency {freq} Hz out of range")
    return f"tone decoded at {freq} Hz (passive drive model)"


@case("SPEC-05", "8", "Buzzer idle high stays silent; type flagged unverified in the UI notes", "VHDL",
      "constant 1 on FPGA_BUZZER decodes as no tone; model note says 'unverified on real hardware'")
def spec_05() -> str:
    from backend.device import DEVICE
    idle = """
library ieee;
use ieee.std_logic_1164.all;
entity buzzer_idle is
    port (FPGA_BUZZER : out std_logic);
end entity;
architecture rtl of buzzer_idle is
begin
    FPGA_BUZZER <= '1';   -- idle = silent (active-low drive)
end architecture;
"""
    result = run_text(idle, top="buzzer_idle", duration=1000, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    buzzer = (result.get("peripherals") or {}).get("buzzer", {})
    check(buzzer.get("tone") is False, f"idle line decoded as tone: {buzzer}")
    notes = DEVICE().get("modelNotes", [])
    buzzer_notes = [n for n in notes if n.get("topic") == "Buzzer"]
    check(bool(buzzer_notes), "no buzzer model note exposed")
    check("unverified" in buzzer_notes[0].get("status", "").lower(),
          f"buzzer note not marked unverified: {buzzer_notes}")
    return "idle = silent; UI note carries the unverified-on-hardware flag"


# ---------------------------------------------------------------------------
# SPEC-06: EEPROM write-protected (WP->VCC) on its own bus (§0c/§0d)
# ---------------------------------------------------------------------------


@case("SPEC-06", "8", "AT24C08 write is blocked (WP tied to VCC) on the I2C_SCL/SDA bus", "VHDL",
      "write 0x5A to addr 0 is refused; readback stays 0x00; LM75 address NACKs on this bus")
def spec_06() -> str:
    result = must_run("board/i2c_eeprom_wp.vhd", duration=8_000_000, resetCycles=0)
    got = int(value(result, "RESULT"))
    check(got == 0x00, f"EEPROM readback = 0x{got:02X} — the blocked write was NOT blocked!")
    probe = int(value(result, "PROBE"))
    check(probe & 1 == 1, f"LM75 probe ack={probe} — LM75 must not answer on the EEPROM bus")
    dump = (result.get("peripherals") or {}).get("eeprom", "")
    check(dump != "", "no EEPROM dump produced")
    check("5a" not in dump.lower(), "0x5A found in the EEPROM dump — write went through")
    return "write blocked (readback 0x00, no 0x5A in dump); LM75 absent from this bus"


@case("SPEC-07", "8", "LM75 answers on its own bus (FPGA_SCL/SDA = 112/113) at 0x48", "VHDL",
      "temperature register reads 0x1900 (25.0 C, 9-bit 0.5 C LSB); EEPROM address NACKs on this bus")
def spec_07() -> str:
    result = must_run("board/i2c_lm75_read.vhd", duration=3_000_000, resetCycles=0)
    got = int(value(result, "RESULT"))
    check(got == 0x1900, f"LM75 temp register = 0x{got:04X} (expected 0x1900 for 25.0 C)")
    probe = int(value(result, "PROBE"))
    check(probe & 1 == 1, f"EEPROM probe ack={probe} — EEPROM must not answer on the LM75 bus")
    return "LM75 read 0x1900 on pins 112/113; EEPROM absent from this bus"


# ---------------------------------------------------------------------------
# SPEC-08: bus topology detection (board_detect) — the two-bus fix
# ---------------------------------------------------------------------------


@case("SPEC-08", "8", "board_detect attaches EEPROM and LM75 to their own buses", "infra",
      "I2C_* ports -> i2c_eeprom model; FPGA_* ports -> i2c_lm75 model; generic SCL/SDA -> EEPROM bus")
def spec_08() -> str:
    from backend.board_detect import board_models, model_files
    from backend.vhdl_parser import VHDLParser
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity both_buses is
    port (I2C_SCL, I2C_SDA : inout std_logic;
          FPGA_SCL, FPGA_SDA : inout std_logic);
end entity;
architecture rtl of both_buses is
begin
end architecture;
"""
    entity = VHDLParser().parse(src).entities[0]
    models = board_models(entity)
    kinds = {m["kind"]: m for m in models}
    check("i2c_eeprom" in kinds and "i2c_lm75" in kinds, f"models={list(kinds)}")
    check(kinds["i2c_eeprom"]["scl"] == "I2C_SCL" and kinds["i2c_eeprom"]["sda"] == "I2C_SDA",
          f"eeprom bus on {kinds['i2c_eeprom']['scl']}/{kinds['i2c_eeprom']['sda']}")
    check(kinds["i2c_lm75"]["scl"] == "FPGA_SCL" and kinds["i2c_lm75"]["sda"] == "FPGA_SDA",
          f"lm75 bus on {kinds['i2c_lm75']['scl']}/{kinds['i2c_lm75']['sda']}")
    files = model_files(models)
    check(files == ["board/models/at24c08.vhd", "board/models/lm75.vhd"], f"files={files}")
    # generic SCL/SDA names (no board I2C_* names) fall back to the EEPROM bus
    only_generic = """
library ieee;
use ieee.std_logic_1164.all;
entity generic_bus is
    port (SCL, SDA : inout std_logic);
end entity;
architecture rtl of generic_bus is
begin
end architecture;
"""
    entity2 = VHDLParser().parse(only_generic).entities[0]
    models2 = board_models(entity2)
    check([m["kind"] for m in models2] == ["i2c_eeprom"], f"generic-name models={[m['kind'] for m in models2]}")
    return "EEPROM on 99/98 bus, LM75 on 112/113 bus, generic names -> EEPROM bus"


# ---------------------------------------------------------------------------
# SPEC-09: UART / VGA decode on the board pins (§7/§8)
# ---------------------------------------------------------------------------


@case("SPEC-09", "8", "UART frames from UART_TXD (114) decode at the design's rate", "VHDL",
      "0x55 ('U') bytes decoded from the MAX3232 TX path")
def spec_09() -> str:
    result = must_run("board/uart_tx.vhd", duration=300_000, clockPeriod=10, resetCycles=0)
    uart = (result.get("peripherals") or {}).get("uart", {})
    frames = uart.get("frames", 0)
    check(frames >= 2, f"only {frames} UART frames decoded")
    check(all(b == 0x55 for b in uart.get("bytes", [])), f"bytes={uart.get('bytes')}")
    return f"{frames} frames of 0x55 decoded, baud~{uart.get('baud')} (sim clock)"


@case("SPEC-10", "8", "VGA sync + 1-bit RGB decode into a frame", "VHDL",
      "640x480@60: 525 hsync pulses per vsync frame, colour bars sampled")
def spec_10() -> str:
    result = must_run("board/vga_bars.vhd", duration=35_000_000, clockPeriod=40, resetCycles=0)
    vga = (result.get("peripherals") or {}).get("vga", {})
    check(vga.get("frame") is True, f"no VGA frame decoded: {vga}")
    check(vga.get("lines") == 525, f"hsync lines per frame = {vga.get('lines')} (expected 525)")
    return f"frame decoded, {vga.get('lines')} hsync lines"


# ---------------------------------------------------------------------------
# SPEC-11: device variants + GPIO count (board_spec.md §0g/§1)
# ---------------------------------------------------------------------------


@case("SPEC-11", "8", "Device profile: 91 user I/O, both trainer chips selectable", "infra",
      "EP4CE6E22C8N and EP4CE10E22C8N both report 91 user I/O and the handbook resources")
def spec_11() -> str:
    from backend.device import DEVICES
    check(DEVICES["ep4ce6"]["userIo"] == 91, f"ep4ce6 userIo={DEVICES['ep4ce6']['userIo']}")
    check(DEVICES["ep4ce10"]["userIo"] == 91, f"ep4ce10 userIo={DEVICES['ep4ce10']['userIo']}")
    check(DEVICES["ep4ce6"]["logicElements"] == 6272 and DEVICES["ep4ce6"]["m9kBlocks"] == 30,
          "EP4CE6 resources wrong")
    check(DEVICES["ep4ce10"]["logicElements"] == 10320 and DEVICES["ep4ce10"]["m9kBlocks"] == 46,
          "EP4CE10 resources wrong")
    return "91 user I/O on both variants; resources match the handbook"


# ---------------------------------------------------------------------------
# SPEC-12: the whole vendor pin file matches the simulator profile
# ---------------------------------------------------------------------------


@case("SPEC-12", "8", "Every pin in vendor/Pinos_RZEasyFPGA.txt matches the profile", "infra",
      "clock/reset/keys/LED/SEG/DIG/SDRAM/VGA/PS2/UART/I2C/IR/buzzer/LCD pins all agree")
def spec_12() -> str:
    from backend.device import BOARD
    vendor: dict[str, str] = {}
    for line in VENDOR_PINS.read_text(encoding="utf-8").splitlines():
        m = re.match(r"set_location_assignment\s+PIN_(\d+)\s+-to\s+(\S+)", line.strip())
        if m:
            vendor[m.group(2)] = f"PIN_{m.group(1)}"
    check(len(vendor) >= 80, f"only {len(vendor)} pins parsed from the vendor file")
    expect = {
        "FPGA_CLK": BOARD["clockPin"], "FPGA_RST": BOARD["resetPin"],
        "FPGA_BUZZER": BOARD["buzzer"]["FPGA_BUZZER"], "IR": BOARD["infrared"]["IR"],
        "UART_TXD": BOARD["uart"]["UART_TXD"], "UART_RXD": BOARD["uart"]["UART_RXD"],
        "PS_CLOCK": BOARD["ps2"]["PS_CLOCK"], "PS_DATA": BOARD["ps2"]["PS_DATA"],
        "I2C_SCL": BOARD["i2c"]["I2C_SCL"], "I2C_SDA": BOARD["i2c"]["I2C_SDA"],
        "FPGA_SCL": BOARD["i2c"]["FPGA_SCL"], "FPGA_SDA": BOARD["i2c"]["FPGA_SDA"],
        "VGA_R": BOARD["vga"]["VGA_R"], "VGA_G": BOARD["vga"]["VGA_G"],
        "VGA_B": BOARD["vga"]["VGA_B"], "VGA_HSYNC": BOARD["vga"]["VGA_HSYNC"],
        "VGA_VSYNC": BOARD["vga"]["VGA_VSYNC"],
    }
    for i in range(4):
        expect[f"KEY[{i}]"] = BOARD["buttons"]["pins"][i]
        expect[f"LED[{i}]"] = BOARD["leds"]["pins"][i]
        expect[f"DIG[{i}]"] = BOARD["displays"]["pins"]["DIG"][i]
    for i in range(8):
        expect[f"SEG[{i}]"] = BOARD["displays"]["pins"]["SEG"][i]
    for i in range(16):
        expect[f"SDRAM_DQ[{i}]"] = BOARD["sdram"]["DQ"][i]
    for i in range(12):
        expect[f"SDRAM_A[{i}]"] = BOARD["sdram"]["A"][i]
    expect.update({"SDRAM_CKE": BOARD["sdram"]["CKE"], "SDRAM_CLK": BOARD["sdram"]["CLK"],
                   "SDRAM_CS": BOARD["sdram"]["CS"], "SDRAM_RAS": BOARD["sdram"]["RAS"],
                   "SDRAM_CAS": BOARD["sdram"]["CAS"], "SDRAM_WE": BOARD["sdram"]["WE"],
                   "SDRAM_BS[0]": BOARD["sdram"]["BS0"], "SDRAM_BS[1]": BOARD["sdram"]["BS1"],
                   "LDQM": BOARD["sdram"]["LDQM"], "UDQM": BOARD["sdram"]["UDQM"]})
    lcd = {"LCD_RS": BOARD["lcd"]["LCD_RS"], "LCD_RW": BOARD["lcd"]["LCD_RW"],
           "LCD_E": BOARD["lcd"]["LCD_E"], "LCD_D[0]": BOARD["lcd"]["LCD_D0"],
           "LCD_D[1]": BOARD["lcd"]["LCD_D1"], "LCD_D[2]": BOARD["lcd"]["LCD_D2"],
           "LCD_D[3]": BOARD["lcd"]["LCD_D3"], "LCD_D[4]": BOARD["lcd"]["LCD_D4"],
           "LCD_D[5]": BOARD["lcd"]["LCD_D5"], "LCD_D[6]": BOARD["lcd"]["LCD_D6"],
           "LCD_D[7]": BOARD["lcd"]["LCD_D7"]}
    expect.update(lcd)
    bad = {name: (pin, expect[name]) for name, pin in vendor.items()
           if name in expect and expect[name] != pin}
    check(not bad, f"profile mismatches vs vendor file: {bad}")
    missing = [name for name in vendor if name not in expect]
    check(not missing, f"vendor pins missing from the profile: {missing}")
    return f"all {len(vendor)} vendor pins match the simulator profile"
