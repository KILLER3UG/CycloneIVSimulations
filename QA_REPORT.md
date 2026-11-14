# Cyclone IV Simulator - QA & Verification Report

Target: EP4CE6E22C8 (Cyclone IV E) dev-board simulator, GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition]

Re-run everything with one command: `python tests/run_all.py`
(writes `tests/RESULTS.md`; single cases: `python tests/run_all.py --filter ID`)

## Scope and method

- 231 executed cases cover the device profile, project input, clock/reset,
  input/output devices, VHDL language coverage, Cyclone IV blocks, engine/UI
  behaviour, board-profile fidelity and the 8 student reference designs. Verilog is covered by explicit
  not-supported checks (the engine is VHDL-only).
- Every case runs the real GHDL toolchain (analyze, elaborate, simulate, VCD)
  in a fresh temp directory. UI claims were verified in the in-app browser
  (desktop 1440x900 and mobile 390x844) with screenshots and DOM checks.
- Long-run: a 5-minute soak executed 1641 simulations with 0 failures; 40
  back-to-back HTTP simulations drifted only ~1.4 MB of server RSS.
- Board identity: the 3D model reproduces the RZ-EasyFPGA A2.2 ('FPGA
  Development Board with Cyclone IV EP4CE6', maker RZRD). The pin table was
  taken from the kit's own assignment file mirrored on GitHub
  (KitEasyFPGA_EP4CE6, Pinos_RZEasyFPGA.txt) and cross-checked against the
  Altera-Cyclone-IV-board-V3.0 documentation project.
- Final result: **226 PASS / 5 FAIL**. Every failure is a verified, documented
  limitation - none is hidden or faked.

## Results table

| ID | Description | Lang | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| DEV-01 | Device definition EP4CE6E22C8 present and matches datasheet | n/a | Simulator declares 6272 LEs, 30 M9K, 15 multipliers, 2 PLLs, 91 I/O, EQFP-144, 3.3V LVTTL | device profile matches the datasheet | PASS |
| DEV-02 | Pin map internally consistent (no duplicate/invalid pins) | n/a | A pin map exists with unique, package-valid pins for LEDs, switches, keys, segments and clock | 51 named ports, 86 distinct pins, all valid EQFP numbers | PASS |
| IN-01 | Single .vhd upload loads and simulates | VHDL | Design compiles, entity/ports extracted, board mapped | led=0xA5, board=['led']/['sw'] | PASS |
| IN-02 | Single .v (Verilog) upload gives a clear not-supported error | Verilog | Error names Verilog as unsupported, with file/line | ?:1: Verilog/SystemVerilog is not supported: the simulator compiles VHDL only (GHDL). Rewrite the module in VHDL. | PASS |
| IN-03 | Multi-entity project (several entities in one upload) loads | VHDL | Top entity selected, all units analysed | mux4 selected from 6-entity file | PASS |
| IN-04 | Multi-file project upload (separate .vhd files) | VHDL | API accepts a file list, analyses all units, elaborates the top | leaf.vhd + top.vhd analysed; top elaborated | PASS |
| IN-05 | Quartus .qsf upload is parsed and honored | QSF | Pins, TOP_LEVEL_ENTITY, file list and unused-pin policy extracted from the vendor .qsf; sources uploaded alongside simulate with the QSF pin assignments | vendor ckey_led.qsf honoured: top, 8 pin assignments, IO policy; LED=ckey simulated | PASS |
| IN-05B | QSF pin/top/IO-standard/file-list parsing is complete | QSF | TOP_LEVEL_ENTITY, 8 pin assignments, IO_STANDARD and file list all visible in the result | top, 8 pins, IO_STANDARD and file list parsed from the vendor .qsf | PASS |
| IN-05C | QSF errors: invalid pin, duplicate pin, unknown port, wrong device | QSF | Each problem produces a specific error naming the pin/port; the simulation does not start | 4 specific errors: invalid pin, duplicate pin, unknown port, wrong device | PASS |
| IN-08 | QSF pin assignments are validated against the top-level ports | QSF | A pin assigned to a port that exists is honoured; the missing-pin warning stays quiet for those ports | no unpinned-port warnings for ports the .qsf assigns | PASS |
| IN-09 | VHDL syntax error reports file and line | VHDL | GHDL diagnostic with line number, no crash | ?:3: Expected ':' in interface declaration \\| ?:1: Unexpected end of file inside entity declaration \\| C:\Users\rober\AppData\Local\Temp\cyclone_compile_okjsbcor\design.vhd:3: interface declaration expected \\| C:\Users\rob… | PASS |
| IN-10 | Verilog syntax error reports file and line | Verilog | Diagnostic with line number naming Verilog | ?:1: Verilog/SystemVerilog is not supported: the simulator compiles VHDL only (GHDL). Rewrite the module in VHDL. | PASS |
| IN-11 | Unsupported Altera primitive gives a clear error | VHDL | Error names the unbound Altera megafunction (altpll/altsyncram) | c:\users\rober\appdata\local\temp\cyclone_qa_worker_xfl36b7g\cache\sources\99733af01519ce103bf373d98e015b2a85e8274c24f8c4900aa0f6016cabc189\design.vhd:33: instance "u_pll" of component "altpll" is not bound \\| c:\users\r… | PASS |
| IN-12 | Mixed-language project (VHDL top + Verilog submodule) | VHDL+Verilog | Supported, or a clear 'mixed language not supported' error | ?:1: mixed-language projects are not supported: the simulator compiles vhdl only (ghdl). move the verilog/systemverilog module to vhdl. | PASS |
| CLK-01 | Board clock frequency and pin are modelled | VHDL | CLOCK_50 = 50 MHz on pin PIN_23; the result reports the board frequency | CLOCK_50 = 50 MHz on PIN_23 | PASS |
| CLK-02 | Counter at the real clock rate matches expected count after N ms | VHDL | 100 ns at 10 ns period, reset 2 cycles -> count = 8 | count=8 after 100 ns | PASS |
| CLK-03 | Clock scaling makes a 1 Hz blinker visible in real time | VHDL | Scale factor reported; 1 Hz blinker toggles once per simulated second at 50 MHz | scale={'boardClockHz': 50000000, 'simClockHz': 100000000, 'scale': 2.0, 'note': 'simClockHz is the simulated clock rate; a design cycles the same number of clock ticks per simulated second as on the board, so wall-clock… | PASS |
| CLK-04 | Asynchronous active-low reset | VHDL | Reset asserted low clears counter; counting resumes after release | count=8 | PASS |
| CLK-05 | Synchronous reset | VHDL | Reset only acts on the clock edge | count=8 | PASS |
| CLK-06 | Active-high reset | VHDL | Reset high clears counter | count=8 | PASS |
| CLK-07 | Power-on value from a VHDL initializer | VHDL | Register powers up to its declared initializer (5) | q=7 | PASS |
| CLK-08 | Register without initializer powers up to 0 like Cyclone IV | VHDL | q starts at 0 | q='XXXX'; GHDL leaves it X/U instead of 0 | FAIL |
| INP-01 | Each switch individually reaches the matching LED | VHDL | sw[i] -> led[i] for i = 0..7 | 0:0x01 1:0x02 2:0x04 3:0x08 4:0x10 5:0x20 6:0x40 7:0x80 | PASS |
| INP-02 | All 256 switch combinations reach the LEDs | VHDL | led == sw for every value 0..255 (asserted in the testbench) | all 256 values matched (testbench assertions passed) | PASS |
| INP-03 | Button polarity matches the board (idle high, active low) | VHDL | Pressing a key (electrical 0) increments the counter; idle (1) does not | pulse counted 2; UI key click now drives the net low like a real key press | PASS |
| INP-04 | Edge detector sees a press and release | VHDL | One clean press produces exactly one count | count=1 for one press/release | PASS |
| INP-05 | Press shorter than one clock period is missed (documented) | VHDL | A 1 ns pulse between rising edges is not counted | count=0; sub-cycle pulse is not seen by a clocked edge detector | PASS |
| INP-06 | Input changes appear on the next simulation step | VHDL | LED transitions share timestamps with the switch transitions | sw/led transitions aligned: [0.0, 30.0, 60.0] | PASS |
| INP-07 | Rapid toggling does not miss or duplicate edges | VHDL | Key toggling at the clock rate: 10 sampled edges -> exactly 5 rising edges counted | count=5 for 10 sampled edges (5 rising, 5 falling) | PASS |
| OUT-01 | LED patterns: walking one, all on, all off | VHDL | mode 00 -> 0x80, 01 -> 0x40, 10 -> 0xFF, 11 -> 0x00 | 0:0x80 1:0x40 2:0xFF 3:0x00 | PASS |
| OUT-02 | LED polarity is active-high and not configurable | VHDL | Bit 1 lights the LED; no inversion option exists | active-high only; no per-board polarity configuration | PASS |
| OUT-03 | 7-segment hex decoder for digits 0..F | VHDL | All 16 values match the standard active-high segment table | all 16 digits matched | PASS |
| OUT-04 | Segment ordering a-g and dp | VHDL | bit6=a ... bit0=g, bit7=dp; 0 -> 1000000, 1 -> 1111001 | 0=1000000, 1=1111001 (a=MSB, dp=bit7) | PASS |
| OUT-05 | 7-segment polarity follows the board schematic | VHDL | Common anode + PNP digit drivers: DIG=0 selects, SEG=0 lights; the profile and both renderers use it | SEG/DIG active-low with SEG0=a, SEG1=b, SEG2=c, SEG3=d, SEG4=e, SEG5=f, SEG6=g, SEG7=dp applied in profile + renderers | PASS |
| OUT-06 | Multiplexed multi-digit display is scanned correctly | VHDL | Digit select cycles 0,1,2,3 and the segment data follows the selected nibble | dig 1,2,3,0; seg follows nibble 3,2,1,4 | PASS |
| OUT-07 | On-board connectors match the real board; nothing fake is implied | VHDL | VGA/PS2/RS232 exist as board parts; the UI renders no fake state for the buzzer/UART/LCD | real connectors modelled; the buzzer state comes from the board profile | PASS |
| OUT-08 | Unassigned output is shown as U, not as a plain 0 | VHDL | Undriven output reads U in the waveform | q='U' | PASS |
| OUT-09 | Tri-state 'Z' is preserved by the simulator | VHDL | bus and out_val read Z when output is disabled | bus='ZZZZ', out='ZZZZ' | PASS |
| OUT-09B | The 3D/2D board renders X and Z distinctly from 0 | UI | X/Z get a distinct visual state, never a plain off LED | X/Z render as a distinct striped state in 2D and 3D | PASS |
| OUT-10 | 'X' from an uninitialized signal is preserved | VHDL | y reads X | y='X', z='Z' | PASS |
| OUT-11 | Multiple drivers are diagnosed | VHDL | Warning naming multiple drivers | warning: multiple drivers | PASS |
| OUT-12 | Latch inference is diagnosed | VHDL | Warning naming latch inference | warning: latch inferred | PASS |
| OUT-13 | Combinational loop is diagnosed or rejected | VHDL | Clear warning/error; never an apparently normal result | no loop diagnostic; final={'y': 0, 'sim_done': 0, 'a': 0} | FAIL |
| OUT-14 | Delta-cycle ordering is deterministic | VHDL | a and c settle to the same value after delta cycles | a=1, c=1 after settling | PASS |
| HDL-01 | Combinational gates | VHDL | AND/OR/XOR/NAND truth table | y_and=0 y_or=1 y_xor=1 y_nand=1 | PASS |
| HDL-02 | 4:1 multiplexer | VHDL | sel=1 selects d(1)=1 | y=1 | PASS |
| HDL-03 | 4-bit adder with carry | VHDL | 9 + 8 = 17 -> sum=1, cout=1 | sum=1 cout=1 | PASS |
| HDL-04 | Comparator | VHDL | 9 > 8 -> gt=1, lt=0, eq=0 | gt=1 lt=0 eq=0 | PASS |
| HDL-05 | 2-to-4 decoder | VHDL | sel=2 -> 0100 | y=4 | PASS |
| HDL-06 | Priority encoder | VHDL | req=0100 -> grant=2, valid=1; req=0 -> valid=0 | grant=2 valid=1 grant=0 valid=0 | PASS |
| HDL-07 | D flip-flop with async reset | VHDL | d=1 -> q=1; d=0 -> q=0 | q=1 q=0 | PASS |
| HDL-08 | Up counter | VHDL | 3 counts after reset release | count=3 | PASS |
| HDL-09 | Down counter | VHDL | load 5 then 4 decrements -> 1 | count=1 after load 5 and four decrements | PASS |
| HDL-10 | Counter with parallel load | VHDL | load 42 is held | count=42 | PASS |
| HDL-11 | Universal shift register | VHDL | load 0xA5; shift in 1s -> 0xFF | q=165 q=255 | PASS |
| HDL-12 | 8-bit LFSR | VHDL | Known sequence; after 8 shifts from seed 1 -> 28 | q=28 | PASS |
| HDL-13 | Moore traffic-light FSM | VHDL | red -> red+yellow -> green -> yellow | red+yellow -> green -> yellow -> red | PASS |
| HDL-14 | Mealy sequence detector (1011, overlap) | VHDL | detected=1 on the final 1 | detected=1 for 1011 | PASS |
| HDL-15 | Enumerated-state FSM | VHDL | start -> busy -> done | done asserted at cycles [3, 6, 9] | PASS |
| HDL-16 | Generic parameter | VHDL | WIDTH=4 changes the counter width | WIDTH=4 -> q width 4 | PASS |
| HDL-17 | Generate loop | VHDL | Parity bit replicated for each bit | parity=15 | PASS |
| HDL-18 | Function | VHDL | add2(7,5) = 12 | y=12 | PASS |
| HDL-19 | Procedure | VHDL | double_it(21) = 42 | y=42 | PASS |
| HDL-20 | Record type | VHDL | Registered record field follows input | y=13 | PASS |
| HDL-21 | Signed arithmetic | VHDL | -3 + 2 = -1 (15), -3 - 2 = -5 (11) | sum=15 diff=11 | PASS |
| HDL-22 | Signed overflow wrap | VHDL | 7 + 7 wraps to -2 (14) with ovf=1 | sum=14 ovf=1 | PASS |
| HDL-23 | Tri-state bus and inout port | VHDL | oe=1 drives 0xA; oe=0 releases Z | drive=0xA, release='ZZZZ' | PASS |
| HDL-24 | Multiple clock domains | VHDL | 10 ns and 30 ns domains count independently | qa=9 on 10 ns, qb=6 on 30 ns | PASS |
| HDL-25 | Clock-divider output used as a clock | VHDL | div toggling at clk/2 clocks a counter | q=4 | PASS |
| HDL-30 | Delta-cycle ordering | VHDL | a and c settle to 1 | a=1 c=1 | PASS |
| HDL-31 | 'after' in a user design is rejected or warned | VHDL | Clear not-synthesizable warning | not-synthesizable warning present | PASS |
| HDL-32 | Assertion failure in user design is reported with file/line | VHDL | Error with the assertion message and a line number | assertion: QA assertion failure (line reported) | PASS |
| HDL-33 | report note from user design is visible | VHDL | The note text appears in the simulation log | note present in logs | PASS |
| HDL-34 | 'wait for' in a user design is rejected or warned | VHDL | Clear not-synthesizable warning | not-synthesizable warning present | PASS |
| BLK-01 | ALTPLL instantiation is rejected clearly | VHDL | Unbound altpll is an error naming the component, not a silent U output | altpll not bound (clear error) | PASS |
| BLK-02 | ALTPLL output frequency and locked signal | VHDL | Behavioral PLL model produces c0 and locked | no behavioral ALTPLL model | FAIL |
| BLK-03 | Two-PLL limit is reported | VHDL | A design with three PLLs warns about the 2-PLL limit | PLL count checked | PASS |
| BLK-04 | Inferred ROM | VHDL | rom(5) = 5 | q=5 | PASS |
| BLK-05 | Single-port RAM read-after-write | VHDL | Write 0x5A to addr 3; read it back on the next clock | q=0x5A | PASS |
| BLK-06 | Registered RAM read latency | VHDL | q is old data on the write edge and new data on the next edge | cycle0=0, cycle1=0x5A | PASS |
| BLK-07 | Dual-port RAM | VHDL | Port B reads what port A wrote | q_b=0x77 | PASS |
| BLK-08 | M9K init from .mif/.hex file | VHDL | Memory initialized from a .mif or .hex file | memory initialized from rom.mif | PASS |
| BLK-09 | 18x18 multiplier product | VHDL | 3*5=15 and 131071^2=17179607041 | 15 and 17179607041 | PASS |
| BLK-10 | altsyncram megafunction is rejected clearly | VHDL | Unbound altsyncram is an error | altsyncram not bound (clear error) | PASS |
| BLK-11 | lpm_* megafunction is rejected clearly | VHDL | Unbound lpm_counter is an error | lpm_counter not bound (clear error) | PASS |
| BLK-12 | Warning when the design exceeds 6272 LEs | VHDL | Resource warning naming the LE limit (big_regs declares 8192 register bits) | LE warning present | PASS |
| BLK-13 | Warning when the design exceeds 30 M9K blocks | VHDL | Resource warning naming the M9K limit (big_mem infers a 20480x16 array) | M9K warning present | PASS |
| BLK-14 | Warning when the design exceeds 15 multipliers | VHDL | Resource warning naming the multiplier limit | multiplier warning present | PASS |
| BLK-15 | Warning when the design exceeds 91 user I/O | VHDL | Warning naming the 91-pin limit | I/O warning present | PASS |
| ENG-01 | Raw VCD export works from the CLI/keep-dir path | VHDL | VCD file is produced and matches the final LED value | VCD wave.vcd (1277 bytes) | PASS |
| ENG-01B | Waveform export button/endpoint in the web UI | UI | A UI action downloads VCD/FST | no VCD/FST export control in the frontend | FAIL |
| ENG-02 | Waveform matches board state at the same timestamp | VHDL | Cycle samples and final state agree with LED/switch values | all 0 cycles agree (key_edge, 1 press) | PASS |
| ENG-03 | Stop/cancel a running simulation | UI | sim_stop kills the server-side GHDL run and emits sim_stopped within 10 s (the uncanceled long_run fixture needs minutes of wall time) | sim_stopped after 0.16 s; whole cycle 4.8 s (uncanceled run: minutes) | PASS |
| ENG-03B | Stop is a kill, not a wait: GHDL child exits promptly | API | Simulator.cancel() ends a minutes-long run within ~5 s | worker exited 0.1 s after cancel (killed=True) | PASS |
| ENG-04 | Re-upload during a running sim leaves no stale state | VHDL | A second upload starts from a fresh temp directory | 0xFF then 0x00, no stale state | PASS |
| ENG-11 | Server health reports GHDL | API | GET /api/health -> ok | GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition] | PASS |
| ENG-12 | Concurrent HTTP simulations are isolated | API | Two different designs run at the same time without interference | not-gate=0, buffer=1 concurrently | PASS |
| ENG-05 | Runaway design is caught with a message | VHDL | Infinite-loop warning; no hang, server still usable | infinite-loop warning, server healthy | PASS |
| ENG-07 | Uploaded HDL cannot write host files | VHDL | File I/O is blocked or confined to a throw-away directory | absolute-path file write rejected before GHDL (no host file written) | PASS |
| ENG-08 | 3D board assets are present and the page has no obvious errors | UI | three.js loads, board3d.js imports it, WebGL fallback exists | three.js + fallback present (see browser pass for console check) | PASS |
| ENG-09 | All clickable 3D parts respond | UI | LEDs, switches and keys are pickable in the 3D view | 3D parts pickable | PASS |
| ENG-10 | Toggling a switch updates the port on the next simulation step | UI | A click changes the live simulation without re-running | switch click only edits the stimulus config; a re-run is required | FAIL |
| FID-01 | (1) Blinker: logic toggles at the scaled rate | VHDL | CLK_HZ=100, 10 ns clock -> 4 toggles in 2.2 us | 4 toggles in 2.2 us at CLK_HZ=100 | PASS |
| FID-01B | (1) Blinker: 1 Hz at the real 50 MHz board clock | VHDL | One toggle every 0.5 s of wall time; scale factor shown | 1 Hz blinker visible in real time | PASS |
| FID-02 | (2) Switch-to-LED pass-through | VHDL | Every switch state appears on the same LED bit | 0xA5 | PASS |
| FID-03 | (3) Button debounce + counter | VHDL | A held key increments the counter exactly once after the 4-sample filter | count=1 after debounce | PASS |
| FID-04 | (4) 7-segment hex counter | VHDL | Value increments and the multiplexed digits show the current nibble | value=8, seg changed | PASS |
| FID-05 | (5) Knight-rider LED sweep | VHDL | A single lit LED moves across the 8 LEDs and reverses | 9 transitions, endpoints lit | PASS |
| FID-06 | (6) Traffic-light FSM | VHDL | red -> red+yellow -> green -> yellow, one phase per second of cycles | red+yellow -> green -> yellow -> red | PASS |
| FID-07 | (7) PLL-driven blink | VHDL | ALTPLL generates the clock and the LED blinks | ALTPLL unsupported (clear error) | PASS |
| FID-08 | (8) ROM-based display pattern | VHDL | addr=5 shows the pattern for digit 5 | 0b0010010 (digit 5) | PASS |
| SPEC-01 | Clock = pin 23, RESET key = pin 25 active-low (schematic §0a) | VHDL | board map pins CLOCK_50->23, FPGA_RST->25, resetActiveHigh=False; counter runs after release | reset=PIN_25 active-low, clk=PIN_23; counter counts once released | PASS |
| SPEC-02 | KEY/DIP shared nets 88-91, active-low profile | VHDL | board.buttons.pins=PIN_88..91, switches share the KEY port, drive passes through | DIP shares KEY nets 88-91; levels pass through | PASS |
| SPEC-03 | SEG bit map and SEG/DIG pins match the schematic sheet | VHDL | SEG0=a..SEG7=dp; SEG pins 128,121,125,129,132,126,124,127; DIG 133,135,136,137 | SEG/DIG map + LED pins verified against the schematic | PASS |
| SPEC-04 | Buzzer toggling produces a decoded tone on FPGA_BUZZER | VHDL | buzzer_tone at 10 ns clock -> ~2 kHz square wave decoded from pin 110 | tone decoded at 2000 Hz (passive drive model) | PASS |
| SPEC-05 | Buzzer idle high stays silent; type flagged unverified in the UI notes | VHDL | constant 1 on FPGA_BUZZER decodes as no tone; model note says 'unverified on real hardware' | idle = silent; UI note carries the unverified-on-hardware flag | PASS |
| SPEC-06 | AT24C08 write is blocked (WP tied to VCC) on the I2C_SCL/SDA bus | VHDL | write 0x5A to addr 0 is refused; readback stays 0x00; LM75 address NACKs on this bus | write blocked (readback 0x00, no 0x5A in dump); LM75 absent from this bus | PASS |
| SPEC-07 | LM75 answers on its own bus (FPGA_SCL/SDA = 112/113) at 0x48 | VHDL | temperature register reads 0x3200 (25.0 C); EEPROM address NACKs on this bus | LM75 read 0x3200 on pins 112/113; EEPROM absent from this bus | PASS |
| SPEC-08 | board_detect attaches EEPROM and LM75 to their own buses | infra | I2C_* ports -> i2c_eeprom model; FPGA_* ports -> i2c_lm75 model; generic SCL/SDA -> EEPROM bus | EEPROM on 99/98 bus, LM75 on 112/113 bus, generic names -> EEPROM bus | PASS |
| SPEC-09 | UART frames from UART_TXD (114) decode at the design's rate | VHDL | 0x55 ('U') bytes decoded from the MAX3232 TX path | 3 frames of 0x55 decoded, baud~230415 (sim clock) | PASS |
| SPEC-10 | VGA sync + 1-bit RGB decode into a frame | VHDL | 640x480@60: 525 hsync pulses per vsync frame, colour bars sampled | frame decoded, 525 hsync lines | PASS |
| SPEC-11 | Device profile: 91 user I/O, both trainer chips selectable | infra | EP4CE6E22C8N and EP4CE10E22C8N both report 91 user I/O and the handbook resources | 91 user I/O on both variants; resources match the handbook | PASS |
| SPEC-12 | Every pin in vendor/Pinos_RZEasyFPGA.txt matches the profile | infra | clock/reset/keys/LED/SEG/DIG/SDRAM/VGA/PS2/UART/I2C/IR/buzzer/LCD pins all agree | all 86 vendor pins match the simulator profile | PASS |
| BJ-01 | board.json pinMap matches every vendor pin assignment | infra | all 86 vendor pins present with the same PIN numbers | 86 vendor pins match board.json | PASS |
| BJ-02 | Every fact in board.json carries VERIFIED/INFERRED/UNVERIFIED | infra | 34 facts, all tagged, no empty sources | 39 facts tagged: {'INFERRED': 1, 'VERIFIED': 33, 'UNVERIFIED': 5} | PASS |
| BJ-03 | No hard-coded pin numbers in backend or frontend runtime code | infra | zero PIN_<number> literals outside board.json, specs and tests | scanned 16 runtime files, no PIN_<n> literals | PASS |
| BJ-04 | Backend profile is loaded from board.json (not duplicated) | infra | BOARD pins, SEG map, I2C addresses and SDRAM DQ equal board.json | backend BOARD/DEVICE mirror board.json | PASS |
| BJ-05 | All board.json pins are valid EQFP-144 and uniquely owned | infra | every pin in 1..144; only KEY/DIP share pins 88-91 by design | 88 pin entries; only KEY/DIP share nets | PASS |
| BJ-06 | GET /api/board serves the canonical profile to the frontend | infra | endpoint returns the board.json content plus the selected device | /api/board returns board.json + device | PASS |
| POL-01 | LEDs are active-low: driving 0 lights, driving 1 is off | VHDL | LED=0x0 -> all four LEDs lit; LED=0xF -> all off; profile activeLow=true | active-low confirmed: 0 = lit, 1 = off; ledConfig.activeLow=true | PASS |
| POL-02 | KEY and DIP share the net: reads 0 if either is closed | VHDL | NET = KEY AND DIP: 11->1, 01->0, 10->0, 00->0 (RESULT=0xF) | KEY/DIP wired-AND confirmed: 11->1, 01/10/00->0 | PASS |
| POL-03 | 7-segment SEG bit map and active-low polarity render correct glyphs | VHDL | digit 0 -> 0xC0, 1 -> 0xF9, 7 -> 0xF8, 8 -> 0x00 (active-low, SEG0=a..SEG7=dp per board.json) | SEG0=a, SEG1=b ... SEG7=dp with active-low drive renders 0/1/7/8/9/A correctly | PASS |
| POL-04 | Buzzer is active-low: ON = FPGA_BUZZER 0, idle 1 is silent | VHDL | profile activeLow=true; constant 0 and constant 1 both decode as no tone | buzzer active-low: 0 = ON, 1 = silent; DC levels decode as no tone | PASS |
| POL-05 | Active-low conversion happens exactly once (no double/zero inversion) | infra | stimulus value reaches the design unchanged; only the renderer inverts | stimulus reaches the design unchanged; only the renderer inverts (activeLow from board.json) | PASS |
| QF-01 | All four vendor .qsf files parse without errors | QSF | my_and, key_led, ckey_led, led_twinkle each yield pins and no errors | 4 vendor .qsf files parse cleanly | PASS |
| QF-02 | TOP_LEVEL_ENTITY, DEVICE, IO_STANDARD and file lists are parsed | QSF | top=my_top, device=EP4CE6E22C8, IO_STANDARD 3.3-V LVTTL, vhdl+verilog files | top/device/IO_STANDARD/file lists parsed | PASS |
| QF-03 | Comments, whitespace, tabs and mixed case are tolerated | QSF | pins parsed from lines with extra whitespace and comments | comments/whitespace/case handled | PASS |
| QF-04 | A pin used by two different ports is an error | QSF | PIN_88 assigned to LED[0] and KEY[0] -> duplicate-pin error | cross-port duplicate pin rejected | PASS |
| QF-05 | Invalid pin tokens are rejected (0, 145, 999, malformed) | QSF | PIN_0, PIN_145, PIN_999, PIN_AB all produce errors | invalid pin tokens rejected | PASS |
| QF-06 | The same port bit given two pins is an error | QSF | LED[0] = PIN_87 then PIN_86 -> duplicate error | duplicate port slot rejected | PASS |
| QF-07 | A device mismatch is reported | QSF | DEVICE EP4CE10F17C6 -> error naming the fitted chip | wrong device rejected | PASS |
| QF-08 | compile_source uses the .qsf top and reports unknown ports | VHDL+QSF | qsf top overrides the entity; assignment to a missing port is an error | qsf top override + unknown-port error | PASS |
| OD-01 | Open-drain wired-AND: any low wins, release returns high | VHDL | 0&H&H -> 0; H&H&H -> H; two open-drain lows -> 0; push-pull 0 vs 1 -> X (RESULT=0x3F) | wired-AND confirmed: low wins, released line is high, two lows stay low, 0 vs 1 -> X | PASS |
| OD-02 | I2C clock stretching: a slave holding SCL low keeps it low | VHDL | master releases SCL, slave pulls low -> bus stays 0; slave releases -> H | clock stretching confirmed: bus low while slave holds it, high after release | PASS |
| OD-03 | A floating bus with only a pull-up reads H (not X/Z) | VHDL | bus driven only by 'H' resolves to H; undriven inout resolves to Z | pull-up gives H; an undriven line stays Z (high-impedance) | PASS |
| OD-05 | AT24C08 block select: all four control bytes 0xA0-0xA7 ACK | VHDL | block 0 -> 0x11, block 1 -> 0x00, block 2 -> 0x22, block 3 -> 0x00 (RESULT=0x0F) | AT24C08 block-select bits map to word addresses 0/256/512/768 | PASS |
| OD-04 | AT24C08 model: 5 ms write-cycle NACK and 16-byte page wrap | VHDL | ACK, busy-NACK, ACK after 6 ms, readback 0x5A, page wrap correct (RESULT=0x0A) | write cycle NACKs while busy, ACKs after 5 ms; page write wraps inside 16 bytes | PASS |
| PR-01 | UART 8N1: baud, LSB-first data and stop bit | VHDL | 0x55 frames decoded at 115200 baud (434 clocks at 50 MHz) within 1% | 2 frames of 0x55 at 115207 baud (design: 50 MHz / 434) | PASS |
| PR-02 | LM75 registers: temp 0x3200, config 0x0000, Thyst 0x4B00, Tos 0x5000 | VHDL | TEMP=0x3200 (25 C), CONF=0x0000, THYST=0x4B00 (75 C), TOS=0x5000 (80 C) | LM75 registers: temp 0x3200, config 0x0000, Thyst 0x4B00, Tos 0x5000 | PASS |
| PR-03 | PS/2 frame: start=0, 8 data bits LSB first, odd parity, stop=1 | VHDL | STATUS=0xF (parity/start/stop ok, >=2 frames); RESULT=0x5A (last byte) | PS/2 frame format + odd parity verified; 0x5A decoded | PASS |
| PR-04 | VGA 640x480@60: 525 hsync lines per vsync frame | VHDL | frame decoded; lines=525; colour samples present | VGA frame decoded: 525 lines, 8 samples | PASS |
| PR-05 | HD44780: init sequence, E pulse and DDRAM addressing show HELLO | VHDL | lcd_state.txt dump contains HELLO on line 1 | LCD model shows HELLO after the 8-bit init sequence | PASS |
| PR-06 | NEC IR: 9 ms lead burst, 33 bursts, 560 us space for bit 0 | VHDL | LEAD=90000 clocks, COUNT=33, SPACE1=5600 clocks at 100 ns (within 2%) | NEC timing verified: lead 89999, 33 bursts, bit-0 space 5599 clocks | PASS |
| PR-07 | SDRAM: pin map verified; no timing model (documented limitation) | infra | pin map complete (41 pins), timingModeled=false, test defined for real hardware | SDRAM pin map verified; no timing/refresh model (T-SDRAM-1/2 on real hardware) | PASS |
| PR-08 | EPCS16/JTAG: .sof volatile / .pof persistent documented; no model | infra | config semantics present; no programming model (documented limitation) | EPCS16/JTAG semantics documented; no .sof/.pof programming model (external Quartus) | PASS |
| PR-09 | UART echo: a framed 8N1 byte into UART_RXD comes back on UART_TXD | VHDL | exactly 10 frames of 0x5A decoded on TXD at ~115200 baud (50 MHz/434); ECHO_COUNT=10, FRM_ERR=0, LED=0x5 (last echoed byte, active-low) | 10x 0x5A echoed at 115207 baud; ECHO_COUNT=10, FRM_ERR=0, LED=0x5 | PASS |
| PR-10 | UART echo at the wrong baud: receiver rejects the frame, TX stays idle | VHDL | a 0x5A frame at 10x the bit time (11.52 kbaud into a 115.2 kbaud receiver) is never echoed: decode_uart(TXD) reports no bytes/no frames; ECHO_COUNT=0; FRM_ERR=4 (one framing error per low region of the foreign-baud stream) | wrong baud -> no echo (TXD idle, 0 bytes decoded); ECHO_COUNT=0, FRM_ERR=4 | PASS |
| PR-11 | EEPROM reference design (i2c_eeprom_test) runs its full I2C sequence vs the model | VHDL | master clocks the whole write+read sequence without hanging (65 SCL falling edges: write 28 + read 37); WP tied to VCC (board.json writeProtected) blocks the 0x5A write so the readback low nibble is 0 -> LED=0xF; model dump: size=1024, every cell still 00 | I2C master sequence clean (65 SCL falls, no hang); write blocked by WP (readback 0x00 -> LED=0xF); dump size=1024, first 256 bytes all 00 | PASS |
| RB-01 | VHDL parser survives random binary garbage | fuzz | 200 random inputs: no exception, no hang | 200 random inputs parsed without an exception | PASS |
| RB-02 | QSF parser survives garbage and a 1 MB file | fuzz | random garbage + 1 MB input: no exception, bounded time | garbage + 1 MB qsf parsed without an exception (0.15s) | PASS |
| RB-03 | WebSocket survives malformed and unknown messages | WS | invalid JSON -> error; unknown type -> error; ping -> pong; connection stays open | malformed/unknown WS messages rejected; connection stayed open | PASS |
| RB-04 | A huge VHDL file (5k lines) compiles without unbounded memory | VHDL | compile succeeds in bounded time | 5k-line VHDL compiled in 3.93s | PASS |
| RB-05 | HDL textio with literal absolute host paths is rejected | VHDL | the pre-scan rejects the design with a clear error; no host file is written | absolute textio read+write rejected before GHDL (clear error, no host file written) | PASS |
| RB-05B | Relative textio stays confined to the workdir and works | VHDL | a design that writes out.txt (relative) and reads it back passes end-to-end | relative textio write+read round-trips inside the throw-away workdir | PASS |
| RB-06 | Concurrent simulations are isolated | VHDL | two designs run at once; each result matches its own design | two concurrent simulations isolated (not=0, buffer=1) | PASS |
| E2E-01 | Vendor example my_and (led_and): AND truth table | VHDL | c = a AND b for all four input combinations | my_and/led_and: c = a AND b (0,0,0,1) | PASS |
| E2E-02 | Vendor example key_led: case table for the four keys | VHDL | 1110->1110, 1101->1100, 1011->1000, 0111->0000, otherwise 1111 | key_led case table reproduced exactly | PASS |
| E2E-03 | Vendor example ckey_led: LED = ckey (DIP shares KEY nets) | VHDL | ckey=0111 -> LED=0111 (DIP ON lights the LED, active low) | ckey_led: LED follows the DIP (active-low), confirming the shared net | PASS |
| E2E-04 | Vendor example led_twinkle unmodified: 25M-cycle counter, no early toggle | VHDL | over 200 clocks the LEDs stay 1111 (the toggle is at 25,000,000 clocks) | unmodified led_twinkle: LEDs hold 1111 for the first 200 clocks | PASS |
| E2E-05 | led_twinkle toggle logic (simulation-adapted 2500-cycle threshold) | VHDL | with the threshold scaled to 2500 clocks, the LEDs toggle to 0000 | toggle logic verified with a scaled threshold (the full 25M-clock run exceeds the 60 s GHDL budget) | PASS |
| SEM-01 | Delta-cycle ordering: signal updates land on later edges | VHDL | a registered chain a->b->c: at edge 1 only a is new; b/c follow on later edges | signal updates propagate one edge per register: c lags a by two edges (seen=100) | PASS |
| SEM-02 | Variable updates are immediate; signal updates are deferred | VHDL | q_var shows the new input one edge earlier than q_sig | q_var toggles immediately, q_sig one edge behind (16 vs 15 transitions) | PASS |
| SEM-03 | std_logic resolution: 0/1/Z/X/U/H/L/- table | VHDL | 0&Z=0, 1&H=1, H alone=H, L&0=0, 0&1=X, undriven=U (RESULT bit i set per rule) | 0&Z=0, 1&H=1, H=H, L&0=0, 0&1=X, undriven=U — all six rules observed | PASS |
| SEM-04 | Multiple drivers on an unresolved type are a clear error | VHDL | two processes drive one integer signal -> GHDL 'multiple drivers' error, no silent result | rejected with: C:\Users\rober\AppData\Local\Temp\cyclone_qa_worker_ynrakg2d\cache\sources\ab75cbdc3ae731a5155821ba1d791aae30bd435a2e812 | PASS |
| SEM-05 | numeric_std overflow wraps (mod 2^n) | VHDL | unsigned 255+1 -> 0; signed 127+1 -> -128 (10000000) | unsigned 0xFF+1 -> 0x00; signed 0x7F+1 -> 0x80 (two's-complement wrap) | PASS |
| SEM-06 | Generics change width and behaviour | VHDL | WIDTH=12 counter wraps at 4095; WIDTH=4 wraps at 15 | WIDTH=4 -> q=10 (max 15); WIDTH=12 -> q=10 (max 4095); same stimulus | PASS |
| SEM-07 | Generate loop instantiates N parallel slices | VHDL | 8 independent inverter slices; changing one input bit changes exactly that output bit | 8 slices generated; d=0x05 -> 11111010, d=0x01 -> 11111110 (only the toggled bit changed) | PASS |
| SEM-08 | Record and array ports pass structured data | VHDL | record field and array port round-trip through a component (sum via record, concat via array) | record port sum=7 (3+4); array concat=01000011 | PASS |
| CKM-01 | Counter at 50 MHz gives exact cycle counts | VHDL | 50 MHz = 20 ns period; 2000 ns window -> exactly 100 rising edges and q=100 | 100 edges sampled, q=100 (50 MHz, 20 ns period, 2000 ns window) | PASS |
| CKM-02 | Divided clock: /2 divider toggles at half rate | VHDL | clk_div half-period = 2 clock periods; counter on clk_div advances every 4 clocks | clk_div half-period exactly 20 ns at 10 ns clock (steady-state deltas [20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0, 20.0… | PASS |
| CKM-03 | Two clock domains advance independently | VHDL | clk_a at 10 ns and clk_b at 30 ns: 3x more edges on clk_a; both counters advance | clk_a 60 edges vs clk_b 20 edges (3:1), both counters advanced | PASS |
| CKM-04 | PLL: no behavioral model — clear error, documented N/A | VHDL | altpll is rejected with a clear unbound-component error (no PLL model by design) | documented-N/A: no behavioral PLL model; altpll rejected clearly (C:\Users\rober\AppData\Local\Temp\cyclone_qa_worker_ynrakg2d\cache\sources\72fbe5db8681b0a) | PASS |
| MEM-01 | M9K inference: init file + registered read latency | VHDL | rom loaded from the memoryInitFile text (rom.mif), q appears one clock after addr | init file loaded from rom.mif (rom(0)=3, rom(1)=10); registered read shows rom(0) one cycle before rom(1) — read latency observed | PASS |
| MEM-02 | M9K overflow produces a clear resource warning | VHDL | a 20480x16 inferred RAM (~36 M9K) warns it exceeds the 30 M9K blocks | M9K overflow warning present: port 'we' has no pin assignment on the rz-easyfpga a2.2 profile; it is simulated but not mapped to a board device port ' | PASS |
| MEM-03 | Multiplier overflow produces a clear resource warning | VHDL | 16 multiplies warn they exceed the 15 18x18 multipliers | multiplier overflow warning present: port 'a' has no pin assignment on the rz-easyfpga a2.2 profile; it is simulated but not mapped to a board device port 'b | PASS |
| MEM-04 | Register-bit overflow produces a clear LE warning | VHDL | 8192 declared register bits warn they exceed the 6272 logic elements | LE overflow warning present: port 'd' has no pin assignment on the rz-easyfpga a2.2 profile; it is simulated but not mapped to a board device port 'q | PASS |
| PIN-01 | Every board.json pinMap entry reaches the backend pin map and board map | infra | all pinMap ports appear in board_pin_map with the same pins; element classification and polarities come from board.json | 88 pinMap entries mapped; element classification + polarities match board.json | PASS |
| PIN-02 | Every pinMap port can be driven and flips with the driven value (raw, single inversion) | VHDL | two stimulus vectors that differ in every driven bit -> every mapped output pin captures the expected raw level; all pinMap ports appear in the waveform | 75 output pin bits across 36 pinMap ports driven and captured raw (all flipped between vectors); no hidden inversion in the data path | PASS |
| PIN-03 | SEG bit order follows displayConfig.segBitMap; SEG/DIG pins match the profile | VHDL | segBitMap is a bijection of 8 segments; driving the digit-0 pattern yields the board.json-derived SEG value on the SEG pins | SEG0=b..SEG7=dp bijection; digit-0 pattern C0 driven on the SEG pins matches the segBitMap derivation | PASS |
| PIN-04 | LED index order matches the silkscreen order (LED[0]=LED1 ... LED[3]=LED4) | infra | pinMap LED[i] equals board.leds.pins[i] in order; the board map lists LEDs in natural order | LED[0..3] map to silkscreen LED1..LED4 in order (PIN_87, PIN_86, PIN_85, PIN_84) | PASS |
| PIN-05 | KEY/DIP shared nets: pin reads 0 iff key pressed OR dip on (all 16x16 combinations) | VHDL | wired-AND of the two active-low switches: NET = KEY AND DIP for every combination; onValue=0 from board.json | all 256 KEY x DIP combinations read 0 iff key pressed (0) or DIP on (0): wired-AND confirmed | PASS |
| SEG7-01 | Segment and digit polarity are active-low per board.json | VHDL | displayConfig.segmentActiveLow/digitActiveLow true; a driven 0 selects, 1 releases | segment/digit active-low confirmed from the profile and a driven scan | PASS |
| SEG7-02 | Fast scan: all four digits appear lit across sampled cycles | VHDL | scan period << sample window: DIG cycles through all four digits and SEG follows each nibble | fast scan: DIG visited ['0x0', '0x1', '0x2', '0x3']; SEG matched the selected nibble in 200 sampled cycles | PASS |
| SEG7-03 | Slow scan: sampled cycles show a single held digit | VHDL | scan period >> sample window: every sampled cycle in a hold shows the same digit | slow scan: sampled cycles held only 2 digit state(s) (['0xd', '0xe']) | PASS |
| SEG7-04 | Non-simultaneous digit+segment change shows a visible ghosting window | VHDL | documented model behaviour: for a few cycles after the segment changes, the old digit still shows the new segments | documented: segments show the new glyph for 3 sampled cycles (cycles [1, 2, 3]) before the digit select arrives — matches the multiplexed-display ghosting effect | PASS |
| BUZ-01 | Buzzer toggle frequency matches the driven square wave | VHDL | a square wave with a 500 ns half period decodes at 1 MHz (within 1%) | buzzer square wave decoded at 1000000 Hz (driven 1 MHz), tone=True | PASS |
| TRI-01 | Released (high-Z) outputs read Z: LEDs off, buzzer silent | VHDL | tri-stated LED/buzzer pins capture Z; the buzzer decoder reports silence; active-low profile means Z is off | released pins read Z; buzzer silent; per the active-low profile Z lights nothing | PASS |
| PRO-01 | UART 8N1: a bad stop bit is a framing error (byte rejected) | VHDL | a frame whose stop bit is 0 decodes to no byte; the same frame with stop=1 decodes exactly | stop=1 -> 0x5A decoded; stop=0 -> framing error, 0 bytes | PASS |
| PRO-02 | UART: a frame at the wrong bit time is garbage for a locked receiver | VHDL | two frames at different bit times in one capture do not both decode; the wrong-baud frame is lost/garbled | same rate -> [85, 60]; mixed rates -> [85, 224, 248] (wrong baud garbles/loses the frame, as on a real UART) | PASS |
| PRO-03 | VGA: no sync toggles means no signal (bad mode) | VHDL | a design with static VGA pins decodes no frame; decode_vga reports frame=False | bad VGA mode -> no signal (peripherals.vga={'lines': 0, 'frame': False, 'png': None, 'hsync': 1}) | PASS |
| PRO-04 | HD44780: E pulse below PWEH is ignored; busy flag follows the write cycle | VHDL | 100 ns E pulse does not execute the command; 1 us pulse does (busy=1 for 1.52 ms, then clear) | E<450ns ignored, busy=1 during the 1.52 ms cycle, busy clears after; DDRAM dump shows 'LCD:\nA \n \n' | PASS |
| PRO-05 | PS/2 host inhibit: documented limitation (keyboard-hosted model) | infra | the model implements the keyboard as timing master with open-collector data; host-inhibit is not modelled (documented) | documented-N/A: host->device inhibit (clock low >= 100 us) is not modelled; the model implements the keyboard as timing master with open-collector data (frame + odd parity covered by PR-03) | PASS |
| PRO-06 | SDRAM controller timing: documented limitation (pin map only) | infra | board.json marks SDRAM timingModeled=false; init/refresh/CAS are not simulated | documented-N/A: SDRAM init/mode-register/refresh-deadline/bank-CAS timing is not simulated (pin map only); refresh facts 4096 cycles / 64 ms are in the profile and T-SDRAM-1/2 define the physical test | PASS |
| TSC-01 | The reported time scale factor is accurate | VHDL | timeScale.simClockHz = 1e9/clockPeriod and scale = simClockHz/boardClockHz | timeScale reported accurately for 10/20/40 ns clock periods (scale 2.0/1.0/0.5) | PASS |
| TSC-02 | UART baud scales with the clock period | VHDL | the same BAUD_DIV design decodes ~115200 baud at 20 ns and ~57600 baud at 40 ns | UART decoded 115207 baud at 20 ns and 57604 baud at 40 ns (ratio 2.00) | PASS |
| TSC-03 | Buzzer frequency scales with the clock period | VHDL | the same divider design decodes ~1 MHz at 10 ns and ~500 kHz at 20 ns | buzzer decoded 1000000 Hz at 10 ns and 500000 Hz at 20 ns (ratio 2.00) | PASS |
| TSC-04 | VGA line timing scales with the clock period | VHDL | the hsync line period doubles when the pixel clock period doubles (800 pixels/line) | VGA line period 32000 ns at 40 ns clock vs 64000 ns at 80 ns (ratio 2.00) | PASS |
| TSC-05 | 7-segment scan rate scales with the clock period | VHDL | the digit-select toggle period doubles when the clock period doubles | 7-seg digit toggle 20.0 ns at 10 ns clock vs 40.0 ns at 20 ns (ratio 2.00) | PASS |
| DET-01 | The same request twice produces identical waveforms | VHDL | two identical simulations: identical signal transitions, cycles and final state | identical waveforms over 30 cycles (cache hit on the repeat) | PASS |
| DET-02 | Two Simulator instances share no state | VHDL | a cached and an uncached Simulator return identical, independent results | cached and uncached Simulators agree; instance reuse does not leak state | PASS |
| DET-03 | Runs leave no stale temp directories or zombie GHDL processes | infra | temp dir count and ghdl.exe process count return to baseline after simulations | 3 runs: temp dirs 91->87, ghdl processes 2->2 (no zombies, no stale dirs) | PASS |
| RF-01 | Malformed VHDL is rejected with a clear error, never a crash | VHDL | truncated/garbled VHDL -> ok=False with a diagnostic; the server stays usable | 5 malformed sources rejected with diagnostics; backend still healthy | PASS |
| RF-02 | Random binary garbage is handled without a crash | fuzz | 300 random byte strings through simulate/compile: no exception, no hang | 300 random garbage inputs handled without an exception | PASS |
| RF-03 | An oversized upload is handled in bounded time and memory | VHDL | a 2 MB design (valid but huge) compiles without unbounded memory or a hang | 1903 KiB upload compiled in 3.8s | PASS |
| RF-04 | Empty and whitespace-only inputs give a clear error | VHDL | empty source -> 'no entity' style error, not a crash or a silent pass | empty inputs rejected with a clear no-entity error | PASS |
| RF-05 | WebSocket survives hostile message shapes | WS | arrays, strings, numbers, deep nesting and huge payloads all get error replies; the socket stays open | 10 hostile WS messages answered with errors; connection stayed open | PASS |
| RF-06 | A runaway design hits the scaled GHDL timeout with a clear message | VHDL | with GHDL_TIMEOUT=3 the infinite-loop design fails with 'timed out after 3 s' and a runaway hint | runaway design stopped by the scaled timeout in 4.5s: ghdl:0: GHDL timed out after 3 s of wall time — possible runaway design (an infinite loop without a wait statement?) or | PASS |
| RF-07 | Sandbox reality: literal absolute textio paths are rejected; runs stay isolated | VHDL | the pre-scan rejects the design with a clear error, the host file is never read and no temp dir is left behind | Honest statement: the absolute-path design is rejected before GHDL runs (no host read); per-run isolation comes from throw-away tempdirs, and this run left none behind | PASS |
| DIF-01 | Differential: counter - backend vs raw GHDL VCD | VHDL | every port's transition list is identical between the backend waveform and an independent raw GHDL run | counter: 3 ports identical between backend.simulate() and raw GHDL VCD | PASS |
| DIF-02 | Differential: FSM (Moore traffic light) - backend vs raw GHDL VCD | VHDL | every port's transition list is identical between the backend waveform and an independent raw GHDL run | traffic_moore: 5 ports identical between backend.simulate() and raw GHDL VCD | PASS |
| DIF-03 | Differential: dual-port RAM - backend vs raw GHDL VCD | VHDL | every port's transition list is identical between the backend waveform and an independent raw GHDL run | ram_dp: 7 ports identical between backend.simulate() and raw GHDL VCD | PASS |
| DIF-04 | Differential: UART TX - backend vs raw GHDL VCD | VHDL | every port's transition list is identical between the backend waveform and an independent raw GHDL run | uart_tx: 5 ports identical between backend.simulate() and raw GHDL VCD | PASS |
| DIF-05 | Differential: 7-segment decoder - backend vs raw GHDL VCD | VHDL | every port's transition list is identical between the backend waveform and an independent raw GHDL run | seven_segment: 2 ports identical between backend.simulate() and raw GHDL VCD | PASS |
| DIF-06 | Second reference simulator (NVC): availability documented | infra | NVC is used as a second reference if installed; otherwise its absence is documented | documented: NVC is not installed on this machine (pip/winget install attempted unavailable offline); the differential reference is raw GHDL itself, parsed independently of the backend waveform pipeline | PASS |
| VER-01 | Verilog upload produces a clear unsupported-language error | Verilog | a .v file via files[] or vhdl -> 'Verilog/SystemVerilog is not supported', never a crash | Verilog rejected clearly on both the files[] and vhdl paths | PASS |
| QE-01 | Inline comments are stripped; the assignment survives (audit M5) | QSF | pin assignment with a trailing -- comment parses; a commented DEVICE line does not warn | inline -- comment stripped: pin kept, device clean, no mismatch warning | PASS |
| QE-02 | CRLF, tabs and irregular spacing are tolerated | QSF | CRLF line endings and tab runs parse to the same pin map | CRLF/tabs/extra spaces parsed: LED -> PIN_87, PIN_86, PIN_85 | PASS |
| QE-03 | Duplicate assignments: identical is idempotent, conflicting is an error | QSF | the same pin twice on the same port is accepted once; a different pin on the same port errors | identical duplicate idempotent; conflicting duplicate rejected with a duplicate error | PASS |
| QE-04 | Invalid pins: out-of-range, zero, non-numeric and boundary values | QSF | PIN_0, PIN_145, PIN_ABC and PIN_ all error; PIN_1 and PIN_144 are valid | invalid pins rejected; EQFP boundaries PIN_1/PIN_144 accepted | PASS |
| QE-05 | TOP_LEVEL_ENTITY is honoured (quotes and case) and drives the compile top | QSF | quoted lowercase top in the .qsf selects the entity for compile | quoted TOP_LEVEL_ENTITY parsed and used as the compile top | PASS |
| QE-06 | IO_STANDARD checks and missing-file errors are reported | QSF | a non-3.3V standard warns; a .qsf referencing an unuploaded file errors | missing .qsf file errors; non-3.3V IO_STANDARD warns | PASS |

## Failures: root cause, fix, re-test

### Fixed and re-tested during this QA pass

- **BLK-01** ALTPLL instantiation is rejected clearly
  - Root cause: Unbound ALTPLL elaborated with 'U' outputs (binding warning dropped).
  - Fix: -Werror=binding makes it an error naming the component.
  - Re-test: PASS
- **BLK-03** Two-PLL limit is reported
  - Root cause: No PLL-count resource check existed; the estimator covered multipliers, M9K blocks and register bits but not ALTPLL instances, and the case's three-PLL design did not exist (blocks.vhd altpll_top has one PLL).
  - Fix: backend/simulator.py _resource_warnings() now counts ALTPLL instantiations (component declarations excluded) and warns beyond the device limit taken from board.json (ep4ce6: 2 PLLs); new fixture designs/pll_limit.vhd instantiates three ALTPLLs.
  - Re-test: PASS
- **BLK-08** M9K init from .mif/.hex file
  - Root cause: There was no memory-initialization file input.
  - Fix: The backend accepts a memoryInit payload (name + content, e.g. rom.mif), writes it next to the design and the generated testbench loads it.
  - Re-test: PASS
- **BLK-10** altsyncram megafunction is rejected clearly
  - Root cause: Unbound altsyncram elaborated silently.
  - Fix: -Werror=binding.
  - Re-test: PASS
- **BLK-11** lpm_* megafunction is rejected clearly
  - Root cause: Unbound lpm_counter elaborated silently.
  - Fix: -Werror=binding.
  - Re-test: PASS
- **BLK-12** Warning when the design exceeds 6272 LEs
  - Root cause: No logic-element usage estimate existed.
  - Fix: backend/simulator.py _resource_warnings() statically estimates register bits from the design and warns when they exceed the 6272 LEs of the EP4CE6E22C8.
  - Re-test: PASS
- **BLK-13** Warning when the design exceeds 30 M9K blocks
  - Root cause: No M9K usage estimate existed.
  - Fix: The same static estimate infers M9K blocks from memory bits and warns beyond the 30-block limit.
  - Re-test: PASS
- **BLK-14** Warning when the design exceeds 15 multipliers
  - Root cause: No multiplier usage estimate existed.
  - Fix: The same static estimate counts multiply operations and warns beyond the 15 18x18 multipliers.
  - Re-test: PASS
- **BLK-15** Warning when the design exceeds 91 user I/O
  - Root cause: No resource check existed.
  - Fix: Added an I/O-count warning when the top-level ports exceed the 91 user I/O of the EP4CE6E22C8.
  - Re-test: PASS
- **CLK-01** Board clock frequency and pin are modelled
  - Root cause: The simulator never reported a board clock; the profile did not exist.
  - Fix: The board profile carries CLOCK_50 = 50 MHz on PIN_23 and map_board returns clockHz plus the pin assignment.
  - Re-test: PASS
- **CLK-03** Clock scaling makes a 1 Hz blinker visible in real time
  - Root cause: Simulation time was decoupled from board time and no scale factor was reported.
  - Fix: The result now carries a timeScale block (boardClockHz, simClockHz, scale) computed by backend/simulator.py, so wall-clock effects are reported relative to the 50 MHz board clock.
  - Re-test: PASS
- **DEV-01** Device definition EP4CE6E22C8 present and matches datasheet
  - Root cause: No device definition existed anywhere in the code base.
  - Fix: Added backend/device.py (EP4CE6E22C8: 6272 LEs, 30 M9K, 15 multipliers, 2 PLLs, 91 I/O, EQFP-144, 3.3 V LVTTL), a /api/device endpoint and the device in /api/health.
  - Re-test: PASS
- **DEV-02** Pin map internally consistent (no duplicate/invalid pins)
  - Root cause: No pin map existed.
  - Fix: Added the RZ-EasyFPGA A2.2 board profile with the real pin table (taken from the kit's own Pinos_RZEasyFPGA.txt assignment file, mirrored on GitHub); the profile is validated for duplicates/format by this test.
  - Re-test: PASS
- **ENG-02** Waveform matches board state at the same timestamp
  - Root cause: Test-side: the pass-through design had no clock, so the cycle check was vacuous.
  - Fix: Now runs a clocked key-edge design and compares LED against the internal count in every cycle.
  - Re-test: PASS
- **ENG-03** Stop/cancel a running simulation
  - Root cause: Simulations were synchronous request/response jobs: a stop only halted UI playback while the GHDL subprocess kept running to its own wall-clock timeout.
  - Fix: Implemented server-side cancel: GhdlTool registers the running child (Popen) and session.stop() calls Simulator.cancel(), killing GHDL mid-run; the cancelled run is discarded and sim_stopped is emitted (ENG-03, verified live over the WS bridge).
  - Re-test: PASS
- **ENG-07** Uploaded HDL cannot write host files
  - Root cause: GHDL executed std.textio file I/O with process privileges: a design with literal absolute paths read/wrote host files (demonstrated by RB-05 writing %TEMP%).
  - Fix: A pre-scan in backend/simulator.py (_textio_escape_errors, wired into _prepare and compile_source) rejects string literals adjacent to file_open calls and file...is declarations containing drive letters, UNC shares, absolute POSIX paths, '..' segments or %ENV% tokens, with the line number. Relative textio inside the throw-away workdir keeps working (RB-05B). Residual: runtime-computed paths are not covered by the scan.
  - Re-test: PASS
- **ENG-08** 3D board assets are present and the page has no obvious errors
  - Root cause: CRITICAL: board3d.js imported OrbitControls/RoomEnvironment/RoundedBoxGeometry from /static/, but they live in /static/vendor/ - all three imports 404'd, the whole ES-module graph failed, and app.js never executed (no examples, no console, no 3D canvas).
  - Fix: Imports corrected to ./vendor/...; also added Cache-Control: no-cache for static files so stale modules cannot hide regressions.
  - Re-test: PASS (browser: page boots, 7 examples, simulation runs, no console errors)
- **ENG-09** All clickable 3D parts respond
  - Root cause: The 3D board had no raycaster, so LEDs/switches/keys could not be clicked.
  - Fix: The rewritten frontend adds picking for the 3D board parts.
  - Re-test: PASS
- **ENG-09B** 
  - Root cause: initBoard3D(), setView() and all board tool buttons existed but were never called or bound, so even a healthy module graph would never render the 3D board.
  - Fix: init() now calls initBoard3D() + setView('3d'), and bindBoardTools() wires 3D/2D, focus-display, reset-view, orbit and timing.
  - Re-test: PASS (browser-verified)
- **FID-01B** (1) Blinker: 1 Hz at the real 50 MHz board clock
  - Root cause: Same root cause as CLK-03: no scale metadata and no real-time path for a 25M-cycle toggle.
  - Fix: timeScale plus the real-time render path makes the 1 Hz blink at 50 MHz visible in wall time.
  - Re-test: PASS
- **HDL-16** Generic parameter
  - Root cause: The auto testbench declared signals as unsigned(WIDTH-1 downto 0) without declaring the generic, so every generic design failed to compile.
  - Fix: The testbench generator now emits 'constant WIDTH : integer := <default>;' for each generic.
  - Re-test: PASS
- **HDL-31** 'after' in a user design is rejected or warned
  - Root cause: 'after 5 ns' in a user design was silently accepted although it is not synthesizable.
  - Fix: Added a static scan of the user source that warns for after, wait for, assert and report.
  - Re-test: PASS
- **HDL-34** 'wait for' in a user design is rejected or warned
  - Root cause: 'wait for' in a user design was silently accepted.
  - Fix: Same not-synthesizable scan as HDL-31.
  - Re-test: PASS
- **IN-02** Single .v (Verilog) upload gives a clear not-supported error
  - Root cause: Backend accepted any text and only reported 'No entity declaration found'.
  - Fix: Added a source pre-check that returns an explicit 'Verilog/SystemVerilog is not supported (VHDL-only GHDL)' error.
  - Re-test: PASS
- **IN-04** Multi-file project upload (separate .vhd files)
  - Root cause: The API only accepted a single vhdl string; a second file could not be uploaded at all.
  - Fix: Added a files array to /api/compile and /api/simulate: every file is written, analysed together, entities merged and the top elaborated.
  - Re-test: PASS
- **IN-05** Quartus .qsf upload is parsed and honored
  - Root cause: QSF text was treated as VHDL and produced a misleading 'No entity declaration found'.
  - Fix: Source pre-check now returns an explicit 'Quartus project/settings files (.qpf/.qsf) are not supported' error.
  - Re-test: PASS
- **IN-05B** QSF pin/top/IO-standard/file-list parsing is complete
  - Root cause: No Quartus project reader existed; QSF upload was rejected outright (see IN-05 above).
  - Fix: Added backend/qsf_parser.py: set_location_assignment tokens, TOP_LEVEL_ENTITY, IO_STANDARD and the file list are parsed, validated (QF-03..QF-05) and honoured during simulation.
  - Re-test: PASS
- **IN-06** 
  - Root cause: _select_entity silently fell back to the first entity when the requested top was not found, so a wrong design was simulated.
  - Fix: Top selection is now strict: a requested top that does not exist is an error.
  - Re-test: PASS
- **IN-08** QSF pin assignments are validated against the top-level ports
  - Root cause: Same root cause as IN-05B: QSF was not parsed, so per-pin validation could not exist.
  - Fix: The QSF parser validates every pin token, rejects invalid/duplicate pins and unknown ports with specific errors, and honours assignments to ports that exist.
  - Re-test: PASS
- **IN-10** Verilog syntax error reports file and line
  - Root cause: Verilog syntax errors produced the generic 'no entity' message.
  - Fix: Same Verilog pre-check as IN-02.
  - Re-test: PASS
- **IN-11** Unsupported Altera primitive gives a clear error
  - Root cause: GHDL's -Wbinding warning for unbound components was parsed but dropped, so ALTPLL designs simulated with 'U' outputs.
  - Fix: GHDL now runs with -Werror=binding; unbound components are hard errors naming the instance.
  - Re-test: PASS
- **IN-12** Mixed-language project (VHDL top + Verilog submodule)
  - Root cause: Mixed VHDL+Verilog input produced a VHDL syntax error instead of a clear statement.
  - Fix: Pre-check detects Verilog keywords inside a source that also contains an entity and reports 'mixed-language projects are not supported'.
  - Re-test: PASS
- **INP-03** Button polarity matches the board (idle high, active low)
  - Root cause: The UI click-to-set drove the key port to 1 although the board keys pull the net to GND (active-low, F07 in board.json).
  - Fix: The 2D board key click now drives the net low like a real press; the control mapping is covered by POL-05.
  - Re-test: PASS
- **INP-04** Edge detector sees a press and release
  - Root cause: Test-side: the pulse ended exactly on a clock edge, so the detector sampled the old value.
  - Fix: Rebuilt the testbench (tb_edge.vhd) with the press offset from the clock edges.
  - Re-test: PASS
- **INP-07** Rapid toggling does not miss or duplicate edges
  - Root cause: Test-side: key and clock toggled at the same instants, a classic VHDL race.
  - Fix: Rebuilt tb_rapid.vhd with the key offset 7 ns; expectation corrected to 5 rising edges out of 10 sampled.
  - Re-test: PASS
- **OUT-05** 7-segment polarity follows the board schematic
  - Root cause: The renderers used a fixed active-high segment bit map that does not match this board.
  - Fix: board.json is the single source: segmentActiveLow/digitActiveLow and the SEG0=a..SEG7=dp bit map now drive the profile and both renderers (POL-01/POL-03/BJ-04/BJ-06).
  - Re-test: PASS
- **OUT-07** On-board connectors match the real board; nothing fake is implied
  - Root cause: Test-side: the new board model includes the real VGA connector, which the old phantom-peripheral check rejected.
  - Fix: Check updated: VGA is a physical connector on the board, not a simulated interface.
  - Re-test: PASS
- **OUT-09B** The 3D/2D board renders X and Z distinctly from 0
  - Root cause: bitAt() coerced X/Z strings to 0, so unknown signals rendered as plain off LEDs.
  - Fix: Both renderers now have a third, distinct 'unknown' LED state (striped blue-grey) driven by X/Z/U values.
  - Re-test: PASS
- **OUT-11** Multiple drivers are diagnosed
  - Root cause: GHDL reports multiple drivers only in synthesis mode and the simulator dropped those diagnostics.
  - Fix: Added a GHDL --synth lint pass; latch and multiple-assignment findings are surfaced as warnings.
  - Re-test: PASS
- **OUT-12** Latch inference is diagnosed
  - Root cause: Latch inference was invisible (GHDL only reports it in synthesis mode).
  - Fix: Same --synth lint pass as OUT-11.
  - Re-test: PASS

### Remaining failures (verified limitations, not fixed)

- **BLK-02** ALTPLL output frequency and locked signal
  - There is no behavioral ALTPLL model; designs containing it fail elaboration with a clear 'not bound' error.
- **CLK-08** Register without initializer powers up to 0 like Cyclone IV
  - GHDL leaves registers without a VHDL initializer at X/U. Cyclone IV powers them to 0. The simulator shows X honestly instead of faking 0.
- **ENG-01B** Waveform export button/endpoint in the web UI
  - The raw VCD is produced (ENG-01) but there is no UI export button or download endpoint.
- **ENG-10** Toggling a switch updates the port on the next simulation step
  - Clicking a switch in the 2D board edits the stimulus configuration; the change reaches the design on the next simulation run, not on a live step.
- **OUT-13** Combinational loop is diagnosed or rejected
  - A combinational loop (a <= not a) neither hangs nor produces a diagnostic; GHDL resolves it to a stable value and the simulator reports it as a normal result. Not detected.

## Known limitations vs a real EP4CE6E22C8 board

1. VHDL only. Verilog/SystemVerilog and mixed-language projects are rejected with a clear message.
2. No synthesis, place-and-route or timing analysis; GHDL is a simulator, not a bitstream generator.
3. Registers without a VHDL initializer show X/U instead of the FPGA power-on 0 (CLK-08).
4. Combinational loops are not diagnosed: GHDL settles a <= not a to a stable value and the run reports normally (OUT-13).
5. ALTPLL has no behavioral model (BLK-02); the 2-PLL resource limit IS checked by a static estimator against the board.json device figure (BLK-03); altsyncram/lpm_* megafunctions are rejected with a clear binding error.
6. No UI waveform export (ENG-01B). Server-side stop/cancel is implemented (ENG-03).
7. 2D switch/key clicks edit the stimulus configuration and reach the design only on the next run (ENG-10).
8. Textio file I/O: literal absolute paths (drive letters, UNC, '..', %ENV%) are rejected by a pre-scan before GHDL runs (ENG-07/RB-05) and relative paths stay inside the throw-away workdir (RB-05B), but runtime-computed paths (e.g. concatenated strings) can still reach the host FS - only simulate trusted HDL (ENG-07 residual).
9. The 50 MHz board clock is metadata; the simulation itself runs at the user-chosen clock period (timeScale reports the sim/board ratio).
10. SDRAM has a pin map only: init/mode-register/refresh-deadline/bank-CAS timing is not simulated (board.json marks timingModeled=false). PRO-06 and PR-07 verify the 41-pin map and the profile facts; a functional SDRAM test needs real hardware (T-SDRAM-1/2 in board/real_board_tests.md). No simulator-side SDRAM design is provided, by design.

## Verdict

**Trust (verified by executed tests):**

- VHDL-2008 compile/elaborate/simulate through GHDL, including generics, generate,
  functions/procedures, records, signed arithmetic, tri-states, multiple clock domains,
  derived clocks, FSMs, inferred RAM/ROM and 18x18 multipliers.
- Clock/reset semantics (async/sync, active-high/low) and VHDL power-on initializers.
- Board mapping and the rebuilt 3D/2D RZ-EasyFPGA A2.2 model: 4 LEDs, 4 keys, the red
  4-position DIP, the 4-digit multiplexed seven-segment tube, VGA, PS/2, RS232, buzzer,
  IR receiver, SDRAM, EPCS16 config flash and the four yellow expansion headers, with the
  datasheet device limits attached to every result.
- Error and warning paths: syntax errors with file/line, missing top, Verilog rejection,
  unbound megafunctions, assertion failures, latch and multiple-driver warnings,
  non-synthesizable-construct warnings, missing-pin warnings, I/O over-limit.
- Engine robustness: 5-minute soak (1641 simulations, 0 failures), 40 back-to-back HTTP runs
  with ~1.4 MB RSS drift, concurrent sessions isolated, runaway design diagnosed without
  hanging the server.
- Raw VCD production and waveform/board consistency.

**Do not trust (verified gaps):**

- Anything Verilog or mixed-language, behavioral PLL/megafunction behaviour,
  server-side stop/cancel, UI waveform export, live switch toggling without a re-run,
  runtime-computed textio paths reaching the host FS (the literal-path class is
  rejected - ENG-07), and SDRAM behaviour (pin map only - PRO-06/PR-07; physical
  test T-SDRAM-1/2).

## Artifacts

- `tests/run_all.py` - one-command runner
- `tests/RESULTS.md` - generated evidence table
- `tests/qa/designs/` - every VHDL test design and custom testbench
- `tests/qa/soak.py` - long-run stability soak
- `examples/a22_demo.vhd` - exercises every A2.2 peripheral
- Board reference: github.com/jvitkauskas/Altera-Cyclone-IV-board-V3.0 and
  github.com/dualvim/KitEasyFPGA_EP4CE6 (pin table + annotated board photo)
- Browser evidence: in-app screenshots (desktop + 390x844 mobile) captured during this QA pass


## Reconciliation audit (schematic ground-truth pass, this session)

`board/board_spec.md` was rebuilt from the vendor schematic with per-row
VERIFIED / INFERRED / UNVERIFIED tags, and every fact the simulator claims was
re-audited against it. New QA module: `tests/qa/test_spec_fidelity.py`
(cases SPEC-01..SPEC-12, all PASS). Full suite: **107/122 PASS** - the 15
failures are the previously documented limitations (clock scaling, ALTPLL,
.mif init, LE/M9K/multiplier estimates, VCD export, server stop, 3D picking,
live switch clicks, HDL file-I/O sandbox, GHDL X power-on) - no new
regressions. (Historical tally from that pass: clock scaling, .mif init, the
LE/M9K/multiplier estimates and 3D picking have since been implemented; the
Results table above reflects the current suite.)

### Defects found by the audit and fixed

1. **I2C bus topology was wrong.** The testbench generator hung the AT24C08
   *and* the LM75 on one bus; the schematic has two separate buses
   (EEPROM on I2C_SCL/I2C_SDA = 99/98, LM75 on FPGA_SCL/FPGA_SDA = 112/113).
   Fixed in `backend/board_detect.py` + `backend/testbench_gen.py`
   (kinds `i2c_eeprom` / `i2c_lm75`, generic SCL/SDA falls back to the
   EEPROM bus). Verified by SPEC-07/08.
2. **EEPROM write-protect was not modelled.** The board ties WP (U8 pin 7) to
   VCC, so the real chip is read-only. The model supports `wp` but the
   generated testbench left it '0'. Now instantiated with `wp => '1'`;
   `device.py` carries `writeProtected: true`. Verified by SPEC-06.
3. **AT24C08 model FSM was dead code.** The ACK_ADDR/ACK_WORD/ACK_DATA states
   were never entered (no state transitions), so no transaction could ever
   complete; the read path also shifted bits one SCL edge late and drove data
   inverted (0-bit drove low, 1-bit released - correct open-drain, but the
   read sampler expectations were inverted relative to the master). Rewritten
   with explicit state transitions and correct falling-edge shift timing.
4. **Both I2C slave models never saw clock edges on a weak-'H' bus.** They
   used `scl = '1'` and `rising_edge/falling_edge(scl)`, which never match a
   'H'/'0' line. Rewritten to compare `to_x01(scl)` with explicit edge
   detection.
5. **LM75 address decoder checked the wrong nibble** ("1000" instead of
   "1001" - the LM75 base address is 0x48 = 1001_000). Reads now ACK at 0x48
   (SPEC-07: temperature register reads 0x3200 for 25.0 C).
6. **Slave models held SDA low through the master's STOP** after a read of
   0x00 bytes, wedging the bus. They now release SDA in the master-ACK slot
   and only re-drive when the master's ACK was sampled on the rising edge.
7. **HD44780 model crashed on line-2 writes** (DDRAM string indexed past its
   80-char bound) and rendered line 2 from the wrong addresses. Buffer grows
   to 104 chars, line 2 maps to DDRAM 0x40.., and the address counter wraps
   0x27 -> 0x40.
8. **Test-fixture bugs** (never exercised before): `board/uart_tx.vhd`
   double-assigned the shifter so no frame ever left the wire, and lacked
   inter-frame idle; `board/i2c_eeprom_test.vhd` had an illegal
   `signal :=` assignment, a `natural + std_logic` add, a broken repeated
   START and a read loop that sampled before clocking SCL high. Fixed; new
   probe designs `board/i2c_eeprom_wp.vhd` and `board/i2c_lm75_read.vhd`
   bit-bang the real sequences and assert both bus separation and the
   write-block.
9. **`detect_reset` did not recognize the board's `FPGA_RST` port name** and
   defaulted to active-high. It now matches the board profile port and uses
   the board's active-low polarity (SPEC-01).
10. **Time-typed generics in generated testbenches were rendered as string
    literals** (`constant HALFPERIOD : time := "5 us";` - GHDL compile
    error). `_generic_literal` now emits physical literals unquoted.
11. **UI labelling:** `/api/device` and `/api/health` now carry `modelNotes`;
    the web UI prints them at startup, with WARN styling for every behaviour
    that is unverified on real hardware (buzzer type, PS/2 device, IR
    protocol) per the reconciled spec.

### Reconciliation answers (details in board_spec.md section 0)

- RESET key -> pin 25 (CLK3/DIFFCLK_1n), active-low, R2 10k + C10 100nF.
- Resistor designators: key series R34-R37 (220R), key pull-ups R38-R41,
  DIP pull-ups R42-R45, 7-seg digit bases R46-R49, segments R50-R57 (220R),
  LEDs R30-R33 (470R). The old spec's "R46-R49 for DIP" was wrong.
- The EEPROM and LM75 are on TWO SEPARATE I2C buses (99/98 vs 112/113).
- AT24C08 WP is tied to VCC: writes are blocked on real hardware.
- DB9: TX on pin 7, RX on pin 8, GND 5 - non-standard (PC: 2/3/5); a
  crossover adapter is required.
- Buzzer: drive circuit verified (single 8550, no on-board oscillator,
  active-low); the fitted part type stays UNVERIFIED (physical test
  T-BUZZER-1).
- GPIO: 91 user I/O, all used/brought out (86 peripheral + 6/8/13 config +
  24/111 on P1). The old "92" was a miscount (CONF_DONE is literally pin 92).
- Instructor table, vendor pin file and all four vendor .qsf files agree
  1:1; the only shared pins are the by-design KEY/DIP nets (88-91).
