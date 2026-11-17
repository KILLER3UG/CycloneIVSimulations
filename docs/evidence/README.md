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