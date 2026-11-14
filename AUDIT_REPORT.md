# Cyclone IV Simulator — Backend Audit Report

Target: RZ-EasyFPGA A2.2 trainer (`EP4CE6E22C8N`, EQFP-144) simulator —
GHDL-backed VHDL engine + Three.js frontend.
Date: 2026-11-13. Evidence: `tests/RESULTS.md` (executed cases),
`tests/MUTATION_REPORT.md` (mutation testing), `board/sources.md`,
`board/component_table.md`, `board/board_spec.md`, `board/board.json`.

## 1. Scope and method

- Read every backend module (`simulator.py`, `testbench_gen.py`, `qsf_parser.py`,
  `vcd_parser.py`, `waveform.py`, `peripherals.py`, `ghdl_tool.py`, `server.py`,
  `vhdl_parser.py`, `device.py`, `board_detect.py`) and the frontend board code.
- Verified the board/wiring facts against the vendor schematic, the vendor pin
  file, the instructor table, independent online pin tables and component
  datasheets (`board/sources.md`, `board/component_table.md`).
- Proved behaviour by executing the real backend: every claim below has a test
  ID in `tests/RESULTS.md` or a mutation ID in `tests/MUTATION_REPORT.md`.
- Differential testing: the engine *is* GHDL, so the reference is GHDL itself
  plus independent Python protocol checkers (UART encoder, VGA timing model,
  7-segment decoder) and testbench assertions. No second HDL simulator
  (NVC/Icarus) is installed on this host; that limitation is recorded.
- **Concurrent work:** while this audit ran, another agent was rewriting the
  frontend (a Vite app under `frontend/src/`, with the dependency-free app
  moved to `frontend/legacy/`) and extending the backend (`backend/session.py`,
  `simulator.py`, `testbench_gen.py`). Full-suite results therefore vary
  between runs; the numbers below are from the final run and the fixes above
  were verified against the tree as it stood at each step.

## 2. Architecture map

| Module | Responsibility | Key assumptions | What breaks them |
| --- | --- | --- | --- |
| `vhdl_parser.py` | Tokenize VHDL, extract entities/generics/ports | Input is VHDL-2008; interface-only extraction | Verilog/mixed input (rejected upstream); unsupported constructs (GHDL reports) |
| `testbench_gen.py` | Build a testbench from the entity + stimulus | One clock, one reset, free inputs get stimulus | Multiple clocks need a custom testbench; `after`/`wait for` are warned |
| `ghdl_tool.py` | Locate/run GHDL analyze/elaborate/run | GHDL on PATH or `GHDL_BIN`; 60 s command timeout | No GHDL → clear error; a true infinite loop hits the 60 s timeout |
| `qsf_parser.py` | Parse .qsf pin/top/IO-standard/file decisions | 144-pin EQFP; port names match the top entity | Other packages/devices → clear errors |
| `vcd_parser.py` | Parse GHDL VCD into transitions | Standard VCD; timescale in the header | Malformed VCD → defensive error |
| `waveform.py` | VCD → UI waveform, cycle samples, board map | Clock detect by name; board profile pin map | Port names outside the profile → "no pin assignment" warning |
| `peripherals.py` | Decode UART/buzzer/VGA from pin transitions; read model dumps | 8N1 idle-high UART; passive buzzer; 525-line VGA | Other encodings decode as garbage (no protocol checker on real hardware) |
| `device.py` | Board/device profile | `board/board.json` is the single source of truth | Missing/invalid JSON → import error |
| `board_detect.py` | Attach VHDL device models to matching ports | Port names match the board profile | Unknown names → no model |
| `simulator.py` | Orchestrate parse→TB→GHDL→VCD→JSON | Fresh temp dir per run; GHDL is the authority | Temp-dir exhaustion; concurrent runs isolated by design |
| `server.py` | REST + WebSocket + static frontend | Trusted HDL (no sandbox) | Malformed JSON/WS handled; untrusted HDL can read/write host files |

## 3. Findings by severity

Severity: **Critical** = wrong behaviour a student would trust; **High** = a
layer reports something false; **Medium** = missing coverage or a latent bug;
**Low** = cosmetic/documentation.

### Critical (fixed, re-tested)

1. **AT24C08 multi-byte reads were corrupted.** `master_acked` was never
   cleared, so on the second and later bytes of a read the model took the wrong
   branch and drove bit 7 of the current byte instead of preloading the next
   byte. Root cause: a stale flag in `board/models/at24c08.vhd`. Fix: consume
   the flag on the falling edge after the ACK. Re-test: `OD-04` (20-byte page
   read-back + wrap) and `OD-05` (four-block read) PASS.
2. **HD44780 model had multiple drivers on `busy`.** `busy` was assigned from
   two processes — illegal VHDL; the model never elaborated. Root cause: the
   busy flag was split between `execute` and `busy_clear`. Fix: derive busy
   from a single `busy_end` timestamp. Re-test: `PR-05` (LCD shows HELLO) PASS.
3. **PS/2 model indexed its byte array out of bounds.** `bytes(which - 1)` on a
   1-based array; the model crashed at runtime. Fix: `bytes(which)`. Re-test:
   `PR-03` PASS.
4. **NEC IR model overflowed.** The 32-bit frame was built in a `natural`
   (31-bit in VHDL) → GHDL "overflow detected". Fix: build it as
   `unsigned(31 downto 0)`. Re-test: `PR-06` PASS.
5. **AT24C08 address decode was wrong.** The model treated control-byte bit 2
   as a physical `A1` pin and ignored bit 0, so it NACKed 0xA4–0xA7 and aliased
   blocks. Datasheet: only A2 is a pin; A1/A0 are word-address bits 9/8. Fix:
   decode the block from bits 2/1 and compute the 10-bit word address. Re-test:
   `OD-05` PASS.

### Critical (found in the final regression pass, fixed)

6. **Auto testbench double-drove board-model pins.** A concurrent refactor of
   `testbench_gen.py` added a default `port <= '0'` stimulus for every
   un-driven input, including pins owned by a device model. The generated
   testbench then had two concurrent drivers on `PS_CLOCK_bus`/`PS_DATA_bus`
   (`<= 'H'` pull-up from the model and `<= '0'` from the stimulus), so the
   bus was forced low and the PS/2 and IR models could never transmit
   (`PR-03` STATUS=0, `PR-06` LEAD=0). Root cause: the default-stimulus loop
   did not exclude model-owned ports. Fix: skip ports listed in
   `config.models`; regression test
   `test_testbench_does_not_double_drive_model_ports`. Re-test: `PR-03`,
   `PR-05`, `PR-06`, `OD-04` PASS.

### High (fixed, re-tested)

6. **Frontend seven-segment polarity/bit map was not driven by the board
   profile.** `state.board.leds.activeLow` read a property off an array
   (always undefined), and the 2D display fell back to a bit map that does not
   match this board. Fix: `BoardMap` now carries `ledConfig` / `displayConfig`
   sourced from `board.json`; the 2D and 3D renderers read them. Re-test:
   `POL-01`, `POL-03`, `BJ-04`, `BJ-06`.
   Note: the repository is being rewritten in parallel — the dependency-free
   frontend now lives in `frontend/legacy/` (still served by `server.py` when
   `frontend/dist/` is absent), and a Vite replacement is a placeholder in
   `frontend/src/`. The legacy app is the one that carries these fixes; the
   new frontend does not consume `board.json` yet (follow-up, not part of this
   audit's executed evidence).
7. **Hard-coded pin numbers in the backend.** `device.py` duplicated the pin
   table. Fix: `board/board.json` is the single source; `device.py` only loads
   and reshapes it; the I/O limit comes from the device profile. Re-test:
   `BJ-03`, `BJ-04`.
8. **QSF parser gaps.** Cross-port duplicate pins and malformed pin tokens
   (`PIN_AB`) were silently accepted; mixed-case port names fragmented the pin
   map. Fix: validate every `set_location_assignment` token, track pin→target,
   and key the pin map by the upper-case name. Re-test: `QF-03`, `QF-04`,
   `QF-05`.
9. **No machine-readable board profile.** Fix: `board/board.json` with tags,
   pin map, polarities, parts and per-fact evidence; `/api/board` serves it;
   the frontend loads it at startup. Re-test: `BJ-01`–`BJ-06`.

### Medium (fixed, re-tested)

10. **LM75 Thyst/Tos power-up defaults missing.** The model returned 0x0000;
    TI specifies 75 °C (0x4B00) and 80 °C (0x5000). Fix + re-test: `PR-02`.
11. **PS/2 model had zero data setup time.** Data and clock changed in the same
    delta, so a real host would sample the previous bit. Fix: 5 µs setup before
    each clock fall. Re-test: `PR-03`.
12. **Config flash mislabelled "M25P16".** README, QA report, report generator
    and the 3D board marking said M25P16; the A2.2 schematic says EPCS16 (the
    A2.1 revision uses M25P16). Fix: all labels now EPCS16, with the revision
    note in `board_spec.md`. Re-test: `SPEC-12` (profile) and manual inspection.
13. **SDRAM refresh figure.** The spec now records 4096 cycles / 64 ms per the
    Hynix datasheet (the 8192 figure is for 8192-row parts). Re-test: `PR-07`.

### Low

14. **`updateSwitchFromConfig` inverted the control state** for active-low
    boards (a stimulus edit marked ON when the bit was 1). Fix: use
    `controlsConfig.activeLow` from the profile. Re-test: `POL-05`.
15. **QA report line endings** normalised during a patch; cosmetic only.

### High and Medium (found in the re-audit pass, fixed and re-tested)

16. **Stale-run hijack in the WebSocket playback session (High).** One shared
    stop Event was cleared by the next `start()`, the worker checked it only
    after `simulate()` returned, the pump task was never cancelled and
    `_begin_stream`'s only guard was `state == "stopped"` — a replaced run
    whose worker outlived `stop()`'s 10 s join streamed its `sim_ready`/
    batches/`sim_done` to the client. Fix: per-run generation counter captured
    by worker AND pump, both re-checked before any state/stream action; fresh
    per-run stop events; the pump task is cancelled on stop/replace. The
    shipped fresh-session-per-`sim_start` behaviour is unchanged. Re-test:
    `test_replaced_run_never_streams_stale_results` (proven to fail with the
    guards disabled; kills mutation M20).
17. **Unbounded waveform cost (Medium).** `value_at` was a linear scan per
    signal per cycle and `to_dict` serialized every transition. Fix: bisect
    over a cached time index (semantics preserved) plus a deterministic
    serialized-transition cap (`MAX_SERIALIZED_TRANSITIONS = 2000`, first and
    last kept); the UART/buzzer/VGA decoders now consume the full, undecimated
    transition lists (a decimated timeline corrupted PR-04/SPEC-10 during
    verification — caught and fixed before landing). Re-test: three new
    waveform unit tests; mutations M21/M22 killed.
18. **No PLL-count resource check (Medium, BLK-03).** The static estimator
    counted multipliers/M9K/register bits but not ALTPLL instances, and the
    case's three-PLL design did not exist. Fix: `_resource_warnings` counts
    ALTPLL instantiations (component declarations stripped first) and warns
    beyond the board.json device limit (2 PLLs); new fixture
    `tests/qa/designs/pll_limit.vhd` (three ALTPLLs); BLK-03's expectation is
    unchanged. Re-test: `BLK-03` PASS; mutation M19 killed.
19. **Literal absolute textio paths escaped to the host FS (Medium, ENG-07).**
    Uploaded HDL could read/write host files by absolute path (RB-05 wrote
    `%TEMP%`, RF-07 read a scratch file, ENG-07 wrote `%TEMP%`). Fix: a
    pre-scan before GHDL runs rejects string literals adjacent to `file_open`
    calls and `file ... is` declarations containing drive letters, UNC shares,
    absolute POSIX paths, `..` segments or `%ENV%` tokens, with the line
    number; relative textio inside the throw-away workdir keeps working.
    Documented residual: runtime-computed paths are not covered by the scan.
    Re-test: `RB-05`, `RB-05B` (new positive case), `ENG-07`, `RF-07` PASS;
    mutation M18 killed.

## 4. Test evidence

- `tests/run_all.py` — one command, writes `tests/RESULTS.md`. New audit
  sections: board profile (`BJ`), polarity (`POL`), QSF (`QF`), open-drain
  (`OD`), protocols (`PR`), robustness (`RB`), end-to-end (`E2E`).
  Final run: **224/230 passed**; the 6 failures are the documented limitations
  in §5.
- The three reference-design gaps from the E2E inventory are closed by new
  protocol cases (`tests/qa/test_audit_protocols.py`): `PR-09` runs the new
  `board/uart_echo.vhd` reference design (a framed 8N1 0x5A byte into
  UART_RXD pin 115 comes back on UART_TXD pin 114; 10 frames at 115207 baud,
  design status outputs ECHO_COUNT/FRM_ERR/LED asserted), `PR-10` drives the
  same frame at 10x the bit time and asserts the receiver rejects it (no
  echo, FRM_ERR=4), and `PR-11` wires the previously orphaned
  `board/i2c_eeprom_test.vhd` EEPROM master into the full pipeline against
  the AT24C08 model with the board's WP tie (writes blocked, reads clean,
  65 SCL falling edges, dump unchanged). SDRAM stays deliberately N/A:
  PRO-06/PR-07 verify the pin-map-only limitation (no timing model; physical
  tests T-SDRAM-1/2).
- `tests/test_audit_units.py` — 39 fast unit tests for the profile, QSF/VCD
  parsers, the peripheral decoders, the testbench generator, clock/reset
  detection, the waveform bisect/serialization cap and the textio path
  pre-scan (mutation-sensitive).
- `tests/qa/mutation.py` — 22 injected bugs; **22/22 killed** (see
  `tests/MUTATION_REPORT.md`). Two initial survivors were a bad mutation
  (it did not reintroduce the bug) and a real gap (the structured pin list and
  the flat pin map in `board.json` could drift); the gap was closed with
  `test_structured_pins_match_pin_map` and the mutation now points at it.
  The five re-audit mutations (M18–M22) cover the textio pre-scan, the
  PLL-count warning, the session per-run generation guards and the waveform
  bisect/serialization cap.
- Coverage: see `tests/COVERAGE.md` (pytest-cov over the backend).

## 5. Known limitations

Synced against the final run (224/230; every failing case ID is named here).

1. VHDL only; Verilog/SystemVerilog rejected with a clear message.
2. No synthesis/place-and-route/timing; GHDL is a simulator.
3. Registers without a VHDL initializer show X/U, not the FPGA power-on 0
   (`CLK-08`).
4. Combinational loops are not diagnosed: GHDL settles `a <= not a` to a
   stable value and the run reports normally (`OUT-13`).
5. ALTPLL has no behavioral model (`BLK-02`); the 2-PLL resource limit IS
   checked by the static estimator against the board.json device figure
   (`BLK-03`); altsyncram/lpm_* are rejected with a clear binding error.
6. No REST cancel endpoint and no UI waveform export (`ENG-03`/`ENG-01B`).
   The in-progress Vite frontend has WebSocket
   `sim_pause`/`sim_step`/`sim_stop`/`sim_reset`; the legacy app
   (`frontend/legacy/`) has none of these.
7. 2D board switch/key clicks edit the stimulus and reach the design only on
   the next run (`ENG-10`); the 3D board is pickable (`ENG-09`).
8. **No full HDL sandbox.** Literal absolute textio paths (drive letters, UNC
   shares, absolute POSIX paths, `..` segments, `%ENV%` tokens) are rejected
   by a pre-scan before GHDL runs (`RB-05`/`ENG-07`/`RF-07`), and relative
   textio stays confined to the throw-away workdir (`RB-05B`). Residual:
   runtime-computed paths (e.g. concatenated strings) can still reach the host
   FS — the scan covers the demonstrated literal-path class only. GHDL still
   runs with process privileges; only simulate HDL you trust.
9. SDRAM and EPCS16 have pin maps only (no timing/programming model).
10. The full 25M-clock `led_twinkle` blink exceeds the 60 s GHDL budget; the
    toggle logic is verified with a scaled threshold (`E2E-04`/`E2E-05`).
11. The Vite frontend under `frontend/src/` does not consume `board.json` yet;
    the legacy app does. Wiring the new frontend to the profile is follow-up.

## 6. Verdict

**Verified correct by executed tests:** the board profile and its single source
of truth; all pin assignments (vendor + 9 independent online tables); the
active-low conventions; the I2C bus split; open-drain/wired-AND behaviour; the
AT24C08 (write-protect, write cycle, page wrap, block select), LM75 (registers
and defaults), PS/2 frame/parity, UART 8N1, VGA 640×480 timing, HD44780 init and
NEC IR timing models; QSF parsing edge cases; parser/bridge robustness; session
isolation; playback-session replacement (a replaced run can never stream stale
results — mutation-tested); the PLL-count and textio absolute-path guards.

**Inferred:** IR receiver output polarity (standard 38 kHz module behaviour);
7-segment glyphs from the schematic pin map.

**Unverified (physical tests defined in `board/real_board_tests.md`):** buzzer
type, PS/2 device type, LCD socket pin order, IR protocol/carrier, LM75 ambient
value, SDRAM behaviour, DB9 wiring, and every other on-hardware check.

**Do not trust:** Verilog, Quartus project import, timing/clock scaling, PLL
and megafunction *behaviour* (BLK-02), .mif init, LE/M9K/DSP limits (static
lower-bound estimates; Quartus fitting is authoritative), UI export/stop, 3D
interaction, live switch toggling without a re-run, and runtime-computed
textio paths reaching the host FS (the demonstrated literal absolute-path
class is rejected before GHDL runs — `ENG-07`/`RB-05`/`RF-07`).
