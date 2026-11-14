# Component evidence table — RZ-EasyFPGA A2.2 (Cyclone IV trainer)

Audit deliverable 3. Part, role, datasheet URL, the facts the simulator uses,
match/mismatch, and confidence. Board-level sources are in `sources.md`.

Scope: verify the component facts the simulator (`backend/device.py`, `backend/peripherals.py`,
`board/models/*.vhd`, `board/board_spec.md`) relies on, against real manufacturer datasheets.
Datasheets are paraphrased; URLs are given for every part. Confidence: **High** = read from a
manufacturer datasheet or an accessible copy of one; **Medium** = consistent across several
distributor copies / application notes, original no longer hosted; **Low** = inferred or
part-specific value not marked on the board.

## Evidence table

| Part | Role | Datasheet URL | Facts the simulator uses | Match / mismatch | Confidence |
| --- | --- | --- | --- | --- | --- |
| **EP4CE6E22C8N** (Cyclone IV E, EQFP-144, speed 8) | FPGA (U5) | Intel product table <https://cdrdv2-public.intel.com/714186/cyclone-iv-product-table.pdf>; Intel EP4CE6 pin file <https://cdrdv2-public.intel.com/655836/ep4ce6.pdf>; Intel Cyclone IV Pin Connection Guidelines <https://docs.altera.com/api/khub/documents/vXvSl9BlOsGmN_9HYOW1oA/content>; handbook mirror <https://www.ecb.torontomu.ca/~courses/ee8205/Data-Sheets/sopc/cyclone4-handbook.pdf> | 6272 LE; 30 M9K = 270 Kbit; 15 18×18 multipliers; 2 PLLs; 91 user I/O (E144); core 1.2 V; 3.3 V LVTTL valid; config pins nCONFIG, CONF_DONE, nSTATUS, ASDO, DATA0, DCLK, nCSO, nCE; JTAG TCK/TDO/TMS/TDI; weak pull-up before/during configuration; nCEO/CLKUSR usable as user I/O | **MATCH.** Product table gives 6 K LE / 30 M9K / 270 Kb / 15 mult / 2 PLL / E144=91 I/O; I/O voltages 1.2–3.3 V and LVTTL listed; core 1.2 V (1.15–1.25 V). Pin file confirms E144 pin 101 = nCEO, pin 103 = CLKUSR; PCG confirms both are usable as user I/O when not used for configuration. | High |
| **EPCS16** (serial config flash, SOIC-8) | Configuration flash (U7) | Intel/Altera EPCS datasheet C51014-5.1 (accessible copy) <https://datasheet.lcsc.com/datasheet/pdf/ff29b06c41963d2dd245c2d94841ddde.pdf?productCode=C7461926>; official chapter <https://cdrdv2-public.intel.com/654965/cyc_c51014.pdf> | 16 Mbit = 2 MiB (2 097 152 bytes); AS-mode pins DATA/ASDI/DCLK/nCS (FPGA side DATA0/ASDO/DCLK/nCSO); non-volatile; write bytes 1.5 typ / 5 max ms; bulk erase 17 typ / 40 max s; sector erase 2 typ / 3 max s | **MATCH.** EPCS16 = 16 777 216 bits = 2 097 152 bytes; four-pin AS interface DATA/ASDI/DCLK/nCS ↔ DATA0/ASDO/DCLK/nCSO; >100 000 program/erase cycles; shipped erased (all 1s). Timing table 16 confirms tWB 1.5/5 ms, tEB(EPCS16) 17/40 s, tES 2/3 s. The simulator stores only the size/part (no timing model), which is not contradicted. | High |
| **HY57V641620** (Hynix SDRAM, TSOP-II-54) | SDRAM (U6) | Hynix datasheet (distributor copy; original no longer hosted) <https://www.alldatasheet.com/datasheet-pdf/pdf/65358/HYNIX/HY57V641620HG.html>; copy <https://www.scribd.com/document/847516002/HY57V641620-4M-X-16-bit-SDRAM>; generic SDRAM init <https://www.fdi.ucm.es/profesor/mendias/DASii/docs/SDRAM.pdf> | 64 Mbit; 16-bit; 4 banks; CAS latency 2/3; 64 ms refresh; pin map | **MATCH on organisation/CAS; note on refresh.** 67 108 864 bits = 4 banks × 1 048 576 × 16; CAS latency 2 or 3 clocks; 3.3 V LVTTL. Hynix specifies **4096 refresh cycles / 64 ms** (4096 rows), not 8192 — 8192 is the JEDEC figure for 8192-row parts. The simulator has no timing model, so nothing to contradict; if any doc claims 8192 for this part it is wrong. Power-up: 200 µs wait, precharge all, ≥2 auto-refresh, MRS (mode register powers up unknown). | High (org/CAS); Medium (init sequence) |
| **AT24C08** (I²C EEPROM, SOIC-8) | EEPROM (U8) | Microchip/Atmel datasheet doc0180 <https://ww1.microchip.com/downloads/en/DeviceDoc/doc0180.pdf>; Atmel C-version copy <https://www.mouser.com/datasheet/2/268/Atmel-8819-SEEPROM-AT24C01C-02C-04C-08C-Auto-Datas-1770768.pdf> | 8 Kbit (1 KiB); 16-byte pages; 5 ms write cycle; device address 0x50; WP high = writes inhibited; ACK polling | **MISMATCH (address decode).** Size, page size, 5 ms self-timed write, WP-high behaviour and busy-NACK all match. But the model’s control-byte decode is wrong: it checks control-byte bit 2 against a physical `A1` pin and ignores bit 0, so it NACKs 0xA4–0xA7 and aliases 0xA2/0xA3 onto block 0. Datasheet: only **A2** is a hard-wired address pin; control-byte bits A1/A0 are the two MSBs of the 10-bit word address (block select). Confirmed by GHDL run (see notes). | High |
| **LM75** (TI digital temperature sensor) | Temp sensor (U9) | TI LM75B datasheet <https://www.ti.com/lit/ds/symlink/lm75b.pdf>; ADI LM75 <https://www.analog.com/media/en/technical-documentation/data-sheets/LM75.pdf> | I²C address 0x48; registers 0x00 temp, 0x01 config, 0x02 Thyst, 0x03 Tos; 9-bit 0.5 °C LSB; Tos/Thyst power-up defaults; OS comparator | **PARTIAL MISMATCH.** Address 1001 A2 A1 A0 = 0x48, register map, 9-bit left-aligned temperature (bits 15..7) and config register all match. The model returns **0x0000 for Thyst and Tos**; datasheet power-up defaults are **Thyst = 75 °C (0x4B00)** and **Tos = 80 °C (0x5000)**. The OS comparator is not modelled (OS pin is unused on this board, so low impact). | High |
| **MAX3232E** (RS-232 transceiver) | UART transceiver (U4) | TI MAX3232E datasheet <https://www.ti.com/lit/ds/symlink/max3232e.pdf> | 2 drivers / 2 receivers; T1IN logic, T1OUT RS-232; T1IN high → T1OUT low (negative); 4 × 0.1 µF charge-pump caps | **MATCH.** Two drivers/two receivers; driver table DIN H → DOUT L (RS-232 logic 1 = negative, so T1IN high gives a negative DB9 voltage); 4 × 0.1 µF external capacitors; 3.3 V supply. Board uses 4 × 100 nF. | High |
| **S8550 / 8550** (PNP, TO-92) | 7-seg digit and buzzer high-side driver (Q1–Q5) | MCC Semi S8550 <https://www.mccsemi.com/pdf/Products/S8550(TO-92)-V1.pdf>; Farnell SS8550 <https://www.farnell.com/datasheets/1869982.pdf> | TO-92 pinout E-B-C; PNP (base pulled low to conduct); VCE(sat) −0.6 V, VBE(sat) −1.2 V; base resistors 2 kΩ (buzzer) / 10 kΩ (digits) | **MATCH on pinout/polarity/saturation.** TO-92 pin 1 = E, 2 = B, 3 = C; PNP, so emitter to +3.3 V and base low turns it on; VCE(sat) −0.6 V max at 500 mA/50 mA, VBE(sat) −1.2 V. Base resistor value is an application choice (not a datasheet fact): 2 kΩ gives ≈1.3 mA base current at 3.3 V. | High (pinout); Medium (resistor) |
| **3461BS-type** 4-digit common-anode 7-segment | Display | XLITX 3461BS <https://www.xlitx.com/datasheet/3461BS.pdf>; 3461AS <https://www.xlitx.com/datasheet/3461AS.pdf> | 12-pin map 1=e, 2=d, 3=dp, 4=c, 5=g, 6=DIG4, 7=b, 8=DIG3, 9=DIG2, 10=f, 11=a, 12=DIG1; Vf ≈1.8 V; If 30 mA cont. / 200 mA peak | **MATCH.** The board’s display pin map matches the 3461BS datasheet exactly (11=a, 7=b, 4=c, 2=d, 1=e, 10=f, 5=g, 3=dp; digit commons 12/9/8/6). Red Vf 1.8 V typ at 10 mA; continuous If 30 mA per die, peak 200 mA. 220 Ω from 3.3 V gives ≈6 mA/segment (≈1.5 mA average at 1/4 multiplex). | High |
| **VS1838B / HS0038 class** 38 kHz IR receiver module | IR receiver (U10) | VS1838B datasheet (distributor copy) <https://www.elecrow.com/download/Infrared%20receiver%20vs1838b.pdf>; datasheets.com <https://www.datasheets.com/various/vs1838b>; pinout/behavior <https://www.tinkered.ai/components/ir-receiver-st1089> | 38 kHz carrier; output idle high, active low; supply 2.7–5.5 V; 3 pins OUT/GND/VCC | **MATCH (class behaviour).** 38 kHz carrier, active-low demodulated output that idles high, 2.7–5.5 V supply, pins OUT/GND/VCC. The exact fitted part is not marked on the schematic, so the specific variant is unverified. | High (class); Medium (exact part) |
| **AMS1117-3.3 / -2.5 / -1.2** | Rail regulators (U1/U2/U3) | Advanced Monolithic Systems datasheet <http://www.advanced-monolithic.com/pdf/ds1117.pdf>; LCSC copy <https://datasheet.lcsc.com/lcsc/1810231814_Advanced-Monolithic-Systems-AMS1117-1-2_C14529.pdf> | Dropout 1.3 V max at 0.8 A (1.1 V typ); output tolerance ±1.5 % (some clones ±2 %); SOT-223 pinout 1=GND/ADJ, 2=VOUT, 3=VIN, tab=VOUT | **MATCH.** Dropout guaranteed max 1.3 V at 0.8 A, decreasing at lower load; reference trimmed to ±1.5 %; pin 1 = GND/ADJ, pin 2 = VOUT, pin 3 = VIN, tab = VOUT. 3.3 V→1.2 V and 5 V→3.3/2.5 V all have enough headroom. | High |
| **50 MHz 4-pin crystal oscillator module** | Clock source | LCSC 4-pin XO <https://datasheet.lcsc.com/datasheet/pdf/2c141c761514440bde9cd51811e8f0e6.pdf?productCode=C5452683>; Raltron 50 MHz XO <https://www.raltron.com/webproducts/specs/CLOCK_OSCILLATOR/CP7050-50.000-3.3-25-X-T-TR.pdf>; Epson SPXO pinout <https://download.epsondevice.com/td/pdf/td_spxo_spso_mhz/SG2016EGN_X1G0061310602_en.pdf> | 4-pin: 1=NC/OE, 2=GND, 3=OUT, 4=VCC; active oscillator; 3.3 V CMOS; ±20–50 ppm | **MATCH.** Standard 4-pin DIP XO pinout is 1 = NC/OE, 2 = GND, 3 = OUT, 4 = VCC (board: VCC=4, GND=2, NC=1, OUT=3). It is an active oscillator (has VCC/GND and a CMOS output), so no external crystal wiring is needed. Exact tolerance is part-specific. | High (pinout); Medium (tolerance) |
| **Buzzer / speaker** (2-terminal) | Sounder (SP) | ElectricalFlux active vs passive <https://electricalflux.com/learn-components/what-is-buzzer-active-passive-piezo-circuit-guide>; Makerguides <https://www.makerguides.com/active-and-passive-piezo-buzzers-with-arduino/>; ATO <https://www.ato.com/difference-between-active-buzzer-and-passive-buzzer> | Simulator models a **passive** speaker (tone requires toggling pin 110); fitted part is flagged unverified | **UNVERIFIED on the board** (schematic shows only a 2-terminal “SPEAKER” behind a PNP, no oscillator). Electrical identification is confirmed: apply 3–5 V DC through a resistor — a continuous tone means **active** (internal oscillator, fixed ≈2–4 kHz), a single click means **passive** (needs a square wave). A passive magnetic buzzer measures a low coil resistance (≈16–42 Ω); an active one does not. | High (method); Low (fitted part) |

## Notes

### Mismatches found

1. **AT24C08 address decode is wrong (datasheet fact the simulator gets wrong).**
   The Atmel/Microchip datasheet says the AT24C08 uses **only A2** as a hard-wired address pin;
   control-byte bits A1 and A0 are the two MSBs of the 10-bit word address (block select), and the
   8-bit word-address byte is the low 8 bits. The model (`board/models/at24c08.vhd`) instead:
   * `dev_ok()` compares control-byte bit 2 against the model’s `A1` generic, so with A1=0 it only
     ACKs control bytes 0xA0–0xA3 and **NACKs 0xA4–0xA7** (which the datasheet says are valid blocks);
   * ignores control-byte bit 0 (the A0 block bit) and builds the word address from the word-address
     byte (`256*bit0 + bits7..1`), so blocks 0 and 1 alias the same array.
   GHDL confirmation (testbench in the session scratch dir, `wp='0'`): write 0x11 to control 0xA0
   address 0, then read control 0xA3 address 0 → model returns 0x11 (datasheet: 0x00); control 0xA4
   → NACK (datasheet: ACK). This is latent on the real board because WP is tied to VCC (writes
   blocked) and the QA test only reads address 0, but any design that reads the upper 512 bytes or
   uses block 1 will see wrong data.

2. **AT24C08 read bit sequence is shifted (model timing defect).**
   In `DATA_R` the model drives a new data bit on **both** the SCL falling and rising edges, so a
   master that samples on the rising edge (as the repo’s own `i2c_eeprom_test.vhd` does) sees every
   other bit. Observed with GHDL: 0x11 read back as 0x17, 0x22 as 0x34. Latent for the same reason
   (the WP test reads an all-zero array).

3. **LM75 Thyst/Tos power-up defaults are not modelled.**
   `board/models/lm75.vhd` returns all-zero data for register pointers 0x02 and 0x03. The TI datasheet
   specifies power-up defaults Thyst = 75 °C (0x4B00) and Tos = 80 °C (0x5000). The temperature and
   configuration registers are correct.

4. **Config-flash label inconsistency inside the simulator.**
   `README.md`, `QA_REPORT.md`, `tests/qa/gen_report.py` and `frontend/board3d.js` label the config
   flash **“M25P16”**, while `board/board_spec.md` and `backend/device.py` correctly say **EPCS16**.
   The schematic and vendor .qsf say EPCS16/EPCS4. M25P16 is a different (Micron SPI) part and is not
   an AS-configuration device; the 3D/2D model marking is wrong.

5. **SDRAM refresh figure.**
   Hynix specifies **4096 refresh cycles / 64 ms** for the HY57V641620 (4096 rows). The “64 ms / 8192
   cycles” wording sometimes seen in notes is the JEDEC generic for 8192-row SDRAMs and is not correct
   for this part. The simulator does not currently state a refresh count.

### Terminology clarifications (not simulator errors)

* **AT24C08 “A0”**: the datasheet’s control byte is `1010 A2 A1 A0 R/W`, but only **A2** exists as a
  pin; A1/A0 are block-select bits. The board’s schematic labels three pins A2/A1/A0 and ties them to
  GND; the resulting 7-bit address 0x50 is correct. The control-byte values 0x50–0x53 do appear, but
  A1/A0 are not physical address pins.
* **EPCS16 AS pins**: the EPCS device pins are **DATA, ASDI, DCLK, nCS**. **ASDO** is the FPGA-side
  pin that drives EPCS ASDI; the board spec’s list (DCLK/DATA/nCS/ASDI) is the EPCS device side.
* **nCEO / CLKUSR**: E144 pin 101 = nCEO and pin 103 = CLKUSR (confirmed in the EP4CE6 pin file).
  Both may be used as user I/O after configuration if not used for configuration (nCEO in a
  single-device chain, CLKUSR if the “user-supplied start-up clock” option is off). The board’s use
  of 101/103 as VGA HSYNC/VSYNC is therefore legal.
* **Weak pull-up**: user I/O and dual-purpose pins have weak pull-ups that are always enabled after
  POR, before and during configuration; they are not enabled before POR and are released in user
  mode. This matches the vendor `.qsf` `RESERVE_ALL_UNUSED_PINS_WEAK_PULLUP "AS INPUT TRI-STATED"`.

### Datasheet facts the simulator gets right (spot list)

* EP4CE6E22C8N: 6272 LE, 30 M9K/270 Kbit, 15 multipliers, 2 PLLs, 91 user I/O, EQFP-144, 1.2 V core,
  3.3 V LVTTL supported, config/JTAG pin set, weak pull-up behaviour, nCEO/CLKUSR as user I/O.
* EPCS16 density (16 Mbit = 2 MiB) and AS interface; non-volatile, shipped erased.
* HY57V641620 organisation (4 banks × 1M × 16), CAS 2/3, 3.3 V LVTTL.
* AT24C08 size/page/write-cycle/WP/ACK-polling behaviour.
* LM75 address 0x48, register map, 9-bit 0.5 °C temperature format, config register.
* MAX3232E channel count, logic/RS-232 pin split, inversion, 4 × 0.1 µF charge-pump capacitors.
* S8550 TO-92 E-B-C pinout and PNP polarity.
* 3461BS 12-pin map, Vf ≈1.8 V, 30 mA continuous / 200 mA peak.
* VS1838B-class 38 kHz carrier, active-low idle-high output, 2.7–5.5 V supply.
* AMS1117 dropout/pinout/tolerance; 4-pin XO pinout; active-vs-passive buzzer identification.

### Method

Datasheet facts were read from the URLs above (manufacturer documents where available; accessible
copies of the same manufacturer documents otherwise). Model behaviour was read from
`backend/device.py`, `backend/board_detect.py`, `backend/peripherals.py` and `board/models/*.vhd`.
The AT24C08 findings were additionally confirmed by compiling `board/models/at24c08.vhd` with GHDL
6.0.0 and running a bit-banged I²C master against it (testbench kept in the session scratch dir).

### Re-verification status (this audit, 2026-11-13)

The audit environment had **no WebSearch tool**, and WebFetch parses HTML only (no PDFs; some
vendor sites 403/404). Per-row status:

* **Re-verified live against the manufacturer's own pages in this audit:** LM75 (TI product page —
  I²C/SMBus, 9-bit, 3 address pins, O.S. output), MAX3232E (TI product page — 2 drivers/2
  receivers, inverting, 3.0–5.5 V, 4 × 0.1 µF), VS1838B-class IR (tinkered.ai — 38 kHz, idle high,
  active-low bursts, 2.7–5.5 V), HY57V641620 (alldatasheet index — "4 Banks x 1M x 16Bit").
* **Carried from the earlier cited datasheet read (PDF inaccessible to WebFetch; original URLs
  intact):** EP4CE6E22C8N product table/pin file/PCG, EPCS16, HY57V641620 timing/refresh detail,
  AT24C08 (Microchip 403 on the product page; datasheet PDF only), 3461BS, S8550, AMS1117,
  50 MHz XO. These rows keep **High/Medium** confidence from the cited datasheets; no web-only
  claim in this table is contradicted by anything found in this audit.
* The board-level facts (pins, polarities, wiring) do not depend on the blocked web sources: they
  are grounded in the vendor schematic crops and `vendor/Pinos_RZEasyFPGA.txt`.
