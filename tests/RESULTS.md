# QA results

Generated: 2026-11-13 18:50:55
GHDL: GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition]
Total: 122  PASS: 107  FAIL: 15

| ID | Description | Lang | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| DEV-01 | Device definition EP4CE6E22C8 present and matches datasheet | n/a | Simulator declares 6272 LEs, 30 M9K, 15 multipliers, 2 PLLs, 91 I/O, EQFP-144, 3.3V LVTTL | device profile present | PASS |
| DEV-02 | Pin map internally consistent (no duplicate/invalid pins) | n/a | A pin map exists with unique, package-valid pins for LEDs, switches, keys, segments and clock | 46 named ports, 86 distinct pins, all valid EQFP numbers | PASS |
| IN-01 | Single .vhd upload loads and simulates | VHDL | Design compiles, entity/ports extracted, board mapped | led=0xA5, board=['led']/['sw'] | PASS |
| IN-02 | Single .v (Verilog) upload gives a clear not-supported error | Verilog | Error names Verilog as unsupported, with file/line | ?:1: Verilog/SystemVerilog is not supported: the simulator compiles VHDL only (GHDL). Rewrite the module in VHDL. | PASS |
| IN-03 | Multi-entity project (several entities in one upload) loads | VHDL | Top entity selected, all units analysed | mux4 selected from 6-entity file | PASS |
| IN-04 | Multi-file project upload (separate .vhd files) | VHDL | API accepts a file list, analyses all units, elaborates the top | leaf.vhd + top.vhd analysed; top elaborated | PASS |
| IN-05 | Quartus .qsf upload is parsed and honored | QSF | Pins, TOP_LEVEL_ENTITY, file list and unused-pin policy extracted from the vendor .qsf; sources uploaded alongside simulate with the QSF pin assignments | vendor ckey_led.qsf honoured: top, 8 pin assignments, IO policy; LED=ckey simulated | PASS |
| IN-05B | QSF pin/top/IO-standard/file-list parsing is complete | QSF | TOP_LEVEL_ENTITY, 8 pin assignments, IO_STANDARD and file list all visible in the result | top, 8 pins, IO_STANDARD and file list parsed from the vendor .qsf | PASS |
| IN-05C | QSF errors: invalid pin, duplicate pin, unknown port, wrong device | QSF | Each problem produces a specific error naming the pin/port; the simulation does not start | 4 specific errors: invalid pin, duplicate pin, unknown port, wrong device | PASS |
| IN-08 | QSF pin assignments are validated against the top-level ports | QSF | A pin assigned to a port that exists is honoured; the missing-pin warning stays quiet for those ports | no unpinned-port warnings for ports the .qsf assigns | PASS |
| IN-09 | VHDL syntax error reports file and line | VHDL | GHDL diagnostic with line number, no crash | ?:3: Expected ':' in interface declaration \| ?:1: Unexpected end of file inside entity declaration \| C:\Users\rober\AppData\Local\Temp\cyclone_compile_jaxnxgih\design.vhd:3: interface declaration expected \| C:\Users\rob… | PASS |
| IN-10 | Verilog syntax error reports file and line | Verilog | Diagnostic with line number naming Verilog | ?:1: Verilog/SystemVerilog is not supported: the simulator compiles VHDL only (GHDL). Rewrite the module in VHDL. | PASS |
| IN-11 | Unsupported Altera primitive gives a clear error | VHDL | Error names the unbound Altera megafunction (altpll/altsyncram) | c:\users\rober\appdata\local\temp\cyclone_sim_6mv6jzb_\design.vhd:33: instance "u_pll" of component "altpll" is not bound \| c:\users\rober\appdata\local\temp\cyclone_sim_6mv6jzb_\design.vhd:12: (in default configuration… | PASS |
| IN-12 | Mixed-language project (VHDL top + Verilog submodule) | VHDL+Verilog | Supported, or a clear 'mixed language not supported' error | ?:1: mixed-language projects are not supported: the simulator compiles vhdl only (ghdl). move the verilog/systemverilog module to vhdl. | PASS |
| CLK-01 | Board clock frequency and pin are modelled | VHDL | CLOCK_50 = 50 MHz on pin PIN_23; the result reports the board frequency | CLOCK_50 = 50 MHz on PIN_23 | PASS |
| CLK-02 | Counter at the real clock rate matches expected count after N ms | VHDL | 100 ns at 10 ns period, reset 2 cycles -> count = 8 | count=8 after 100 ns | PASS |
| CLK-03 | Clock scaling makes a 1 Hz blinker visible in real time | VHDL | Scale factor reported; 1 Hz blinker toggles once per simulated second at 50 MHz | no scale factor reported; result keys=['board', 'duration', 'entity', 'errors', 'logs', 'ok', 'peripherals', 'qsf', 'top', 'warnings', 'waveforms'] | FAIL |
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
| OUT-05 | 7-segment polarity follows the board schematic | VHDL | Common anode + PNP digit drivers: DIG=0 selects, SEG=0 lights; the profile and both renderers use it | SEG/DIG active-low with SEG0=b, SEG1=a, SEG2=c, SEG3=d, SEG4=e, SEG5=f, SEG6=g, SEG7=dp applied in profile + renderers | PASS |
| OUT-06 | Multiplexed multi-digit display is scanned correctly | VHDL | Digit select cycles 0,1,2,3 and the segment data follows the selected nibble | dig 1,2,3,0; seg follows nibble 3,2,1,4 | PASS |
| OUT-07 | On-board connectors match the real board; nothing fake is implied | VHDL | VGA/PS2/RS232 exist as board parts; the UI renders no fake state for the buzzer/UART/LCD | real connectors modelled; no fake peripheral state in the UI | PASS |
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
| BLK-03 | Two-PLL limit is reported | VHDL | A design with three PLLs warns about the 2-PLL limit | no PLL resource check | FAIL |
| BLK-04 | Inferred ROM | VHDL | rom(5) = 5 | q=5 | PASS |
| BLK-05 | Single-port RAM read-after-write | VHDL | Write 0x5A to addr 3; read it back on the next clock | q=0x5A | PASS |
| BLK-06 | Registered RAM read latency | VHDL | q is old data on the write edge and new data on the next edge | cycle0=0, cycle1=0x5A | PASS |
| BLK-07 | Dual-port RAM | VHDL | Port B reads what port A wrote | q_b=0x77 | PASS |
| BLK-08 | M9K init from .mif/.hex file | VHDL | Memory initialized from a .mif or .hex file | no memory-init file input exists | FAIL |
| BLK-09 | 18x18 multiplier product | VHDL | 3*5=15 and 131071^2=17179607041 | 15 and 17179607041 | PASS |
| BLK-10 | altsyncram megafunction is rejected clearly | VHDL | Unbound altsyncram is an error | altsyncram not bound (clear error) | PASS |
| BLK-11 | lpm_* megafunction is rejected clearly | VHDL | Unbound lpm_counter is an error | lpm_counter not bound (clear error) | PASS |
| BLK-12 | Warning when the design exceeds 6272 LEs | VHDL | Resource warning naming the LE limit | no LE resource warning | FAIL |
| BLK-13 | Warning when the design exceeds 30 M9K blocks | VHDL | Resource warning naming the M9K limit | no M9K resource warning | FAIL |
| BLK-14 | Warning when the design exceeds 15 multipliers | VHDL | Resource warning naming the multiplier limit | 16 multipliers produced no warning: "port 'a' has no pin assignment on the rz-easyfpga a2.2 profile; it is simulated but not mapped to a board device port 'b' has no pin assignment on the rz-easyfpga a2.2 profile; it is… | FAIL |
| BLK-15 | Warning when the design exceeds 91 user I/O | VHDL | Warning naming the 91-pin limit | I/O warning present | PASS |
| ENG-01 | Raw VCD export works from the CLI/keep-dir path | VHDL | VCD file is produced and matches the final LED value | VCD wave.vcd (1277 bytes) | PASS |
| ENG-01B | Waveform export button/endpoint in the web UI | UI | A UI action downloads VCD/FST | no VCD/FST export control in the frontend | FAIL |
| ENG-02 | Waveform matches board state at the same timestamp | VHDL | Cycle samples and final state agree with LED/switch values | all 0 cycles agree (key_edge, 1 press) | PASS |
| ENG-03 | Stop/cancel a running simulation | UI | Stop aborts the server-side GHDL run and clears state | no server-side stop/cancel endpoint | FAIL |
| ENG-04 | Re-upload during a running sim leaves no stale state | VHDL | A second upload starts from a fresh temp directory | 0xFF then 0x00, no stale state | PASS |
| ENG-11 | Server health reports GHDL | API | GET /api/health -> ok | GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition] | PASS |
| ENG-12 | Concurrent HTTP simulations are isolated | API | Two different designs run at the same time without interference | not-gate=0, buffer=1 concurrently | PASS |
| ENG-05 | Runaway design is caught with a message | VHDL | Infinite-loop warning; no hang, server still usable | infinite-loop warning, server healthy | PASS |
| ENG-07 | Uploaded HDL cannot write host files | VHDL | File I/O is blocked or confined to a throw-away directory | uploaded HDL wrote C:\Users\rober\AppData\Local\Temp\cyclone_qa_escape.txt outside the sandbox | FAIL |
| ENG-08 | 3D board assets are present and the page has no obvious errors | UI | three.js loads, board3d.js imports it, WebGL fallback exists | three.js + fallback present (see browser pass for console check) | PASS |
| ENG-09 | All clickable 3D parts respond | UI | LEDs, switches and keys are pickable in the 3D view | no raycaster/click handling in the 3D board | FAIL |
| ENG-10 | Toggling a switch updates the port on the next simulation step | UI | A click changes the live simulation without re-running | switch click only edits the stimulus config; a re-run is required | FAIL |
| FID-01 | (1) Blinker: logic toggles at the scaled rate | VHDL | CLK_HZ=100, 10 ns clock -> 4 toggles in 2.2 us | 4 toggles in 2.2 us at CLK_HZ=100 | PASS |
| FID-01B | (1) Blinker: 1 Hz at the real 50 MHz board clock | VHDL | One toggle every 0.5 s of wall time; scale factor shown | no clock scale factor reported | FAIL |
| FID-02 | (2) Switch-to-LED pass-through | VHDL | Every switch state appears on the same LED bit | 0xA5 | PASS |
| FID-03 | (3) Button debounce + counter | VHDL | A held key increments the counter exactly once after the 4-sample filter | count=1 after debounce | PASS |
| FID-04 | (4) 7-segment hex counter | VHDL | Value increments and the multiplexed digits show the current nibble | value=8, seg changed | PASS |
| FID-05 | (5) Knight-rider LED sweep | VHDL | A single lit LED moves across the 8 LEDs and reverses | 9 transitions, endpoints lit | PASS |
| FID-06 | (6) Traffic-light FSM | VHDL | red -> red+yellow -> green -> yellow, one phase per second of cycles | red+yellow -> green -> yellow -> red | PASS |
| FID-07 | (7) PLL-driven blink | VHDL | ALTPLL generates the clock and the LED blinks | ALTPLL unsupported (clear error) | PASS |
| FID-08 | (8) ROM-based display pattern | VHDL | addr=5 shows the pattern for digit 5 | 0b0010010 (digit 5) | PASS |
| SPEC-01 | Clock = pin 23, RESET key = pin 25 active-low (schematic §0a) | VHDL | board map pins CLOCK_50->23, FPGA_RST->25, resetActiveHigh=False; counter runs after release | reset=PIN_25 active-low, clk=PIN_23; counter counts once released | PASS |
| SPEC-02 | KEY/DIP shared nets 88-91, active-low profile | VHDL | board.buttons.pins=PIN_88..91, switches share the KEY port, drive passes through | DIP shares KEY nets 88-91; levels pass through | PASS |
| SPEC-03 | SEG bit map and SEG/DIG pins match the schematic sheet | VHDL | SEG0=b..SEG7=dp; SEG pins 128,121,125,129,132,126,124,127; DIG 133,135,136,137 | SEG/DIG map + LED pins verified against the schematic | PASS |
| SPEC-04 | Buzzer toggling produces a decoded tone on FPGA_BUZZER | VHDL | buzzer_tone at 10 ns clock -> ~2 kHz square wave decoded from pin 110 | tone decoded at 2000 Hz (passive drive model) | PASS |
| SPEC-05 | Buzzer idle high stays silent; type flagged unverified in the UI notes | VHDL | constant 1 on FPGA_BUZZER decodes as no tone; model note says 'unverified on real hardware' | idle = silent; UI note carries the unverified-on-hardware flag | PASS |
| SPEC-06 | AT24C08 write is blocked (WP tied to VCC) on the I2C_SCL/SDA bus | VHDL | write 0x5A to addr 0 is refused; readback stays 0x00; LM75 address NACKs on this bus | write blocked (readback 0x00, no 0x5A in dump); LM75 absent from this bus | PASS |
| SPEC-07 | LM75 answers on its own bus (FPGA_SCL/SDA = 112/113) at 0x48 | VHDL | temperature register reads 0x3200 (25.0 C); EEPROM address NACKs on this bus | LM75 read 0x3200 on pins 112/113; EEPROM absent from this bus | PASS |
| SPEC-08 | board_detect attaches EEPROM and LM75 to their own buses | infra | I2C_* ports -> i2c_eeprom model; FPGA_* ports -> i2c_lm75 model; generic SCL/SDA -> EEPROM bus | EEPROM on 99/98 bus, LM75 on 112/113 bus, generic names -> EEPROM bus | PASS |
| SPEC-09 | UART frames from UART_TXD (114) decode at the design's rate | VHDL | 0x55 ('U') bytes decoded from the MAX3232 TX path | 3 frames of 0x55 decoded, baud~230415 (sim clock) | PASS |
| SPEC-10 | VGA sync + 1-bit RGB decode into a frame | VHDL | 640x480@60: 525 hsync pulses per vsync frame, colour bars sampled | frame decoded, 525 hsync lines | PASS |
| SPEC-11 | Device profile: 91 user I/O, both trainer chips selectable | infra | EP4CE6E22C8N and EP4CE10E22C8N both report 91 user I/O and the handbook resources | 91 user I/O on both variants; resources match the handbook | PASS |
| SPEC-12 | Every pin in vendor/Pinos_RZEasyFPGA.txt matches the profile | infra | clock/reset/keys/LED/SEG/DIG/SDRAM/VGA/PS2/UART/I2C/IR/buzzer/LCD pins all agree | all 86 vendor pins match the simulator profile | PASS |
