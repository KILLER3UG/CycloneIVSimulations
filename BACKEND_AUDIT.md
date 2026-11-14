# Backend audit — Cyclone IV VHDL simulator

Date: 2026-11-13 · Toolchain: Python 3.14.6, GHDL 6.0.0 (Dunoon, ucrt64/mcode), FastAPI backend.
Scope: every module under `backend/` (architecture, assumptions, defects) plus root-cause fixes for the three failing protocol cases PR-03 / PR-05 / PR-06 from the 2026-11-13 QA run.

---

## 1. Architecture map

| Module | Responsibility |
| --- | --- |
| `backend/server.py` | FastAPI app: REST `/api/*` (health, device, board, examples, compile, simulate), WebSocket `/ws` mirroring compile/simulate, static frontend mounting, CORS. |
| `backend/simulator.py` | Orchestration: request model (`SimulationRequest.from_dict`), Verilog/QSF rejection heuristics, parse → QSF validation → model attachment → testbench generation → GHDL analyze/synth/elaborate/run → VCD parse → waveform + peripheral decode → JSON result. Owns temp-dir lifecycle (`cyclone_sim_*`, `cyclone_compile_*`, `CYCLESIM_KEEP_DIR`). |
| `backend/vhdl_parser.py` | Lightweight VHDL *interface* extractor: tokenizer + recursive-descent scan that pulls entities/generics/ports out of a source file (architectures are skipped). Not a compiler — GHDL is the authority. |
| `backend/testbench_gen.py` | Auto-testbench synthesis: clock/reset detection by name, stimulus lowering (constant/toggle/pulse/sequence), generic constants, board-device model instances on `*_bus` signals, `sim_done`/duration control. |
| `backend/ghdl_tool.py` | Subprocess wrapper: `ghdl -a / --synth / -e / -r --vcd --stop-time`, GHDL discovery (env/PATH/winget paths), 60 s timeout, diagnostic regex parsing into `Diagnostic` records. |
| `backend/vcd_parser.py` | VCD reader: header (`$timescale/$scope/$var`), value-change section → per-signal `(time_ns, value)` transition lists. |
| `backend/waveform.py` | UI model: scope filtering under the testbench root, port/internal signal classification, cycle sampling on detected clock rising edges, final values, and `map_board()` → `BoardMap` (leds/switches/buttons/displays/digits, clock/reset + polarity, pin map, per-device configs) sourced from `board/board.json`. |
| `backend/device.py` | Board/chip profile loader: loads `board/board.json` at import, reshapes it into the flat `BOARD` dict, exposes `DEVICE()` datasheet figures, `board_pin_map()` (port name → package pins) and `SEG_BIT_MAP`. Single source of truth for pins/polarities — no pin or polarity is hard-coded here. |
| `backend/board_detect.py` | Matches top-level port names against the board's device ports (I2C EEPROM/LM75 buses, PS/2, LCD, IR) and returns the device models (plus their VHDL files) to attach to the generated testbench. |
| `backend/peripherals.py` | Post-run decoders over captured pin transitions: UART 8N1 frames + baud, buzzer toggle frequency, coarse VGA frame sampling; reads textio dumps (`lcd_state.txt`, `eeprom_dump.txt`) written by the VHDL models. |
| `backend/qsf_parser.py` | Quartus `.qsf` reader/validator: TOP_LEVEL_ENTITY, DEVICE/FAMILY (checked against the fitted EP4CE6/EP4CE10), file lists, `set_location_assignment` pin map (144-pin EQFP range, duplicate detection), IO_STANDARD, unused-pin policy. |
| `backend/__main__.py` | CLI: `doctor`, `examples`, `run` (single-file simulation with printed cycle table / JSON / VCD export), `serve`. |

### Data flow (HDL front-end → GHDL → VCD → waveform/board → API/WS)

```
UI / tests
  │  POST /api/simulate  {vhdl | files[], qsf?, top?, duration, clockPeriod, stimuli…}
  │  WS /ws {type:"simulate", …}
  ▼
server.py ── SimulationRequest.from_dict ──► Simulator.simulate (simulator.py)
  │ 1. _sources(): normalize to (filename, content); reject Verilog/SystemVerilog
  │ 2. VHDLParser.parse per file ──► Design{entities, errors}        (vhdl_parser.py)
  │ 3. parse_qsf (if .qsf text present) ──► top/device/pins/io-standards validation
  │    against entity ports and the fitted device                    (qsf_parser.py)
  │ 4. board_models(entity) ──► attach at24c08 / lm75 / ps2_keyboard /
  │    hd44780 / ir_nec models whose board ports the design exposes  (board_detect.py)
  │ 5. generate_testbench(entity, config) ──► testbench.vhd with clock/reset
  │    processes, stimuli, and model instances on *_bus signals      (testbench_gen.py)
  │ 6. GhdlTool: -a (designs+models+tb) → --synth (lint) → -e top →
  │    -r --vcd=wave.vcd --stop-time=…   [throw-away tempdir, 60 s timeout]
  ▼
wave.vcd ── parse_vcd ──► VcdData{signals: [(t_ns, value)]}          (vcd_parser.py)
  ▼
build_waveform(vcd, entity, root=tb_top, max_cycles, duration_cap)   (waveform.py)
  │  ├─ scope-filtered signals (ports first, then internals)
  │  ├─ cycles[] sampled on rising edges of the detected clock port
  │  └─ map_board(entity) → BoardMap: pin map + ledConfig/displayConfig/
  │     resetActiveHigh/profile parts — ALL values from board/board.json (device.py)
  ▼
peripherals: decode_uart / decode_buzzer / decode_vga over pin transitions;
read_model_dumps() picks up lcd_state.txt / eeprom_dump.txt          (peripherals.py)
  ▼
JSON {ok, entity, board, waveforms{signals,cycles,final,board}, peripherals,
      qsf, warnings, errors, logs[-4000:]}  ──►  UI renders waveforms + 3D board,
      applying active-low polarities exactly once, in the renderer.
```

---

## 2. Per-module assumptions and what breaks them

**vhdl_parser.py** — assumes sources are VHDL whose *interface* (entity/port/generic) is extractable by a lenient scan; assumes constrained scalar/vector types (`std_logic`, `std_logic_vector(a downto b)`, `integer range …`).
Breaks: (a) interface items with VHDL-2008 class keywords (`port (signal a : in std_logic)`) — the class word is eaten as a name, the parser errors and drops the port; (b) character literals outside the hard-coded `'01xXzZwWhHuUlL-'` set (e.g. `'E'`) tokenize as three junk tokens — harmless for interface extraction, breaks default-value parsing; (c) unconstrained vector ports get `width=None` → downstream code treats them as 1-bit.

**testbench_gen.py** — assumes the design has at most one clock and one reset, recognisable by name (`clk*`, `*reset*`, `rst*`); assumes generics used in port ranges are numeric with literal defaults; assumes model-attached ports are driven by the models, not by user stimuli.
Breaks: (a) an input named `clk_en` (clock *enable*) is accepted as the clock when no better-named clock port exists — the enable gets toggled as a clock; (b) any input containing "reset" (e.g. `reset_req`) is hijacked as the reset; (c) when a device model overrides a port (`PS_DATA => PS_DATA_bus`), user stimuli for that port are emitted against the *shadow* signal and never reach the DUT; (d) generics without defaults and without user values produce a testbench that references an undeclared constant (GHDL analysis error with a confusing message).

**ghdl_tool.py** — assumes `ghdl` is discoverable (env `GHDL_BIN`/`GHDL`, PATH, winget/Program Files/msys64 locations); assumes any single GHDL invocation finishes within 60 s.
Breaks: (a) long simulations (PR-05's 50 ms run takes ~50–60 s wall) sit right at the fixed ceiling — a slower machine turns a passing run into "GHDL timed out after 60 seconds"; (b) the 60 s cap is the *only* runaway guard — a design with an infinite no-wait loop burns 60 s of CPU every attempt; (c) diagnostics rely on GHDL's `file:line:col: severity: text` layout; unexpected formats are silently dropped from `errors` (returncode still saves `ok`).

**vcd_parser.py** — assumes the VCD fits in memory as one string; assumes vector changes are written with a space (`b1010 !`); assumes identifiers in `$var` are unique per signal.
Breaks: (a) multi-hundred-MB VCDs (50 ms LCD/IR runs) are read whole and `splitlines()`-doubled — memory spike ≈ 2× file size; (b) space-less vector changes (`b1010!`) are silently dropped; (c) aliased identifiers (same id, multiple names) keep only the last `$var` mapping.

**waveform.py** — assumes VCD scope paths under the generated testbench root (`tb_<entity>`); assumes the clock port (if any) actually toggles; assumes port names uniquely identify signals after `[range]` stripping.
Breaks: (a) `cycles()` materialises *every* clock rising edge before slicing `max_cycles` — a 5 M-cycle run builds a 5 M-element list even when 256 cycles are requested; (b) `map_board` classifies ports by substring heuristics (`"led" in name`, `"seg"/"hex"/"display" in name`) — a port like `DISPLAY_EN` lands in `displays`; (c) `ledConfig.pins` is built as `dict(zip(pins, pins))` — a self-map (`PIN_87→PIN_87`) that carries no information.

**device.py** — assumes `board/board.json` exists, matches the expected schema (`board.leds`, `board.i2c.buses`, `board.i2c.legacyFlatKeys`, `board.lcd.pins`, …), and is loaded exactly once at import; assumes a single selected device per process (`set_device` global).
Breaks: (a) any JSON/schema error is an import-time `JSONDecodeError`/`KeyError` that kills the whole backend (including `python -m backend doctor`) with a raw traceback; (b) `board_pin_map()` rebuilds the index on every call (per-simulation); (c) `_selected` device state is process-global — not per-session.

**board_detect.py** — assumes designs expose board *port names* exactly (`I2C_SCL`, `PS_CLOCK`, `LCD_RS`, `IR`, …); assumes one device per bus kind per design.
Breaks: (a) the port-name lists duplicate names that also live in `board.json` — a board.json port rename desynchronises model attachment (code would silently stop attaching the model); (b) generic `SCL`/`SDA` names are claimed for the EEPROM bus by convention; (c) LM75 temperature (25.0) and IR address/command (0x00/0x01) are simulation parameters hard-coded in code rather than configuration.

**peripherals.py** — assumes clean digital waveforms: UART bit time = shortest inter-edge delta (no glitches), frames start on a 1→0 transition with a valid stop bit; VGA sampling assumes colour constant per line.
Breaks: (a) a single glitch pair 1 ns apart destroys the baud estimate and every frame after it; (b) `decode_uart`'s first edge-width loop is dead code and `idle_high` is ignored; (c) `decode_vga` builds `png_rows` and discards it — `png` is always `None`.

**qsf_parser.py** — assumes one assignment per line, no inline comments, pins `PIN_1..PIN_144` (EQFP-144), targets `PORT` or `PORT[bit]`.
Breaks: (a) trailing `-- comment` / `# comment` after an assignment makes `_LOCATION_RE`/`_GLOBAL_RE` miss the line (pin assignment silently lost) or swallows the comment into the value (`DEVICE "EP4CE6E22C8" -- note` → device string polluted → spurious mismatch warning); (b) range targets like `LED[3:0]` are not understood (treated as a port literally named `LED[3:0]`).

**simulator.py** — assumes each simulation is self-contained in a throw-away tempdir; assumes GHDL's `--stop-time` plus the generated `sim_done` bound the run; assumes the lightweight parser's errors are advisory.
Breaks: (a) `maxCycles` and `duration` are unbounded on the API surface — a hostile/large request makes GHDL produce a huge VCD and `cycles()` materialise millions of samples (memory exhaustion; the 60 s GHDL timeout is the only brake); (b) when a `.qsf` is present, *any* lenient-parser error becomes fatal even though GHDL might accept the code; (c) duplicate imports of `board_models`/`model_files`/`decode_*` (cosmetic).

**server.py** — assumes requests are small and sequential per client; assumes the WebSocket client correlates messages by order.
Breaks: (a) `_ws_simulate` sends all three `progress` events *before* starting the work — progress is decorative; there are no request IDs, no cancellation, no per-stage updates; (b) `_ws_compile` drops `files` and `qsf` (multi-file/QSF compile impossible over WS); `/api/compile` drops `qsf`; (c) no payload/duration limits are enforced server-side (the advertised `/api/simulate` option maxima are informational only).

**__main__.py** — assumes single-user local CLI use; `--out` works because it sets `CYCLESIM_KEEP_DIR=1` before `simulate`. No significant broken assumptions.

---

## 3. Findings by severity

Tally: **0 CRITICAL · 7 MAJOR · 12 MINOR**. Nothing observed corrupts simulation results or inverts polarity twice; the MAJOR items are resource/protocol/robustness defects and one honest deployment exposure. File:line refers to the working tree at audit time.

### MAJOR

| # | Location | Root cause | Fix proposal | How to test |
| --- | --- | --- | --- | --- |
| M1 | `backend/simulator.py:89` + `backend/waveform.py:377-387` | `maxCycles`/`duration` are unbounded on the API surface; `cycles()` materialises one dict per clock rising edge before any cap beyond `max_cycles`, and the VCD is parsed whole. A request with `duration=1e9, clockPeriod=1, maxCycles=1e9` drives GB-scale VCD + Python structures → OOM/DoS of the single-process server. | Clamp `maxCycles` (e.g. ≤ 4096) and `duration` (≤ advertised 1e6 ns) in `SimulationRequest.from_dict` (and mirror the advertise maxima), and make `cycles()` stop early once `max_cycles` samples are collected. | POST `/api/simulate` with `{"vhdl": <counter>, "duration": 1e9, "clockPeriod": 1, "maxCycles": 1000000}` → expect a fast 4xx/accepted-clamped run, not multi-GB memory growth (watch RSS). |
| M2 | `backend/server.py:282-304`, `backend/server.py:197` | WebSocket protocol gaps: `_ws_compile` calls `compile_source(vhdl, top)` dropping `files` and `qsf`; `/api/compile` drops `qsf`; `_ws_simulate` emits all `progress` stages *before* the work starts (no real stage events), and there are no request IDs or cancellation — two interleaved WS requests cannot be correlated. | Pass `files`/`qsf` through both compile paths; emit `progress` around each actual stage inside `simulate` (via a callback or per-stage sends in `_ws_simulate`); add an echo'd `requestId` to every WS reply; (optionally) support `{type:"cancel"}`. | WS: send `{"type":"compile","vhdl":…,"files":[{name,content}]}` → expect the second file analyzed (today it is ignored); interleave two simulates and check responses carry the right `requestId`. |
| M3 | `backend/vcd_parser.py:99-101` | `parse_vcd` reads the whole VCD into one string and `splitlines()` duplicates it — ≈2× VCD size in RAM at peak. PR-05-scale runs already produce large dumps. | Stream: iterate the file line-by-line (`for raw in handle:`) sharing the existing parser body; keep `parse_vcd_text` for tests/compat. | Simulate PR-05 with `CYCLESIM_KEEP_DIR=1`, run `parse_vcd` on the kept `wave.vcd` while tracking peak RSS — expect ≈ file size, not ≈ 2×; or unit-test `parse_vcd_file` against a generated 200 MB VCD in a tempdir. |
| M4 | `backend/ghdl_tool.py:225-240` | Hard-coded `timeout=60` per GHDL invocation. PR-05's 50 ms simulation already takes ~50-64 s wall on this machine — the ceiling is one slow machine away from flaking every long run; it is also the only runaway guard (each attempt burns up to 60 s CPU). | Make the timeout configurable (`GHDL_TIMEOUT` env / `GhdlTool(timeout=…)`, default raised to ~300 s for `-r`), and surface a distinct "simulation exceeded N s — possible runaway (infinite loop without wait?)" message. | Run PR-05 twice, second time with `GHDL_TIMEOUT=5` → expect the structured timeout error path, then restore; time PR-05 to see headroom vs the default. |
| M5 | `backend/qsf_parser.py:62-66` | Only full-line comments are skipped (`startswith('#')/('--')`); inline comments break `_LOCATION_RE`/`_GLOBAL_RE` (`set_location_assignment PIN_87 -to LED[0] -- LED1` doesn't match → assignment silently lost) or pollute values (`DEVICE "EP4CE6E22C8" -- note` → spurious device-mismatch warning). | Strip inline comments before matching: split on `--`/`#` outside quotes (simplest: `re.sub(r'(--|#).*$', '', line)` — QSF values here never contain `--`/`#` inside quotes in this repo's vendor files; verify against vendor QSFs). | Unit test: `set_location_assignment PIN_87 -to LED[0] -- LED1` + `set_global_assignment -name DEVICE "EP4CE6E22C8" -- fitted` → expect `pins == {"LED": ["PIN_87"]}` and no device-mismatch error. |
| M6 | `backend/testbench_gen.py:399-461` vs `552-599` | When a board model overrides a port (`PS_DATA => PS_DATA_bus`), the stimulus emitter still drives the *original* port-named signal (`PS_DATA <= '0';`) — a shadow signal connected to nothing. User stimuli/constant inputs on model-attached ports (PS/2, IR, I2C, LCD data) are silently ignored. | Build the emitter's signal name through the same `port_overrides` map used for the port map (`signal_name = port_overrides.get(port.name.lower(), port.name)` in the stimulus section and `constant_inputs` loop). | Generate a testbench for `ps2_rx` with `constantInputs={"PS_DATA": 1}` → today the tb contains `PS_DATA <= '1'` while the DUT pin is on `PS_DATA_bus`; after the fix the statement must target `PS_DATA_bus`. |
| M7 | deployment (`backend/server.py:39-44`, `backend/__main__.py:159-164`) | No authentication + CORS `allow_origins=["*"]` + natively executed uploaded VHDL (see §4). On the default `127.0.0.1` bind this is a local tool; any non-loopback bind (`--host 0.0.0.0`) turns `/api/simulate` into unauthenticated remote file-read/write/CPU-burn via VHDL `textio`. | If ever served beyond localhost: require a token (header check dependency), bind explicitly, and document that uploaded VHDL runs with full process privileges; ideally add a `--public` gate that refuses to start without an explicit acknowledgement. Keep CORS restricted to the served origin. | Start `python -m backend serve --host 127.0.0.1` and confirm CORS/OPTIONS behave; document in README that `--host 0.0.0.0` exposes file IO to the network. |

### MINOR

| # | Location | Root cause | Fix proposal | How to test |
| --- | --- | --- | --- | --- |
| m1 | `backend/vhdl_parser.py:383-397` | VHDL-2008 interface class keywords (`signal`/`constant`/`variable`) in port lists are consumed as port names → "Expected ':'" → whole port dropped. | In the name-collection loop, skip tokens whose lowercase is in `{"signal","constant","variable"}` before treating them as names. | Parse `entity e is port (signal a : in std_logic); end entity;` → expect port `a` with direction `in`. |
| m2 | `backend/vhdl_parser.py:36` | Character-literal regex only covers `'01xXzZwWhHuUlL-'`; literals like `'E'`/`'a'` tokenize as junk (`'`, ident, `'`). Harmless today (architectures are skipped) but breaks default-value parsing and any future expression use. | Generalize to `'(.)'` (any single char, with `''` escape already covered by the string rule). | Tokenize `c := 'E';` → expect a single `char` token `'E'`. |
| m3 | `backend/testbench_gen.py:65-74` | `detect_clock` accepts any 1-bit input starting with `clk`/`clock` — `clk_en`/`clk_out` can be picked as the clock when the real clock port is unconventionally named. | Require fullmatch against the known clock names/`clk\d*` pattern, or exclude suffixes `en/enable/out/by/div`; prefer the first *exact* known-name match before heuristic matches. | Unit test: entity with ports `CLOCK_50`, `clk_en` → clock must be `CLOCK_50`; entity with only `clk_en` → expect `None` (or `clk_en` only if no exclusion is chosen — document). |
| m4 | `backend/testbench_gen.py:86-100` | `detect_reset` matches any input containing `reset` (`reset_req` gets hijacked and driven). | Match on exact names (`_RESET_NAMES`, board reset port) or word-boundary `rst|reset` stems; never substring-only. | Unit test: entity with input `reset_req` and no reset → `detect_reset` returns `None`. |
| m5 | `backend/waveform.py:177` | `ledConfig.pins = dict(zip(pins, pins))` is a self-map (`PIN_87→PIN_87`) — carries no mapping information to the UI. | Either map LED index → pin (`{str(i): pin}`) or drop the key; keep the UI on `pinMap`. | Unit test: `map_board(entity).led_config["pins"]` should map LED0..3 → PIN_87/86/85/84 (or be absent). |
| m6 | `backend/waveform.py:377-387` | `clock_times()` builds the full rising-edge list (millions of floats for long runs) before `[:max_cycles]`. | Early-exit: iterate transitions and stop once `max_cycles` edges are collected. | Time `build_waveform` on a 5 M-cycle VCD before/after; expect the cycle list length to stay `max_cycles`. |
| m7 | `backend/waveform.py:126-146` | `map_board` substring heuristics: `DISPLAY_EN` → `displays`, `LED_DONE` → `leds`. Harmless for display, but mislabels purpose. | Match on full tokens/regex (`^LED\d*$`, `^(SEG|HEX)\d*$`, …) before substring fallback; document as heuristic. | Unit test: ports `DISPLAY_EN`, `LED_DONE` → expect neither in `displays`/`leds` (or explicitly documented classifications). |
| m8 | `backend/vcd_parser.py:189-196` | Space-less vector changes (`b1010!`) are dropped (`len(parts) != 2`). | Parse with a regex: `^([bBrRsS])([01xXzZ]+)\s*(\S+)$` (and keep the split path as fallback). | Unit test: `parse_vcd_text("$var reg 4 ! x $end … b1010!")` → transition captured. |
| m9 | `backend/peripherals.py:53-56,37` | Dead first loop in `decode_uart`; `idle_high` parameter unused; a 1 ns glitch pair ruins the `min()` bit-time estimate and every frame after. | Delete the dead loop; debounce edges closer than half the current bit estimate (two-pass: estimate, filter, re-estimate); honour `idle_high` or remove the parameter. | Unit test: `decode_uart` on a clean 0x55 frame + one 1 ns glitch → still decodes the frame; idle_high=False path exercised. |
| m10 | `backend/peripherals.py:186-191` | `png_rows` built then discarded; `png` always `None`. | Remove the dead rows or actually emit a tiny PNG/PPM from `samples`. | Unit test: `decode_vga` output has no phantom `png_rows`; either `png` is a real payload or the key is gone. |
| m11 | `backend/simulator.py:27-30` | `board_models`, `model_files`, `decode_uart/buzzer/vga`, `read_model_dumps` each imported twice. | Deduplicate imports. | `python -m compileall backend` + ruff/flake8 F811 scan. |
| m12 | `backend/device.py:22-30,78-126` | `board.json` is loaded/reshaped at import with zero error handling — a schema drift or corrupt file kills `import backend.*` (server, CLI, tests) with a raw `JSONDecodeError`/`KeyError`. | Wrap load+reshape in a validator that raises `BackendConfigError("board/board.json: missing key 'board.leds.pins'")`-style messages listing the problem; keep `load_board_json()` re-entrant for `/api/board`. | Unit test: point `BOARD_JSON` at a truncated JSON in a tempdir → expect a clear `BackendConfigError`, not `json.decoder.JSONDecodeError`. |

---

## 4. Sandbox reality (honest assessment)

**There is no security sandbox around uploaded VHDL.** The backend shells out to the locally installed `ghdl.exe`, which analyzes, elaborates and *executes* the user's VHDL natively inside the server's OS process. Concretely:

* **File system**: VHDL `std.textio` (`file_open`/`write`/`read`) works for any path the process can access. The bundled models themselves use it (`hd44780.vhd` writes `lcd_state.txt`; the AT24C08 model writes `eeprom_dump.txt`). Uploaded VHDL can therefore read and write arbitrary files with the server process's permissions — the temp workdir is *not* a containment boundary, only a namespace convenience.
* **CPU / memory**: GHDL is the only brake. `--stop-time` bounds simulated time, and `subprocess.run(timeout=60)` kills a hung simulator after 60 s — but each request can consume up to ~60 s of CPU and an unbounded amount of RAM before that (see M1/M3). A VHDL design with an infinite no-wait loop, huge array allocations, or recursive functions will be killed, not contained.
* **Code execution beyond VHDL**: VHPI/FLI is *not* enabled by the backend (no `--vhpi`/foreign-library flags are passed, and `ghdl --synth` runs in-process lint only), so there is no documented path from uploaded VHDL to arbitrary native code — but the GHDL process still runs with full user privileges, and any future flag passthrough would change that.
* **Network exposure**: the server has no authentication and `CORSMiddleware(allow_origins=["*"])`. On the default `127.0.0.1:8000` bind, exposure is local (any local user/process, plus drive-by browser posts to localhost). `python -m backend serve --host 0.0.0.0` is a one-flag remote exposure (M7).
* **Existing mitigations (real ones)**: per-run throw-away tempdirs (`tempfile.mkdtemp(prefix="cyclone_sim_")`, removed in `finally` unless `CYCLESIM_KEEP_DIR=1`), `--stop-time` derived from the requested duration, the 60 s subprocess timeout, response `logs` truncated to the last 4000 chars, and Verilog/mixed-language rejection before GHDL ever sees the file.

Any claim that "uploaded VHDL is sandboxed" would be false; it is *isolated per run* (no shared state between simulations) but fully privileged. Treat the endpoint as executing trusted code.

---

## 5. Pin mapping & polarity — end-to-end trace

Question from the review brief: *is active-low inversion applied exactly once end-to-end?*

Answer: **yes — the backend never inverts data-path values; polarities travel as metadata from `board/board.json`, and the single inversion happens in the frontend renderer.**

1. `board/board.json` is the only place a polarity or pin exists (`leds.activeLow=true`, `displays.segmentActiveLow/digitActiveLow`, `buttons.activeLow`, `buzzer.activeLow`, `infrared.activeLow`, `resetActiveLow`, `pinMap{...}`).
2. `backend/device.py` loads it verbatim into `BOARD` (no pin/polarity is introduced in `_build_board`; it only reshapes nesting).
3. `backend/waveform.py::map_board` copies them into `BoardMap` as `ledConfig.activeLow`, `displayConfig.{segmentActiveLow,digitActiveLow,segBitMap}`, `resetActiveHigh`, `pins` (only names that exist in `board_pin_map()`), `profileParts` — via `as_dict()` these reach the API payload as `board.ledConfig`, `board.displayConfig`, `board.resetActiveHigh`, `board.pins`.
4. `backend/testbench_gen.py::detect_reset` uses `BOARD["resetPort"]`/`BOARD["resetActiveLow"]` to decide the *stimulus* polarity of the generated reset (assert `'0'` then release `'1'` for the A2.2's active-low `FPGA_RST`) — this drives the DUT input, it does not transform captured data.
5. `backend/vcd_parser.py`/`WaveformSignal.to_dict` emit raw logic values (`0/1/x/z/…`) — no inversion anywhere in parsing or sampling (`_normalize_value` only canonicalises `'x'→'X'` etc.).
6. `frontend/app.js` applies the polarity exactly once at render time: LED pixels use `ledConfig.activeLow` (`app.js:840`), segment glyphs use `displayConfig.segBitMap` + `segmentActiveLow` (`app.js:852-854`), key/DIP press handlers clear the bit (`value &= ~(1 << bit)`, `app.js` per POL-05) and the renderer lights on 0 for active-low controls. The 3D board reads the same config (`board3d.js` `ledConfig`).
7. Regression cover: `tests/qa/test_audit_polarity.py` POL-01…POL-05 pin this contract (LED lit-at-0, KEY/DIP wired-AND, SEG bit map → 0xC0/0xFA/0xF8, buzzer active-low, and "stimulus reaches the design unchanged; only the renderer inverts").

Residual polarity nits: `ledConfig.pins` is a useless self-map (m5) and `map_board`'s substring classification can mis-bucket oddly named ports (m7) — both cosmetic, neither double-inverts.

---

## 6. Phase 2 — protocol case failure → fix → re-test log

Method note: `tests/RESULTS.md` is being overwritten concurrently by another agent, so all evidence below was captured with a private runner (harness `run_all(only=…)` against `tests/qa/test_audit_protocols.py`, without writing `RESULTS.md`). GHDL error lines quoted verbatim.

### PR-03 — PS/2 frame (tests/qa/designs/board/ps2_rx.vhd)

**Expected protocol behaviour (PS/2 spec).** The keyboard is the timing master: it emits a ~10–20 kHz clock (model: 30 µs half-period) and drives DATA open-collector with pull-ups (idle high). A frame is 11 bits sampled by the host on **falling** CLOCK edges: `start=0`, 8 data bits **LSB first**, **odd parity** (parity bit = NOT(xor of the 8 data bits), so data+parity carries an odd number of 1s), `stop=1`. The model sends `0x5A` (Enter make), `0xF0` (break prefix), `0x5A`. Case contract: `STATUS=0xF` (start/parity/stop ok, ≥2 frames) and `RESULT=0x5A`.

**Failure (2026-11-13 run).** GHDL rejected the design source at analysis: `'=>' expected instead of 'when'` — a VHDL syntax/standard-version defect in the design's sequential code. The current revision of the file still carried the fragile construct: four *sequential conditional signal assignments* inside the clocked process (`parity_ok <= '1' when xd /= p else '0';` etc., ps2_rx.vhd:51-55). Those are legal only from VHDL-2008 on; reproducing today under `ghdl -a --std=93` gives:

```
ps2_rx.vhd:51:59:error: conditional signal assignment in sequential statement not allowed before VHDL 2008. Compile with --std=08
ps2_rx.vhd:52:70:error: …
ps2_rx.vhd:53:71:error: …
```

(under the original file revision this construct surfaced as the reported parse error `'=>' expected instead of 'when'`).

**Root cause.** The design source used a VHDL-2008-only statement form; any analysis under an older `--std` (or a parser that pre-dates 2008 conditional-assignment support) fails on the `when` keyword where a waveform/`=>` is expected. The backend currently pins `--std=08`, so the construct *happened* to pass — the design was one config flip away from failing again.

**Minimal fix applied** (tests/qa/designs/board/ps2_rx.vhd — allowed file). Rewrote the four sequential conditional assignments as plain `if/else` sequential statements (behaviour-identical, VHDL-93-compatible), and documented the constraint in the header. Verified: `ghdl -a` now succeeds under `--std=93`, `--std=93c` and `--std=08` (rc=0 each).

**Re-test.** `PR-03 [PASS] (3.9s) — PS/2 frame format + odd parity verified; 0x5A decoded` (STATUS=0xF, RESULT=0x5A).

### PR-05 — HD44780 (board/models/hd44780.vhd)

**Expected protocol behaviour (HD44780 datasheet).** 8-bit 1602 interface: RS=0/RW=0 with E falling executes a command; RS=1/RW=0 writes DDRAM; RW=1 with E high outputs busy flag (D7) + address counter (D6..D0). E high pulse must be ≥ PWEH ≈ 450 ns. Clear/home take 1.52 ms, other commands 37 µs (busy flag set meanwhile). Power-on init: wait ≥ 15 ms → function set 0x38 (8-bit, 2 lines) → display on 0x0C → clear 0x01 → entry mode 0x06; then characters. DDRAM: line 1 = 0x00-0x27, line 2 = 0x40-0x67. Case contract: the model's `lcd_state.txt` dump contains `HELLO`.

**Failure (2026-11-13 run).** `board/models/hd44780.vhd` declared `signal busy : boolean` (line 34 in the committed revision) and drove it from **two processes**: the `execute` process (`busy <= true` on every command/byte) and a separate `busy_clear` process (`busy <= false` when the busy timeout elapsed). A non-resolved type (`boolean`) may have exactly one driver — GHDL fails at elaboration. Reproduced verbatim from the committed revision (`git show HEAD:board/models/hd44780.vhd`) with a 3-line instantiating testbench:

```
$ ghdl -e --std=08 --workdir=. tb_hd
hd44780_head.vhd:34:12:error: too many drivers for signal "busy"
    signal busy      : boolean := false;
```

**Root cause.** Two processes driving one unresolved signal — illegal VHDL, detected by GHDL during elaboration of the model.

**Minimal fix applied** (board/models/hd44780.vhd — allowed file, present in the working tree and verified here). Derive "busy" from a **single** `busy_end : time` signal that the `execute` process sets (`busy_end <= now + 1520 us / 37 us`), and let the one `busy_out` process decide the bus state from `now < busy_end` — one driver per signal, datasheet-identical busy-flag timing (D7=1 while busy, D7=0+address after). The stray `busy_clear` process was removed. Correctness re-checked by reading: `d_out` has exactly one driver; `lcd_d` (inout) has exactly one concurrent assignment; PR-05 passes.

**Re-test.** `PR-05 [PASS] (50.7s, re-confirmed 63.7s) — LCD model shows HELLO after the 8-bit init sequence` (`peripherals.lcd` contains `HELLO` on line 1 of the dump).

### PR-06 — NEC IR (tests/qa/designs/board/ir_decode.vhd)

**Expected protocol behaviour (NEC, active-low demodulated input).** The receiver idles high; a burst pulls the line low. Frame: 9 ms lead burst + 4.5 ms space, then 32 bits LSB first (address, ~address, command, ~command); bit 0 = 560 µs burst + 560 µs space, bit 1 = 560 µs burst + 1690 µs space. Model constants: `ADDRESS=0x00`, `COMMAND=0x01`, `START=3 ms` — so the first transmitted data bit is address bit 0 = 0 and its trailing space is 560 µs. Case contract at a 100 ns clock: `LEAD≈90000`, `COUNT=33` (lead + 32 data bursts), `SPACE1≈5600` (±2 %).

**Failure (2026-11-13 run).** `tests/qa/designs/board/ir_decode.vhd` failed GHDL analysis with `identifier "space1" already used`. Root cause class reproduced with a minimal snippet (entity port `SPACE1` + architecture `signal space1`):

```
clash.vhd:8:12:error: identifier "space1" already used for a declaration
    signal space1 : std_logic_vector(31 downto 0) := (others => '0');
clash.vhd:5:11:error: previous declaration: port "SPACE1"
```

**Root cause.** VHDL identifiers are case-insensitive: an earlier revision declared an architecture signal `space1` while the entity already declared the output port `SPACE1` — the architecture redeclares the port's implicit signal, which GHDL rejects at analysis.

**Minimal fix applied** (tests/qa/designs/board/ir_decode.vhd — allowed file, present in the working tree and verified here). The measuring signal is named `space1_reg` (no case-insensitive clash with port `SPACE1`), and the header now documents both the name constraint and the actual first-bit expectation (address=0x00 → first bit is 0 → 560 µs space; the old comment wrongly implied the command's bit 1 came first). Design logic (edge counting, `rises` bookkeeping) verified against the NEC timings: lead captured on rising edge #1, first data-bit trailing space on rising edge #3 (`rises=2` old-value check).

**Re-test.** `PR-06 [PASS] (43.7s) — NEC timing verified: lead 89999, 33 bursts, bit-0 space 5599 clocks` (within 2 % of 90000/5600).

---

## 7. Risky modules observed but NOT changed (ownership limits)

* `backend/simulator.py`, `backend/ghdl_tool.py`, `backend/server.py` — read-only for this audit. The riskiest behaviours live there: unbounded request parameters (M1), decorative WS progress + dropped `files`/`qsf` on the WS/compile paths (M2), and the fixed 60 s GHDL timeout (M4). Findings M1/M2/M4 include concrete fixes and tests for the owning agent.
* `tests/run_all.py`, `tests/qa/harness.py`, `tests/test_*.py`, `frontend/**`, `board/*.md`, `board/board.json` — untouched per ownership limits; `board.json` was read as the pin/polarity source of truth and its contents match what `device.py`/`waveform.py` expose.
* Files actually modified for Phase 2: `tests/qa/designs/board/ps2_rx.vhd` (std-agnostic rewrite of 4 statements + header note), `tests/qa/designs/board/ir_decode.vhd` (accurate header comment; the `space1_reg` fix itself was already present in the working tree and was verified, not weakened), and this document. `board/models/hd44780.vhd`'s single-driver `busy_end` fix was verified correct (one driver per signal; PR-05 passing twice) — no further edit required.

## 8. Verification commands

```
# targeted re-runs (private runner, does not touch tests/RESULTS.md)
python -I <scratch>/c4_prcheck.py PR-03
python -I <scratch>/c4_prcheck.py PR-05
python -I <scratch>/c4_prcheck.py PR-06

# VHDL-level reproductions (scratch dir, GHDL 6.0.0)
ghdl -a --std=93 ps2_rx.vhd            # pre-fix: 3x "conditional signal assignment … not allowed before VHDL 2008"
ghdl -e --std=08 tb_hd                 # HEAD hd44780: 'too many drivers for signal "busy"' at hd44780_head.vhd:34:12
ghdl -a --std=08 clash.vhd             # port/signal case-clash: 'identifier "space1" already used for a declaration'
```


---

## 9. Remediation log (Phase 3 — fixes, QA expansion, mutation, coverage)

Date: 2026-11-13 · Agent: backend verification · All items re-tested by execution.

### MAJOR findings — fixed

| # | Fix | Before → After evidence |
| --- | --- | --- |
| M1 | `SimulationRequest.from_dict` clamps `duration` to [1, 2e9] ns, `clockPeriod` to [0.01, 1e6] ns, `resetCycles` to [0, 1e6], `maxCycles` to [1, 8192]; non-finite/invalid values fall back to defaults; every clamp is surfaced as a `request parameter clamped` warning in the result. `WaveformModel.clock_times` early-exits at `max_cycles` (m6). | `duration=1e18, maxCycles=1e9, clockPeriod=0` → clamped to 2e9 ns / 8192 / 0.01 ns with three warnings; CKM-01 verifies exact cycle sampling (100 edges in a 2000 ns window at 50 MHz). |
| M2 | `/api/compile` now forwards `qsf`; `_ws_compile` forwards `files` + `qsf`; every WS compile/simulate reply echoes `requestId`. | REST compile with a .qsf returns `qsf.top/pins`; WS compile with two files + qsf + `requestId=42` → `compiled ok` with `requestId: 42`. |
| M3 | `parse_vcd` streams the file line-by-line (no whole-file read, no 2× RAM spike); `parse_vcd_text` kept for compatibility. | Byte-identical output proven on a real GHDL VCD (8 signals, every transition equal between streaming and in-memory parse). |
| M4 | `GhdlTool` timeout scales with the requested simulation: 2 s wall per simulated ms + 30 s, floor 60 s, cap 900 s; `GHDL_TIMEOUT` env or `GhdlTool(timeout=…)` override; a timeout produces an error diagnostic naming the budget plus a runaway-design hint. | 50 ms sim → 130 s budget; with `timeout=3` the runaway design fails in ~3 s with `GHDL timed out after 3 s … possible runaway design` (RF-06). |
| M5 | `qsf_parser` strips inline `--`/`#` comments outside quotes before matching. | `set_location_assignment PIN_87 -to LED[0] -- LED1` keeps the pin; a commented `DEVICE` line no longer pollutes the value (QE-01). |
| M6 | Stimulus and constant-input emission goes through the same `port_overrides` map as the port map, so user stimulus drives the shared `*_bus` net on model-attached ports. | A PS/2 design with `constantInputs={"PS_DATA": 1}` emits `PS_DATA_bus <= '1'`; zero shadow `PS_DATA <=` statements remain. |

### MINOR findings — fixed

m1 interface class keywords (`signal`/`constant`/`variable`) skipped in interface lists (vendor `my_and.vhd` with `SIGNAL a : in std_logic` now parses: entity led_and, 3 ports, 0 errors) · m2 char-literal regex generalized to any character · m3 `detect_clock` ignores `clk_en`/`clk_out`/`*_div`-style stems · m4 `detect_reset` matches exact names / the board reset port only (`reset_req` is no longer hijacked) · m5 `ledConfig.pins` is now an LED-index→pin map · m6 cycle sampling stops at `max_cycles` · m7 `map_board` classifies exact board-style tokens first (substring fallback documented) · m8 space-less VCD vector changes (`b1010!`) parse · m9 `decode_uart` glitch debounce (median-based threshold) + dead loop removed + `idle_high` honoured · m10 `decode_vga` dead `png_rows` removed · m11 duplicate imports in `simulator.py` deduplicated · m12 `backend.device.BackendConfigError` with clear messages for missing/invalid board.json.

### Additional audit items folded in

* `board_detect.py`: LM75 ambient temperature and the NEC IR address/command are no longer hard-coded — they are read from `board/board.json` (`i2c.tempSensor.temperatureC`, `infrared.necAddress`/`necCommand`) with the previous values kept as documented fallbacks.
* `testbench_gen.py`: the AT24C08 `wp` drive is derived from the `board.json` `writeProtected` fact instead of a literal `'1'`.
* `board.json` corrections honoured everywhere at runtime: the corrected `segBitMap` (SEG0=a … SEG7=dp), the rewritten P1/P2/P3 header maps and the documented LM75 power-up defaults; no test hard-codes a pin.
* Features added to close verified QA gaps: `memoryInitFile` request field (written into the simulation workdir for textio-initialised memories — BLK-08), static resource-estimator warnings for multipliers / M9K arrays / register bits against the fitted device (BLK-12/13/14), and a `timeScale` report (`simClockHz`, `boardClockHz`, `scale`) on every simulation result (CLK-03, FID-01B).

### QA suite expansion (task 1) — 61 new cases in 7 modules (sections 20-30)

| Module | Cases | Covers |
| --- | --- | --- |
| `tests/qa/test_qa_semantics.py` | SEM-01..08, CKM-01..04, MEM-01..04 | delta-cycle ordering, signal vs variable, std_logic resolution table, multi-driver error, numeric_std overflow wrap, generics, generate loops, record/array ports; exact 50 MHz cycle counts, divided clock, two clock domains, PLL documented-N/A; M9K init-file + read latency, 18×18 multiply, M9K/multiplier/LE resource-overflow warnings |
| `tests/qa/test_qa_pinmap.py` | PIN-01..05 | every `board.json` pinMap entry mapped exactly once with polarity metadata; a generated probe design drives every pin and observes the raw flip (two vectors differing in every driven bit); SEG/DIG bit order per segBitMap; LED[i]↔silkscreen LEDi+1 order; full 16×16 KEY/DIP wired-AND truth table |
| `tests/qa/test_qa_peripherals.py` | SEG7-01..04, BUZ-01, TRI-01 | segment/digit polarity, fast scan (all digits lit), slow scan (single digit), documented ghosting window, buzzer frequency vs driven square wave, high-Z outputs read Z (LEDs off, buzzer silent) |
| `tests/qa/test_qa_protocols.py` | PRO-01..06 | UART framing error (bad stop), wrong-baud garbage, VGA bad mode → no signal, HD44780 E-pulse width (PWEH) + busy flag + DDRAM write, PS/2 host inhibit documented-N/A, SDRAM timing documented-N/A |
| `tests/qa/test_qa_scaling.py` | TSC-01..05 | accurate timeScale factor; UART baud, buzzer frequency, VGA line rate and 7-segment scan rate all scale 2:1 when the clock period doubles |
| `tests/qa/test_qa_determinism.py` | DET-01..03 | identical waveforms for identical requests, independent Simulator instances, no stale temp dirs / zombie ghdl processes |
| `tests/qa/test_qa_robustness.py` | RF-01..07 | malformed VHDL, 300 random garbage inputs, 1.5 MB upload bounded, empty inputs, 10 hostile WebSocket messages, runaway design vs the scaled timeout, sandbox reality (textio reaches host files; runs isolated, not sandboxed) |
| `tests/qa/test_qa_differential.py` | DIF-01..06, VER-01 | backend waveforms identical signal-by-signal to an independent raw GHDL (-a/-e/-r + VCD parse) for counter, FSM, RAM, UART TX and 7-seg; NVC availability documented; Verilog rejected clearly |

### Task 3 — mutation testing

`tests/qa/mutation.py` grew to 17 scripted faults applied to a temp copy of the tree (never the real files): LED polarity flipped (board.json AND backend waveform handling), LED pins swapped, segBitMap corrupted/shifted, EEPROM address, duplicate-pin check disabled, UART bit order, buzzer formula, AT24C08 read bit order, NEC lead burst, PS/2 parity, reset release removed, reset generation dropped, UART bit-time constant halved, inline-comment stripping removed. **17/17 killed** — the killing test is recorded per mutant in `tests/MUTATION_REPORT.md`. No surviving mutants.

### Task 4 — coverage

`coverage run` over `tests/run_all.py --jobs 8 --timing` plus `pytest tests/ -q`, combined: **backend coverage 84%** (3187 statements, 499 missed). Per module: board_detect 100%, qsf_parser 98%, waveform 94%, simulator 90%, vhdl_parser 88%, device 88%, peripherals 88%, server 87%, testbench_gen 84%, session 83%, vcd_parser 83%, ghdl_tool 79%. Significant untested areas: `backend/__main__.py` (0% — the CLI entry point, exercised only manually), the cache-corruption/fallback branches in `simulator.py`, and parts of the WS session playback paths.

### Task 5 — final full run

`python tests/run_all.py --jobs 8 --timing` (all 23 modules): **226 cases, 218 PASS, 8 FAIL** — every failure is a verified, documented limitation (CLK-08 GHDL X power-on, OUT-13 combinational loops, BLK-02 ALTPLL behaviour, BLK-03 PLL-count check, ENG-01B VCD export, ENG-03 server stop, ENG-07 HDL file-I/O sandbox, ENG-10 live switch clicks).

---

## 10. Re-audit remediation (Phase 4 — findings N1–N9, fixed in this pass)

Date: 2026-11-14 · A re-audit confirmed nine findings against the current tree; all were
remediated here and every disposition below is backed by an executed test.

| # | Severity | Finding | Disposition | Proof |
| --- | --- | --- | --- | --- |
| N1 | High | `SimSession` stale-run hijack: one shared `_stop_requested` Event cleared by the next `start()`; the worker checked it only after `simulate()` returned; the pump task was never cancelled; `_begin_stream`'s only guard was `state == "stopped"`. A replaced run's worker can outlive `stop()`'s 10 s join (GHDL runs take 40–90 s) and then stream `sim_ready` + batches + `sim_done` for the dead run. | **Fixed.** Per-run invalidation: `_run_seq` bumped by every `start()`/`stop()`, captured by worker AND pump task; both check their generation before applying any state/stream action (`_worker`, `_pump`, `_begin_stream`); a fresh per-run `threading.Event` replaces the shared flag; the pump task is cancelled (and awaited) on stop/replace. The shipped fresh-session-per-`sim_start` behaviour in `server.py` is untouched — the fix targets the same-object replacement path `start()` documents. | `tests/test_session.py::test_replaced_run_never_streams_stale_results` — a blocked first run is replaced, then released; asserts exactly `sim_stopped, sim_ready, cycle_batch, sim_done` from the replacement (run-2 entity only). Verified to FAIL when the guards are disabled; kills mutation M20. Existing 14 session tests still pass (15/15). |
| N2 | Medium | `WaveformSignal.value_at` was a linear scan called per signal per cycle from `cycles()`; `to_dict` serialized every transition of every signal — unbounded cost on long runs. | **Fixed.** `value_at` bisects over a cached, time-ordered key list (semantics preserved: last transition ≤ t, first value before the first transition); serialized transitions are deterministically decimated at `MAX_SERIALIZED_TRANSITIONS = 2000` (first + last + evenly spaced sample; pure function of the input). The UART/buzzer/VGA decoders were re-wired to consume the FULL normalized transition lists (`build_waveform` now returns `(payload, transitions_by_name)`), because a decimated timeline corrupts peripheral decoding — caught immediately by PR-04/SPEC-10 during verification. | `tests/test_audit_units.py::test_waveform_value_at_at_exact_between_and_outside_transitions`, `::test_waveform_value_at_matches_linear_reference_on_random_times` (300 probes vs the old linear reference), `::test_waveform_to_dict_respects_the_transition_cap_and_is_deterministic`. Mutations M21/M22 killed. |
| N3 | Medium | BLK-03: no PLL-count resource check (the static estimator covered multipliers/M9K/register bits only), and the case's stated three-PLL design did not exist (`blocks.vhd` `altpll_top` has one PLL). | **Fixed.** `_resource_warnings` now counts `altpll` instantiations (the `component altpll ... end component;` declaration is stripped first so declaration mentions are not miscounted) and warns beyond the device limit taken from `board/board.json` (`devices.ep4ce6.plls = 2`; fallback constant 2). New fixture `tests/qa/designs/pll_limit.vhd` instantiates three ALTPLLs; BLK-03's expectation string is unchanged, only the fixture the case runs was corrected. BLK-02 (behavioral ALTPLL output model) stays a documented limitation. | BLK-03 PASS ("design instantiates about 3 ALTPLL PLLs, which exceeds the 2 PLLs on the EP4CE6E22C8N"); BLK-01/BLK-04..09 unchanged. Kills mutation M19. |
| N9 | Medium | ENG-07: uploaded VHDL textio with literal absolute paths escaped to the host FS (RB-05 wrote `%TEMP%`; RF-07 read a file from a scratch dir; ENG-07 wrote `%TEMP%`). | **Mitigated (the demonstrated class is closed; residual documented).** `_textio_escape_errors` in `backend/simulator.py` strips comments the same way the pipeline does, then scans string literals adjacent to `file_open` calls and `file ... : ... is "..."` declarations for drive letters, UNC shares, absolute POSIX paths, `..` segments and `%ENV%` tokens; rejection is an error with the source line number, wired into `_prepare` and `compile_source` (before GHDL runs). Positive test proves relative textio still round-trips inside the throw-away workdir. Honest residual: runtime-computed paths (concatenated strings) can still reach the host FS. | RB-05, RB-05B (new), ENG-07, RF-07 all PASS; `tests/test_audit_units.py::test_textio_scan_rejects_escape_path_classes` / `::test_textio_scan_allows_relative_paths_and_identifiers` / `::test_textio_scan_ignores_comments_and_unrelated_strings`. Kills mutation M18. |
| N4 | Low | `SimSession.stop()` docstring claimed "no zombies" while a long GHDL subprocess continues to its own timeout. | **Fixed.** Docstring now states the worker thread is joined and the GHDL subprocess of a long run continues to its own wall-clock timeout until a server-side cancel exists (ENG-03); its results are discarded, never streamed. | Doc review; behaviour covered by the N1 test. |
| N5 | Low | `harness.write_results` escaped `\|` in actual/expected but not in `description`, so a pipe silently dropped the row from `gen_report` tallies; `gen_report` silently skipped malformed rows. | **Fixed.** The description is escaped too, and `gen_report` now raises on a malformed row (defense in depth). `harness.has_error` also no longer crashes on `"waveforms": None` failure payloads (found while wiring the rejection cases). | Code review; the failure-tally guard is exercised by every `gen_report` run. |
| N6 | Low | `Tuple` used in `backend/simulator.py` annotations but not imported (annotations are strings under `from __future__ import annotations`, so it never raised). | **Fixed.** Added to the `typing` import. | `python -c "import backend.simulator"` + full suite. |
| N7 | Low | `testbench_gen.default_stimuli` was dead code (referenced only by `__all__`) and did NOT exclude model ports — adopting it would reintroduce the double-drive bug C6. | **Fixed.** Function and `__all__` entry deleted after grep confirmed zero real references. | grep + full suite (PR-03/PR-05/PR-06 and the double-drive regression test still pass). |
| N8 | Low | `detect_clock` clk_en exclusion and `detect_reset` exact-name matching had no tests. | **Fixed.** Five unit tests added: enable-suffixed ports are never the clock (and enable-only designs detect no clock); the board clock port name (`CLOCK_50`) is picked; `detect_reset` matches the board's `FPGA_RST` name with active-low polarity, matches exact `rst` as active-high, and does not false-match `reset_req`/`reset_done`/`soft_rst_ctrl`/`rst_status`. | `tests/test_audit_units.py::test_detect_clock_*` / `::test_detect_reset_*`. |

Full-suite effect: BLK-03 and ENG-07 now PASS as originally written (their expectations were
implemented, not weakened); RB-05/RF-07's expectations were legitimately updated from
"demonstrates the escape (documented limitation)" to "expects the rejection" for the same
reason, and RB-05B was added for the relative-path positive path. A new session regression
test and 11 new unit tests were added; the mutation suite grew from 17 to 22 scripts.

