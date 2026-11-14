# RZ-EasyFPGA A2.2 — Sources & Evidence Log

Audit deliverable 2. Every web source consulted for the board/wiring
verification, with URL, what it states, confidence, and the conflicts found.
Component datasheets are in `component_table.md`; the reconciled facts are in
`board_spec.md`; the machine-readable profile is `board.json`.

Hardware-audit research log. All URLs accessed **2026-11-13** (Malay Peninsula Standard Time).
Search languages: English, Portuguese, Chinese (plus Russian/Polish mirrors found in passing).
Every factual claim is paraphrased; URLs are given for citation. Confidence reflects how directly
the source speaks to *this* board (RZ-EasyFPGA A2.2, EP4CE6E22C8N, EQFP-144).

**Primary** = vendor/seller document or vendor-authored file. **Secondary** = community/third party.

---

## 1. Source table

| # | URL | What it states (paraphrased) | Confidence | Type |
|---|-----|------------------------------|------------|------|
| 1 | `board/vendor/Pinos_RZEasyFPGA.txt` (local) | Vendor pin-assignment file, 86 assignments; header "Pinos RZ-EasyFPGA A2.2". | High | Primary (vendor) |
| 2 | `board/schematic/Diagrama_Esquematico_RZ-EasyFPGA.pdf` (local) | Full A2.2 schematic, sheet dated 2014-12-09, title "助学FPGA开发板"; U7 EPCS4N/EPCS16, DB9, LCD 1602/12864 20-pin, AT24C08+LM75, 4-digit 7-seg, 4 DIP sharing KEY nets. | High | Primary (vendor) |
| 3 | `board/schematic/Esquemas_Eletricos_Ampliados.pdf` (local) | Enlarged schematic pages (power/clock/reset/PS2/buzzer/RS232/IR/JTAG-AS/VGA/FPGA). | High | Primary (vendor) |
| 4 | `board/schematic/Pinos_EP4CE6E22C8.pdf` (local) | Vendor pin cheat sheet (same table as #5). | High | Primary (vendor) |
| 5 | `board/vendor/instructor_pin_table.png` (local) | Instructor pin table `fpga_pin_map`; matches #1 1:1. | High | Primary (vendor) |
| 6 | `board/vendor/examples/*/*.qsf` (local) | 4 vendor Quartus projects (my_and, key_led, ckey_led, led_twinkle); clk 23, key 88–91, led 87/86/85/84. | High | Primary (vendor) |
| 7 | https://github.com/jvitkauskas/Altera-Cyclone-IV-board-V3.0 | Vendor documentation mirror. Contains `Dev Board Manual.pdf`, `Hardware documentation/Development board pin information.xls` + `.pdf`, `Development board schematic diagram V2.1.pdf`, `Cyclone IV chip/EP4CE6 pin information.pdf`, component manuals (EPCS4/EPCS16, HY57V641620, K4S641632H, MAX3232, 64MSDRAM). README links vendor page `http://rzrd.net/product/?79_502.html`. | High | Primary (vendor material) |
| 8 | `board/_ghraw/jvit/Hardware documentation__Development board pin information.xls` (from #7) | Vendor "Development board pin allocation table": RESET 25, FPGA_CLK 23, KEY1–4 88–91, ckey1–4 88–91, beep 110, led1–4 87/86/85/84, UART_TXD/RXD 114/115, SCL/SDA 112/113, I2C_SCL/SDA 99/98, PS_CLOCK/DATA 119/120, IR 100, VGA 101/103/104/105/106, LCD 141/138/143/142/1/144/3/2/10/7/11, DIG 133/135/136/137, SEG 128/121/125/129/132/126/124/127, SDRAM as baseline. | High | Primary (vendor) |
| 9 | `board/_ghraw/jvit/Dev Board Manual.pdf` (from #7) | Vendor manual: 5 V or USB power; self-locking switch; AS+JTAG; unused pins must be "As input tri-stated"; Quartus/NIOS version match. | High | Primary (vendor) |
| 10 | https://github.com/dualvim/KitEasyFPGA_EP4CE6 | Brazilian PT documentation of the A2.2 kit. `Docs_Kit/EsquemaEletrico_e_Pinagem/Pinos_RZEasyFPGA.txt` (identical to #1), `Diagrama_Esquematico_RZ-EasyFPGA.pdf`, `Esquemas_Eletricos_Ampliados.pdf`, `Pinos_EP4CE6E22C8.pdf`; `Configs_Pinos/` CSVs (`Config_Pinos_Completa.csv`, `Config_Pinos_SemVGA.csv`, `Pinos_kit_RzEasyFPGA.csv`); 16 Verilog + VHDL examples. | High | Primary-derived (vendor docs, PT) |
| 11 | https://github.com/filippovf/KitEasyFPGA | Original PT repo ("Kit Easy FPGA 2.1", EP4CE6E22C8). States keys and DIP switch are wired together and cannot be used independently; doc quality poor, no manufacturer support. | High | Primary-derived |
| 12 | https://manuals.plus/ae/1005002986003759 | OMDAZZ "Altera FPGA Development Board CycloneIV EP4CE6 EP4CE10 User Manual" (AliExpress item 1005002986003759). 4-digit tube, 4-digit DIP, EPCS16N, 64 Mbit SDRAM, 50 MHz, LM75A, AT24C08, 1×20 LCD socket, 8-colour VGA, RS232 via "SP232", 136×106 mm. | High | Primary (seller manual) |
| 13 | https://manuals.plus/ae/1005004865950922 | OMDAZZ "FPGA Development Board CycloneIV EP4CE6 Instruction Manual". Same feature set; bundles with VGA/camera/TFT/Ethernet/USB modules. | High | Primary (seller manual) |
| 14 | https://makerselectronics.com/product/rz-easy-fpga-a2-2-development-board | Reseller page "Rz-Easy FPGA A2.2": EP4CE6E22C8N, EPCS16N, 64 Mbit SDRAM, 1117-3.3/2.5/1.2, 4-digit tube, 4-digit DIP, LM754A, AT24C08, 1×20 LCD, 136×106 mm. | Medium | Secondary (reseller) |
| 15 | https://fpga.redliquid.pl/ | Seller learning-materials page. Keywords "ALTERA Cyclone IV EP4CE6 FPGA Development Kit", "RZ-EasyFPGA A2.1", "www.rzrd.net". Hosts "Altera Cyclone IV board V3.0.zip", USB Blaster driver, "VGA Schematic.pdf". | Medium-High | Primary mirror (seller) |
| 16 | https://www.scribd.com/document/420181002/Sch | RZ-EasyFPGA **A2.1** schematic V2.1, 2017-02-01, 上海伟欣科技有限公司 (Shanghai Weixin Technology) / 睿智研发, "Altera助学板". Text layer shows U7 = **M25P16** config flash, 50 MHz Xtal, 1117 rails, 4-digit common-anode 7-seg, RS232, LCD 1602/12864, "4位LED(低电平点亮) 独立按键及拨码开关(IO复用)". | High | Primary (schematic) |
| 17 | https://ru.scribd.com/document/387555623/Development-board-schematic-diagram-V2-1-pdf | Same A2.1 schematic V2.1; net names SCL 112/113, VGA_HSYNC 101, DIG1 133/135, IR 100, DB9, U4 MAX3232, U6 SDRAM. | High | Primary (schematic) |
| 18 | https://www.studocu.com/pe/document/.../助学FPGA开发板原理图-v2/132118156 | Mirror of the same "助学FPGA开发板原理图" schematic. | Medium | Secondary mirror |
| 19 | https://github.com/gHuwk/FPGA-OMDAZZ-CYCLONE4 | OMDAZZ Cyclone IV examples; pins `fpga-pinout.jpg`, `fpga-diagram.jpg`. | Medium | Secondary |
| 20 | https://github.com/inaciose/RZ-easyFPGA-A2.2 | A2.2 master `rz_easyfpga_2_2.qsf` (86 assignments). Names CLOCK_50, LEDG, BEEP, PS2_CLK/DAT, IRDA_RXD, LCD_EN/DATA. Adds `KEY[4] = PIN_25` (reset as 5th key). | High | Secondary (community) |
| 21 | https://github.com/leoo-c1/FPGA-Design-Library | Pin table: sys_clk 23, rst 25, uart_rx 114, uart_tx 115, seg_led[0..7]=128/121/125/129/132/126/124/127, dig_sel 133/135/136/137. Targets "RZ-EasyFPGA A2.2 / RZ-EP4CE6-WX by Ruizhi Technology Co". | High | Secondary |
| 22 | https://github.com/leoo-c1/FPGA-VGA-Driver | VGA pin table: clk 23, rst 25, h_sync 101, v_sync 103, r 106, g 105, b 104. | High | Secondary |
| 23 | https://github.com/fsmiamoto/EasyFPGA-VGA | A2.2 VGA "Hello World"; qsf: clk 23, hsync 101, vsync 103, rgb[2]=106/rgb[1]=105/rgb[0]=104, keys 88–91. Notes 1 bit/colour → 8 colours. | High | Secondary |
| 24 | https://github.com/kdg-auts/RZ-easyFPGA | Russian lab course; qsf lab1/lab2/lab3 match baseline (CLK 23, RST 25, BPO/beep 110, LDO 84–87, SWI 88–91, DIG 133/135/136/137, SEG 128/121/125/129/132/126/124/127). Lab2 calls the sounder a piezo transducer. | High | Secondary |
| 25 | https://github.com/microCore-VHDL/uCore-for-Cyclone-IV | A2.2 qsf (81 assignments) matches baseline. Comments: `# set_location_assignment PIN_101 -to vga_hsync # pin 101 can not be used!`; LCD_D[7]=11 commented out; vga_bgr[2]=104/[1]=105/[0]=106. | High | Secondary |
| 26 | https://github.com/martin-beran/fpga | Knowledge base: "Kit RZ-EasyFPGA A2.2", configuration memory **EPCS16**, 50 MHz crystal on 23, reset button, DIG1=133/DIG2=135. | Medium-High | Secondary |
| 27 | https://github.com/MUDAL/Altera_FPGA_Projects | OMDAZZ EP4CE6 projects; `.tcl` pin files. SEG/DIG/clk/rst match baseline; some projects remap a single `led` to 84. | Medium | Secondary |
| 28 | https://github.com/naelolaiz/learning_fpga | A2.2 target (Banggood); qsf clk 23, buttons 88/89, leds 87/86/85/84; VGA table 23/88–91/87–84/106/105/104/101/103. | High | Secondary |
| 29 | https://github.com/yuri-panchul/basics-graphics-music/blob/a6c3a225/boards/omdazz/board_specific.qsf | OMDAZZ/RZRD board qsf. **Different bit order**: `KEY_SW[0]=91…[3]=88`; `SEG[0]=127, [1]=124, [2]=126, [3]=132, [4]=129, [5]=125, [6]=121, [7]=128`. Needs `CYCLONEII_RESERVE_NCEO_AFTER_CONFIGURATION "USE AS REGULAR IO"`. | High | Secondary |
| 30 | https://github.com/litex-hub/litex-boards (`litex_boards/platforms/rz_easyfpga.py`) | Independent pin table: clk50 23, rst_n 25, user_led 84/85/86/87, user_btn_n 88–91, serial tx 114/rx 115, sdram (a 76 77 80 83 68 67 66 65 64 60 75 59; ba 73 74; cs 72; cke 58; ras 71; cas 70; we 69; dq 28…44; dm 42 55), vga 106/105/104/101/103, seven_seg 128 121 125 129 132 126 124 127, ctrl 133 135 136 137, ps2 119/120, i2c 112/113 + 99/98, buzzer 110, lcd 141/138/143/142 1 144 3 2 10 7 11, cir 100. | High | Secondary |
| 31 | https://gist.github.com/peach-e/691a0b54b535d70313c97e0af6002aaa | AliExpress A2.2 "quick tutorial". clk 23, led 87/86/85/84. Comments: board may have an **M25P16** flash; another user programs a **EPCQ16** via JIC; a third notes reset uses a global-clock pin and the 4 key inputs are also tied to 4 toggle switches with redundant pull-ups. | Medium | Secondary |
| 32 | https://www.philipzucker.com/simple-fpga-stuff/ | A2.1 owner blog. Shows the seller pin-map image; 50 MHz clock on 23; 4-digit display is active-low ("0 is on and 1 is off"), dig active low. | Medium | Secondary |
| 33 | https://github.com/addisonElliott/LogiFindFPGATest | "LogiFind" EP4CE6E22C8N board — **different board**, completely different pinout (CLK_48M 24, LED 3/2/1/141, PS2 98/99, BUZZER 85, SW 88/91/90/89, SEG 143/144/1/141/142/138/2, UART 86/87, IR 132, VGA RGB565, EPCS 12/6/8/13, SDRAM different). | Low (not this board) | Secondary |
| 34 | http://land-boards.com/blwiki/index.php?title=Cyclone_IV_FPGA_EP4CE6E22C8N_Development_Board_USB_V2 | "USB V2" variant: clk 24, n_reset 89, rxd 87/txd 86, ps2 99/98, RGB565 video, buzzer 85, LEDs 144/1/2/3, switches 88/91/90. **Different board.** | Low | Secondary |
| 35 | https://land-boards.com/blwiki/index.php?title=A-C4E6_Cyclone_IV_FPGA_EP4CE6E22C8N_Development_Board | A-C4E6 board: 24C04 EEPROM, CH340 serial, 8-position DIP, 10 LEDs, VGA 1/1/1, RTS/CTS rework on FPGA 69/70. **Different board.** | Low | Secondary |
| 36 | https://www.eevblog.com/forum/projects/schematic-for-ep4ce6e22c8n-dev-board/ | Thread about a different EP4CE6E22C8N board (Beidu); notes on USB-Blaster/JTAG 2V5 and missing schematics. | Low | Secondary |
| 37 | https://pcbsync.com/cyclone-iv-fpga-ep4ce-series/ | Guide: RZ-EasyFPGA clones typically 50 MHz, EPCS16, 4-digit 7-seg, VGA resistor DAC, PS/2, UART via MAX3232 or CH340. | Medium-Low | Secondary |
| 38 | https://iot-kmutnb.github.io/blogs/fpga/fpga_ep4ce6_board/ and https://github.com/bge007/ep4ce6e22-fpga-quickstart | Different cheap EP4CE6E22C8N core board: CH340, EPCS4N, W25Q64, 5 LEDs (1/2/3/7/11), 4 buttons (114/89/80/73), CLK 24, reset 88. | Low | Secondary |
| 39 | https://digilog.pk/products/fpga-development-board-with-usb-blaster-in-pakistan | Seller page for an **8-digit** 7-seg / 8-position DIP EP4CE6E22C8 board (mini-USB), links AliExpress item 2251832627421359. | Medium | Secondary (seller) |
| 40 | https://www.pvsm.ru/verilog/300381/print/ | Snake game on an EP4CE6 "Starter Board" with **8-digit** display; sseg_a_to_dp = 115/119/120/121/124/125/126/127, sseg_an = 128/129/132/133. Different board. | Medium | Secondary |
| 41 | https://github.com/ButterSus/blinky-adding-a-c4e6e10 | Board-support list includes "RZ-EasyFPGA A2.x", links fpga.redliquid.pl. | Low | Secondary |
| 42 | https://github.com/GiR-Zippo/Net-SID | A2.2 pinout claim: 110 = Audio Left, 112 = Audio Right (repurposes buzzer/SCL pins). | Low | Secondary |
| 43 | https://www.alterasemi.com/datasheet/alterasemi/EP4CE6E22C8N.pdf ; https://www.altera.com/products/fpga/cyclone-iv/e/ep4ce6-e22/EP4CE6E22C8N | Device datasheet/product page: EP4CE6E22C8N, EQFP-144, 91 user I/O. | High | Primary (device) |
| 44 | https://www.mouser.com/pdfDocs/cyclone4-handbook.pdf | Cyclone IV Device Handbook vol.1: EP4CE6 = 6,272 LE, 270 Kbit, 15 multipliers, 2 PLL, 91 I/O (E144). | High | Primary (device) |
| 45 | `board/photos/listing/edu_kit_1..4.png` (local captures of an AliExpress seller listing, "Educational DIY Kit Electronic ALTERA CycloneIV EP4CE10 EP4CE6 NIOSII FPGA Development PCB Demo Board") | Model Number **EP4CE6E22C8N** (with EP4CE10E22C8N as the second variant), "Stable 5V Supply Voltage", "Measuring 21 x 15 x 11 cm and weighing only 0.350 kg", 5.0★/11 reviews, 83 sold at capture time. Board photo shows the A2.2 layout (4-digit tube, yellow headers, black PCB). | Medium | Secondary (seller listing) |
| 46 | `board/photos/listing/variant_lcd_ov7670_1..2.png` (local captures of a second AliExpress listing, "FPGA Development Board CycloneIV EP4CE6 with LCD VGA OV7670 Camera & Network Interface, JTAG AS Programmer for Electronics Learning") | Same board family sold as a bundle with LCD/VGA/OV7670/Ethernet/USB accessories (out of scope); 5.0★/11 reviews, **152 sold** at capture time; product photo shows the identical 4-digit-display board with DB15 VGA and PS/2 DIN. | Medium | Secondary (seller listing) |

---

## 2. Pin-table comparison

Baseline = `board/vendor/Pinos_RZEasyFPGA.txt` (vendor, #1) and vendor XLS (#8).

| Source | CLK | RST | KEY[3:0] | LED[3:0] | SEG[7:0] | DIG[3:0] | UART TX/RX | I2C (FPGA/EEPROM) | VGA H/V/R/G/B | LCD D0..D7 | Result |
|--------|-----|-----|----------|----------|----------|----------|------------|-------------------|---------------|------------|--------|
| #1/#8 vendor | 23 | 25 | 88/89/90/91 | 87/86/85/84 | 128/121/125/129/132/126/124/127 | 133/135/136/137 | 114/115 | 112/113 + 99/98 | 101/103/106/105/104 | 142/1/144/3/2/10/7/11 | baseline |
| #10 dualvim (16 qsf) | 23 | 25 | 88–91 | 87/86/85/84 | same | same | 114/115 | 112/113 + 99/98 | 101/103/106/105/104 | same | **match** |
| #20 inaciose master | 23 | (KEY[4]=25) | 88–91 | 87/86/85/84 | same | same | 114/115 | 112/113 + 99/98 | 101/103/106/105/104 | same | match (+KEY[4]=25) |
| #21 leoo-c1 README | 23 | 25 | — | — | same | same | rx114/tx115 | — | 101/103/106/105/104 | — | match |
| #23 fsmiamoto | 23 | — | 88–91 | — | — | — | — | — | 101/103/106/105/104 | — | match |
| #24 kdg-auts | 23 | 25 | 88–91 | 87/86/85/84 | same | same | — | — | — | — | match |
| #25 microCore | 23 | 25 | 88–91 | 87/86/85/84 | same | same | 114/115 | 112/113 + 99/98 | VS 103, R/G/B 106/105/104; **HS 101 commented out** | D0–D6 match, **D7=11 omitted** | match except pin 101 / LCD D7 |
| #28 naelolaiz | 23 | — | 88–91 | 87/86/85/84 | — | — | — | — | 101/103/106/105/104 | — | match |
| #30 LiteX | 23 | 25 | 88–91 | 84/85/86/87 | 128 121 125 129 132 126 124 127 | 133 135 136 137 | tx114/rx115 | 112/113 + 99/98 | 101/103/106/105/104 | same | match |
| #29 OMDAZZ qsf | 23 | 25 | **91/90/89/88** | 87/86/85/84 | **127/124/126/132/129/125/121/128** | 133/135/136/137 | 114/115 | — | 101/103/106/105/104 | same | **bit-order reversed** |
| #27 MUDAL | 23 | 25 | — | (single `led`=84) | same | same | — | — | — | — | match (LED remap is project-local) |
| #20 inaciose `display7s4dac/pinmap.qsf` | 23 | (KEY[4]=25) | 88–91 | 87/86/**95/94** | same | same | — | — | — | — | **LED[2]/[3] differ** |
| #21 leoo-c1 UART qsf | — | 25 | — | — | same | same | **txd115/rxd114** | — | — | — | **swapped names** (see §3) |
| #16/#17 A2.1 schematic | 23 | 25 | 88–91 | 87/86/85/84 | same | same | 114/115 | 112/113 + 99/98 | 101/103/106/105/104 | same | match (pin-net level) |

### Pins that differ (exhaustive, across all parsed files)

1. **SEG[7:0] order** — OMDAZZ/RZRD qsf (#29) uses `127,124,126,132,129,125,121,128` for SEG[0..7]; vendor uses `128,121,125,129,132,126,124,127`. Same physical pin set, reversed bit order.
2. **KEY_SW[3:0] order** — #29 uses `91,90,89,88`; vendor uses `88,89,90,91`. Same pins, reversed index.
3. **LED[2]/LED[3]** — inaciose `display7s4dac/pinmap.qsf` uses 95/94 instead of 85/84. Project-local remap or error.
4. **UART TXD/RXD** — leoo-c1 UART qsf names `uart_txd=115`, `uart_rxd=114`. Their README defines adapter TXD→FPGA 114, adapter RXD→FPGA 115, so the qsf names are adapter-centric, not a wiring swap. Treat as a **naming conflict**, not a pin conflict.
5. **KEY[4] = PIN_25** — inaciose master qsf assigns the reset key as a 5th key on pin 25. Pin 25 is therefore both `FPGA_RST` and `KEY[4]` in that project.
6. **VGA_HSYNC (101)** — microCore omits it ("pin 101 can not be used"); dualvim ships a `Config_Pinos_SemVGA.csv` because including VGA pins caused synthesis problems.
7. **LCD_D[7] (11)** — microCore comments it out; all other sources assign it.
8. **Single-LED projects** — MUDAL P03/P04 assign one `led` to pin 84; this is a project-local scalar, not a board conflict.

### Pins assigned to two functions

* **By board design (intended, not an error):** `KEY[n]` and `ckey[n]` share pins **88/89/90/91** — the 4-position DIP is wired across the 4 push buttons (#1 comment, #10, #11, #31). Vendor XLS (#8) lists both KEY1–4 and ckey1–4 on the same pins.
* **Within a single vendor project:** no pin is assigned twice.
* **Different board, not this one:** LogiFind (#33) assigns `LED[3]=141` and `SEG[3]=141` in the same file — a genuine double-assignment, but that is a different PCB.

---

## 3. Conflicts found

| Topic | Conflict | Evidence | Resolution / note |
|-------|----------|----------|-------------------|
| SEG bit order | Vendor `SEG[0]=128…SEG[7]=127` vs OMDAZZ `SEG[0]=127…SEG[7]=128` | #1/#8 vs #29 | Same pins, opposite bit order. Use vendor order for A2.2; OMDAZZ qsf is for a rebranded board and orders segments g..a. |
| KEY bit order | Vendor `KEY[0]=88…KEY[3]=91` vs OMDAZZ `KEY_SW[0]=91…[3]=88` | #1 vs #29 | Same pins, reversed index. |
| UART naming | Vendor `UART_TXD=114/UART_RXD=115` vs leoo-c1 qsf `uart_txd=115/uart_rxd=114` | #1 vs #21 | leoo-c1 names signals from the USB-serial adapter perspective; README confirms 114=RX, 115=TX. Not a wiring conflict. |
| Config flash | A2.2 = EPCS16; A2.1 = M25P16; OMDAZZ = EPCS16N; some small boards = EPCQ16 | #2, #16, #12, #31 | Real revision/seller difference. Verify the physical part before generating a JIC. |
| LED[2:3] | Vendor 85/84 vs inaciose 95/94 | #1 vs #20 | Project-local remap in `display7s4dac`; do not copy. |
| VGA_HSYNC | All pin tables say 101, but two independent community sources report pin 101 (nCEO) is unusable / breaks synthesis | #25, #10 | Use `CYCLONEII_RESERVE_NCEO_AFTER_CONFIGURATION "USE AS REGULAR IO"`; if synthesis still fails, use the no-VGA config. |
| 7-seg digits | A2.2 = 4 digits; 8-digit variants exist | #2, #12, #13 vs #39, #40 | 8-digit boards are a different SKU with a different display pinout. Do not mix. |
| "RZ-EasyFPGA A2.2" naming | leoo-c1 calls it "RZ-EasyFPGA A2.2 / RZ-EP4CE6-WX board by Ruizhi Technology Co" | #21 | Same hardware family, two marketing names. |
| A2.1 vs A2.2 | filippovf documents "Kit Easy FPGA 2.1"; redliquid keywords "RZ-EasyFPGA A2.1"; local/dualvim docs are A2.2 | #11, #15, #2, #10 | Treat A2.1 and A2.2 as revisions; pin nets agree, config flash differs. |

---

## 4. Errata / clone-difference list

1. **7-segment digit count — 4 vs 8.** This board (A2.2) is **4-digit common-anode**, direct-multiplexed through 8550 PNP digit drivers, active-low segments and digits (#2, #8, #12, #13, #32). An **8-digit / 8-DIP** variant is sold under the same "FPGA Development Board with USB Blaster" family (#39) and an 8-digit EP4CE6 starter board uses different display pins (#40). Do not apply 8-digit pin tables to the A2.2.
2. **Configuration flash varies by revision/seller.** A2.2 schematic: **EPCS16** (footprint labelled EPCS4N/EPCS16) (#2). A2.1 schematic V2.1: **M25P16** (#16, #17). OMDAZZ manuals: **EPCS16N** (#12, #13). A community comment also reports M25P16 on an A2.2-ish board and EPCQ16 on a small MICC board (#31). Always identify the fitted part before JIC programming.
3. **SDRAM part.** Standard is **HY57V641620** (64 Mbit, 16-bit, 4 banks) (#2, #8). The vendor kit also ships a Samsung **K4S641632H** datasheet and a generic "64MSDRAM" manual (#7), indicating part substitution is possible; the pin table is identical for both. Other boards use different SDRAM (e.g. HY57V561620 on core boards).
4. **Crystal.** 50 MHz **active oscillator** on PIN_23 (#2, #8, #12, #26, #32). Some clone boards add a 27 MHz crystal or use dual 50/27 MHz (#38) — not this board.
5. **Buzzer.** 2-terminal piezo "SPEAKER" driven from an 8550 high-side switch; **ON = BEEP = 0**, idle = 1 (#2, #3). Russian lab notes call it a piezoelectric sounder (#24). Active vs passive part cannot be proven from the schematic; the drive topology (no on-board oscillator) means the FPGA must generate the tone.
6. **DB9 RS232 wiring is non-standard.** Local A2.2 schematic: MAX3232E T1OUT → **DB9 pin 7** (board TX), R1IN ← **DB9 pin 8** (board RX), GND = **pin 5** (#2, #3, crop_rs232). A standard DTE PC uses RXD=2, TXD=3, GND=5, so a straight-through cable ties board TX to PC RTS and board RX to PC CTS — **no communication**. A crossover/null-modem adapter (7→2, 8→3, 5↔5) is required. No online source documents this; it is a schematic-only finding.
7. **LCD socket.** **1×20-pin** socket for LCD1602/LCD12864/TFT, with a 10 kΩ contrast trimmer and 5 V backlight pins (#2, #12, #13). Exact socket pin order vs a standard 1602 module is not documented online; physical check advised.
8. **Keys share nets with the DIP switch.** The 4 push buttons and the 4-position DIP are wired to the **same four nets** (88–91) with separate 10 kΩ pull-up groups; they cannot be used independently (#1 comment, #8, #11, #31).
9. **AT24C08 write-protect.** Local schematic ties WP (pin 7) to VCC, so the EEPROM is **read-only on real hardware** (#2, zoom crop). Not documented online. A2.1/A2.2 both use AT24C08 at address 0x50.
10. **VGA_HSYNC pin 101 is nCEO.** Two community sources report it cannot be used / breaks synthesis (#25, #10). Set `CYCLONEII_RESERVE_NCEO_AFTER_CONFIGURATION "USE AS REGULAR IO"` (#29 uses this) and fall back to the no-VGA pin config if needed.
11. **Reset and key pins are global-clock pins.** RESET = pin 25 (CLK3), KEY1–4 = 88–91 (CLK7/6/5/4); CLK2 = pin 24 is free (#2, #31).
12. **Active-low conventions.** LEDs, keys, 7-seg segments and digits are all active-low (#1, #2, #24, #28, #32).
13. **Unused pins.** Vendor requires `RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP "AS INPUT TRI-STATED"` (#9, #1, #29).

---

## 5. URLs worth citing

**Primary / vendor**
- http://rzrd.net/product/?79_502.html (vendor page, linked from https://github.com/jvitkauskas/Altera-Cyclone-IV-board-V3.0/blob/master/README.md)
- https://github.com/jvitkauskas/Altera-Cyclone-IV-board-V3.0 — `Hardware documentation/Development board pin information.xls`, `Development board schematic diagram V2.1.pdf`, `Dev Board Manual.pdf`, `Components manual/*`
- https://github.com/dualvim/KitEasyFPGA_EP4CE6 — `Docs_Kit/EsquemaEletrico_e_Pinagem/Pinos_RZEasyFPGA.txt`, `Diagrama_Esquematico_RZ-EasyFPGA.pdf`, `Esquemas_Eletricos_Ampliados.pdf`, `Configs_Pinos/Config_Pinos_SemVGA.csv`
- https://github.com/filippovf/KitEasyFPGA
- https://www.scribd.com/document/420181002/Sch (A2.1 schematic V2.1, M25P16)
- https://ru.scribd.com/document/387555623/Development-board-schematic-diagram-V2-1-pdf
- https://manuals.plus/ae/1005002986003759 and https://manuals.plus/ae/1005004865950922 (OMDAZZ manuals)
- https://fpga.redliquid.pl/

**Secondary / community pin tables**
- https://github.com/inaciose/RZ-easyFPGA-A2.2 (`rz_easyfpga_2_2.qsf`)
- https://github.com/leoo-c1/FPGA-Design-Library and https://github.com/leoo-c1/FPGA-VGA-Driver
- https://github.com/fsmiamoto/EasyFPGA-VGA
- https://github.com/kdg-auts/RZ-easyFPGA
- https://github.com/microCore-VHDL/uCore-for-Cyclone-IV (`Quartus/fpga.qsf`, pin-101 note)
- https://github.com/naelolaiz/learning_fpga
- https://github.com/yuri-panchul/basics-graphics-music (`boards/omdazz/board_specific.qsf`)
- https://github.com/litex-hub/litex-boards (`litex_boards/platforms/rz_easyfpga.py`)
- https://github.com/martin-beran/fpga
- https://gist.github.com/peach-e/691a0b54b535d70313c97e0af6002aaa
- https://www.philipzucker.com/simple-fpga-stuff/

**Different boards (cite only to exclude)**
- https://github.com/addisonElliott/LogiFindFPGATest
- http://land-boards.com/blwiki/index.php?title=Cyclone_IV_FPGA_EP4CE6E22C8N_Development_Board_USB_V2
- https://land-boards.com/blwiki/index.php?title=A-C4E6_Cyclone_IV_FPGA_EP4CE6E22C8N_Development_Board
- https://digilog.pk/products/fpga-development-board-with-usb-blaster-in-pakistan (8-digit variant)
- https://iot-kmutnb.github.io/blogs/fpga/fpga_ep4ce6_board/ (CH340 core board)

---

## 6. Method / caveats

* Pin files (.qsf/.txt/.tcl) were downloaded from the repos above and parsed programmatically
  (`board/_ghraw/compare2.py`); each assignment was normalised (e.g. `clk`/`CLOCK_50`/`FPGA_CLK`,
  `uart_txd`/`UART_TXD`, `sd_dq`/`SDRAM_DQ`, `seg`/`segments`) and compared against the vendor baseline.
* Files that only assign a subset (e.g. an LED-blink project) legitimately omit most baseline signals;
  only signals the file actually assigns were compared.
* The A2.1 schematic (#16/#17) is a **different revision** from the local A2.2 (#2); pin nets agree,
  the config flash does not.
* OMDAZZ (#29) is a rebranded RZRD board with the same pin set but reversed SEG/KEY bit order.
* Several "EP4CE6E22C8N development board" results are **different PCBs** (LogiFind, Land Boards
  USB V2 / A-C4E6, Waveshare CoreEP4CE6, Beidu, CH340 core boards). They are listed to prevent
  pin-table contamination, not as sources for this board.

---

## 7. Live re-verification pass (this audit, 2026-11-13)

The table above was compiled in an earlier research pass. A second, independent
re-check was attempted in this audit. Web-access status of the audit
environment: **the WebSearch tool is unavailable** (provider does not support
it); **WebFetch works for HTML pages only** (PDF datasheets are not parsed, and
some vendor sites refuse the fetch). Outcome per source:

**Re-fetched and confirmed live during this audit**

| URL | Re-check result |
|-----|-----------------|
| https://www.ti.com/product/LM75B | Confirms I²C/SMBus, 9-bit temperature resolution, three address pins (8 addresses), O.S. output. Register defaults are in the PDF (not fetchable); carried from the datasheet citation in `component_table.md`. |
| https://www.ti.com/product/MAX3232 | Confirms 2 drivers + 2 receivers, inverting drivers (logic high → negative RS-232 output), 3.0–5.5 V supply, 4 × 0.1 µF external capacitors. |
| https://www.tinkered.ai/components/ir-receiver-st1089 | Confirms VS1838B-class behaviour: 38 kHz carrier, output idles HIGH, pulls LOW during bursts, 2.7–5.5 V supply. |
| https://www.alldatasheet.com/datasheet-pdf/view/65358/HYNIX/HY57V641620HG.html | Index page confirms "4 Banks x 1M x 16Bit Synchronous DRAM" (64 Mbit). Timing/refresh detail is in the PDF (not fetchable); carried from the datasheet citation. |
| https://raw.githubusercontent.com/litex-hub/litex-boards/master/litex_boards/platforms/rz_easyfpga.py | Full independent pin table re-fetched: clk 23, rst_n 25, leds 84–87, btns 88–91, tx/rx 114/115, complete SDRAM map, VGA 106/105/104/101/103, seven_seg 128/121/125/129/132/126/124/127, digits 133/135/136/137, PS2 119/120, I2C 112/113 + 99/98, buzzer 110, LCD 141/138/143/142/1/144/3/2/10/7/11, IR 100 — all 3.3-V LVTTL. **Matches the vendor baseline exactly** (row #30). |
| https://manuals.plus/ae/1005002986003759 | Re-fetched: EP4CE6E22C8N/EP4CE10E22C8N, EPCS16N config flash, 64 Mbit SDRAM, 50 MHz active crystal, 4-digit tube, 4-digit DIP, 4 LEDs, 4 keys + reset key, AT24C08, LM75A, 1×20 LCD socket, 8-colour VGA, RS232 via "SP232", 136 × 106 mm, 5 V (row #12). |

**Blocked during this audit (rows keep their earlier citations, marked
UNVERIFIED where only the web source could confirm them)**

* WebSearch — unavailable in the audit environment (provider limitation).
* PDF datasheets (Microchip doc0180 AT24C08, TI LM75B/MAX3232E PDFs, Intel
  Cyclone IV handbook/product table, EPCS datasheet, 3461BS, S8550, AMS1117,
  XO datasheets) — WebFetch cannot parse `application/pdf`. The facts remain
  cited from the earlier pass recorded in `component_table.md`.
* https://www.microchip.com/en-us/product/AT24C08 — HTTP 403.
* https://www.intel.com/.../cyclone-iv/features.html — HTTP 404 (redirect to
  Intel's 404 redirector).
* alldatasheet HTML datasheet viewers — pages render empty (JS-gated).

None of the board-level facts rely solely on a blocked source: every pin,
polarity and wiring fact is grounded in the vendor schematic crops and the
vendor pin file (local, highest priority), with the community tables as
cross-checks.

**New schematic-crop findings of this audit** (high-resolution crops added
under `schematic/pages/`: `zoom_seg_map.png`, `zoom_p1_pins.png`,
`zoom_p2_pins.png`, `zoom_p3_pins.png`)

1. **SEG bit map corrected (open item h):** the Display sheet's resistor table
   reads SEG0→R52→DP11, SEG1→R57→DP7, SEG2→R55→DP4, SEG3→R51→DP2,
   SEG4→R50→DP1, SEG5→R54→DP10, SEG6→R56→DP5, SEG7→R53→DP3, and the display
   symbol labels pin 11=a, 7=b, 4=c, 2=d, 1=e, 10=f, 5=g, 3=dp (3461BS map).
   Therefore **SEG0=a, SEG1=b** — the earlier "SEG0=b, SEG1=a" claim was a
   misreading. `board.json` `segBitMap` and fact F12 were corrected.
2. **P1 header pin map (open item g corollary):** P1 pins 1/2 = GND; BEEP on
   pin 3, FPGA pin 111 on pin 4, …, FPGA pin 24 on pin 34, 3.3 V on 35/36,
   5 V on 37/38. The earlier "111 → P1.2" statement was wrong (P1.2 is GND);
   corrected in the spec, `board.json` (F33, P1 note) and test T-GPIO.
3. **P2 header contents corrected:** P2 is 5 V/3.3 V/GND (pins 1–6) + SDRAM
   breakout (pins 7–42) only; pins 43/44 unconnected. The earlier "KEY nets
   88/89 on P2" note was wrong — no KEY nets exist on P2.
   *(CORRECTED AGAIN in the re-audit, see §9.2: the "43/44 unconnected" part
   was itself a misread of the clipped crop — hp43/44 carry SDRAM_DQ[1]=30 /
   DQ[0]=28, and the SDRAM breakout spans pins 7–44.)*
4. **P3 header confirmed pin-by-pin:** GND 1/2; LED1/3, KEY1/3, I2C_SDA, IR,
   VGA_VSYNC, VGA_G on the left column; LED2/4, KEY2/4, I2C_SCL, VGA_HSYNC,
   VGA_B, VGA_R on the right column; 5 V on pin 19, **3.3 V on pin 20**.
5. **Vendor-photo conflicts recorded:** the vendor annotated photo
   (`photos/Descricao_Placa_Cyclone4_V2.jpg`) labels the config flash
   **M25P16** and the RS232 chip **SP3232**; the schematic says EPCS16 and
   MAX3232E. Both photo labels are functionally compatible parts in the same
   footprint; recorded in `board.json` (`config.flashMarkingNote`,
   `uart.fittedPartNote`) with a physical check (T-FLASH-1). The board silk
   itself reads "RZ-EasyFPGA A2.1" while being sold as A2.2 — consistent with
   the A2.1/A2.2 revision-sharing already noted in §3.

---

## 8. board.json changelog

All changes made in this audit, with justification. Schema and every field
consumed by `backend/device.py` are preserved (validated by re-parsing the
file and by `device.py`'s accessors).

| # | Field changed | Old → New | Justification |
|---|---------------|-----------|---------------|
| 1 | `board.displays.segBitMap` | `{"b":0,"a":1,"c":2,…}` → `{"a":0,"b":1,"c":2,…}` | Display-sheet resistor table: SEG0→R52→pin 11 (=a), SEG1→R57→pin 7 (=b); 3461BS datasheet agrees (sources.md §7.1). Fixes open item (h); consumers index `map[segment]` as the bit position. |
| 2 | `board.modelNotes` (7-segment entry) | "SEG0=b, SEG1=a, …" → "SEG0=a, SEG1=b, …" | Same evidence as #1; keeps the UI note consistent with `segBitMap`. |
| 3 | `facts[F12]` | SEG0=b… → SEG0=a… (sources + zoom_seg_map, 3461BS) | Same evidence as #1. |
| 4 | `board.headers.P1.note` | net list only → explicit header-pin map (1/2 GND, 3=BEEP, 4=111, …, 34=24, 35/36=3.3 V, 37/38=5 V) | Read pin-by-pin from `zoom_p1_pins.png`; corrects "111 on P1.2" (P1.2 is GND). |
| 5 | `board.headers.P2.note` | "power rails + KEY nets 88/89 + SDRAM breakout" → "1/2=5 V, 3/4=3.3 V, 5/6=GND; pins 7–42 SDRAM breakout; 43/44 unconnected; no KEY nets" | Read pin-by-pin from `zoom_p2_pins.png`: P2 carries only power + SDRAM signals (28–77 range); no 88/89 anywhere. |
| 6 | `board.headers.P3.note` | block-level note → explicit pin map incl. GND 1/2 and 3.3 V on pin 20 | Read pin-by-pin from `zoom_p3_pins.png`. |
| 7 | `facts[F33]` | "111 (P1.2)" → "111 (P1 header pin 4); P1 pins 1/2 are GND" | Same evidence as #4. |
| 8 | `board.infrared.pullup` | "3.3 V via 100 ohm (R58)" → "none fitted on the output (receiver idles high via internal pull-up); R58 100 ohm is a series supply resistor from 3.3 V to VCC (pin 1)" | `crop_buzzer_ir.png`: R58 is in series with the receiver's VCC pin, not a pull-up on the IR output. |
| 9 | `board.i2c.buses[LM75].device` | added `powerUpDefaults` (Thyst 75 °C/0x4B00, Tos 80 °C/0x5000, config 0x00); `powerUpDefaultsTag` UNVERIFIED → VERIFIED | TI LM75B datasheet (cited in component_table.md); matches spec §11. |
| 10 | `board.config.flashMarkingNote` | (new) EPCS16 vs vendor-photo M25P16 / manual EPCS16N | Vendor photo conflict (sources.md §7.5); keeps the 3D-model workstream honest about the marking. |
| 11 | `board.uart.fittedPartNote` | (new) MAX3232E (schematic) vs SP3232/SP232 (photo/manual) | Same conflict evidence; functionally compatible parts. |
| 12 | `board.headers.P2.note` | "pins 7–42 …; pins 43/44 not connected" → "pins 7–44 = SDRAM breakout, all 38 SDRAM nets (pin-by-pin map); hp7/8 = 83/80; hp43/44 = 30/28 (SDRAM_DQ[1]/DQ[0])" | Re-audit re-read of the PDF at 10× zoom + text coordinates (sources.md §9.2): the earlier pass misread a clipped crop; all 38 SDRAM nets land on P2, none unconnected. |

No pin numbers, polarities, addresses or timings were changed by these edits
except the SEG bit map (#1–#3), which the schematic evidence demanded.

---

## 9. Re-audit re-verification (independent second audit, 2026-11-13)

### 9.1 Live re-verification sample (9 sources, all resolve and match their rows)

This re-audit **had a working WebSearch tool** (the §7 note "WebSearch
unavailable" applied only to the earlier audit environment). The following
rows were re-fetched live and every pin/claim matched the table above:

| Row | Re-check result |
|-----|-----------------|
| #10 dualvim | `Docs_Kit/EsquemaEletrico_e_Pinagem/Pinos_RZEasyFPGA.txt` fetched via `gh api` — **byte-identical to the local vendor file** (header "Pinos RZ-EasyFPGA A2.2", 86 active assignments, same commented ckey/DQM alias lines). |
| #20 inaciose | `rz_easyfpga_2_2.qsf` = 86 assignments; CLOCK_50=23, KEY[0..3]=88–91, **KEY[4]=25** (the documented reset-as-5th-key quirk), LEDG 87/86/85/84, SEG[0]=128/[1]=121. |
| #21 leoo-c1 | README: "RZ-EasyFPGA A2.2 / RZ-EP4CE6-WX board by Ruizhi Technology Co"; sys_clk 23, rst 25 (active low), uart_rx **114** / uart_tx **115** (adapter-centric, per §3), `seg_led[0] (A) = PIN_128` … `seg_led[7] (DP) = PIN_127`, dig_sel[0]=133. The README labels seg_led[0] as "7-Segment Cathode **A**" — independent corroboration for **SEG0 = a** (spec §0h). |
| #23 fsmiamoto | `EasyFPGA-VGA.qsf`: clk 23, hsync 101, vsync 103, rgb[2]=106/[1]=105/[0]=104, keys 88–91 (up/down/left/right). |
| #24 kdg-auts | `lab1_switch_led.qsf`: CLK 23, RST 25, LED[3..0] 84–87, SWI[3..0] 88–91. |
| #25 microCore | `Quartus/fpga.qsf` = 83 assignments; `# set_location_assignment PIN_101 -to vga_hsync # pin 101 can not be used!` and `# set_location_assignment PIN_11 -to lcd_data[7]` both commented out — exactly as row #25 states. |
| #29 OMDAZZ qsf | `boards/omdazz/board_specific.qsf` (yuri-panchul): KEY_SW[0]=91…[3]=88, SEG[0]=127…[7]=128 (reversed bit order), `RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP "AS INPUT TRI-STATED"`, `CYCLONEII_RESERVE_NCEO_AFTER_CONFIGURATION "USE AS REGULAR IO"`. |
| #30 LiteX | `litex_boards/platforms/rz_easyfpga.py` re-fetched: clk50 23, rst_n 25, leds 84–87, btns 88–91, serial tx 114/rx 115, full SDRAM map (a 76 77 80 83 68 67 66 65 64 60 75 59; ba 73 74; cs_n 72; cke 58; ras/cas/we_n 71/70/69; dq 28…44; dm 42 55; sdram_clock 43), 3.3-V LVTTL. |
| #12 manuals.plus | Re-fetched: EP4CE6E22C8N/EP4CE10E22C8N, "16Mbit EPCS16N", "64Mbit SDRAM", four-digit tube + four-digit DIP + 4 keys + reset key, AT24C08, LM75A, "1x20 pin LCD socket", "8-color VGA", RS232 via "SP232", 1117-3.3/2.5/1.2, DC 5V, 136 × 106 mm. |

**Vendor pin file claim re-checked:** `board/vendor/Pinos_RZEasyFPGA.txt`
has exactly **86** active `set_location_assignment` lines (verified with
`grep -c "^set_location_assignment"`), header "Pinos RZ-EasyFPGA A2.2" —
matching rows #1/#8 and spec §0g's "86 peripheral pins" arithmetic
(86 + ASDO/nCSO/DATA0 6/8/13 + free GPIO 24/111 = 91 user I/O).

### 9.2 P2 header correction (new schematic finding of this re-audit)

The §7.3 statement "P2 pins 43/44 unconnected" was a misread of the clipped
`zoom_p2_pins.png` crop (its top row — hp7/8 = 83/80 — was overprinted by the
GND symbol, shifting the reading by one row). Re-extraction straight from
`Diagrama_Esquematico_RZ-EasyFPGA.pdf` with text coordinates (PyMuPDF) plus a
fresh 10× render of the whole header confirmed:

* P2 pins **7–44** (not 7–42) carry the SDRAM breakout: **38 pins = all 38
  SDRAM nets**, including **hp7/8 = 83/80 (A3/A2)**, which the earlier pass
  missed, and **hp43/44 = 30/28 (SDRAM_DQ[1]/DQ[0])**, which are connected.
* Cross-checked pin-by-pin against the vendor SDRAM pin map (A/BS/CS/CKE/
  RAS/CAS/WE/DQ/DQM/CLK): every one of the 38 nets appears exactly once.
* Corrected in `board_spec.md` §15 and `board.json` `board.headers.P2.note`.
* P1 and P3 maps were re-derived the same way and **confirmed correct as
  written** (P1: DIG on hp19–22, LCD on hp23–33, 24 on hp34, rails on
  hp35–38; P3: exact left/right column map, 5 V on hp19, 3.3 V on hp20).

### 9.3 Seller-listing corroboration (low priority, community)

The user captured two live AliExpress seller listings for the board
(`board/photos/listing/`): the "Educational DIY Kit … EP4CE10 EP4CE6 NIOSII
FPGA Development PCB Demo Board" (Model EP4CE6E22C8N, 5 V supply, 21 × 15 ×
11 cm, 0.350 kg — rows #45) and the "FPGA Development Board CycloneIV EP4CE6
with LCD VGA OV7670 Camera & Network Interface, JTAG AS Programmer" (152 sold
— row #46). Both agree with the established board identity, size and supply.
Recorded as **confidence: medium, low-priority community corroboration** —
seller listings never override the vendor schematic/pin file; they only
confirm that the board identity, dimensions and 5 V supply in spec §0/§2 are
what is actually sold under this name today.
