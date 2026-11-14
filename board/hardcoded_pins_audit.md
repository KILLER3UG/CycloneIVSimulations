# Hard-coded pin / polarity / silkscreen audit — backend/ and frontend/

Audit deliverable. Everything below is a place where the code embeds board
data (pin numbers, polarities, bit maps, part markings) that should be read
from `board/board.json` / `board/board_spec.md` instead. **No fixes applied
here** — this file is the work list for the follow-up code workstream.

Baseline evidence: `board/board.json` (single source of truth), the schematic
crops under `board/schematic/pages/`, and `board/vendor/Pinos_RZEasyFPGA.txt`.
Line numbers are as of the 2026-11-13 audit; re-grep before editing if the
tree moved.

## 1. Stale SEG bit map fallbacks (re-audited 2026-11-13: src/ fixed, legacy/ still wrong)

`board.json` `displays.segBitMap` was corrected to
`{"a":0,"b":1,"c":2,"d":3,"e":4,"f":5,"g":6,"dp":7}` (SEG0=a, SEG1=b — see
`board_spec.md` §0h and `sources.md` §7.1/§9.1). The re-audit re-grepped every
location listed in the first audit:

**FIXED since the first audit (now carry the corrected map or no fallback):**

| Location | Current state |
| --- | --- |
| `frontend/src/main.js` | `DEFAULT_SEG_MAP` constant and profile fallback **removed**; main.js no longer references segBitMap/segMap at all (the profile value flows through `board/io.js` + `board/layout.js`). |
| `frontend/src/board/io.js:13` | `DEF_SEG_MAP = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, dp: 7 }` — corrected. |
| `frontend/src/board/layout.js:467` | `b.displays?.segBitMap \|\| { a: 0, b: 1, … }` — corrected. |
| `frontend/src/board/layout.test.js:28` | fixture `segBitMap: { a: 0, b: 1, … }` — corrected. |

**STILL STALE (old `{ b: 0, a: 1, … }` map — renders a/b swapped if the
profile is missing; only affects the legacy viewer):**

| Location | What to change |
| --- | --- |
| `frontend/legacy/app.js:853` | fallback `|| { b: 0, a: 1, … }` — fix or delete with the legacy viewer. |
| `frontend/legacy/board3d.js:1121` | `this.segBitMap = disp.segBitMap \|\| { b: 0, a: 1, … };` — same. |
| `frontend/legacy/board3d.js:1243` | `const map = this.segBitMap \|\| { b: 0, a: 1, … };` — same. |

## 2. Part markings / silkscreen labels

| Location | What is there | What to change |
| --- | --- | --- |
| `frontend/src/board/layout.js:132` | U7 row: `marking: "EPCS16"`, `status: S.DS + " (M25P16-compatible footprint)"` | Correct per `board.json` `config.flash` = EPCS16; the note is acceptable, but ideally quote `config.flashMarkingNote` (EPCS16 vs M25P16/EPCS16N marking conflict, test T-FLASH-1). |
| `frontend/legacy/board3d.js:613` | chip marking `["EPCS16"]` | Already corrected this audit (was `M25P16`); keep in sync with `config.flash`. |
| `frontend/legacy/board3d.js:937` | silkscreen `label("EPCS16", …)` | Same. |
| `frontend/legacy/board3d.js:619` | chip marking `["MAX3232"]` | Schematic part is MAX3232E; the fitted part may be SP3232 (see `board.json` `uart.fittedPartNote`). Cosmetic; optionally note the conflict. |
| `frontend/legacy/board3d.js:945` | silkscreen `label("MAX3232", …)` | Same. |
| `frontend/legacy/board3d.js:611` | `marking: ["hynix", "HY57V641620"]` | Fine (matches schematic U6); no change. |

## 3. Backend hard-coded model inputs (peripheral stimulus/parameters)

Re-audited 2026-11-13. Two of the first audit's items were already applied:

| Location | Current state | What to change |
| --- | --- | --- |
| `backend/board_detect.py` (LM75 model) | **PARTIALLY FIXED**: now reads `BOARD["i2c"]["tempSensor"].get("temperatureC", 25.0)` with a comment explaining the classroom default — profile-overridable. The 25.0 literal remains as the fallback. | Optional: add `temperatureC` to `board.json` `i2c.legacyFlatKeys.tempSensor` so the default lives in the profile. |
| `backend/testbench_gen.py:437` | **FIXED**: `wp = "1" if BOARD["i2c"]["eeprom"].get("writeProtected", True) else "0"` — derived from `board.json`, not a literal. | None. |
| `backend/board_detect.py` (PS/2 model) | still `"scancoders": [0x5A]` | Hardcoded demo scancode; low priority (test stimulus, not board data). |
| `backend/board_detect.py` (IR model) | still a default NEC frame (now documented in a comment as "0x00/0x01 … the documented default frame") | Low priority. |
| `backend/testbench_gen.py:426, 445` | comments naming `I2C_SCL(99)/I2C_SDA(98)`, `FPGA_SCL(112)/FPGA_SDA(113)`, R25/R26, R27/R28 | Comments only (values come from the profile via `board_detect.py`); optionally reword to "see board.json". |
| `backend/peripherals.py:37` | `decode_uart(…, idle_high: bool = True)` default | Fine as a standard-UART default; callers use it unchanged. No action. |

## 4. Checked and found clean

* `backend/device.py` — no pin numbers, polarities or part constants; everything
  is loaded from `board/board.json` and reshaped structurally only.
* `backend/board_detect.py` port-name matching (`I2C_SCL`, `FPGA_SCL`, `PS_CLOCK`,
  `LCD_RS`, `IR`, …) — matches names, not pin numbers; the names mirror the
  vendor pin file, which is acceptable (they are the board's port names).
* `backend/qsf_parser.py` / `backend/simulator.py` — only the 144-pin EQFP
  package bound (a device property), no board pin literals.
* `frontend/src/board/layout.js` LED/button/switch/buzzer rows — polarity and
  pins are read from the profile (`b.leds?.activeLow`, `b.buttons?.pins`, …).
* `frontend/src/board/fpga.js:101` — builds `PIN_<n>` identifiers generically
  from the profile; no hard-coded pin numbers.

## 5. Suggested order of work for the fixing pass (updated after re-audit)

1. ~~Flip the seven stale SEG-map fallbacks (§1)~~ — **done for `frontend/src/`**
   (main.js, io.js, layout.js, layout.test.js); only the three `frontend/legacy/`
   fallbacks remain (app.js:853, board3d.js:1121, board3d.js:1243).
2. ~~Update `layout.test.js` fixture~~ — done.
3. ~~Thread `writeProtected` from `board.json` into the generated testbench (§3)~~ —
   done (`testbench_gen.py:437`).
4. Optionally fix the legacy viewer fallbacks (they only matter if
   `frontend/legacy/` is still served anywhere) and move the demo stimulus
   constants (PS/2 scancode, IR frame) into a config block; lowest priority.
