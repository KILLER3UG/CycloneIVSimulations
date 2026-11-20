# Changelog

All notable changes to **Cyclone IV Studio** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-11-20

### Fixed
- **Auto-relaunch after update**: the updater-driven (silent) NSIS install closes the running app, so the in-app `relaunch()` never fired and the app stayed closed. A `POSTINSTALL` hook now relaunches the freshly installed build, and `PREINSTALL` also stops the app executable itself.

## [0.1.1] - 2026-11-20

### Added
- **Desktop auto-update**: the toolbar gained a **Check for updates** button. The installed app queries this repository's GitHub releases (`latest.json`), downloads the minisign-signed installer with a live progress bar, installs it and relaunches. Release builds are signed (`createUpdaterArtifacts` + `TAURI_SIGNING_PRIVATE_KEY` secret) and every release ships an updater manifest (`latest.json`).
- `frontend/scripts/updater-e2e.mjs` drives the full update flow against the installed app via CDP.

### Fixed
- Interactive **terminal bridge** could hang forever: the pipe-backed `cmd.exe` fallback read the pipe with `BufferedReader.read(4096)` (blocks until the buffer fills), and `winpty` was not declared in `requirements.txt`, so CI never exercised the ConPTY path. The fallback now uses `read1()`, the PTY spawn is bounded (15 s) and runs off the event loop, and test WebSocket reads are hard-bounded.
- Multi-board audit fixes: cancelled GHDL runs return a clean "Simulation cancelled" instead of raising `AttributeError`; I²C device models are skipped on boards without them instead of crashing; the QSF validator follows the selected board (package pin range, BGA ball names, fitted devices); imported boards get real Cyclone IV E resource figures; switch aliases resolve per board; plus smaller pin-resolution, classifier, strictPins and cache fixes.

## [0.1.0] - 2026-11-16

### Added
- **Interactive 3D RZ-EasyFPGA A2.2 Board Simulator**: Three.js hardware model featuring EP4CE6E22C8N / EP4CE10E22C8N FPGA packages, 4 active-low red LEDs, 4 momentary active-low push keys (`KEY1`–`KEY4`) pulled up via 10 kΩ resistors sharing nets with 4 latching DIP switches, 4-digit common-anode red 7-segment display with persistence-of-vision multiplexing, piezo buzzer, and expandable board inspection overlay.
- **Quartus-Style IDE & Project Manager**:
  - Multi-file VHDL-2008 and Verilog-2001 project tree and editor tabs (`+ Add file` `.vhd`, `.v`), inline rename, confirmation-free file delete with Undo toast, top-level entity pinning (`Set as Top-Level`), automatic transitive dependency resolution, ignored-file reporting, and empty-project state.
  - Single unified **Compile** button that compiles, validates pin assignments, programs the virtual JTAG board, and runs GHDL simulation while preserving previous board state when compilation fails.
  - Scrollable Quartus-style **Messages** panel with severity filters (`All` / `Err` / `Warn` / `Info`), summary metrics, and click-to-jump `file:line` navigation.
  - Collapsible left and right sidebars with persistent rail toggles, keyboard shortcuts (`Ctrl+B`, `Ctrl+\`, `Ctrl+Enter`), and reload state preservation.
- **Editable Pin Planner & QSF Support**:
  - Per-bit expansion for bus ports (`led[3..0]`), valid EQFP-144 pin catalog dropdown with connected board peripheral labels, custom pin entry, I/O standard selection, optional `Apply board defaults` helper, and `.qsf` import/export round-trip persisted in `localStorage`.
  - Pre-compile validation matching Quartus rules: warnings for unassigned ports (no-op on hardware) and errors for duplicate pin assignments, nonexistent pins, and direction conflicts.
- **Waveform & Peripheral Inspectors**: Interactive VCD waveform viewer with zoom/pan/cursor/probes plus live decoded UART, VGA, character LCD, buzzer, and I2C EEPROM/temperature sensor analyzers.
- **Windows Desktop Distribution**: Standalone PyInstaller + GHDL backend sidecar managed by a native Tauri v2 shell, Windows NSIS/MSI installer (`v0.1.0`), per-user storage in `%APPDATA%\CycloneIVStudio`, `THIRD_PARTY_LICENSES.md`, and draft GitHub Release CI workflow.
