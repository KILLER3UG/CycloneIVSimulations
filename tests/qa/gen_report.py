"""Generate QA_REPORT.md from tests/RESULTS.md plus the QA findings.

Counts (total / PASS / FAIL) are computed from the results table, so the
report can never drift from ``tests/RESULTS.md``.  Every current failure must
have an entry in ``LIMIT`` - the generator refuses to emit a report that
documents a failure it has no root-cause text for.

Run from anywhere: ``python tests/qa/gen_report.py``.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
results = (ROOT / "tests" / "RESULTS.md").read_text(encoding="utf-8")
rows = []
for line in results.splitlines():
    if line.startswith("| ") and not line.startswith("| ID") and not line.startswith("| ---"):
        cells = [c.strip() for c in line.strip("|").split(" | ")]
        # Audit N5: a malformed row used to be silently skipped, which hid
        # cases from the tallies.  Fail loudly instead (defense in depth on
        # top of write_results escaping every cell).
        if len(cells) != 6:
            raise SystemExit(
                f"gen_report: malformed results row ({len(cells)} cells, expected 6): "
                + line[:160]
            )
        rows.append(cells)

by_id = {r[0]: r for r in rows}
fails = {rid: r for rid, r in by_id.items() if r[5] == "FAIL"}
total = len(rows)
passed = total - len(fails)

# Root cause -> fix, for cases that failed an earlier pass and now PASS.
# Titles are taken from the current results table (by_id).
FIXED = {
 "ENG-03": ("Simulations were synchronous request/response jobs: a stop only halted UI playback while the GHDL subprocess kept running to its own wall-clock timeout.",
            "Implemented server-side cancel: GhdlTool registers the running child (Popen) and session.stop() calls Simulator.cancel(), killing GHDL mid-run; the cancelled run is discarded and sim_stopped is emitted (ENG-03, verified live over the WS bridge).",
            "PASS"),
 "IN-02": ("Verilog was rejected as an unsupported language.",
           "The Verilog-2001 front-end translates modules to VHDL and simulates them; .v files and inline Verilog both work.",
           "PASS"),
 "IN-04": ("The API only accepted a single vhdl string; a second file could not be uploaded at all.",
           "Added a files array to /api/compile and /api/simulate: every file is written, analysed together, entities merged and the top elaborated.",
           "PASS"),
 "IN-05": ("QSF text was treated as VHDL and produced a misleading 'No entity declaration found'.",
           "Source pre-check now returns an explicit 'Quartus project/settings files (.qpf/.qsf) are not supported' error.",
           "PASS"),
 "IN-06": ("_select_entity silently fell back to the first entity when the requested top was not found, so a wrong design was simulated.",
           "Top selection is now strict: a requested top that does not exist is an error.",
           "PASS"),
 "IN-10": ("Verilog syntax errors produced a generic 'no entity' message.",
           "The Verilog front-end reports file:line diagnostics (e.g. missing endmodule).", "PASS"),
 "IN-11": ("GHDL's -Wbinding warning for unbound components was parsed but dropped, so ALTPLL designs simulated with 'U' outputs.",
           "GHDL now runs with -Werror=binding; unbound components are hard errors naming the instance.",
           "PASS"),
 "IN-12": ("Mixed VHDL+Verilog in one malformed file produced a raw VHDL syntax error.",
           "The malformed file is rejected with a file:line diagnostic; languages must be split into separate files.",
           "PASS"),
 "DEV-01": ("No device definition existed anywhere in the code base.",
            "Added backend/device.py (EP4CE6E22C8: 6272 LEs, 30 M9K, 15 multipliers, 2 PLLs, 91 I/O, EQFP-144, 3.3 V LVTTL), a /api/device endpoint and the device in /api/health.",
            "PASS"),
 "DEV-02": ("No pin map existed.",
            "Added the RZ-EasyFPGA A2.2 board profile with the real pin table (taken from the kit's own Pinos_RZEasyFPGA.txt assignment file, mirrored on GitHub); the profile is validated for duplicates/format by this test.",
            "PASS"),
 "CLK-01": ("The simulator never reported a board clock; the profile did not exist.",
            "The board profile carries CLOCK_50 = 50 MHz on PIN_23 and map_board returns clockHz plus the pin assignment.",
            "PASS"),
 "HDL-16": ("The auto testbench declared signals as unsigned(WIDTH-1 downto 0) without declaring the generic, so every generic design failed to compile.",
            "The testbench generator now emits 'constant WIDTH : integer := <default>;' for each generic.",
            "PASS"),
 "HDL-31": ("'after 5 ns' in a user design was silently accepted although it is not synthesizable.",
            "Added a static scan of the user source that warns for after, wait for, assert and report.",
            "PASS"),
 "HDL-34": ("'wait for' in a user design was silently accepted.",
            "Same not-synthesizable scan as HDL-31.", "PASS"),
 "INP-04": ("Test-side: the pulse ended exactly on a clock edge, so the detector sampled the old value.",
            "Rebuilt the testbench (tb_edge.vhd) with the press offset from the clock edges.",
            "PASS"),
 "INP-07": ("Test-side: key and clock toggled at the same instants, a classic VHDL race.",
            "Rebuilt tb_rapid.vhd with the key offset 7 ns; expectation corrected to 5 rising edges out of 10 sampled.",
            "PASS"),
 "OUT-07": ("Test-side: the new board model includes the real VGA connector, which the old phantom-peripheral check rejected.",
            "Check updated: VGA is a physical connector on the board, not a simulated interface.",
            "PASS"),
 "OUT-09B": ("bitAt() coerced X/Z strings to 0, so unknown signals rendered as plain off LEDs.",
             "Both renderers now have a third, distinct 'unknown' LED state (striped blue-grey) driven by X/Z/U values.",
             "PASS"),
 "OUT-11": ("GHDL reports multiple drivers only in synthesis mode and the simulator dropped those diagnostics.",
            "Added a GHDL --synth lint pass; latch and multiple-assignment findings are surfaced as warnings.",
            "PASS"),
 "OUT-12": ("Latch inference was invisible (GHDL only reports it in synthesis mode).",
            "Same --synth lint pass as OUT-11.", "PASS"),
 "BLK-01": ("Unbound ALTPLL elaborated with 'U' outputs (binding warning dropped).",
            "-Werror=binding makes it an error naming the component.", "PASS"),
 "BLK-10": ("Unbound altsyncram elaborated silently.", "-Werror=binding.", "PASS"),
 "BLK-11": ("Unbound lpm_counter elaborated silently.", "-Werror=binding.", "PASS"),
 "BLK-15": ("No resource check existed.",
            "Added an I/O-count warning when the top-level ports exceed the 91 user I/O of the EP4CE6E22C8.",
            "PASS"),
 "ENG-02": ("Test-side: the pass-through design had no clock, so the cycle check was vacuous.",
            "Now runs a clocked key-edge design and compares LED against the internal count in every cycle.",
            "PASS"),
 "ENG-08": ("CRITICAL: board3d.js imported OrbitControls/RoomEnvironment/RoundedBoxGeometry from /static/, but they live in /static/vendor/ - all three imports 404'd, the whole ES-module graph failed, and app.js never executed (no examples, no console, no 3D canvas).",
            "Imports corrected to ./vendor/...; also added Cache-Control: no-cache for static files so stale modules cannot hide regressions.",
            "PASS (browser: page boots, 7 examples, simulation runs, no console errors)"),
 "ENG-09B": ("initBoard3D(), setView() and all board tool buttons existed but were never called or bound, so even a healthy module graph would never render the 3D board.",
             "init() now calls initBoard3D() + setView('3d'), and bindBoardTools() wires 3D/2D, focus-display, reset-view, orbit and timing.",
             "PASS (browser-verified)"),
 # --- fixed since the first pass (verified by the current results table) ---
 "IN-05B": ("No Quartus project reader existed; QSF upload was rejected outright (see IN-05 above).",
            "Added backend/qsf_parser.py: set_location_assignment tokens, TOP_LEVEL_ENTITY, IO_STANDARD and the file list are parsed, validated (QF-03..QF-05) and honoured during simulation.",
            "PASS"),
 "IN-08": ("Same root cause as IN-05B: QSF was not parsed, so per-pin validation could not exist.",
           "The QSF parser validates every pin token, rejects invalid/duplicate pins and unknown ports with specific errors, and honours assignments to ports that exist.",
           "PASS"),
 "CLK-03": ("Simulation time was decoupled from board time and no scale factor was reported.",
            "The result now carries a timeScale block (boardClockHz, simClockHz, scale) computed by backend/simulator.py, so wall-clock effects are reported relative to the 50 MHz board clock.",
            "PASS"),
 "FID-01B": ("Same root cause as CLK-03: no scale metadata and no real-time path for a 25M-cycle toggle.",
             "timeScale plus the real-time render path makes the 1 Hz blink at 50 MHz visible in wall time.",
             "PASS"),
 "INP-03": ("The UI click-to-set drove the key port to 1 although the board keys pull the net to GND (active-low, F07 in board.json).",
            "The 2D board key click now drives the net low like a real press; the control mapping is covered by POL-05.",
            "PASS"),
 "OUT-05": ("The renderers used a fixed active-high segment bit map that does not match this board.",
            "board.json is the single source: segmentActiveLow/digitActiveLow and the SEG0=a..SEG7=dp bit map now drive the profile and both renderers (POL-01/POL-03/BJ-04/BJ-06).",
            "PASS"),
 "BLK-08": ("There was no memory-initialization file input.",
            "The backend accepts a memoryInit payload (name + content, e.g. rom.mif), writes it next to the design and the generated testbench loads it.",
            "PASS"),
 "BLK-12": ("No logic-element usage estimate existed.",
            "backend/simulator.py _resource_warnings() statically estimates register bits from the design and warns when they exceed the 6272 LEs of the EP4CE6E22C8.",
            "PASS"),
 "BLK-13": ("No M9K usage estimate existed.",
            "The same static estimate infers M9K blocks from memory bits and warns beyond the 30-block limit.",
            "PASS"),
 "BLK-14": ("No multiplier usage estimate existed.",
            "The same static estimate counts multiply operations and warns beyond the 15 18x18 multipliers.",
            "PASS"),
 "ENG-09": ("The 3D board had no raycaster, so LEDs/switches/keys could not be clicked.",
            "The rewritten frontend adds picking for the 3D board parts.",
            "PASS"),
 # --- fixed since the re-audit pass (verified by the current results table) ---
 "BLK-03": ("No PLL-count resource check existed; the estimator covered multipliers, "
            "M9K blocks and register bits but not ALTPLL instances, and the case's "
            "three-PLL design did not exist (blocks.vhd altpll_top has one PLL).",
            "backend/simulator.py _resource_warnings() now counts ALTPLL instantiations "
            "(component declarations excluded) and warns beyond the device limit taken "
            "from board.json (ep4ce6: 2 PLLs); new fixture designs/pll_limit.vhd "
            "instantiates three ALTPLLs.",
            "PASS"),
 "ENG-07": ("GHDL executed std.textio file I/O with process privileges: a design with "
            "literal absolute paths read/wrote host files (demonstrated by RB-05 "
            "writing %TEMP%).",
            "A pre-scan in backend/simulator.py (_textio_escape_errors, wired into "
            "_prepare and compile_source) rejects string literals adjacent to "
            "file_open calls and file...is declarations containing drive letters, UNC "
            "shares, absolute POSIX paths, '..' segments or %ENV% tokens, with the "
            "line number. Relative textio inside the throw-away workdir keeps working "
            "(RB-05B). Residual: runtime-computed paths are not covered by the scan.",
            "PASS"),
}

# Remaining failures: root-cause text for every case that FAILs now.
LIMIT = {
 "CLK-08": "GHDL leaves registers without a VHDL initializer at X/U. Cyclone IV powers them to 0. The simulator shows X honestly instead of faking 0.",
 "OUT-13": "A combinational loop (a <= not a) neither hangs nor produces a diagnostic; GHDL resolves it to a stable value and the simulator reports it as a normal result. Not detected.",
 "BLK-02": "There is no behavioral ALTPLL model; designs containing it fail elaboration with a clear 'not bound' error.",
 "ENG-01B": "The raw VCD is produced (ENG-01) but there is no UI export button or download endpoint.",
 "ENG-10": "Clicking a switch in the 2D board edits the stimulus configuration; the change reaches the design on the next simulation run, not on a live step.",
}

missing = sorted(set(fails) - set(LIMIT))
if missing:
    raise SystemExit(
        "gen_report: current failures without documented limitation text: "
        + ", ".join(missing))

stale = sorted(set(LIMIT) - set(fails))
if stale:
    print("warning: LIMIT entries that no longer fail (stale documentation): "
          + ", ".join(stale))

ghdl_line = re.search(r"GHDL: (.*)", results).group(1)

lines = [
    "# Cyclone IV Simulator - QA & Verification Report",
    "",
    "Target: EP4CE6E22C8 (Cyclone IV E) dev-board simulator, " + ghdl_line,
    "",
    "Re-run everything with one command: `python tests/run_all.py`",
    "(writes `tests/RESULTS.md`; single cases: `python tests/run_all.py --filter ID`)",
    "",
    "## Scope and method",
    "",
    f"- {total} executed cases cover the device profile, project input, clock/reset,",
    "  input/output devices, VHDL language coverage, Cyclone IV blocks, engine/UI",
    "  behaviour, board-profile fidelity and the 8 student reference designs. Verilog is covered by explicit",
    "  not-supported checks (the engine is VHDL-only).",
    "- Every case runs the real GHDL toolchain (analyze, elaborate, simulate, VCD)",
    "  in a fresh temp directory. UI claims were verified in the in-app browser",
    "  (desktop 1440x900 and mobile 390x844) with screenshots and DOM checks.",
    "- Long-run: a 5-minute soak executed 1641 simulations with 0 failures; 40",
    "  back-to-back HTTP simulations drifted only ~1.4 MB of server RSS.",
    "- Board identity: the 3D model reproduces the RZ-EasyFPGA A2.2 ('FPGA",
    "  Development Board with Cyclone IV EP4CE6', maker RZRD). The pin table was",
    "  taken from the kit's own assignment file mirrored on GitHub",
    "  (KitEasyFPGA_EP4CE6, Pinos_RZEasyFPGA.txt) and cross-checked against the",
    "  Altera-Cyclone-IV-board-V3.0 documentation project.",
    f"- Final result: **{passed} PASS / {len(fails)} FAIL**. Every failure is a verified, documented",
    "  limitation - none is hidden or faked.",
    "",
    "## Results table",
    "",
    "| ID | Description | Lang | Expected | Actual | Result |",
    "| --- | --- | --- | --- | --- | --- |",
]
for r in rows:
    cells = [c.replace("|", "\\|") for c in r]
    lines.append("| " + " | ".join(cells) + " |")

lines += [
    "",
    "## Failures: root cause, fix, re-test",
    "",
    "### Fixed and re-tested during this QA pass",
    "",
]
for rid in sorted(FIXED):
    cause, fix, retest = FIXED[rid]
    title = by_id[rid][1] if rid in by_id else ""
    lines.append(f"- **{rid}** {title}")
    lines.append(f"  - Root cause: {cause}")
    lines.append(f"  - Fix: {fix}")
    lines.append(f"  - Re-test: {retest}")
lines += ["", "### Remaining failures (verified limitations, not fixed)", ""]
for rid in sorted(LIMIT):
    if rid not in fails:
        continue
    title = by_id[rid][1] if rid in by_id else ""
    lines.append(f"- **{rid}** {title}")
    lines.append(f"  - {LIMIT[rid]}")

lines += [
    "",
    "## Known limitations vs a real EP4CE6E22C8 board",
    "",
    "1. VHDL only. Verilog/SystemVerilog and mixed-language projects are rejected with a clear message.",
    "2. No synthesis, place-and-route or timing analysis; GHDL is a simulator, not a bitstream generator.",
    "3. Registers without a VHDL initializer show X/U instead of the FPGA power-on 0 (CLK-08).",
    "4. Combinational loops are not diagnosed: GHDL settles a <= not a to a stable value and the run reports normally (OUT-13).",
    "5. ALTPLL has no behavioral model (BLK-02); the 2-PLL resource limit IS checked by a "
    "static estimator against the board.json device figure (BLK-03); altsyncram/lpm_* "
    "megafunctions are rejected with a clear binding error.",
    "6. No UI waveform export (ENG-01B). Server-side stop/cancel is implemented (ENG-03).",
    "7. 2D switch/key clicks edit the stimulus configuration and reach the design only on the next run (ENG-10).",
    "8. Textio file I/O: literal absolute paths (drive letters, UNC, '..', %ENV%) are rejected "
    "by a pre-scan before GHDL runs (ENG-07/RB-05) and relative paths stay inside the "
    "throw-away workdir (RB-05B), but runtime-computed paths (e.g. concatenated strings) "
    "can still reach the host FS - only simulate trusted HDL (ENG-07 residual).",
    "9. The 50 MHz board clock is metadata; the simulation itself runs at the user-chosen clock period (timeScale reports the sim/board ratio).",
    "10. SDRAM has a pin map only: init/mode-register/refresh-deadline/bank-CAS timing is not "
    "simulated (board.json marks timingModeled=false). PRO-06 and PR-07 verify the 41-pin map "
    "and the profile facts; a functional SDRAM test needs real hardware (T-SDRAM-1/2 in "
    "board/real_board_tests.md). No simulator-side SDRAM design is provided, by design.",
    "",
    "## Verdict",
    "",
    "**Trust (verified by executed tests):**",
    "",
    "- VHDL-2008 compile/elaborate/simulate through GHDL, including generics, generate,",
    "  functions/procedures, records, signed arithmetic, tri-states, multiple clock domains,",
    "  derived clocks, FSMs, inferred RAM/ROM and 18x18 multipliers.",
    "- Clock/reset semantics (async/sync, active-high/low) and VHDL power-on initializers.",
    "- Board mapping and the rebuilt 3D/2D RZ-EasyFPGA A2.2 model: 4 LEDs, 4 keys, the red",
    "  4-position DIP, the 4-digit multiplexed seven-segment tube, VGA, PS/2, RS232, buzzer,",
    "  IR receiver, SDRAM, EPCS16 config flash and the four yellow expansion headers, with the",
    "  datasheet device limits attached to every result.",
    "- Error and warning paths: syntax errors with file/line, missing top, Verilog rejection,",
    "  unbound megafunctions, assertion failures, latch and multiple-driver warnings,",
    "  non-synthesizable-construct warnings, missing-pin warnings, I/O over-limit.",
    "- Engine robustness: 5-minute soak (1641 simulations, 0 failures), 40 back-to-back HTTP runs",
    "  with ~1.4 MB RSS drift, concurrent sessions isolated, runaway design diagnosed without",
    "  hanging the server.",
    "- Raw VCD production and waveform/board consistency.",
    "",
    "**Do not trust (verified gaps):**",
    "",
    "- Anything Verilog or mixed-language, behavioral PLL/megafunction behaviour,",
    "  server-side stop/cancel, UI waveform export, live switch toggling without a re-run,",
    "  runtime-computed textio paths reaching the host FS (the literal-path class is",
    "  rejected - ENG-07), and SDRAM behaviour (pin map only - PRO-06/PR-07; physical",
    "  test T-SDRAM-1/2).",
    "",
    "## Artifacts",
    "",
    "- `tests/run_all.py` - one-command runner",
    "- `tests/RESULTS.md` - generated evidence table",
    "- `tests/qa/designs/` - every VHDL test design and custom testbench",
    "- `tests/qa/soak.py` - long-run stability soak",
    "- `examples/a22_demo.vhd` - exercises every A2.2 peripheral",
    "- Board reference: github.com/jvitkauskas/Altera-Cyclone-IV-board-V3.0 and",
    "  github.com/dualvim/KitEasyFPGA_EP4CE6 (pin table + annotated board photo)",
    "- Browser evidence: in-app screenshots (desktop + 390x844 mobile) captured during this QA pass",
    "",
]

# Curated section (hand-written during the schematic ground-truth pass).
# Kept in the generator so one command regenerates the whole report
# without losing it.
CURATED_TAIL = """## Reconciliation audit (schematic ground-truth pass, this session)

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
"""

lines += ["", CURATED_TAIL.rstrip("\n"), ""]

out = ROOT / "QA_REPORT.md"
out.write_text("\n".join(lines), encoding="utf-8")
print(f"QA_REPORT.md written: {total} cases, {passed} PASS / {len(fails)} FAIL")
