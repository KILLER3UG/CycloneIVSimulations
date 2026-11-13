# RZ-EasyFPGA A2.2 — Physical board tests & results (ground truth addendum)

Companion to `board_spec.md`. The vendor example projects (`my_and`, `key_led`,
`ckey_led`, `led_twinkle`) only exercise the clock, keys/DIP and LEDs. Every
other peripheral has **no vendor reference design**, so each one below gets a
small physical test to run at school. Results are recorded in the Results
section at the bottom — they become additional ground truth for the simulator.

Conventions: pins are EQFP144 numbers; "0"/"1" = logic level on the FPGA pin.
All tests fit in one Quartus project per test using the pins from
`Pinos_RZEasyFPGA.txt` (device `EP4CE6E22C8`, 3.3-V LVTTL).

| ID | Peripheral | Test design (what to load) | Expected real behaviour | Result |
| --- | --- | --- | --- | --- |
| T-RESET | Reset key (pin 25) | Counter clocked by clk(23), async clear driven by the RESET net; LEDs show count. Hold RESET pressed, release, press again. | Released: RESET reads 1 (10 kΩ pull-up), counter runs. Pressed: RESET = 0, counter clears/holds at 0. ~1 ms RC means a <1 ms glitch bounce is filtered-ish; bouncing may still show — observe. | ☐ |
| T-7SEG-1 | Digit select polarity | Drive DIG1..4 = 1110 (only DIG1=0), SEG = pattern for "1." (b,c on → SEG0=0, SEG2=0, dp=0? check map: SEG0=b, SEG2=c, SEG7=dp). | Only the rightmost digit (DIG1, pin 133) lights; other three fully off (their PNPs are cut). If two digits glow dimly, multiplex ghosting exists. | ☐ |
| T-7SEG-2 | Segment map | Static "0." on digit 1: SEG pins a..dp = 0 except g (SEG6) and use dp to confirm. Expected lit segments from the map (SEG1=a, SEG0=b, SEG2=c, SEG3=d, SEG4=e, SEG5=f, SEG7=dp). | Shows "0." exactly if the SEG-bit map (SEG0=b, SEG1=a, SEG2=c, SEG3=d, SEG4=e, SEG5=f, SEG6=g, SEG7=dp) is right. A wrong map shows a rotated/mirrored glyph. | ☐ |
| T-7SEG-3 | Multiplexing | Scan 4 digits at 1 kHz, different numeral per digit. | All four digits show their numeral with no visible flicker; brightness ~¼ of static. Confirms PNP high-side multiplexing works at classroom scan rates. | ☐ |
| T-BUZZER-1 | Buzzer type (active vs passive) + polarity | (a) Drive BEEP=0 constant (DC). (b) Drive BEEP with 1 kHz–4 kHz square wave (50% duty). (c) BEEP=1 constant. | (a) continuous beep ⇒ **active** buzzer; only a faint click ⇒ **passive**. (b) clear tone ⇒ passive (and confirms drive). (c) silent in both cases ⇒ ON=0 confirmed. Record which type sounded. | ☐ |
| T-BUZZER-2 | Audible frequency range | Sweep square wave 100 Hz → 10 kHz on BEEP. | Passive speaker: audible roughly 300 Hz–5 kHz, loudest near resonance (~2–4 kHz typical). Record the loudest frequency. | ☐ |
| T-UART-1 | RS232 loopback / PC link | uart_tx.vhd-style 8N1 transmitter at 115200 baud, sends "U" repeatedly. Connect USB-UART adapter to the DB9: adapter RXD ← DB9 pin 7, adapter TXD → DB9 pin 8, GND ↔ pin 5. | PC terminal shows "U" characters. If nothing arrives with a straight-through cable, the pin-7/8 non-standard wiring (spec §0e) is confirmed — retry with the crossover. Record which cable worked. | ☐ |
| T-UART-2 | Baud accuracy | Send 0x55 pattern at 9600 and 115200; measure on the adapter (or scope on pin 114 pre-MAX3232). | Bit time within ±2% of nominal (50 MHz/integer divider). Frames decode cleanly at the PC. | ☐ |
| T-VGA-1 | Sync + colors | 640×480@60 generator: vga_r/g/b = 1 bit each, hs=101, vs=103. Show color bars: R on for lines 0–159, G for 160–319, B for 320–479. | Monitor (via VGA cable) shows 3 horizontal bands red/green/blue in the right order; 8-color palette confirmed by lighting R+G+B for the last band → white. | ☐ |
| T-VGA-2 | Sync timing sanity | Same design; count hs pulses per vs pulse on a scope/logic probe at pins 101/103. | 525 hs pulses per vs frame (640×480@60). If no scope: monitor locks (no rolling) = timing plausible. | ☐ |
| T-PS2-1 | PS/2 device + pull-ups | PS/2 host receiver (falling-edge sampler on ps_clock=119, ps_data=120). Plug a keyboard into the 6-pin DIN. | Typing produces scancode bytes (e.g. 0x5A=Enter make, 0xF0 break prefix) in LEDs/7-seg. Confirms 10 kΩ pull-ups to 5 V hold the bus idle-high and the keyboard is the clock master. | ☐ |
| T-PS2-2 | No-device idle | Same receiver, nothing plugged in. | Both lines stay high (pull-ups); receiver sees no clocks. (If a mouse is plugged instead, protocol differs — record which device was used.) | ☐ |
| T-LCD-1 | LCD socket + contrast | HD44780 init (8-bit, from vendor pin map: RS=141, RW=138, E=143, D0..D7=142,1,144,3,2,10,7,11), print "HELLO". Contrast trimmer mid-scale. | A 1602 module shows "HELLO" on line 1. Turning the trimmer through its range goes blank↔dark; find the sweet spot and record the trimmer position. Record the module used (1602 vs 12864). | ☐ |
| T-LCD-2 | Socket pin order sanity | If T-LCD-1 shows garbage: swap-check with a continuity meter from the socket pins to R30..? / FPGA traces per the schematic net list (LCD1=RS…LCD11=D7). | Confirms/corrects the socket pin order assumed from the schematic crop (spec §14 marks this UNVERIFIED). | ☐ |
| T-IR-1 | IR receiver + protocol | NEC receiver: measure bursts on pin 100 (LED on pin 100 inverted, or capture with the PC audio-line/scope). Press buttons on a NEC-type remote. | Idle = 1 (high). Button press gives a 9 ms leading burst + 4.5 ms space, then 32 bits (560 µs bursts). Decode address/command; record the remote's codes. If no remote exists at school, record that and test only the idle-high level. | ☐ |
| T-EEPROM-1 | AT24C08 reads (bus 98/99) | Bit-bang I2C on pins 99(SCL)/98(SDA) at ~100 kHz; read 16 bytes from address 0x50, show on LEDs/UART. | Device ACKs at 0x50 and returns data (fresh board reads 0xFF or previous camp content). Confirms address 0x50 and the dedicated bus. | ☐ |
| T-EEPROM-2 | Write protection (WP=VCC) | Same bus: attempt a page write to 0x50 (e.g. write 0xA5 to addr 0), wait 5 ms, read back. | **Write must NOT stick**: readback ≠ 0xA5 (stays 0xFF on a fresh chip). The chip may NACK the data bytes during the write. This confirms WP is tied to VCC on the real board (spec §0d). If the write DOES stick, WP is grounded on this unit — record it! | ☐ |
| T-LM75-1 | LM75 temperature (bus 112/113) | Bit-bang I2C on pins 112(SCL)/113(SDA); read reg 0x00 (2 bytes) from 0x48. | Returns a plausible room temperature: value/2 °C within ~18–30 °C. Confirms the second bus and address 0x48. Record the value and the room thermometer reading. | ☐ |
| T-SDRAM-1 | Data integrity | Minimal SDRAM controller (init, auto-refresh, write pattern to a row, read back). Compare on LEDs. | Readback matches written pattern (e.g. 0xA5A5 / 0x5A5A in several banks). Confirms pin map + 16-bit bus. | ☐ |
| T-SDRAM-2 | Refresh behaviour | Write, stop refresh for 0/1/2 s, read back. | With refresh stopped, cells decay after ~seconds (readback errors appear); with refresh running, data holds. Demonstrates why controllers must refresh. | ☐ |
| T-GPIO | Header GPIO pins 24 & 111 | Drive pin 24 high/low, read pin 111 as input with a jumper wire between P1.34 and P1.2. | Reading follows the driven level — confirms pins 24 (P1.34) and 111 (P1.2) are usable free GPIO (spec §0g). | ☐ |
| T-CLK | 50 MHz oscillator | Divide by 50,000,000 → 1 Hz blink on LED1. | LED1 blinks at ~1 Hz (period measured with a phone stopwatch ≈ 1.00 s). Confirms the oscillator is 50 MHz and active (works without external crystal wiring). | ☐ |
| T-POWER | Rails | Multimeter on the regulator outputs with the power switch on. | 3.3 V ±0.15, 2.5 V ±0.15, 1.2 V ±0.1; USB jack also powers the board through the switch. | ☐ |

## Results (fill in at school)

Record: date, board serial/visual condition, and per-test outcome. Any result
that contradicts `board_spec.md` becomes a spec correction.

| ID | Date | Outcome (PASS/FAIL + observed values) | Notes |
| --- | --- | --- | --- |
| T-RESET | | | |
| T-7SEG-1 | | | |
| T-7SEG-2 | | | |
| T-7SEG-3 | | | |
| T-BUZZER-1 | | | |
| T-BUZZER-2 | | | |
| T-UART-1 | | | |
| T-UART-2 | | | |
| T-VGA-1 | | | |
| T-VGA-2 | | | |
| T-PS2-1 | | | |
| T-PS2-2 | | | |
| T-LCD-1 | | | |
| T-LCD-2 | | | |
| T-IR-1 | | | |
| T-EEPROM-1 | | | |
| T-EEPROM-2 | | | |
| T-LM75-1 | | | |
| T-SDRAM-1 | | | |
| T-SDRAM-2 | | | |
| T-GPIO | | | |
| T-CLK | | | |
| T-POWER | | | |

Nothing has been executed on physical hardware yet — all rows are open. The
simulator audit (see QA_REPORT.md updates) treats these as pending ground
truth and labels modelled-but-unproven behaviour accordingly.
