# RZ-EasyFPGA A2.2 — Board Specification (Ground Truth, reconciled)

School trainer board: "Altera Cyclone IV EP4CE6/EP4CE10 NIOS II FPGA Development
Board" (21 × 15 × 11 cm, 5 V supply, USB Blaster included).

**Chip (confirmed by user + vendor schematic + vendor .qsf):** `EP4CE6E22C8N`
(Cyclone IV E, EQFP-144, speed grade 8).

## Tag legend

Every factual row below carries one tag:

* **VERIFIED** — read directly from the vendor schematic / vendor files; the
  sheet reference is given. No interpretation needed.
* **INFERRED** — deduced from verified evidence; the reasoning is stated.
* **UNVERIFIED** — cannot be proven from the available documents; needs a
  physical check on the real board (test defined in `real_board_results.md`).

Reference keys:

| Key | Source |
| --- | --- |
| SCH | `schematic/Diagrama_Esquematico_RZ-EasyFPGA.pdf`, sheet 1/1 ("助学FPGA开发板.Sch", 2014-12-09) — the single main sheet |
| AMP1 / AMP4 / AMP5 | `schematic/Esquemas_Eletricos_Ampliados.pdf` enlargement pages (AMP1 = power/clock/reset/PS2/buzzer/RS232/IR/JTAG-AS/VGA; AMP4/AMP5 = FPGA chip) |
| CROP-* | zoomed crops of the main sheet under `schematic/pages/` (`crop_reset_clk`, `crop_leds_dip`, `crop_sevenseg`, `crop_rs232`, `crop_ps2_eep`, `crop_buzzer_ir`, `crop_power`, `crop_jtag`, `crop_lcd`, `zoom_*`) |
| PIN | `vendor/Pinos_RZEasyFPGA.txt` (kit pin-assignment file) |
| INST | `vendor/instructor_pin_table.png` (instructor table, `fpga_pin_map`) |
| QSF | `vendor/examples/*/*.qsf` (my_and, key_led, ckey_led, led_twinkle) |
| DS | component datasheet (Cyclone IV handbook, AT24C08, LM75) |

Pin numbers are **EQFP144 package pins** (silkscreened on the board and printed
in the instructor table). Never reuse pins from other boards.

## 0. Reconciliation findings (questions a–g, resolved)

**a. RESET key net/pin — VERIFIED.** The RESET key (silk "RESET") shorts the
`RESET` net to GND; `RESET` has R2 10 kΩ pull-up to 3.3 V and C10 100 nF to
GND (~1 ms RC), and lands on FPGA **pin 25** (bank symbol U5I: CLK3/DIFFCLK_1n).
Cross-checked: PIN `PIN_25 -to FPGA_RST` [PIN], "FPGA_RESET 25" [INST].
Active-low: pressed = 0, released = 1. [SCH, CROP-reset_clk, PIN, INST]

**b. Resistor designators — VERIFIED; the old spec's "R46–R49 for DIP
pull-ups" was WRONG (that was the collision).** Real topology, read from the
zoomed Botões/DIP and Display sheets [CROP-leds_dip, CROP-sevenseg, SCH]:

| Function | Designators | Value / wiring |
| --- | --- | --- |
| Key series resistors | **R34–R37** | 220 Ω, FPGA pin → node → key S1–S4 → GND |
| Key pull-ups | **R38–R41** | 10 kΩ from 3.3 V to each KEY net |
| DIP pull-ups | **R42–R45** | 10 kΩ from 3.3 V to each DIP-wired KEY net |
| 7-seg digit base resistors | **R46–R49** | 10 kΩ, DIG1→R49, DIG2→R48, DIG3→R47, DIG4→R46, into Q1–Q4 8550 bases |
| 7-seg segment resistors | **R50–R57** | 220 Ω (SEG4→R50, SEG3→R51, SEG0→R52, SEG7→R53, SEG5→R54, SEG2→R55, SEG6→R56, SEG1→R57) |
| LED resistors | R30–R33 | 470 Ω in each LED cathode |

So: keys and DIP each have their own 10 kΩ pull-up group in parallel on the
same four nets (KEY1–KEY4); the digit base resistors are R46–R49. No
designator is used twice on the sheet.

**c. I2C buses — VERIFIED: TWO SEPARATE buses.**
EEPROM AT24C08 (U8) sits on `I2C_SCL` = **99** / `I2C_SDA` = **98** with
pull-ups R25/R26 5.1 kΩ → 3.3 V. LM75 (U9) sits on `FPGA_SCL` = **112** /
`FPGA_SDA` = **113** with pull-ups R27/R28 5.1 kΩ → 3.3 V. Different FPGA pins
and separate pull-up pairs → two independent buses; a design must bit-bang
them separately. [SCH, CROP-ps2_eep, PIN, INST]

**d. AT24C08 WP pin — VERIFIED: tied to VCC (3.3 V).** Zoomed sheet shows
U8 pin 7 (WP) tied to the same 3.3 V node as pin 8 (VCC); A2/A1/A0 (pins 1–3)
tie to GND → device address **0x50**. Consequence: **on real hardware the
EEPROM is permanently write-protected — reads work, writes are blocked**
(AT24C08 datasheet: WP high inhibits write). The simulator must model this
and label it. [SCH, CROP-ps2_eep (zoom_eep), DS]

**e. DB9 RS232 wiring — VERIFIED, and it MISMATCHES the standard.**
MAX3232E U4: `UART_TXD` = 114 → T1IN(11) → T1OUT(14) → **DB9 pin 7**;
`UART_RXD` = 115 ← R1OUT(12) ← R1IN(13) ← **DB9 pin 8**; GND = **DB9 pin 5**.
A standard PC (DTE) DB9 has RXD = pin 2, TXD = pin 3, GND = pin 5. So with a
straight-through cable the board's TX lands on the PC's RTS (7) and the
board's RX listens on CTS (8) — **communication fails**. A crossover adapter
(board 7 → PC 2, board 8 → PC 3, 5 ↔ 5) is required. [SCH, CROP-rs232, AMP1]

**f. Buzzer type — drive circuit VERIFIED, part type UNVERIFIED.** The sheet
shows a 2-terminal "SPEAKER" (SP) fed from an 8550 PNP high-side switch
(BEEP → R18 2 kΩ → base; R17 10 kΩ pull-up on BEEP to 3.3 V; R19 33 Ω emitter
to 3.3 V). No on-board oscillator → the FPGA must toggle the pin to make
sound, and **ON = BEEP = 0**, idle = 1 (silent). Whether the fitted part is an
active (self-oscillating) buzzer or a passive speaker **cannot be proven from
the schematic** → UNVERIFIED. Physical test: see `real_board_results.md`
(T-BUZZER-1). [SCH, CROP-buzzer_ir, AMP1]

**g. GPIO count — VERIFIED: 91 user I/O; "92" was a miscount.** The Cyclone IV
handbook gives 91 user I/O for the E144 package [DS]. The schematic's bank
symbols U5A–U5I list exactly 91 I/O-capable pins (bank 1 = pins 1, 2, 3, 6, 7,
8, 10, 11, 13 — pins 2/3 are easy to miss in text extraction). All 91 are
used/brought out: 86 to on-board peripherals (incl. clock 23, reset 25), pins
6/8/13 to the EPCS16 config flash (ASDO/nCSO/DATA0) and AS header, and pins
24 → P1.34, 111 → P1.2 as free GPIO on the P1 header. **There is no 92nd GPIO
pin.** (Likely source of the old "92": CONF_DONE is literally package pin 92 —
a dedicated output, not user I/O.) [SCH, CROP-leds_dip (P1 zoom), DS]

## 1. Device

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Family / part | Cyclone IV E, **EP4CE6E22C8N** (marking EP4CE6E22C8N; Quartus device `EP4CE6E22C8`) | VERIFIED | SCH (U5 title), QSF `DEVICE EP4CE6E22C8` |
| Package / speed | EQFP-144, speed grade 8 | VERIFIED | QSF `DEVICE_FILTER_PIN_COUNT 144`, `DEVICE_FILTER_SPEED_GRADE 8` |
| LEs | 6,272 | VERIFIED | DS (Cyclone IV handbook) |
| Memory | 270 Kbit = 30 M9K blocks | VERIFIED | DS |
| 18×18 multipliers | 15 | VERIFIED | DS |
| PLLs | 2 | VERIFIED | DS |
| User I/O | **91** (E144) | VERIFIED | DS; matches the 91 I/O pins drawn in SCH U5A–U5I |
| GPIO brought out | **91** — all of them (86 peripheral + 6/8/13 config + 24/111 on P1); "92" was a miscount, see §0g | VERIFIED | SCH, CROP-leds_dip |
| EP4CE10E22C8N variant | 10,320 LE, 46 M9K, 414 Kbit, 23 mult, 2 PLL, 91 user I/O | VERIFIED | DS (drop-in bigger variant sold with the kit) |

## 2. Power and configuration

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Input | 5 V DC barrel jack ("POWER", pin 1 = +V) or USB (power only, no data) | VERIFIED | SCH Alimentação, CROP-power, AMP1 |
| Power switch | self-locking SW-DPDT cuts the 5 V input; R1 2 kΩ + D1 LED = power indicator on 5 V | VERIFIED | SCH, CROP-power |
| Rails | 3.3 V (U1 1117-3.3 from 5 V), 2.5 V (U3 1117-2.5 from 5 V), 1.2 V (U2 1117-1.2 **from 3.3 V**) | VERIFIED | SCH, CROP-power, AMP1 |
| Config flash | EPCS16 (U7; footprint accepts EPCS4/EPCS16), AS mode: DCLK/DATA/nCS/ASDI; DATA via R7 22 Ω | VERIFIED | SCH, CROP-jtag, AMP1 |
| JTAG | HEADER 5X2: TCK/TDO/TMS/TDI + R8 1 kΩ/R9,R10 10 kΩ pull-ups to 2.5 V | VERIFIED | SCH, CROP-jtag |
| AS header | HEADER 5X2: DCLK/CONF_DONE/nCONFIG/DATA/ASDO/nCE/nCSO + R11 10 kΩ | VERIFIED | SCH, CROP-jtag |
| Unused pins | `RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP "AS INPUT TRI-STATED"` | VERIFIED | all vendor QSF |
| Config device in .qsf | `USE_CONFIGURATION_DEVICE ON`, `EPCS4`/`EPCS16` | VERIFIED | QSF |
| EPCS16 size | 16,777,216 bits = 2 MiB (vendor note "2.097.157 bytes" is a typo) | VERIFIED | SCH note; arithmetic |

## 3. Clock and reset

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Clock | 50 MHz active oscillator (4-pin: VCC=4, GND=2, NC=1, CLKout=3), 3.3 V powered, C9 100 nF decoupling, 33 Ω series (R3) → `FPGA_CLK` = **PIN_23** (CLK1/DIFFCLK_0n) | VERIFIED | SCH, CROP-reset_clk, PIN, INST |
| Reset | RESET key to GND, **ACTIVE LOW**, on **PIN_25** (CLK3/DIFFCLK_1n); R2 10 kΩ pull-up to 3.3 V + C10 100 nF (~1 ms RC) | VERIFIED | SCH, CROP-reset_clk, PIN, INST — see §0a |
| Spare clock pin 24 (CLK2/DIFFCLK_1p) | routed to P1 header pin 34 (free GPIO), no other use | VERIFIED | SCH P1 header zoom |

## 4. Keys, DIP switch, LEDs

### Keys KEY1–KEY4 (S1–S4, 4 push buttons)
| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Pins | KEY1 = 88, KEY2 = 89, KEY3 = 90, KEY4 = 91 (CLK4–CLK7 dual-purpose pins) | VERIFIED | INST, PIN, QSF (key_led: key[0..3] = 88–91), SCH |
| Drive | key closes the net to GND through 220 Ω series (R34–R37) | VERIFIED | SCH, CROP-leds_dip |
| Pull-ups | 10 kΩ to 3.3 V, designators **R38–R41** | VERIFIED | SCH, CROP-leds_dip (zoom) |
| Polarity | pressed = 0, released = 1 (active-low) | VERIFIED | SCH; QSF key_led.v drives LED on key=0 |

### DIP switch (4-position, SW) — shares the key nets
| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Pins | DIP1 = 88, DIP2 = 89, DIP3 = 90, DIP4 = 91 (same nets KEY1–KEY4) | VERIFIED | INST (`ckey1..4`), PIN (comment), QSF (ckey_led: ckey[1..4] = 88–91) |
| Wiring | DIP common side (pins 1–4) to GND; switched side (pins 8/7/6/5) to the KEY nets; pull-ups **R42–R45** 10 kΩ to 3.3 V | VERIFIED | SCH, CROP-leds_dip (zoom) |
| Polarity | switch ON/closed = 0, OFF/open = 1 (same net as the matching key; the two cannot be used independently) | VERIFIED | SCH (electrical); vendor ckey_led.v comment wording is garbled but the net topology is unambiguous |
| QSF cross-check | my_and.qsf uses s1=88, s2=89 (the same nets as KEY1/KEY2, DIP1/DIP2) | VERIFIED | QSF |

### LEDs LED1–LED4 (4 discrete LEDs)
| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Pins | LED1 = 87, LED2 = 86, LED3 = 85, LED4 = 84 | VERIFIED | INST, PIN, QSF (led[0..3] = 87/86/85/84; ckey_led LED[1..4] = 87/86/85/84) |
| Wiring | anodes to 3.3 V rail; cathodes → 470 Ω (R30–R33) → FPGA pins | VERIFIED | SCH, CROP-leds_dip |
| Polarity | lit = 0 (active-low); high or high-Z = off | VERIFIED | SCH; QSF ckey_led.v comment "送1灭，送0亮"; key_led.v drives 0 to light |

## 5. Seven-segment display (4 digits, multiplexed)

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Part | 4-digit common-anode display (12-pin), segments a–g + dp per digit | VERIFIED | SCH, CROP-sevenseg |
| Digit select | DIG1 = 133, DIG2 = 135, DIG3 = 136, DIG4 = 137 → 10 kΩ base resistors **R46–R49** (DIG1→R49 … DIG4→R46) → **8550 PNP** high-side drivers (Q1–Q4) from 3.3 V | VERIFIED | SCH, CROP-sevenseg |
| Digit polarity | digit ON when DIG pin = 0 (PNP conducts when its base is pulled low) | VERIFIED | SCH, CROP-sevenseg |
| Segments | SEG0 = 128, SEG1 = 121, SEG2 = 125, SEG3 = 129, SEG4 = 132, SEG5 = 126, SEG6 = 124, SEG7 = 127 → 220 Ω (R50–R57) → display | VERIFIED | SCH, CROP-sevenseg, INST |
| Segment polarity | segment lit when SEG pin = 0 (cathode drive; common anode) | VERIFIED | SCH |
| Segment mapping | SEG0 = b, SEG1 = a, SEG2 = c, SEG3 = d, SEG4 = e, SEG5 = f, SEG6 = g, SEG7 = dp (display pins 11=a, 7=b, 4=c, 2=d, 1=e, 10=f, 5=g, 3=dp) | VERIFIED | SCH Display section, CROP-sevenseg |
| Drive method | direct multiplexing, one digit at a time through the PNP | VERIFIED | SCH |

## 6. Buzzer

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Pin | BEEP = **110** (net FPGA_BUZZER) | VERIFIED | INST, PIN |
| Drive | BEEP → R18 2 kΩ → base of Q5 8550 PNP (high-side from 3.3 V via R19 33 Ω); R17 10 kΩ pull-up on BEEP | VERIFIED | SCH, CROP-buzzer_ir, AMP1 |
| Polarity | ON when BEEP = 0; idle = 1 (silent) | VERIFIED | SCH |
| Type | 2-terminal "SPEAKER", single-transistor drive, **no on-board oscillator → the design must generate the tone** | VERIFIED (drive topology) | SCH, CROP-buzzer_ir |
| Fitted part: active vs passive | schematic cannot prove it → **UNVERIFIED**; physical test T-BUZZER-1 in real_board_results.md | UNVERIFIED | — |

## 7. RS232

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Transceiver | MAX3232E (U4, 3.3 V, C41–C44 4 × 100 nF charge pumps) | VERIFIED | SCH, CROP-rs232 |
| FPGA pins | UART_TXD = 114 (T1IN), UART_RXD = 115 (R1OUT) | VERIFIED | INST, PIN |
| DB9 | T1OUT(14) → **DB9 pin 7** (board TX), R1IN(13) ← **DB9 pin 8** (board RX), GND = **pin 5** | VERIFIED | SCH, CROP-rs232, AMP1 |
| Standard comparison | standard DTE DB9: RXD = 2, TXD = 3, GND = 5 → **MISMATCH** (board TX on 7, RX on 8): straight-through cable fails; crossover (7→2, 8→3, 5↔5) needed | VERIFIED (mismatch) | schematic vs DS (EIA/TIA-232 pinout) |
| Unused channel | T2IN/T2OUT/R2IN/R2OUT unconnected | VERIFIED | SCH, CROP-rs232 |

## 8. VGA (8 colors)

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Pins | VGA_R = 106, VGA_G = 105, VGA_B = 104, VGA_HSYNC = 101, VGA_VSYNC = 103 | VERIFIED | INST, PIN |
| Wiring | R/G/B 1-bit through 1 kΩ series (R16/R15/R14); HS/VS through 33 Ω (R13/R12); DB15 connector | VERIFIED | SCH, AMP1 (VGA) |
| DB15 pin map | R→1, G→2, B→3, HSYNC→13, VSYNC→14, grounds 4–10; standard VGA pinout | VERIFIED | AMP1 (VGA) |
| Colors | 2³ = 8 colors (1 bit per channel) | VERIFIED | SCH |

## 9. PS/2

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Pins | PS_CLOCK = 119 (connector pin 5), PS_DATA = 120 (connector pin 1) | VERIFIED | INST, PIN, AMP1 (PS2) |
| Wiring | 470 Ω series (R21/R22) between FPGA and connector; **10 kΩ pull-ups to 5 V** (R23/R24) on both lines | VERIFIED | SCH, CROP-ps2_eep, AMP1 |
| Bus | open-collector (device pulls low), idle high; connector pin 4 = 5 V (keyboard power), pin 3 = GND | VERIFIED | SCH, AMP1 |
| Fitted device (keyboard vs mouse) | not shown on schematic | UNVERIFIED | physical test T-PS2-1 |

## 10. I2C EEPROM — AT24C08

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Part | AT24C08 (U8), 8 Kbit = 1 KiB, 16-byte pages | VERIFIED | SCH, CROP-ps2_eep |
| Bus | **separate bus**: I2C_SCL = 99, I2C_SDA = 98, pull-ups R25/R26 5.1 kΩ → 3.3 V | VERIFIED | SCH, INST, PIN — see §0c |
| Address | A2/A1/A0 tied to GND → device address 0b1010_000 = **0x50** | VERIFIED | SCH, zoom_eep |
| WP | **pin 7 tied to VCC (3.3 V) → writes blocked on real hardware; read-only** | VERIFIED | SCH, zoom_eep, DS — see §0d |
| Behaviour | byte/page write, ACK polling, ~5 ms write cycle | VERIFIED | DS (only reachable off-board: WP blocks writes on this board) |

## 11. Temperature sensor — LM75

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Part | LM75 (U9) | VERIFIED | SCH, CROP-ps2_eep |
| Bus | **separate bus**: FPGA_SCL = 112, FPGA_SDA = 113, pull-ups R27/R28 5.1 kΩ → 3.3 V | VERIFIED | SCH, INST, PIN — see §0c |
| Address | A2/A1/A0 to GND → **0x48** | VERIFIED | SCH, zoom_eep |
| OS output | pin 3 (OS) unused | VERIFIED | SCH (no net) |
| Registers | 0x00 temperature (9-bit, 0.5 °C LSB), 0x01 config, 0x02 Thyst, 0x03 Tos | VERIFIED | DS |
| Ambient temperature during a classroom run | unknown until measured | UNVERIFIED | physical test T-LM75-1 |

## 12. SDRAM

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Part | HY57V641620 (U6) — 64 Mbit, 16-bit bus, 4 banks | VERIFIED | SCH (U6), PIN |
| Pins | DQ[15:0]: 28,30,31,32,33,34,38,39,54,53,52,51,50,49,46,44; A[11:0]: 76,77,80,83,68,67,66,65,64,60,75,59; CKE 58, CLK 43, CS 72, RAS 71, CAS 70, WE 69, BS0 73, BS1 74, LDQM 42, UDQM 55 | VERIFIED | INST, PIN, SCH |
| Header breakout | SDRAM pins also routed to P2 (22×2) | VERIFIED | SCH IO Interface |

## 13. IR receiver

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Part | 3-pin IR receiver module (U10) + 100 Ω supply resistor (R58) from 3.3 V; pin 1 = VCC, pin 2 = GND, pin 3 = out | VERIFIED | SCH, CROP-buzzer_ir, AMP1 |
| Pin | IR = **100** | VERIFIED | INST, PIN |
| Output | demodulated, active-low bursts, idle high (standard receiver behaviour) | INFERRED | standard IR receiver behaviour; part number not marked on SCH |
| Carrier / protocol | 38 kHz / NEC-compatible assumed | UNVERIFIED | physical test T-IR-1 |

## 14. LCD socket

| Item | Value | Tag | Source |
| --- | --- | --- | --- |
| Socket | 20-pin, 1602/12864 | VERIFIED | SCH, CROP-lcd |
| Signal nets | LCD1=RS(141), LCD2=RW(138), LCD3=E(143), LCD4=D0(142), LCD5=D1(1), LCD6=D2(144), LCD7=D3(3), LCD8=D4(2), LCD9=D5(10), LCD10=D6(7), LCD11=D7(11) | VERIFIED | INST, PIN, SCH |
| Contrast | 10 kΩ trimmer (designator "RW") from 5 V, wiper = VBG to contrast pin; R29 1 kΩ to GND | VERIFIED | SCH, CROP-lcd |
| Backlight / socket pin positions | 5 V on pins 19/20; exact socket pin order vs a standard 1602 module | UNVERIFIED | physical check T-LCD-1 (schematic crop is ambiguous at this resolution) |

## 15. Expansion headers

| Header | Size | Notes | Tag | Source |
| --- | --- | --- | --- | --- |
| P1 | 19×2 | carries BEEP(110), 111, SCL(112), SDA(113), TXD(114), RXD(115), PS_CLOCK(119), PS_DATA(120), SEG1/6/2/5/7/0/3/4 (121,124,125,126,127,128,129,132), DIG1–4 (133,135,136,137), LCD2/1/4/3/6/5/8/7/10/9/11 (138,141,142,143,144,1,3,2,7,10,11), **24**, 3.3 V, 5 V, GND | VERIFIED | SCH P1 zoom |
| P2 | 22×2 | power rails + KEY nets 88/89 + SDRAM breakout | VERIFIED (block level; pin-by-pin read is low-confidence at this zoom) | SCH P2 zoom |
| P3 | 10×2 | LED1/3 (84/86), KEY1/3 (88/90), I2C_SDA(98), IR(100), VGA_VSYNC(103), VGA_G(105), 5 V … (right column mirrors: LED2/4, KEY2/4, I2C_SCL, VGA_HSYNC, VGA_B, VGA_R) | VERIFIED (block level) | SCH P3 zoom |

## 16. Peripheral inventory status

| Peripheral | Status |
| --- | --- |
| 50 MHz oscillator, RESET key, 4 keys, DIP, 4 LEDs, 4-digit tube, buzzer drive, RS232/DB9, VGA (8-color), PS/2, LCD socket + trimmer, SDRAM, EPCS16, JTAG/AS 2×5, expansion headers, rails 3.3/2.5/1.2 V | **Confirmed** (schematic + photos) — VERIFIED |
| IR receiver, AT24C08 EEPROM (read-only, WP=VCC), LM75 temperature sensor | **Confirmed** (schematic) — VERIFIED; IR protocol and LM75 ambient value UNVERIFIED |
| Buzzer part type (active vs passive), PS/2 device type, LCD socket pin order vs standard module, IR carrier/protocol | **UNVERIFIED** — physical tests in real_board_results.md |
| LCD module, OV7670 camera, ENC28J60 Ethernet, USB module | **Out of scope** (bundle accessories; user confirmed board-only kit) |
| 8-digit tube variant | Different board variant — not this board |

## 17. Instructor pin table vs vendor .qsf cross-check

Compared `vendor/instructor_pin_table.png` against all four vendor .qsf files
and `Pinos_RZEasyFPGA.txt`:

* **No differences.** Every pin in the instructor table matches the vendor pin
  file 1:1 (RESET 25, CLK 23, KEY 88–91, ckey 88–91, LED 87/86/85/84, beep 110,
  IIC SCL/SDA 112/113 + I2C_SCL/SDA 99/98, PS2 119/120, IR 100, VGA
  101/103/104/105/106, LCD 141/138/143/142/1/144/3/2/10/7/11, DIG 133/135/136/137,
  SEG 128/121/125/129/132/126/124/127, SDRAM as listed in §12).
* Vendor examples agree: led_twinkle (clk 23, led 87/86/85/84), key_led
  (key 88–91, led 87/86/85/84), ckey_led (ckey 88–91, LED[1..4] 87/86/85/84),
  my_and (s1 88, s2 89, led1 87).
* **Pins used by two functions — by board design (shared nets, not a conflict):**
  KEY[n] and ckey[n] share pins 88–91 (the DIP is wired across the keys;
  "Os botões e os DIP estão ligados juntos!" — vendor pin file footer). Within
  any single vendor project no pin is assigned twice.
* The only "surprising" assignments are dual-purpose config pins used as user
  I/O, which is legal: VGA_HSYNC = 101 (nCEO), VGA_VSYNC = 103 (CLKUSR),
  SEG0 = 128 / SEG3 = 129 / SEG5 = 126 / SEG6 = 124 / SEG7 = 127 (DATA[2,3]/DQ
  dual-purpose) — all post-configuration user I/O per the Cyclone IV pinout.

## 18. Peripherals NOT exercised by any vendor example

The four vendor examples only drive: clk, keys/DIP, LEDs. **Everything else
has no vendor reference design**: 7-segment display, buzzer, RS232/DB9, VGA,
PS/2, LCD socket, IR receiver, AT24C08 EEPROM, LM75, SDRAM, RESET key input.
Physical tests for each are defined in `real_board_results.md`
(T-7SEG, T-BUZZER, T-UART, T-VGA, T-PS2, T-LCD, T-IR, T-EEPROM, T-LM75,
T-SDRAM, T-RESET) and results must be recorded there as additional ground
truth.
