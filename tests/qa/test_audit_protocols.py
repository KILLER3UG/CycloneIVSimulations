"""Section 13: peripheral protocol models checked against their datasheets.

UART 8N1, I2C (AT24C08 + LM75), PS/2 frame format, VGA timing, HD44780 init,
NEC IR timing.  SDRAM and EPCS/JTAG have pin maps only (documented limits).
"""
from __future__ import annotations

from harness import case, check, errors_text, must_run, signal, value


def _falling_edges(result: dict, name: str) -> int:
    """Count 1->0 transitions of a captured signal ('H' counts as high)."""
    def level(v) -> int:
        if v in (1, "1", "H"):
            return 1
        return 0
    prev = 1
    edges = 0
    for _t, v in signal(result, name)["transitions"]:
        current = level(v)
        if prev == 1 and current == 0:
            edges += 1
        prev = current
    return edges


@case("PR-01", "13", "UART 8N1: baud, LSB-first data and stop bit", "VHDL",
      "0x55 frames decoded at 115200 baud (434 clocks at 50 MHz) within 1%")
def pr_01() -> str:
    result = must_run("board/uart_tx.vhd", duration=300_000, clockPeriod=20, resetCycles=0)
    uart = (result.get("peripherals") or {}).get("uart", {})
    frames = uart.get("frames", 0)
    check(frames >= 2, f"only {frames} frames decoded")
    check(all(b == 0x55 for b in uart.get("bytes", [])), f"bytes={uart.get('bytes')}")
    baud = int(uart.get("baud") or 0)
    check(abs(baud - 115200) / 115200 < 0.01, f"baud {baud} not within 1% of 115200")
    return f"{frames} frames of 0x55 at {baud} baud (design: 50 MHz / 434)"


@case("PR-02", "13", "LM75 registers: temp 0x1900, config 0x0000, Thyst 0x4B00, Tos 0x5000", "VHDL",
      "TEMP=0x1900 (25 C, 9-bit 0.5 C LSB), CONF=0x0000, THYST=0x4B00 (75 C), TOS=0x5000 (80 C)")
def pr_02() -> str:
    result = must_run("board/i2c_lm75_regs.vhd", duration=8_000_000, clockPeriod=10, resetCycles=0)
    temp = int(value(result, "TEMP"))
    conf = int(value(result, "CONF"))
    thyst = int(value(result, "THYST"))
    tos = int(value(result, "TOS"))
    check(temp == 0x1900, f"TEMP={temp:#06x}; expected 0x1900 for 25.0 C (9-bit, 0.5 C LSB)")
    check(conf == 0x0000, f"CONF={conf:#06x}; expected 0x0000 power-up default")
    check(thyst == 0x4B00, f"THYST={thyst:#06x}; expected 0x4B00 (75 C default)")
    check(tos == 0x5000, f"TOS={tos:#06x}; expected 0x5000 (80 C default)")
    return "LM75 registers: temp 0x1900, config 0x0000, Thyst 0x4B00, Tos 0x5000"


@case("PR-03", "13", "PS/2 frame: start=0, 8 data bits LSB first, odd parity, stop=1", "VHDL",
      "STATUS=0xF (parity/start/stop ok, >=2 frames); RESULT=0x5A (last byte)")
def pr_03() -> str:
    result = must_run("board/ps2_rx.vhd", duration=5_000_000, clockPeriod=10, resetCycles=0)
    status = int(value(result, "STATUS"))
    data = int(value(result, "RESULT"))
    check(status == 0xF, f"STATUS={status:01X}; parity/start/stop check failed")
    check(data == 0x5A, f"RESULT={data:#04x}; expected 0x5A")
    return "PS/2 frame format + odd parity verified; 0x5A decoded"


@case("PR-04", "13", "VGA 640x480@60: 525 hsync lines per vsync frame", "VHDL",
      "frame decoded; lines=525; colour samples present")
def pr_04() -> str:
    result = must_run("board/vga_bars.vhd", duration=35_000_000, clockPeriod=40, resetCycles=0)
    vga = (result.get("peripherals") or {}).get("vga", {})
    check(vga.get("frame") is True, f"no frame decoded: {vga}")
    check(vga.get("lines") == 525, f"lines={vga.get('lines')}; expected 525")
    check(bool(vga.get("samples")), "no colour samples decoded")
    return f"VGA frame decoded: {vga.get('lines')} lines, {len(vga.get('samples', {}))} samples"


@case("PR-05", "13", "HD44780: init sequence, E pulse and DDRAM addressing show HELLO", "VHDL",
      "lcd_state.txt dump contains HELLO on line 1")
def pr_05() -> str:
    result = must_run("board/lcd_hello.vhd", duration=50_000_000, clockPeriod=10, resetCycles=0)
    lcd = (result.get("peripherals") or {}).get("lcd", "")
    check("HELLO" in lcd, f"LCD dump missing HELLO: {lcd[:120]!r}")
    return "LCD model shows HELLO after the 8-bit init sequence"


@case("PR-06", "13", "NEC IR: 9 ms lead burst, 33 bursts, 560 us space for bit 0", "VHDL",
      "LEAD=90000 clocks, COUNT=33, SPACE1=5600 clocks at 100 ns (within 2%)")
def pr_06() -> str:
    result = must_run("board/ir_decode.vhd", duration=100_000_000, clockPeriod=100, resetCycles=0)
    lead = int(value(result, "LEAD"))
    count = int(value(result, "COUNT"))
    space1 = int(value(result, "SPACE1"))
    check(abs(lead - 90_000) / 90_000 < 0.02, f"LEAD={lead}; expected ~90000")
    check(count == 33, f"COUNT={count}; expected 33 bursts (lead + 32 data)")
    check(abs(space1 - 5_600) / 5_600 < 0.02, f"SPACE1={space1}; expected ~5600 (bit 0 = 560 us)")
    return f"NEC timing verified: lead {lead}, {count} bursts, bit-0 space {space1} clocks"


@case("PR-07", "13", "SDRAM: pin map verified; no timing model (documented limitation)", "infra",
      "pin map complete (41 pins), timingModeled=false, test defined for real hardware")
def pr_07() -> str:
    from backend.device import BOARD
    sd = BOARD["sdram"]
    pins = len(sd["DQ"]) + len(sd["A"]) + 13
    check(pins == 41, f"SDRAM pin count {pins}; expected 41 (16 DQ + 12 A + 13 control)")
    check(sd.get("timingModeled") is False, "SDRAM profile claims a timing model")
    return "SDRAM pin map verified; no timing/refresh model (T-SDRAM-1/2 on real hardware)"


@case("PR-08", "13", "EPCS16/JTAG: .sof volatile / .pof persistent documented; no model", "infra",
      "config semantics present; no programming model (documented limitation)")
def pr_08() -> str:
    from backend.device import BOARD
    config = BOARD["config"]
    check("volatile" in config["sof"], f"sof semantics: {config['sof']}")
    check("persistent" in config["pof"], f"pof semantics: {config['pof']}")
    check("EPCS16" in config["flash"], f"flash: {config['flash']}")
    return "EPCS16/JTAG semantics documented; no .sof/.pof programming model (external Quartus)"


# ---------------------------------------------------------------------------
# PR-09..PR-11: the two reference designs the first E2E inventory found
# missing - a UART echo (RX -> TX loopback) and the orphaned AT24C08 EEPROM
# master fixture wired into the full pipeline.  Expected values below are
# derived from the designs' source before the run (bit schedule analysis),
# not from observed output.
# ---------------------------------------------------------------------------

# 8N1 frame for 0x5A: idle, start, d0..d7 LSB first (0,1,0,1,1,0,1,0), stop.
_ECHO_FRAME = [1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1]


@case("PR-09", "13", "UART echo: a framed 8N1 byte into UART_RXD comes back on UART_TXD", "VHDL",
      "exactly 10 frames of 0x5A decoded on TXD at ~115200 baud (50 MHz/434); "
      "ECHO_COUNT=10, FRM_ERR=0, LED=0x5 (last echoed byte, active-low)")
def pr_09() -> str:
    # 11-bit frame at 434 clocks/bit, 20 ns clock: frames repeat every
    # 95480 ns; byte k is accepted at ~91310 + (k-1)*95480 ns and its echo
    # takes 86800 ns, so the 10th echo ends ~1037460 ns and the 11th byte
    # would be accepted at ~1046110 ns -> duration 1042000 ns captures
    # exactly 10 complete echoes and no partial (garbage) frame.
    result = must_run("board/uart_echo.vhd", duration=1_042_000, clockPeriod=20,
                      resetCycles=0,
                      stimuli=[{"port": "UART_RXD", "kind": "sequence",
                                "values": _ECHO_FRAME, "periodCycles": 434}])
    uart = (result.get("peripherals") or {}).get("uart", {})
    frames = uart.get("frames", 0)
    check(frames == 10, f"decoded {frames} frames; expected exactly 10 (one per received byte)")
    check(uart.get("bytes") == [0x5A] * 10, f"bytes={uart.get('bytes')}")
    baud = int(uart.get("baud") or 0)
    check(abs(baud - 115200) / 115200 < 0.01, f"baud {baud} not within 1% of 115200")
    echoed = int(value(result, "ECHO_COUNT"))
    check(echoed == 10, f"ECHO_COUNT={echoed}; expected 10 (the design's own count)")
    check(int(value(result, "FRM_ERR")) == 0, "FRM_ERR nonzero: clean frames were rejected")
    led = int(value(result, "LED"))
    check(led == 0x5, f"LED={led:01X}; expected 0x5 (0x5A low nibble 0xA, active-low)")
    return f"10x 0x5A echoed at {baud} baud; ECHO_COUNT=10, FRM_ERR=0, LED=0x5"


@case("PR-10", "13", "UART echo at the wrong baud: receiver rejects the frame, TX stays idle", "VHDL",
      "a 0x5A frame at 10x the bit time (11.52 kbaud into a 115.2 kbaud receiver) is never echoed: "
      "decode_uart(TXD) reports no bytes/no frames; ECHO_COUNT=0; FRM_ERR=4 "
      "(one framing error per low region of the foreign-baud stream)")
def pr_10() -> str:
    # Every data/stop sample lands 4400..82620 ns after a falling edge, i.e.
    # inside the triggering low region (regions are 86800 ns at 10x baud), so
    # each attempt assembles 0x00 with a low stop bit and is discarded: the
    # four low regions of the frame (start+d0, d2, d5, d7) give exactly
    # FRM_ERR=4 within the 1 ms capture (the 5th falls at 1041610 ns).
    result = must_run("board/uart_echo.vhd", duration=1_000_000, clockPeriod=20,
                      resetCycles=0,
                      stimuli=[{"port": "UART_RXD", "kind": "sequence",
                                "values": _ECHO_FRAME, "periodCycles": 4340}])
    uart = (result.get("peripherals") or {}).get("uart", {})
    check(uart.get("frames") == 0,
          f"frames={uart.get('frames')}; a locked receiver must not decode the echo")
    check(uart.get("bytes") == [], f"bytes={uart.get('bytes')}; TX must stay idle")
    check(int(value(result, "ECHO_COUNT")) == 0,
          "ECHO_COUNT nonzero: the wrong-baud byte was echoed")
    check(int(value(result, "FRM_ERR")) == 4,
          f"FRM_ERR={int(value(result, 'FRM_ERR'))}; expected 4 framing errors")
    return "wrong baud -> no echo (TXD idle, 0 bytes decoded); ECHO_COUNT=0, FRM_ERR=4"


@case("PR-11", "13", "EEPROM reference design (i2c_eeprom_test) runs its full I2C sequence vs the model", "VHDL",
      "master clocks the whole write+read sequence without hanging (65 SCL falling edges: write 28 + read 37); "
      "WP tied to VCC (board.json writeProtected) blocks the 0x5A write so the readback low nibble is 0 -> LED=0xF; "
      "model dump: size=1024, every cell still 00")
def pr_11() -> str:
    # The auto testbench instantiates the AT24C08 with wp => '1' (derived from
    # board.json writeProtected=true - the real U8 pin 7 is tied to VCC), so
    # the design's data byte is NACKed and never programs the array.  The
    # case proves the DESIGN's master sequence runs clean (START/ACK/STOP,
    # both directions, no bus wedge) and that reads return the un-programmed
    # cell - exactly the write-protected behaviour of the real board.
    #
    # Falling-edge derivation (verified against instrumented call counters):
    # scl_low is called 68 times, and exactly 3 land on an already-low line
    # (write STOP, rep-START's first, read STOP) -> 65 edges:
    #   write 28 = START fall + 3 bytes x (8 data + 1 ACK) clocks
    #   read  37 = START fall + 3 bytes x 9 + rep-START fall + 8 read clocks
    result = must_run("board/i2c_eeprom_test.vhd", duration=8_000_000, resetCycles=0)
    falls = _falling_edges(result, "I2C_SCL_bus")
    check(falls == 65,
          f"I2C_SCL falling edges = {falls}; expected 65 (write phase 28 + read phase 37: "
          "START + 3x9 ACK-clocked bytes each phase, + rep-START and 8 read clocks)")
    led = int(value(result, "LED"))
    check(led == 0xF,
          f"LED={led:01X}; expected 0xF (readback low nibble 0x0 - a successful write of 0x5A "
          "would show ~0xA = 0x5)")
    dump = (result.get("peripherals") or {}).get("eeprom", "")
    check("size=1024" in dump, f"no/short EEPROM model dump: {dump[:80]!r}")
    tokens = dump.split("\n", 1)[1].split()
    # The model dumps the FULL 1 KiB array (at24c08.vhd dump_proc loops
    # i in 0 to MEM_BYTES-1 = 0..1023, 16 bytes per line).
    check(len(tokens) == 1024 and set(tokens) == {"00"},
          "EEPROM dump is not uniformly 00: the write-protected cell changed "
          f"({len(tokens)} tokens, {sorted(set(tokens))[:4]}...)")
    return ("I2C master sequence clean (65 SCL falls, no hang); write blocked by WP "
            "(readback 0x00 -> LED=0xF); dump size=1024, all 1024 bytes 00")
