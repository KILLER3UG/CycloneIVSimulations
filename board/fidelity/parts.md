# Parts inventory with estimated positions — RZ-EasyFPGA A2.2

Companion to `reference_index.md`. Positions are read off `board/photos/Foto_Rz-EasyFPGA_A2.2.jpg`
(top-down, 565 × 434 px) and cross-checked against `Descricao_Placa_Cyclone4_V2.jpg`,
`board_v3.jpg` and the `photos/listing/edu_kit_*.png` shots.

## Coordinate system, scale, uncertainty

* Origin = **PCB top-left corner** in the reference photo orientation: the corner at
  the power section (DC jack / power switch / USB-B). **x → right, y → down**, in mm.
* Board edges in this orientation: **top** = LCD socket + display + trimmer + power
  switch + DC jack + USB-B; **right** = PS/2 + DB9 + VGA; **bottom** = 4 keys + LEDs +
  SDRAM + RESET; **left** = AS + JTAG headers. (Matches the layout seed.)
* Scale from known parts on the top-down photo: P1 19×2.54 = 48.26 mm → 184 px,
  P2 22×2.54 = 55.88 mm → 213 px (ratio 1.158 = 55.88/48.26, exact), P3 10×2.54 =
  25.4 mm → 95 px → **0.2623 mm/px (3.82 px/mm), ±2 %**.
* **PCB outline ≈ 132 × 104 mm, ±4 mm** (corner points (19,33)–(525,28)–(529,424)–(28,427) px).
  The listing's 21 × 15 × 11 cm is the cased *package* — deliberately not used.
* D-sub shells, the LCD socket and the PS/2 barrel overhang the PCB edge by up to
  ~8 mm; positions below are the *centers* of each part as mounted.
* **Every position in this file is photo-derived ⇒ ASSUMED** (no survey of the real
  board was possible). Each row carries an uncertainty: ±2 mm for parts measured on
  4–5× zoomed crops, ±4 mm for parts measured on the full photo, ±5 mm for the
  left-edge headers (shroud edges hard to separate from the black PCB).

## Status legend

* **CONFIRMED** — part existence/identity agreed by photo + `board_spec.md`/schematic
  (position still photo-derived/ASSUMED).
* **FROM DATASHEET** — package/size taken from the component datasheet or schematic
  symbol; position photo-derived/ASSUMED.
* **ASSUMED** — position (or the part itself, where noted) estimated from photos only.

## Main components

| id | position mm (x, y) ± | size mm | color / material | silkscreen | data source | status |
| --- | --- | --- | --- | --- | --- | --- |
| U5 (FPGA EP4CE6E22C8N, `fpga`) | 49, 57 ±2 | 26 × 24 (EQFP-144 body 22 × 22 + leads) | black epoxy, gold leads | "U5", "ALTERA Cyclone IV" | photo + board_spec | ASSUMED (identity CONFIRMED) |
| P1 header 19×2 (`headers/P1`) | 47, 33 ±2 | 48.3 × 5.8 | yellow plastic, gold pins | "P1" + pin numbers | photo + board_spec | ASSUMED (size CONFIRMED) |
| P2 header 22×2 (`headers/P2`) | 51, 78 ±2 | 55.9 × 5.8 | yellow plastic, gold pins | "P2" + pin numbers | photo + board_spec | ASSUMED (size CONFIRMED) |
| P3 header 10×2 (`headers/P3`) | 75, 56 ±2 | 5.0 × 25.2 | yellow plastic, gold pins | "P3" | photo + board_spec | ASSUMED (size CONFIRMED) |
| DISP1 4-digit 7-seg (`displays`) | 94, 10 ±2 | ≈30 × 16 (0.30′′ class; *not* 40 × 19 — measured on photo) | dark grey epoxy, blue lit segments | pin numbers 01–12 | photo + board_spec | ASSUMED |
| RW trimmer 10 kΩ (`lcd` contrast) | 114, 10 ±2 | 8.7 × 12.1 | blue body, brass screw | "RW" (per spec) | photo + board_spec | ASSUMED |
| LCD1 socket 20-pin (`lcd`) | 61, 1 ±2 | 54.3 × 8.7 (overhangs top edge) | black plastic | "LCD" | photo + board_spec | ASSUMED |
| PS2 mini-DIN 6 (`ps2`) | 132, 14 ±2 | 17.6 × 19.1 (shell overhangs edge) | silver metal shield | "PS" | photo + board_spec | ASSUMED |
| DB9 RS232 (`uart`) | 133, 44 ±2 | ≈33 × 25 (shell overhangs edge) | black plastic, silver shell | "RS232" nearby | photo + board_spec | ASSUMED |
| VGA DB15 (`vga`) | 129, 85 ±2 | 38 × 29 hood (overhangs edge) | blue plastic, silver shell | "VGA" | photo + board_spec | ASSUMED |
| SW1 power switch (`config`/power) | 11, 1 ±2 | 9.4 × 11 + red cap | red cap, silver DPDT body | "Power switch" callout | photo + board_spec | ASSUMED |
| J1 DC jack 5 V (`config`/power) | 3, 1 ±2 | 11 × 11.8 | black plastic, brass sleeve | — (callout "5V socket") | photo + board_spec | ASSUMED |
| USB1 USB-B (power only) | 27, 1 ±2 | 15 × 16.3 | silver metal shell | "USB供电" | photo + board_spec | ASSUMED |
| U1 1117-3.3 (`config`/rails) | 21, 21 ±2 | SOT-223 6.5 × 7 | black | "U1" | photo + board_spec | ASSUMED |
| U2 1117-1.2 (`config`/rails) | 30, 21 ±2 | SOT-223 6.5 × 7 | black | "U2" | photo + board_spec | ASSUMED |
| U3 1117-2.5 (`config`/rails) | 39, 21 ±2 | SOT-223 6.5 × 7 | black | "U3" | photo + board_spec | ASSUMED |
| U4 SP3232 / MAX3232E (`uart`) | 112, 45 ±2 | SOIC-16 10.3 × 7.5 | black | "U4" | photo + board_spec | FROM DATASHEET (size), ASSUMED pos; schematic says MAX3232E, callout says SP3232 — pin-compatible |
| U6 SDRAM HY57V641620 (`sdram`) | 60, 92 ±3 | TSOP-II 54, 22.2 × 11.8 | black | "U6", hynix marking | photo + board_spec | FROM DATASHEET (size), ASSUMED pos |
| U7 config flash EPCS16 / M25P16 (`config`) | 22, 52 ±3 | SOIC-16 10.3 × 7.5 | black | "U7" | photo + board_spec | FROM DATASHEET (size), ASSUMED pos; callout names M25P16 (EPCS16-compatible) |
| U8 AT24C08 EEPROM (`i2c` bus 1) | 87, 51 ±2 | SOIC-8 5.2 × 7.5 | black | "U8" | photo + board_spec | FROM DATASHEET (size), ASSUMED pos |
| U9 LM75A temp sensor (`i2c` bus 2) | 115, 51 ±2 | SOIC-8 5.2 × 7.5 | black | "U9" | photo + board_spec | FROM DATASHEET (size), ASSUMED pos |
| U10 IR receiver (`infrared`) | 112, 100 ±3 | ≈10 × 5, 3-pin module | black | "U10" | photo + board_spec | ASSUMED |
| X1 oscillator 50 MHz (`config`/clock) | 23, 65 ±2 | 13.1 × 7.9 metal can, "50.000" | silver can | "X1" | photo + board_spec | ASSUMED (marking CONFIRMED) |
| SP1 buzzer (`buzzer`) | 97, 60 ±4 | Ø15 disc | black | "SP", "+" | photo + board_spec | ASSUMED |
| SW2 DIP switch 4-pos (`switches`) | 92, 71 ±2 | 12.6 × 11 | red body, white "ON DIP" | "SW" | photo + board_spec | ASSUMED |
| RESET key (`config`/reset) | 8, 88 ±2 | 7 × 8.7 (6×6 tact + cap) | black | "RESET" | photo + board_spec | ASSUMED |
| S1 key (`buttons/KEY[0]`) | 109, 91 ±2 | 10.5 × 11 (6×6 tact + cap) | black, silver cap | "S1" | photo + board_spec | ASSUMED |
| S2 key (`buttons/KEY[1]`) | 121, 91 ±2 | 10.5 × 11 | black, silver cap | "S2" | photo + board_spec | ASSUMED |
| S3 key (`buttons/KEY[2]`) | 134, 91 ±2 | 10.5 × 11 | black, silver cap | "S3" | photo + board_spec | ASSUMED |
| S4 key (`buttons/KEY[3]`) | 146, 91 ±2 | 10.5 × 11 | black, silver cap | "S4" | photo + board_spec | ASSUMED |
| LED1 (`leds/LED[0]`) | 83, 89 ±2 | 0805 ≈2 × 1.6 (pitch ≈6 mm) | white lens | "LED1" | photo + board_spec | ASSUMED |
| LED2 (`leds/LED[1]`) | 88, 89 ±2 | 0805 | white lens | "LED2" | photo + board_spec | ASSUMED |
| LED3 (`leds/LED[2]`) | 94, 89 ±2 | 0805 | white lens | "LED3" | photo + board_spec | ASSUMED |
| LED4 (`leds/LED[3]`) | 99, 89 ±2 | 0805 | white lens | "LED4" | photo + board_spec | ASSUMED |
| JTAG header 2×5 (`config`/jtag) | 11, 94 ±5 | 25.4 × 10.2 boxed (photo box reads taller) | black box, gold pins | "JTAG" | photo + board_spec | ASSUMED |
| AS header 2×5 (`config`/as) | 11, 61 ±5 | 25.4 × 10.2 boxed (photo box reads taller) | black box, gold pins | "AS" | photo + board_spec | ASSUMED |
| Standoffs M3 brass ×4 | (1,0) (131,1) (1,101) (132,101) ±4 | Ø8, ~11 mm tall | brass/gold | — | photo (board_v3 shows case) | ASSUMED |

## Electrolytic capacitors (3)

| id | position mm (x, y) ± | size mm | color / material | silkscreen | data source | status |
| --- | --- | --- | --- | --- | --- | --- |
| C_E1 | 49, 6 ±2 | Ø6.6 × 11.8 | black cylinder, silver top | — | photo | ASSUMED (visible) |
| C_E2 (2.5 V rail) | 61, 22 ±2 | Ø4 × 7 | silver/black cylinder | "2.5V" nearby | photo | ASSUMED (visible) |
| C_E3 (input, near DC jack) | 12, 11 ±5 | ≈Ø6 × 11 | black cylinder | — | seed "3 electrolytic caps" | ASSUMED (not clearly resolved on photos) |

## Resistor / capacitor clusters (grouped rows; positions are cluster centers)

| id | position mm (x, y) ± | size / note | silkscreen | data source | status |
| --- | --- | --- | --- | --- | --- |
| R30–R33 LED 470 Ω | 90, 97 ±3 | 4 × 0805 under the LEDs | "R30 R31 R32 R33" | photo + board_spec | ASSUMED |
| R34–R37 key series 220 Ω | 93, 83 ±3 | 4 × 0805 next to DIP | "R34…R37" | photo + board_spec | ASSUMED |
| R38–R45 key + DIP pull-ups 10 kΩ | 124, 82 ±3 | 8 × 0805 right of DIP | "R38…R45" | photo + board_spec | ASSUMED |
| Q1–Q4 8550 digit drivers + R46–R49 bases | 74, 10 ±3 | 4 × SOT-23 + 4 × 0805 left of display | "Q1…Q4" | photo + board_spec | ASSUMED |
| R50–R57 segment 220 Ω | 94, 22 ±3 | 8 × 0805 row under display | "R50…R57" | photo + board_spec | ASSUMED |
| R12–R16 VGA 33 Ω / 1 kΩ | 109, 73 ±3 | 5 × 0805 above VGA | "R12…R16" | photo + board_spec | ASSUMED |
| R17–R19 buzzer drive | 83, 71 ±3 | 3 × 0805 left of buzzer | "R17 R18 R19" | photo + board_spec | ASSUMED |
| R21–R24 PS/2 series + pull-ups | 118, 16 ±3 | 4 × 0805 near PS/2 | "R21…R24" | photo + board_spec | ASSUMED |
| R25–R28 I²C pull-ups 5.1 kΩ | 101, 51 ±3 | 4 × 0805 between U8 and U9 | "R25…R28" | photo + board_spec | ASSUMED |
| R1 + D1 power indicator | 15, 11 ±3 | 0805 + LED | "R1", "D1" | photo + board_spec | ASSUMED |
| R2 + C10 reset RC | 20, 86 ±3 | 0805 pair near RESET | "R2", "C10" | photo + board_spec | ASSUMED |
| R7 + R11 EPCS/AS support | 13, 45 ±4 | 0805 pair near U7 | "R7", "R11" | photo + board_spec | ASSUMED |
| R8–R10 JTAG pull-ups | 14, 70 ±4 | 0805 trio near JTAG | "R8 R9 R10" | photo + board_spec | ASSUMED |
| R3–R6 clock / FPGA support | 33, 62 ±4 | 0805 group left of FPGA | "R3…R6" | photo + board_spec | ASSUMED |
| C41–C44 MAX3232 charge pumps | 106, 55 ±3 | 4 × 0805 around U4 | "C41…C44" | photo + board_spec | ASSUMED |
| C2/C4/C6/C7/C8 tantalum (rails) | 29, 21 ±3 | yellow tantalum row at U1–U3 | "C2…C8" | photo | ASSUMED |
| FB1/FB2 + C11/C13 FPGA power | 37, 73 ±4 | ferrite beads + caps at FPGA left edge | "FB1 FB2 C11 C13" | photo | ASSUMED |
| C9 oscillator decoupling | 24, 67 ±4 | 0805 next to X1 | "C9" | photo + board_spec | ASSUMED |

## Notes / conflicts

* **Variant conflict:** on `variant_lcd_ov7670_*` the PS/2 slot holds a grey round
  connector instead of the primary board's PS/2 mini-DIN. Variant geometry ignored
  (see `reference_index.md`).
* Display measured ≈30 × 16 mm on the photo — the commonly quoted 40 × 19 mm
  4-digit tube does **not** match this board's fitted part.
* U4: schematic says MAX3232E, the vendor callout says "SP3232 Serial chip" — treat
  as the same footprint; model behaviour identical for the simulator.
* U7: schematic says EPCS16, callout says "M25P16 Flash" — same SOIC-16 footprint,
  EPCS16-compatible SPI flash.
* The acrylic case + brass standoffs (visible in `board_v3.jpg`) explain the
  21 × 15 × 11 cm listing size; the bare PCB is ≈132 × 104 mm.
