# Cyclone IV Studio

A browser-based **Intel Cyclone IV (EP4CE6E22C8)** development-board simulator
with a real VHDL simulation engine, a dev-board I/O panel, and a waveform viewer.

The VHDL is not interpreted by a home-grown toy engine.  It is compiled and
simulated by **GHDL** (VHDL-2008), the same kind of flow Quartus/ModelSim uses:

```
editor -> entity parser -> auto testbench -> ghdl -a -> ghdl -e -> ghdl -r -> VCD -> UI
```

GHDL produces a real VCD (Value Change Dump); the backend converts it into
per-signal transitions, rising-edge cycle samples, a final state, and a mapping
of ports to the board's LEDs / switches / keys / 7-segment displays.  The
frontend then renders all of that in the browser, including playback of the
captured clock cycles.

## Windows Desktop Installer (3-Step Quick Start)

No Python, Node.js, or separate GHDL setup is required when using the installer:

1. Download **`Cyclone IV Studio_<version>_x64-setup.exe`** (and optional `SHA256SUMS.txt`) from the GitHub Releases page.
2. Double-click the installer to install per-user (bundled runtime includes GHDL, FastAPI, and the built UI; user logs and projects live in `%APPDATA%\CycloneIVStudio`).
   > **Windows SmartScreen Note:** Because this open-source build is currently unsigned, Windows Defender SmartScreen may display *"Windows protected your PC"*. Click **More info** -> **Run anyway**, or verify the file hash against `SHA256SUMS.txt` first.
3. Launch **Cyclone IV Studio** from the Start Menu, pick an example or click **+ Add file** (`.vhd` / `.v`), assign pins in **Pin Planner**, and press **Compile**.

See [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for license terms and the GHDL GPL-2.0 source offer.

---

## Development Setup (From Source)

### 1. Install GHDL

```powershell
winget install ghdl.ghdl.ucrt64.mcode
python -m backend doctor
```

The backend also finds GHDL through `GHDL_BIN` if it is installed elsewhere.

### 2. Install Python & Node Dependencies

```powershell
python -m pip install -r backend/requirements.txt
npm install
cd frontend && npm install && npm run build && cd ..
```

### 3. Run in Development Mode

Terminal 1 (backend API on `127.0.0.1:8080`):
```powershell
python -m backend serve --host 127.0.0.1 --port 8080 --reload
```

Terminal 2 (Vite dev server on `http://localhost:8000`, proxying `/api` and `/ws` to `:8080`):
```powershell
npm run dev
```

Or run both from a single backend server on `:8080` serving `frontend/dist/`.

### 4. Build the Standalone Desktop Installer

```powershell
python -m pip install pyinstaller
python scripts/sync_version.py --check
cd frontend && npm run build && cd ..
python packaging/build_sidecar.py
npx tauri build
```

Installer artifacts are written to `src-tauri/target/release/bundle/nsis/`.

## What works today

- Real GHDL compilation/elaboration/simulation (VHDL-2008, `--std=08`).
- Entity/generic/port parsing, including multi-name ports and constrained vectors.
- Automatic testbench generation from the entity:
  - clock and reset detection (including active-low resets),
  - constant / toggle / pulse / sequence stimulus for every free input,
  - generic overrides.
- Custom testbench support (paste your own TB and pick its top entity).
- VCD parsing into waveform transitions, clock-edge cycle samples, final state.
- Board mapping by port name: `led*` -> LEDs, `sw*`/`dip*` -> switches,
  `key*`/`btn*` -> buttons, `hex*`/`seg*`/`display*` -> 7-segment displays.
- Device + board profile (`/api/device`): EP4CE6E22C8 datasheet limits and the
  RZ-EasyFPGA A2.2 pin table (CLOCK_50/PIN_23, FPGA_RST/PIN_25, KEY[3:0],
  LED[3:0], SEG[7:0] + DIG[3:0], VGA, PS/2, UART, buzzer, IR, I2C, SDRAM),
  returned with every result.
- Single source of truth `board/board.json`: pins, polarities, pull-ups,
  drivers, part numbers and VERIFIED/INFERRED/UNVERIFIED tags. The backend
  (`/api/board`) and the frontend both load their board parameters from it;
  no pin numbers are hard-coded in runtime code.
- Multi-file projects via the `files` array on `/api/compile` and `/api/simulate`.
- Synthesis lint warnings (latch inference, multiple drivers) from a GHDL
  `--synth` pass, unbound megafunctions as hard errors, and warnings for
  non-synthesizable constructs, missing pin assignments and I/O over 91 pins.
- Web IDE: syntax-highlighted editor, compile/run, error list with jump-to-line,
  board panel, waveform canvas with zoom/pan/cursor, and cycle playback.
- REST API and WebSocket API.
- CLI (`run`, `doctor`, `examples`, `serve`).
- 26 automated tests (parser, VCD, testbench generation, full GHDL runs, API).

## CLI

```powershell
# check GHDL
python -m backend doctor

# list examples
python -m backend examples

# run an example and print a cycle table
python -m backend run examples/counter.vhd --duration 200 --cycles 16

# keep the raw VCD
$env:CYCLESIM_KEEP_DIR = "1"
python -m backend run examples/counter.vhd --duration 200 --out wave.vcd

# JSON output (useful for scripting)
python -m backend run examples/traffic_light.vhd --duration 300 --json
```

## Examples

| File | Entity | What it demonstrates |
| --- | --- | --- |
| `examples/counter.vhd` | `counter` | 8-bit counter wired to the LEDs, synchronous reset |
| `examples/seven_segment.vhd` | `seven_segment` | switch input decoded to a 7-segment display |
| `examples/traffic_light.vhd` | `traffic_light` | Moore FSM driving red/yellow/green LEDs |
| `examples/uart_tx.vhd` | `uart_tx` | continuous 8N1 UART transmitter (small `TX_DIV` for simulation) |
| `examples/a22_demo.vhd` | `a22_demo` | drives every A2.2 peripheral: CLOCK_50, KEY, LED, SEG + DIG (multiplexed) |
| `examples/gated_counter.vhd` | `gated_counter` | counter that only runs while `enable` is high; try a toggle stimulus |

## Architecture

```
backend/
  vhdl_parser.py    tokenizer + entity/generic/port extractor
  testbench_gen.py  clock/reset detection, stimulus, auto-testbench VHDL
  ghdl_tool.py      GHDL discovery, analyze/elaborate/run, diagnostic parsing
  vcd_parser.py     VCD header + value-change parser (timescale to ns)
  waveform.py       VCD -> UI waveform, cycle samples, board mapping
  simulator.py      orchestration (parse -> TB -> GHDL -> VCD -> JSON)
  server.py         FastAPI REST + WebSocket + static frontend
  __main__.py       CLI
frontend/
  index.html        IDE shell
  styles.css        dark dev-board theme
  app.js            editor, board, waveform canvas, playback, API client
tests/
  test_parser.py, test_vcd.py, test_testbench.py, test_simulator.py, test_server.py
```

### Simulation flow

1. **Parse** the VHDL source to find the entity interface and generics.
2. **Generate a testbench** (unless you supply one):
   - `clk` is detected by name (`clk`, `clock`, `CLOCK_50`, ...), default 10 ns.
   - `reset`/`rst`/`nreset` is detected; active-low names are driven low.
   - Every remaining input gets a stimulus row (`constant` by default).
   - Signals are initialised so toggle stimulus has a defined start value.
3. **GHDL analyze** the design and testbench into a throw-away work library.
4. **GHDL elaborate** the top level.
5. **GHDL run** with `--vcd` and `--stop-time`.
6. **Parse the VCD**, filter to the testbench scope, de-duplicate port/internal
   signals, convert values, and sample every rising clock edge.
7. **Return JSON** to the browser; the UI draws waveforms and the board.

All of this happens in a fresh temporary directory per request, so concurrent
simulations cannot interfere.

## REST API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | GHDL path/version |
| `GET` | `/api/examples` | bundled examples with source |
| `GET` | `/api/examples/{id}` | one example |
| `POST` | `/api/compile` | `{vhdl, top?}` -> entity, board, errors |
| `POST` | `/api/simulate` | `{vhdl, top?, testbench?, duration, clockPeriod, resetCycles, resetActiveHigh, stimuli[], generics{}}` |
| `WS` | `/ws` | same operations with `progress` messages |

Stimulus item:

```json
{"port": "enable", "kind": "toggle", "value": 0, "values": [], "periodCycles": 3, "pulseCycles": 1}
```

`kind` is one of `constant`, `toggle`, `pulse`, `sequence`.

## Board mapping

The mapping is heuristic and based on port names:

| Role | Names |
| --- | --- |
| clock | `clk`, `clock`, `CLOCK_50`, `sys_clk`, ... |
| reset | `reset`, `rst`, `reset_n`, `nreset`, ... |
| LEDs | contains `led` |
| switches | contains `sw`, `switch`, `dip` |
| buttons | contains `key`, `btn`, `button`, `push` |
| 7-segment | contains `hex`, `seg`, `seven`, `display`, `digit` |

This is intentionally simple; the RZ-EasyFPGA A2.2 pin table in
`backend/device.py` provides the real pin assignments for designs that use the
kit's port names (LED, KEY, SEG, DIG, CLOCK_50, VGA_*, ...).

## Limitations / notes

- This is **GHDL simulation**, not the full Quartus toolchain.  Quartus is still
  the right tool for synthesis, place-and-route, pin assignment and timing.
- Quartus-generated RTL can be simulated here when it is portable VHDL.  Altera
  megafunctions/primitives (ALTPLL, altsyncram, cycloneive components, etc.) are
  not available to GHDL; those designs need Quartus + ModelSim/Questa or the
  Altera simulation libraries.
- The parser is an interface extractor, not a full VHDL compiler.  GHDL is the
  authority on language correctness.
- The auto testbench is intentionally simple: one clock, one reset, and
  per-input stimulus.  Complex testbenches should be supplied as `testbench`.
- Waveform cycle samples are capped (`maxCycles`, default 256; the UI asks for
  2048) to keep the payload small; all transitions are still returned.
- The 3D board (Three.js) models the RZ-EasyFPGA A2.2: 4 LEDs, 4 keys, a red
  4-position DIP, the 4-digit multiplexed seven-segment tube, VGA, PS/2, RS232,
  buzzer, IR receiver, SDRAM, EPCS16 config flash, 50 MHz crystal and the 144-pin EQFP
  package ringed by the four yellow expansion headers. The 2D board is clickable
  and drives the stimulus (reaching the design on the next run); the 3D board
  parts are pickable too (ENG-09).
- **No HDL sandbox**: GHDL executes `std.textio` file I/O with process privileges.
  Only simulate HDL you trust.

## Tests

```powershell
python -m pytest -q                 # fast unit tests (profile, parsers, decoders)
python tests/run_all.py             # unit tests + full QA suite -> tests/RESULTS.md
python tests/qa/mutation.py         # mutation testing -> tests/MUTATION_REPORT.md
```

The QA suite covers the device profile, project input, clock/reset, I/O
devices, VHDL language coverage, Cyclone IV blocks, engine/UI behaviour, the
vendor examples, and audit sections for the board profile (`BJ`), polarity
(`POL`), QSF parsing (`QF`), open-drain buses (`OD`), peripheral protocols
(`PR`), robustness (`RB`) and end-to-end runs (`E2E`).

## Next

1. Quartus/ModelSim adapter for designs that use Altera primitives (ALTPLL,
   altsyncram, lpm_*), plus .mif/.hex memory initialization.
2. Behavioral ALTPLL model and LE/M9K/multiplier resource-limit warnings.
3. Real-time clock scaling so a 1 Hz blinker at 50 MHz can be watched live.
4. Clickable 3D board (raycaster picking) and live switch toggling.
5. Save/load projects and waveform export (CSV/VCD) in the UI. (A server-side
   stop/cancel WAS the roadmap item here — it is implemented now via the WS
   `sim_stop` -> `Simulator.cancel()` path.)