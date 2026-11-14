# Reference image index — RZ-EasyFPGA A2.2 fidelity work

Every image currently under `board/photos/` (including `listing/` and `ref/`) and
`board/ui_reference/`. Compiled for the 3D board-model / UI fidelity tasks.

## Priority legend

* **primary** — authoritative for board layout, colors, connector positions and
  silkscreen. The real top-down photo (`Foto_Rz-EasyFPGA_A2.2.jpg`), the annotated
  vendor callout sheet, and the "Educational DIY Kit … NIOSII" listing shots.
* **secondary** — supporting only. The "… LCD VGA OV7670 Camera & Network Interface"
  variant listing shots (different board styling — see conflict note below) and the
  angled in-case photo.
* **ui_reference** — SimulIDE desktop screenshots; style reference for the simulator
  UI only. **Never** use them as board-geometry evidence.

## Index

| File | Angle / view | What it is good for | Priority |
| --- | --- | --- | --- |
| `board/photos/Foto_Rz-EasyFPGA_A2.2.jpg` | Straight top-down, bare board, tan background | **Best layout source.** Component positions, PCB outline, silkscreen (P1/P2/P3 pin numbers, AS/JTAG/RESET, R- and U-designators), colors (yellow headers, blue VGA/trimmer, red DIP/power cap). Scale anchor: P1 19×2.54 = 48.26 mm, P2 22×2.54 = 55.88 mm, P3 10×2.54 = 25.4 mm all measure consistently → 0.2623 mm/px | primary |
| `board/photos/Descricao_Placa_Cyclone4_V2.jpg` | Top-down with vendor callout arrows | Component identification (confirms FPGA EP4CE6E22C8, SP3232 serial chip, M25P16 flash, LM75A, AT24C08, SDRAM 64 Mbit, 50 M active crystal, buzzer, IR receiver, LCD 12864/1602 socket, DIP switch, 4 keys, 4 LEDs, PS2/RS232/VGA interfaces). Use for *what each part is*, not for measurements | primary |
| `board/photos/listing/edu_kit_1.png` | Angled close-up (FPGA / SDRAM / header corner) | Package shapes at an angle: EQFP-144 body, SDRAM TSOP, yellow header shrouds, connector bodies, power button, electrolytic cap. Cross-check of part placement | primary |
| `board/photos/listing/edu_kit_2.png` | Angled (display / buzzer / power corner) | 4-digit display, buzzer, blue trimmer, red-capped power switch, DC jack, USB-B, electrolytic caps, "Cyclone IV" logo placement | primary |
| `board/photos/listing/edu_kit_3.png` | Near top-down, full board | Whole-board layout cross-check against `Foto_Rz…`; confirms 4-digit display (not the 8-digit variant), connector bank on the right edge | primary |
| `board/photos/listing/edu_kit_4.png` | Angled (connector edge) | Right-edge connector bank order and colors: VGA (blue DB15), DB9, PS/2 mini-DIN; case-free board proportions | primary |
| `board/photos/listing/variant_lcd_ov7670_1.png` | Near top-down, variant board | Variant styling only (grey PS/2-position connector — see conflict note). Do **not** take geometry from these | secondary |
| `board/photos/listing/variant_lcd_ov7670_2.png` | Angled, variant board | Same as above; also shows bundle accessories (camera, modules) that are out of scope | secondary |
| `board/photos/board_v3.jpg` | Angled 3/4 view, board inside acrylic case | 3D form factor: PCB thickness, connector heights, acrylic top plate + brass corner standoffs (explains the 21 × 15 × 11 cm *package* size vs the ≈132 × 104 mm PCB) | secondary |
| `board/photos/ref/board_v3_full.jpg` | identical duplicate of `board_v3.jpg` (md5 `3498df0a2cf90ae22f5c25ff55cb5cc2`) | Same as `board_v3.jpg` | secondary |
| `board/photos/ref/annotated.jpg` | — | **Broken file**: 14-byte ASCII text `404: Not Found` (failed download stub). Not an image; needs re-download or removal | — |
| `board/ui_reference/simulide_desktop_1.png` | SimulIDE 2.0.0 desktop, `calculator.sim2` running | UI style only: light schematic canvas on beige grid, left component palette (Meters/Sources/Switches/Passive/…), top toolbar with run/pause, green "Running" pill, bottom simulation console (time, speed, engine load), dark status bar | ui_reference |
| `board/ui_reference/simulide_desktop_2.png` | SimulIDE 2.0.0 desktop, same circuit later in run | Same; second timing sample of the console/toolbar states | ui_reference |

## Variant-board conflict (logged, ignored for geometry)

The two `variant_lcd_ov7670_*` listing photos show a board sold with an LCD, OV7670
camera and network interface. On those photos the right-edge connector bank has a
**grey/silver round connector in the slot where the primary RZ-EasyFPGA A2.2 has its
PS/2 mini-DIN** (purple/dark-violet body in the edu-kit listing shots; silver-shielded
in the close-up `Foto_Rz…` photo). The variant's connector colours/placement do not
match the primary board and must **not** be copied into the model. Primary-board
geometry wins: connector edge order is PS/2 (top), DB9 (middle), VGA DB15 (bottom),
with the grey variant connector logged here as a known conflict only.

## Scale derivation note (for `parts.md`)

Measured on `Foto_Rz-EasyFPGA_A2.2.jpg` (565 × 434 px): P1 = 184 px for 48.26 mm,
P2 = 213 px for 55.88 mm (ratio 1.158 = 55.88/48.26 exactly), P3 = 95 px for 25.4 mm.
→ **0.2623 mm/px (3.82 px/mm), ±2 %**. PCB outline from the dark-region corners:
(19,33)–(525,28)–(529,424)–(28,427) px → **≈132 × 104 mm, ±4 mm** (D-sub shells and
the LCD socket overhang the PCB edge by up to ~8 mm). The listing's 21 × 15 × 11 cm
is the cased package size — never use it for the PCB.
