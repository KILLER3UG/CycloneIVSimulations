# RZ-EasyFPGA A2.2 — physical board tests (to run at school)

Companion to `board_spec.md`. Every test below is for a peripheral that **no
vendor example project exercises** (the vendor examples only drive the clock,
keys/DIP and LEDs). Run each design on the real board with Quartus using the
pins from `vendor/Pinos_RZEasyFPGA.txt` (device `EP4CE6E22C8`, 3.3-V LVTTL)
and record the outcome in `board/real_board_results.md` — those results become
ground truth and override this document if they disagree.

Conventions: pins are EQFP144 numbers; "0"/"1" = logic level on the FPGA pin.
All designs are small enough for one Quartus project each.

| ID | Peripheral | Test design | Expected real behaviour |
| --- | --- | --- | --- |
| T-RESET | Reset key (pin 25) | Counter on clk(23), asynchronous clear driven by the RESET net; LEDs show the count. Hold RESET, release, press again. | Released: RESET reads 1 (10 kΩ pull-up), counter runs. Pressed: RESET = 0, counter clears/holds. The ~1 ms RC filters short bounce; observe whether bounce shows. |
| T-CLK | 50 MHz oscillator | Divide by 50,000,000 → 1 Hz blink on LED1. | LED1 blinks at ~1 Hz (period ≈ 1.00 s on a stopwatch). Confirms the oscillator is 50 MHz and active. |
| T-7SEG-1 | Digit select polarity | Drive DIG1..4 = 1110 (only DIG1 = 0); SEG = pattern for "1." (b,c,dp on). | Only the rightmost digit (DIG1, pin 133) lights; the other three are fully off. Two dim digits = ghosting. |
| T-7SEG-2 | Segment map | Static "0." on digit 1: a,b,c,d,e,f,dp driven low, g high. | Shows "0." exactly if SEG0=a, SEG1=b, SEG2=c, SEG3=d, SEG4=e, SEG5=f, SEG6=g, SEG7=dp (spec §0h). A wrong map shows a rotated/mirrored glyph. |
| T-7SEG-3 | Multiplexing | Scan 4 digits at ~1 kHz, a different numeral per digit. | All four digits show their numeral with no visible flicker; brightness ~¼ of static. |
| T-BUZZER-1 | Buzzer type + polarity | (a) BEEP = 0 DC. (b) BEEP with a 1–4 kHz square wave. (c) BEEP = 1 DC. | (a) continuous beep ⇒ **active** buzzer; only a click ⇒ **passive**. (b) clear tone ⇒ passive. (c) silent in both cases ⇒ ON = 0 confirmed. Record the type. |
| T-BUZZER-2 | Audible range | Sweep a square wave 100 Hz → 10 kHz on BEEP. | Passive speaker: audible ~300 Hz–5 kHz, loudest near resonance. Record the loudest frequency. |
| T-UART-1 | RS232 / PC link | 8N1 transmitter at 115200 baud, sends "U". USB-UART adapter: adapter RXD ← DB9 pin 7, adapter TXD → DB9 pin 8, GND ↔ pin 5. | PC terminal shows "U". If nothing arrives with a straight-through cable, the pin-7/8 non-standard wiring (spec §0e) is confirmed — retry with the crossover. Record which cable worked. |
| T-UART-2 | Baud accuracy | Send 0x55 at 9600 and 115200; measure at the adapter or on pin 114 (pre-MAX3232). | Bit time within ±2 % of nominal (50 MHz / integer divider); frames decode cleanly. |
| T-VGA-1 | Sync + colours | 640×480@60 generator: R/G/B 1 bit each on 106/105/104, HS 101, VS 103. Colour bars: R on lines 0–159, G 160–319, B 320–479. | Monitor shows three horizontal bands red/green/blue in order; lighting R+G+B on the last band gives white (8-colour palette). |
| T-VGA-2 | Sync timing | Count HS pulses per VS pulse at pins 101/103. | 525 HS pulses per VS frame. No scope: a locked (non-rolling) picture means the timing is plausible. |
| T-PS2-1 | PS/2 device + pull-ups | PS/2 host receiver (falling-edge sampler on ps_clock=119, ps_data=120). Plug a keyboard into the 6-pin DIN. | Typing produces scancode bytes (e.g. 0x5A = Enter make, 0xF0 break prefix). Confirms the 10 kΩ pull-ups to 5 V hold the bus idle-high and the keyboard is the clock master. |
| T-PS2-2 | No-device idle | Same receiver, nothing plugged in. | Both lines stay high (pull-ups); no clocks. If a mouse is fitted, the protocol differs — record the device. |
| T-LCD-1 | LCD socket + contrast | HD44780 init (8-bit, RS=141, RW=138, E=143, D0..D7=142,1,144,3,2,10,7,11), print "HELLO". Contrast trimmer mid-scale. | A 1602 module shows "HELLO" on line 1. Sweep the trimmer to find the sweet spot; record the module type (1602 vs 12864). |
| T-LCD-2 | Socket pin order | If T-LCD-1 shows garbage: continuity-check the socket pins against the schematic net list (LCD1=RS … LCD11=D7). | Confirms/corrects the socket pin order assumed from the schematic crop (spec §14 marks it UNVERIFIED). |
| T-IR-1 | IR receiver + protocol | NEC receiver: measure bursts on pin 100 (LED on pin 100 inverted, or a scope). Press buttons on a NEC remote. | Idle = 1 (high). A press gives a 9 ms leading burst + 4.5 ms space, then 32 bits (560 µs bursts). Decode address/command; record the codes. No remote: record that and test only the idle-high level. |
| T-EEPROM-1 | AT24C08 reads (bus 98/99) | Bit-bang I2C on pins 99(SCL)/98(SDA) at ~100 kHz; read 16 bytes from 0x50. | Device ACKs at 0x50 and returns data (fresh board reads 0xFF or previous content). Confirms the address and the dedicated bus. |
| T-EEPROM-2 | Write protection (WP=VCC) | Same bus: attempt a page write to 0x50 (write 0xA5 to addr 0), wait 5 ms, read back. | **Write must NOT stick**: readback ≠ 0xA5 (stays 0xFF on a fresh chip). The chip may NACK the data bytes. Confirms WP is tied to VCC (spec §0d). If the write DOES stick, WP is grounded on this unit — record it. |
| T-LM75-1 | LM75 temperature (bus 112/113) | Bit-bang I2C on pins 112(SCL)/113(SDA); read reg 0x00 (2 bytes) from 0x48. | Returns a plausible room temperature: value/2 °C within ~18–30 °C. Confirms the second bus and address 0x48. Record the value and a room thermometer reading. |
| T-SDRAM-1 | Data integrity | Minimal SDRAM controller (init, auto-refresh, write a pattern to a row, read back). Compare on LEDs. | Readback matches the written pattern (e.g. 0xA5A5 / 0x5A5A in several banks). Confirms the pin map and 16-bit bus. |
| T-SDRAM-2 | Refresh behaviour | Write, stop refresh for 0/1/2 s, read back. | With refresh stopped, cells decay after ~seconds (readback errors appear); with refresh running, data holds. |
| T-GPIO | Header GPIO 24 & 111 | Drive pin 24 high/low; read pin 111 as an input with a jumper between P1 header pin 34 (FPGA 24) and P1 header pin 4 (FPGA 111). Caution: P1 header pins 1/2 are GND — do not jumper to them. | Reading follows the driven level — confirms pins 24 and 111 are usable free GPIO (spec §0g; header map in zoom_p1_pins.png). |
| T-POWER | Rails | Multimeter on the regulator outputs with the power switch on. | 3.3 V ±0.15, 2.5 V ±0.15, 1.2 V ±0.1; the USB jack also powers the board through the switch. |
| T-DIP-1 | DIP switch + key shared nets | Design reads KEY1–4 as inputs (pull-ups on); flip each DIP position and press each key in turn. | Flipping DIP[n] or pressing KEY[n] both pull the SAME net n (pin 88+n−1) low — they cannot differ. Confirms the shared-net wiring (spec §4) and the R38–R41/R42–R45 pull-up groups. |
| T-FLASH-1 | Config flash identity | Read the U7 package marking; in Quartus, use the AS programmer (USB Blaster) and let it identify the EPCS device. | Marking reads EPCS16 (or M25P16/EPCS16N per the vendor photo/manual — see sources.md §7.5); Quartus identifies a 16 Mbit AS flash. Record the exact marking. If Quartus cannot identify, note the board revision. |
| T-LM75-2 | LM75 register defaults | On bus 112/113, read reg 0x01 (config), 0x02 (Thyst), 0x03 (Tos) at address 0x48, power-on state. | Config = 0x00; Thyst = 0x4B00 (75 °C); Tos = 0x5000 (80 °C) — the datasheet power-up defaults (component_table.md). Confirms the LM75 datasheet model. |
| T-EEPROM-3 | AT24C08 block select | On bus 99/98, issue a current-address/word read with control bytes 0x50, 0x51, 0x52, 0x53 and compare the first data byte of each. | All four control bytes ACK (only A2 is a real pin; A1/A0 are block-select bits — spec §10). Blocks may hold different data; blocks 0/1 must NOT alias. |
| T-UART-3 | DB9 pin roles | Design sends a steady 0x55 at 9600. Multimeter/scope on DB9 pins 7 and 8 vs pin 5. | Pin 7 carries the board TX (idle ≈ −5 to −9 V mark, data swings ±5 V); pin 8 stays quiet (it is the board RX input). Confirms the non-standard 7/8 wiring (spec §0e) without a PC. |
| T-HDR-1 | Header power/GND map | Multimeter continuity/voltage on P1 (1/2 GND, 35/36 3.3 V, 37/38 5 V), P2 (1/2 5 V, 3/4 3.3 V, 5/6 GND), P3 (1/2 GND, 19 5 V, 20 3.3 V). | Every listed pin measures the expected rail; no continuity between GND and rails. Confirms the header pin maps (spec §15, zoom_p1/p2/p3_pins.png). |

## How to record results

Use the Results table in `board/real_board_results.md`: date, board
condition, per-test outcome, observed values, and any contradiction with
`board_spec.md`. A contradiction is a spec correction, not a test failure.
