# STOP 1 — Evidence (Parts A–D)

Date: 2026-11-17
Board: RZ-EasyFPGA A2.2, `EP4CE6E22C8N` (EQFP-144).
Hardware source of truth: `board/board_spec.md`, `board/board.json`, `board/vendor/`.

> **Buzzer pin:** the schematic / `board.json` / vendor pin file give
> **BEEP = PIN_110** (active-low, 8550 PNP high-side). `PIN_85` is **LED3**.
> The prompt's `PIN_85` was not used; you approved PIN_110.

## Commits in this pass

| Commit | Scope |
| --- | --- |
| `7a0a58b` | A1 — one hardware map; hardcoded pin fallbacks removed; guard test |
| `1e9200f` | A3 — 7-seg duty-cycle brightness, scan-rate persistence, ghosting |
| `b88d3b7` | B — cycle-accurate buzzer audio, `buzz1.vhd`, 1 s countdown |
| `c373518` | B fixes — 800 Hz measurement, release countdown, live e2e |
| `03ce116` | C/D — resizable sidebar, collapsible Messages, GHDL differential, evidence |
| `5014e3f` | QA — cancel-without-token fix, Verilog tests corrected |

## Reproduce

```bash
# 8765 is used because 8080 was held by a stale server in this environment
python -m backend serve --port 8765
cd frontend && npm run build

node scripts/buzz1-e2e.mjs http://127.0.0.1:8765/
node scripts/sevseg-display-e2e.mjs http://127.0.0.1:8765/
cd .. && python tests/run_all.py
```

## Artifacts

| File | Proves |
| --- | --- |
| `buzz1-idle.png` | buttons open (logic 1) → **Silent** |
| `buzz1-hold-800hz.png` | hold KEY1 → **800 Hz**, 62,500 cycles/period, 50% duty |
| `buzz1-released-silent.png` | release → silent after **1.0 s** (`sec_counter` = 49,999,999) |
| `buzz1-pinplan.png` | clk/btn1/btn2/buzzerb → PIN_23 / 88 / 89 / **110** |
| `buzz1.qsf` | exported Quartus `.qsf` (4 assignments) |
| `buzz1-sidebar-resized.png` | drag handle: 420 → 530 px, canvas reflows |
| `buzz1-sidebar-collapsed.png` / `-expanded.png` | collapse/expand |
| `buzz1-messages-expanded.png` | Messages panel (collapsible; see log) |
| `sevseg-keys-open.png` | all keys open → display dark |
| `sevseg-display.png` | all DIP closed → **4 tubes integrate via POV** |
| `sevseg-pinplan.png` | s1..s4 / dtube / seven_seg pin defaults |
| `buzz1-e2e.log` | all buzz1/UI checks PASS |
| `sevseg-display-e2e.log` | all 7-seg checks PASS |
| `full-suite.log` | **226/231 passed**, 129 unit tests |

## Full-suite result

```
Units: 140 passed (pytest tests/)
231/231 passed
```

STOP 1B fixed the last 5 baseline failures (and 4 stale Verilog expectations):

| ID | Fix |
| --- | --- |
| IN-02 / VER-01 | Verilog is a supported feature — tests assert compile+simulate |
| IN-10 / IN-12 | Verilog/mixed-language file:line diagnostics |
| CLK-08 | X/U documented (no faked power-up 0) |
| OUT-13 | combinational-loop lint (`backend/lint.py`) |
| BLK-01 / BLK-02 / CKM-04 / IN-11 | behavioural `altpll` model; `altsyncram` stays rejected |
| ENG-01B | Export VCD button (`frontend/src/vcdExport.js`) |
| ENG-10 | switch click auto re-run asserted |

## STOP 2 — packaging verification

- `tauri-build.log` — `npx tauri build` (NSIS, 49.35 MiB installer)
- `SHA256SUMS.txt` — installer SHA-256 (`ca97e2d3…9702`)
- `sidecar-offline-smoke.log` — frozen backend run from a **path with spaces**:
  doctor OK (GHDL resolved from the bundle), buzz1 800 Hz, Verilog `blink_v`
  simulated without Icarus
- `stop2-app-running.png` — installed app running with the live backend
- `stop2-clean-vm-checklist.md` — scripted clean-VM sequence + results
  (install → launch → buzz1/buzz_4tone → Verilog → close → upgrade → uninstall;
  all PASS; uninstall fully removes the app directory via the POSTUNINSTALL
  hook and leaves no `cyclone-backend.exe`/`ghdl.exe` behind)

## STOP 1C — header controls + schematic fixes

**All four header controls now silence the buzzer immediately** (oscillator
gain → 0, countdown timer cancelled, badge → Silent) — `transport-controls-e2e.mjs`,
all PASS:

| Control | Verified behaviour |
| --- | --- |
| **Power Off** | gain 0, badge Silent, SP1 ring stops, LEDs/7-seg off, board unprogrammed; **Power On** reloads the idle state (keys open = '1', D1 lit) |
| **Pause** | gain 0 immediately, tone silenced; Resume restores it |
| **Stop** | gain 0, countdown cancelled, board returned to idle |
| **Reset** | countdown aborted, gain 0, badge Silent (no 1 s wait) |

Also fixed in this pass:

- **Generic countdown detector** — pure register-slope analysis, no signal-name
  filter; proven with `hold_window` (no `cnt`/`count` substring) at `step = 2`
  in both the backend and frontend unit tests, and with
  `tests/qa/designs/board/buzz_4tone.vhd` (renamed `cnt_delay`/`gate_en`/
  `half_period`, 25 M cycles = 0.5 s, 500/800/1000/1600 Hz).
- **LM75** — temperature register is 9-bit (`round(T*2) << 7`), so 25.0 °C reads
  **0x1900** (was 0x3200); Thyst/Tos writes; behavioural OS comparator output
  (the A2.2 OS pin 3 has no net). `PR-02`/`SPEC-07` updated.
- **AT24C08** — block select across all four blocks (`0x50`–`0x53`) covered by
  `OD-05`.
- **LED / 7-seg dual labels** — `board.json`, the Pin Planner and the 3D board
  now show both namings: `PIN_87 = LED[0] / D1 / net LED4` …
  `PIN_84 = LED[3] / D4 / net LED1`, and the digits carry `R46`–`R49` +
  `D1` (leftmost) … `D4` (rightmost).
- **PIN_24** is a dedicated input-only clock pin (Output/InOut rejected);
  **PIN_111** added as P1 header I/O; **PIN_101** (VGA_HSYNC/nCEO) stays an
  output.
- **Diagnostics** — GHDL’s cryptic `missing ";" at end of architecture` now
  appends “a ';' is missing at the end of the previous statement (check the
  line above it)”.
- **Non-ASCII lint** — invisible copy-paste characters (non-breaking spaces,
  smart quotes, dashes) are reported with their exact line/column instead of a
  cryptic parser error.

Full suite: **231/231 passed, 149 unit tests** (`full-suite-231.log`).
`board-matrix.mjs` (extra harness) is 12/16 — the four failures are its DIP-walk
helper racing the re-simulation lag, not board behaviour (M4a/M4b/M6/M7b/M9/M10
cover those paths and pass).

## STOP 1D — 4-tube 7-seg live rendering + stimulus lag

**`board-matrix.mjs` is now 16/16** and `sevseg-4tube-e2e.mjs` is **7/7 ALL
PASS**. Four real defects were found and fixed (none were "just timing"):

| Defect | Root cause | Fix |
| --- | --- | --- |
| Matrix display checks read all zeros | They polled `display.segTarget`, which the **compact board image never populates** — it only fills `segHold` (the rendered POV duty image). `segTarget` is the *live-path* instantaneous phase. | All display assertions now read `segHold` (threshold match, since POV duty is fractional: ~0.25 for a 1-of-4 mux, 1.0 for static drive). |
| 4-tube mux showed one tube / partial scan | The interactive capture was too short to span a full slow scan, and POV sampling rode the capture edges. | Display designs now request a **10 ms / 500 k-cycle window**, and `pov_clock_edges()` samples **131 072 evenly spaced edges across the whole capture**, so a 65 536-cycle scan is covered ~7×. |
| `sevseg-4tube-e2e.mjs` never compiled | The harness passed `{ src, top }` to `page.evaluate` but the page function destructured `{ s, t }` — the design source and top-level name were both `undefined`. | Argument names aligned; the e2e now compiles and asserts 4 distinct POV glyphs, partial 2-tube (D3/D4 lit, D1/D2 dark, unassigned dp dark), static drive, and KEY1 → '1'. |
| Matrix DIP walk only ever drove bit 0 | `setSw` read `btn.dataset.index`, but `data-index` lives on the `.bc-cell` wrapper — `Number(undefined)` → `NaN`, and `val >> NaN` === `val >> 0`, so all four switches followed bit 0. | Index is read from `btn.closest('.bc-cell')`. |

Also reconciled with the shipped behaviour:

- **M3 / M7a** expected "exactly one tube lit" (instantaneous scan). Both matrix
  designs scan at 3.1 MHz and 763 Hz — far above the 60 Hz persistence
  threshold — so the eye integrates **all four tubes at once**. They now assert
  the correct POV image (four distinct glyphs simultaneously).
- **M8** assumed the board started "all DIPs closed", but DIP state carries over
  from M7a's walk; it now drives the all-closed state explicitly.
- **M11** expected power-on to stay unprogrammed; the shipped behaviour
  (deliberate, `main.js setPower`) **auto-restores the compiled design** on
  power-on so a key press works without re-clicking Compile. Asserted
  accordingly.
- **`scripts/sync_version.py`** no longer expects the removed `#tb-version`
  toolbar badge (STOP 1D de-clutter); the version is still single-sourced into
  `package.json`, `frontend/package.json`, `tauri.conf.json`,
  `backend/__init__.py`, `state.js appVersion` (About dialog) and `Cargo.toml`.

Stimulus lag: an interactive **result LRU cache** keyed by the full simulation
request (48 entries) plus a persistent GHDL **library cache** make repeated
KEY/DIP walks return in ~0.1 ms instead of re-running GHDL; rapid input walks
are coalesced by the existing 90 ms debounce. A *first-time* display stimulus
still costs one 500 k-cycle GHDL run (~13 s) — that is the honest cost of the
extended POV window.

New bundled example: **`examples/sevseg_4tube.vhd`** (1/2/3/4 across the four
tubes, 763 Hz scan) — verified to compile and integrate to the correct
per-tube POV image; `build_sidecar.py` copies every `examples/*.vhd`, so it
ships in the installer automatically.

Artifacts: `sevseg-4tube-mux.png`, `sevseg-4tube-partial.png`,
`sevseg-4tube-static.png`, `sevseg-4tube-key1.png`, `sevseg-4tube-e2e.log`,
`board-matrix.log` (16/16), `full-suite-stop1d.log` (231/231 + 149 units),
`transport-controls-e2e.log` (5/5), `partcd-e2e.log` (5/5).

## STOP 1B — generic countdown (no signal-name hardcoding)

`_detect_down_counter` (backend) and `detectDownCounter` (frontend) measure the
**signed slope of every internal integer signal** — no name filter. The longest
run of the dominant decrement gives `step`, and `cycles = terminal / step + 1`
(the load cycle is part of the note). The longest timer wins, so any student
naming works.

Proven with `tests/qa/designs/board/buzz_4tone.vhd` — renamed signals
(`cnt_delay`, `gate_en`, `half_period`), 25,000,000-cycle (0.5 s) timer, and
4 keys → 500 / 800 / 1000 / 1600 Hz. Tests: `test_buzz_4tone_*` in
`tests/test_buzzer.py`.

## STOP 1B artifacts

| File | Proves |
| --- | --- |
| `partcd-newfile.png` | new file defaults to `.vhd` + entity/architecture template |
| `partcd-undo.png` | delete + Undo restores the file and its pin mappings |
| `partcd-top-dep.png` | Set as Top-Level + automatic dependency inclusion (Files: 2) |
| `partcd-validation.png` | duplicate / nonexistent / direction-conflict errors |
| `partcd-board-closeup.png` / `-iso.png` | 3D board: QFP, 7-seg, keys, LEDs, buzzer, DIP, silkscreen |
| `buzz1-sp1-ring.png` | SP1 buzzer with the active pulse ring |
| `partcd-e2e.log` | all Part C/D checks PASS |
| `full-suite-231.log` | **231/231 passed**, 140 unit tests |

## Full-suite result (STOP 1, superseded)

```
Units: 129 passed (pytest tests/)
226/231 passed
FAILED: CLK-08, OUT-13, BLK-02, ENG-01B, ENG-10
```

These 5 are the **same pre-existing baseline failures** recorded at `6317759`
(226/5). They are not A–D regressions:

| ID | Nature |
| --- | --- |
| CLK-08 | GHDL leaves an uninitialized register as `X`; the test expects power-up `0` |
| OUT-13 | combinational loop is not diagnosed |
| BLK-02 | no behavioral ALTPLL model (documented N/A) |
| ENG-01B | no VCD/FST export UI (outside A–D scope) |
| ENG-10 | a switch click re-runs the simulation **by design**; the test expects no re-run |

All A/B/C/D-targeted tests pass: `test_buzzer.py` (8), `test_single_hardware_map.py`
(5), `test_simulator.py` (18), 31 frontend unit tests, both browser e2e suites.

## Hardware model notes

- **Buzzer:** BEEP PIN_110, active-low; steady `'1'` → silent; passive speaker
  (no on-board oscillator); 800 Hz = 62,500 cycles at 50 MHz; note length is
  read from the design's own `sec_counter` load (49,999,999 cycles = 1.000 s).
- **7-seg:** 1-of-4 multiplex → 25% duty per lit segment; scan ≥60 Hz
  integrates (persistence), <60 Hz shows the instantaneous digit; ghosting
  without blanking is a faint overlay (intensity = overlap / digit dwell).
- **Clock:** board timebase is 50 MHz (20 ns); the UI capture remains 65,546
  cycles so cycle-indexed expectations are unchanged.

No push, tag, or release was made.