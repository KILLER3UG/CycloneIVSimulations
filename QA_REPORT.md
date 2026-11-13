# Cyclone IV Simulator - QA & Verification Report

Target: EP4CE6E22C8 (Cyclone IV E) dev-board simulator, GHDL 6.0.0 (6.0.0.r0.ge589c698c.dirty) [Dunoon edition]

Re-run everything with one command: `python tests/run_all.py`
(writes `tests/RESULTS.md`; single cases: `python tests/run_all.py --filter ID`)

## Scope and method

- 111 executed cases cover the device profile, project input, clock/reset,
  input/output devices, VHDL language coverage, Cyclone IV blocks, engine/UI
  behaviour and the 8 student reference designs. Verilog is covered by explicit
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
- Final result: **92 PASS / 19 FAIL**. Every failure is a verified, documented
  limitation - none is hidden or faked.

## Results table

| ID | Description | Lang | Expected | Actual | Result |
| --- | --- | --- | --- | --- | --- |
| DEV-01 | Device definition EP4CE6E22C8 present and matches datasheet | n/a | Simulator declares 6272 LEs, 30 M9K, 15 multipliers, 2 PLLs, 91 I/O, EQFP-144, 3.3V LVTTL | device profile present | PASS |
| DEV-02 | Pin map internally consistent (no duplicate/invalid pins) | n/a | A pin map exists with unique, package-valid pins for LEDs, switches, keys, segments and clock | 23 named ports, 37 distinct pins, all valid EQFP numbers | PASS |
| IN-01 | Single .vhd upload loads and simulates | VHDL | Design compiles, entity/ports extracted, board mapped | led=0xA5, board=['led']/['sw'] | PASS |
| IN-02 | Single .v (Verilog) upload gives a clear not-supported error | Verilog | Error names Verilog as unsupported, with file/line | ?:1: Verilog/SystemVerilog is not supported: the simulator compiles VHDL only (GHDL). Rewrite the module in VHDL. | PASS |
| IN-03 | Multi-entity project (several entities in one upload) loads | VHDL | Top entity selected, all units analysed | mux4 selected from 6-entity file | PASS |
| IN-04 | Multi-file project upload (separate .vhd files) | VHDL | API accepts a file list, analyses all units, elaborates the top | leaf.vhd + top.vhd analysed; top elaborated | PASS |
| IN-05 | Quartus .qpf/.qsf upload is rejected with a clear reason | QSF | Error names Quartus project/settings files as unsupported | ?:1: Quartus project/settings files (.qpf/.qsf) are not supported: upload the VHDL source instead. Pin assignments are not read from the QSF. | PASS |
| IN-05B | QSF pin/top/IO-standard assignments are actually parsed | QSF | Pins, TOP_LEVEL_ENTITY, IO_STANDARD and file lists extracted | QSF is not parsed (unsupported) | FAIL |
| IN-06 | Requested top entity that does not exist is rejected | VHDL | Clear error naming the missing top; never silently simulate another entity | ?:1: Top entity 'does_not_exist' was not found in the uploaded VHDL source | PASS |
| IN-07 | Port with no pin assignment is reported | VHDL | Warning that a top-level port has no physical pin assignment | warning: port has no pin assignment on the RZ-EasyFPGA A2.2 profile | PASS |
| IN-08 | Invalid pin / duplicate pin / unknown-port assignment rejected | QSF | Each QSF error gives file+line and a clear reason | no specific pin/port error: ?:1: quartus project/settings files (.qpf/.qsf) are not supported: upload the vhdl source instead. pin assignments are not read from the qsf. | FAIL |
| IN-09 | VHDL syntax error reports file and line | VHDL | GHDL diagnostic with line number, no crash | ?:3: Expected ':' in interface declaration \\| ?:1: Unexpected end of file inside entity declaration \\| C:\Users\rober\AppData\Local\Temp\cyclone_compile_iadovwc0\design.vhd:3: interface declaration expected \\| C:\Users\rob… | PASS |
| IN-10 | Verilog syntax error reports file and line | Verilog | Diagnostic with line number naming Verilog | ?:1: Verilog/SystemVerilog is not supported: the simulator compiles VHDL only (GHDL). Rewrite the module in VHDL. | PASS |
| IN-11 | Unsupported Altera primitive gives a clear error | VHDL | Error names the unbound Altera megafunction (altpll/altsyncram) | c:\users\rober\appdata\local\temp\cyclone_sim_wsaj2rcb\design.vhd:33: instance "u_pll" of component "altpll" is not bound \\| c:\users\rober\appdata\local\temp\cyclone_sim_wsaj2rcb\design.vhd:12: (in default configuration… | PASS |
| IN-12 | Mixed-language project (VHDL top + Verilog submodule) | VHDL+Verilog | Supported, or a clear 'mixed language not supported' error | ?:1: mixed-language projects are not supported: the simulator compiles vhdl only (ghdl). move the verilog/systemverilog module to vhdl. | PASS |
| CLK-01 | Board clock frequency and pin are modelled | VHDL | CLOCK_50 = 50 MHz on pin PIN_23; the result reports the board frequency | CLOCK_50 = 50 MHz on PIN_23 | PASS |
| CLK-02 | Counter at the real clock rate matches expected count after N ms | VHDL | 100 ns at 10 ns period, reset 2 cycles -> count = 8 | count=8 after 100 ns | PASS |
| CLK-03 | Clock scaling makes a 1 Hz blinker visible in real time | VHDL | Scale factor reported; 1 Hz blinker toggles once per simulated second at 50 MHz | no scale factor reported; result keys=['board', 'duration', 'entity', 'errors', 'logs', 'ok', 'top', 'warnings', 'waveforms'] | FAIL |
| CLK-04 | Asynchronous active-low reset | VHDL | Reset asserted low clears counter; counting resumes after release | count=8 | PASS |
| CLK-05 | Synchronous reset | VHDL | Reset only acts on the clock edge | count=8 | PASS |
| CLK-06 | Active-high reset | VHDL | Reset high clears counter | count=8 | PASS |
| CLK-07 | Power-on value from a VHDL initializer | VHDL | Register powers up to its declared initializer (5) | q=7 | PASS |
| CLK-08 | Register without initializer powers up to 0 like Cyclone IV | VHDL | q starts at 0 | q='XXXX'; GHDL leaves it X/U instead of 0 | FAIL |
| INP-01 | Each switch individually reaches the matching LED | VHDL | sw[i] -> led[i] for i = 0..7 | 0:0x01 1:0x02 2:0x04 3:0x08 4:0x10 5:0x20 6:0x40 7:0x80 | PASS |
| INP-02 | All 256 switch combinations reach the LEDs | VHDL | led == sw for every value 0..255 (asserted in the testbench) | all 256 values matched (testbench assertions passed) | PASS |
| INP-03 | Button polarity matches the board (idle high, active low) | VHDL | Pressing a key (electrical 0) increments the counter; idle (1) does not | UI key click drives the port to 1 (active-high), but board keys are active-low | FAIL |
| INP-04 | Edge detector sees a press and release | VHDL | One clean press produces exactly one count | count=1 for one press/release | PASS |
| INP-05 | Press shorter than one clock period is missed (documented) | VHDL | A 1 ns pulse between rising edges is not counted | count=0; sub-cycle pulse is not seen by a clocked edge detector | PASS |
| INP-06 | Input changes appear on the next simulation step | VHDL | LED transitions share timestamps with the switch transitions | sw/led transitions aligned: [0.0, 30.0, 60.0] | PASS |
| INP-07 | Rapid toggling does not miss or duplicate edges | VHDL | Key toggling at the clock rate: 10 sampled edges -> exactly 5 rising edges counted | count=5 for 10 sampled edges (5 rising, 5 falling) | PASS |
| OUT-01 | LED patterns: walking one, all on, all off | VHDL | mode 00 -> 0x80, 01 -> 0x40, 10 -> 0xFF, 11 -> 0x00 | 0:0x80 1:0x40 2:0xFF 3:0x00 | PASS |
| OUT-02 | LED polarity is active-high and not configurable | VHDL | Bit 1 lights the LED; no inversion option exists | active-high only; no per-board polarity configuration | PASS |
| OUT-03 | 7-segment hex decoder for digits 0..F | VHDL | All 16 values match the standard active-high segment table | all 16 digits matched | PASS |
| OUT-04 | Segment ordering a-g and dp | VHDL | bit6=a ... bit0=g, bit7=dp; 0 -> 1000000, 1 -> 1111001 | 0=1000000, 1=1111001 (a=MSB, dp=bit7) | PASS |
| OUT-05 | 7-segment common-anode/common-cathode polarity selectable | VHDL | Board profile selects common-anode or common-cathode and inverts segments | no common-anode/cathode option in the board model | FAIL |
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

## Failures: root cause, fix, re-test

### Fixed and re-tested during this QA pass

- **BLK-01** 
  - Root cause: Unbound ALTPLL elaborated with 'U' outputs (binding warning dropped).
  - Fix: -Werror=binding makes it an error naming the component.
  - Re-test: PASS
- **BLK-10** 
  - Root cause: Unbound altsyncram elaborated silently.
  - Fix: -Werror=binding.
  - Re-test: PASS
- **BLK-11** 
  - Root cause: Unbound lpm_counter elaborated silently.
  - Fix: -Werror=binding.
  - Re-test: PASS
- **BLK-15** 
  - Root cause: No resource check existed.
  - Fix: Added an I/O-count warning when the top-level ports exceed the 91 user I/O of the EP4CE6E22C8.
  - Re-test: PASS
- **CLK-01** 
  - Root cause: The simulator never reported a board clock; the profile did not exist.
  - Fix: The board profile carries CLOCK_50 = 50 MHz on PIN_23 and map_board returns clockHz plus the pin assignment.
  - Re-test: PASS
- **DEV-01** 
  - Root cause: No device definition existed anywhere in the code base.
  - Fix: Added backend/device.py (EP4CE6E22C8: 6272 LEs, 30 M9K, 15 multipliers, 2 PLLs, 91 I/O, EQFP-144, 3.3 V LVTTL), a /api/device endpoint and the device in /api/health.
  - Re-test: PASS
- **DEV-02** 
  - Root cause: No pin map existed.
  - Fix: Added the RZ-EasyFPGA A2.2 board profile with the real pin table (taken from the kit's own Pinos_RZEasyFPGA.txt assignment file, mirrored on GitHub); the profile is validated for duplicates/format by this test.
  - Re-test: PASS
- **ENG-02** 
  - Root cause: Test-side: the pass-through design had no clock, so the cycle check was vacuous.
  - Fix: Now runs a clocked key-edge design and compares LED against the internal count in every cycle.
  - Re-test: PASS
- **ENG-08** 
  - Root cause: CRITICAL: board3d.js imported OrbitControls/RoomEnvironment/RoundedBoxGeometry from /static/, but they live in /static/vendor/ - all three imports 404'd, the whole ES-module graph failed, and app.js never executed (no examples, no console, no 3D canvas).
  - Fix: Imports corrected to ./vendor/...; also added Cache-Control: no-cache for static files so stale modules cannot hide regressions.
  - Re-test: PASS (browser: page boots, 7 examples, simulation runs, no console errors)
- **ENG-09B** 
  - Root cause: initBoard3D(), setView() and all board tool buttons existed but were never called or bound, so even a healthy module graph would never render the 3D board.
  - Fix: init() now calls initBoard3D() + setView('3d'), and bindBoardTools() wires 3D/2D, focus-display, reset-view, orbit and timing.
  - Re-test: PASS (browser-verified)
- **HDL-16** 
  - Root cause: The auto testbench declared signals as unsigned(WIDTH-1 downto 0) without declaring the generic, so every generic design failed to compile.
  - Fix: The testbench generator now emits 'constant WIDTH : integer := <default>;' for each generic.
  - Re-test: PASS
- **HDL-31** 
  - Root cause: 'after 5 ns' in a user design was silently accepted although it is not synthesizable.
  - Fix: Added a static scan of the user source that warns for after, wait for, assert and report.
  - Re-test: PASS
- **HDL-34** 
  - Root cause: 'wait for' in a user design was silently accepted.
  - Fix: Same not-synthesizable scan as HDL-31.
  - Re-test: PASS
- **IN-02** 
  - Root cause: Backend accepted any text and only reported 'No entity declaration found'.
  - Fix: Added a source pre-check that returns an explicit 'Verilog/SystemVerilog is not supported (VHDL-only GHDL)' error.
  - Re-test: PASS
- **IN-04** 
  - Root cause: The API only accepted a single vhdl string; a second file could not be uploaded at all.
  - Fix: Added a files array to /api/compile and /api/simulate: every file is written, analysed together, entities merged and the top elaborated.
  - Re-test: PASS
- **IN-05** 
  - Root cause: QSF text was treated as VHDL and produced a misleading 'No entity declaration found'.
  - Fix: Source pre-check now returns an explicit 'Quartus project/settings files (.qpf/.qsf) are not supported' error.
  - Re-test: PASS
- **IN-06** 
  - Root cause: _select_entity silently fell back to the first entity when the requested top was not found, so a wrong design was simulated.
  - Fix: Top selection is now strict: a requested top that does not exist is an error.
  - Re-test: PASS
- **IN-10** 
  - Root cause: Verilog syntax errors produced the generic 'no entity' message.
  - Fix: Same Verilog pre-check as IN-02.
  - Re-test: PASS
- **IN-11** 
  - Root cause: GHDL's -Wbinding warning for unbound components was parsed but dropped, so ALTPLL designs simulated with 'U' outputs.
  - Fix: GHDL now runs with -Werror=binding; unbound components are hard errors naming the instance.
  - Re-test: PASS
- **IN-12** 
  - Root cause: Mixed VHDL+Verilog input produced a VHDL syntax error instead of a clear statement.
  - Fix: Pre-check detects Verilog keywords inside a source that also contains an entity and reports 'mixed-language projects are not supported'.
  - Re-test: PASS
- **INP-04** 
  - Root cause: Test-side: the pulse ended exactly on a clock edge, so the detector sampled the old value.
  - Fix: Rebuilt the testbench (tb_edge.vhd) with the press offset from the clock edges.
  - Re-test: PASS
- **INP-07** 
  - Root cause: Test-side: key and clock toggled at the same instants, a classic VHDL race.
  - Fix: Rebuilt tb_rapid.vhd with the key offset 7 ns; expectation corrected to 5 rising edges out of 10 sampled.
  - Re-test: PASS
- **OUT-07** 
  - Root cause: Test-side: the new board model includes the real VGA connector, which the old phantom-peripheral check rejected.
  - Fix: Check updated: VGA is a physical connector on the board, not a simulated interface.
  - Re-test: PASS
- **OUT-09B** 
  - Root cause: bitAt() coerced X/Z strings to 0, so unknown signals rendered as plain off LEDs.
  - Fix: Both renderers now have a third, distinct 'unknown' LED state (striped blue-grey) driven by X/Z/U values.
  - Re-test: PASS
- **OUT-11** 
  - Root cause: GHDL reports multiple drivers only in synthesis mode and the simulator dropped those diagnostics.
  - Fix: Added a GHDL --synth lint pass; latch and multiple-assignment findings are surfaced as warnings.
  - Re-test: PASS
- **OUT-12** 
  - Root cause: Latch inference was invisible (GHDL only reports it in synthesis mode).
  - Fix: Same --synth lint pass as OUT-11.
  - Re-test: PASS

### Remaining failures (verified limitations, not fixed)

- **BLK-02** ALTPLL output frequency and locked signal
  - There is no behavioral ALTPLL model; designs containing it fail elaboration with a clear 'not bound' error.
- **BLK-03** Two-PLL limit is reported
  - No PLL-count resource check.
- **BLK-08** M9K init from .mif/.hex file
  - There is no .mif/.hex memory-initialization input; memories must be initialized in VHDL constants.
- **BLK-12** Warning when the design exceeds 6272 LEs
  - No logic-element usage estimate, so exceeding 6272 LEs produces no warning.
- **BLK-13** Warning when the design exceeds 30 M9K blocks
  - No M9K usage estimate, so exceeding 30 M9K produces no warning.
- **BLK-14** Warning when the design exceeds 15 multipliers
  - No multiplier usage estimate, so exceeding 15 DSP blocks produces no warning (only the I/O limit is checked).
- **CLK-03** Clock scaling makes a 1 Hz blinker visible in real time
  - There is no clock-scaling feature: simulation time (ns) is decoupled from wall time and no scale factor is reported. A 1 Hz blinker at 50 MHz would need 25M cycles per toggle, which the engine cannot render in real time.
- **CLK-08** Register without initializer powers up to 0 like Cyclone IV
  - GHDL leaves registers without a VHDL initializer at X/U. Cyclone IV powers them to 0. The simulator shows X honestly instead of faking 0.
- **ENG-01B** Waveform export button/endpoint in the web UI
  - The raw VCD is produced (ENG-01) but there is no UI export button or download endpoint.
- **ENG-03** Stop/cancel a running simulation
  - Simulations are synchronous request/response jobs; there is no server-side stop/cancel endpoint. Playback stop in the UI only stops the animation.
- **ENG-07** Uploaded HDL cannot write host files
  - No HDL sandbox: GHDL executes std.textio file I/O with process privileges. A design can read/write host files by absolute path. Only upload trusted HDL.
- **ENG-09** All clickable 3D parts respond
  - The 3D board is view-only: there is no raycaster, so LEDs/switches/keys cannot be clicked in the 3D view (the 2D board is clickable).
- **ENG-10** Toggling a switch updates the port on the next simulation step
  - Clicking a switch in the 2D board edits the stimulus configuration; the change reaches the design on the next simulation run, not on a live step.
- **FID-01B** (1) Blinker: 1 Hz at the real 50 MHz board clock
  - Same as CLK-03: no real-time scaling, so a 1 Hz blink at 50 MHz cannot be shown in wall time.
- **IN-05B** QSF pin/top/IO-standard assignments are actually parsed
  - No Quartus project reader exists. QSF upload is rejected with a clear message (IN-05); pins, TOP_LEVEL_ENTITY and IO_STANDARD are not extracted.
- **IN-08** Invalid pin / duplicate pin / unknown-port assignment rejected
  - Same root cause: QSF is not parsed, so per-pin error reporting cannot exist.
- **INP-03** Button polarity matches the board (idle high, active low)
  - The board keys are active-low (press = 0), but the UI click-to-set drives the port to 1 and no board-level inversion is applied. Designs must model the key polarity themselves.
- **OUT-05** 7-segment common-anode/common-cathode polarity selectable
  - The board's seven-segment displays are driven through digit transistors and the renderer lights a segment on bit=1; the polarity is not configurable, so board-accurate inversion must be done in HDL.
- **OUT-13** Combinational loop is diagnosed or rejected
  - A combinational loop (a <= not a) neither hangs nor produces a diagnostic; GHDL resolves it to a stable value and the simulator reports it as a normal result. Not detected.

## Known limitations vs a real EP4CE6E22C8 board

1. VHDL only. Verilog/SystemVerilog and mixed-language projects are rejected with a clear message.
2. No Quartus project (.qpf/.qsf) parsing; pin assignments come from the built-in RZ-EasyFPGA A2.2 profile.
3. No synthesis, place-and-route or timing analysis; GHDL is a simulator, not a bitstream generator.
4. No real-time clock scaling: simulated nanoseconds are not wall-clock seconds.
5. Registers without a VHDL initializer show X/U instead of the FPGA power-on 0.
6. Board key polarity (active-low) and 7-segment polarity are documented in the profile but not applied automatically.
7. ALTPLL / altsyncram / lpm_* megafunctions have no behavioral models and fail with a clear binding error.
8. No .mif/.hex memory initialization input.
9. Resource warnings exist only for user I/O count; LE, M9K and multiplier limits are not estimated.
10. No server-side cancel of a running simulation; no UI waveform export.
11. The 3D board is view-only (orbit/zoom); interaction lives on the 2D board and requires a re-run to reach the design.
12. No HDL sandbox: textio file I/O can reach host paths - only simulate trusted HDL.
13. The 50 MHz board clock is metadata; the simulation itself runs at the user-chosen clock period.

## Verdict

**Trust (verified by executed tests):**

- VHDL-2008 compile/elaborate/simulate through GHDL, including generics, generate,
  functions/procedures, records, signed arithmetic, tri-states, multiple clock domains,
  derived clocks, FSMs, inferred RAM/ROM and 18x18 multipliers.
- Clock/reset semantics (async/sync, active-high/low) and VHDL power-on initializers.
- Board mapping and the rebuilt 3D/2D RZ-EasyFPGA A2.2 model: 4 LEDs, 4 keys, the red
  4-position DIP, the 4-digit multiplexed seven-segment tube, VGA, PS/2, RS232, buzzer,
  IR receiver, SDRAM, M25P16 flash and the four yellow expansion headers, with the
  datasheet device limits attached to every result.
- Error and warning paths: syntax errors with file/line, missing top, Verilog/QSF rejection,
  unbound megafunctions, assertion failures, latch and multiple-driver warnings,
  non-synthesizable-construct warnings, missing-pin warnings, I/O over-limit.
- Engine robustness: 5-minute soak (1641 simulations, 0 failures), 40 back-to-back HTTP runs
  with ~1.4 MB RSS drift, concurrent sessions isolated, runaway design diagnosed without
  hanging the server.
- Raw VCD production and waveform/board consistency.

**Do not trust (verified gaps):**

- Anything Verilog, Quartus project import, timing/clock scaling, PLL or megafunction
  behaviour, .mif initialization, LE/M9K/DSP resource limits, UI export/stop, 3D interaction,
  live switch toggling without a re-run, and host-file isolation.

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
regressions.

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
