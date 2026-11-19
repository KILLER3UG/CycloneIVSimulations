# Cyclone IV Studio — Redesign & Optimization Plan (fresh-agent pass)

Measured at HEAD `7e1bf22` (tag `v0.1.0`), against the **installed** desktop app
(`%LOCALAPPDATA%\Programs\Cyclone IV Studio\cyclone-iv-studio.exe`, WebView2 CDP
`:9229`, RTX 4050 Laptop GPU, D3D11). Audit probes: geometry at 1440×900 and
1280×800, every workbench/dock tab, camera presets, popovers, compile/interaction
timings, renderer state, backend phase profile. Screenshots reviewed visually.

## Status

- [x] Step 1 live audit (this document, measurements below)
- [x] Phase 1 — layout defects (CSS/DOM, low risk) — verify-phase1 ALL PASS, terminal-e2e ALL PASS
- [ ] Phase 2 — render path: hero framing, glow, palette, demand-driven rendering
- [ ] Phase 3 — backend VCD parse speed (QA-protected)
- [ ] Step 3 full gates · Step 4 rebuild + installed-app verification + lifecycle

Baseline gates at `7e1bf22` (before edits): `python tests/run_all.py` →
**169 unit + 231/231 QA, exit 0**; `npm --prefix frontend run test:unit` →
**43/43**.

## Audit measurements (baseline, installed v0.1.0)

| Metric | Value | Verdict |
| --- | --- | --- |
| Header / HUD height | 42 px / 36 px, 0 overlaps, 0 doc overflow (both resolutions) | keep |
| K1 press → 800 Hz + ring | **1.3 ms**, 0 HTTP, ring opacity 0.9 | invariant holds |
| sevseg_4tube K1 → 1111 | **0.6 ms**, segHold duty 0.25 on b/c of all 4 tubes | invariant holds |
| DIP toggle | 0.5 ms | invariant holds |
| buzz1 cold Compile & Run | 3.88 s to programmed + 0.62 s capture | optimize (P3) |
| sevseg_4tube first capture | 8.4 s (500 k-cycle POV window) | honest cost, keep |
| `simulate()` backend phases | GHDL subprocesses ≈ 1.1 s; **parse_vcd ≈ 1.24 s of 2.55 s** | optimize (P3) |
| Renderer idle | 133 calls / 20 956 tris / 25 tex / 23 programs per frame; tiered 60/24/6 fps, never sleeps; 10 Hz IO timer repaints buffers while static | optimize (P2) |
| Camera framing | dist 341 vs sphere-fit 237 → **ratio 1.437**, board ≈ 55 % of viewport | tighten (P2) |
| Bloom | `quality:"balanced"` → **no composer** → lit tubes flat red, no glow | enable (P2) |
| Display cards pane | cards 362 px tall in 215 px pane; UART send row at y=986 (window 900) → **clipped** | fix (P1) |
| Bottom dock | fixed 260 px; board viewport only 498 px at 1280×800; no resize affordance | fix (P1) |
| Terminal | accessible mirror `<pre>` (≤150 px) renders below the command bar, duplicates xterm and squeezes it | fix (P1) |
| xterm fit | only on open; no refit on dock tab show / dock resize | fix (P2) |
| SP1 ring / focus pulse / pin highlight | cyan `0x7fd4ff` / `0x66d9ff` / (0.4,1.6,2.6) — off-palette | recolor (P2) |
| Terminal `ghdl --version` | 184 ms | keep |
| JS heap | 27 MB idle → 43 MB post-compile → 31 MB | keep |
| Page errors during full audit | 0 | keep |

## Phase 1 — layout defects (low risk, CSS/DOM only)

| # | Action | Citation | Verify |
| --- | --- | --- | --- |
| 1.1 | Display cards: grid row `minmax(0,1fr)`, cards `min-height:0`, compact LCD screen (drop legacy `min-height:76px`/17 px font inside the dock), VGA canvas scales to fit. All three cards fully inside the pane at 1440×900, 1280×800 and any dock height ≥ 180 px. | `frontend/src/styles.css:1468-1484` (`.display-cards`/`.display-card`), legacy `.lcd-screen` `styles.css:886-895` | live geometry probe: card bottom ≤ pane bottom, serial-send visible; installed-app step 10 |
| 1.2 | Resizable bottom dock: drag handle on `#bottom` top edge (same pattern as the workbench resizer), persist `c4_bottom_h`, clamp 180 px…min(560 px, 60 vh); responsive default `--bottom-h: clamp(190px, 26vh, 280px)` (was fixed 260 px). Board viewport gains ~50 px at 1280×800. | `frontend/index.html:61-63`, `frontend/src/styles.css:1425-1430`, resizer pattern `frontend/src/main.js:563-595` | drag probe: height changes, board/canvas reflow, wave + xterm refit; collapse/expand still 28 px |
| 1.3 | Terminal mirror `#terminal-output` becomes visually-hidden (sr-only class) but stays live in the DOM (every e2e reads `textContent`). xterm owns the full pane. Repair `studio-screenshots.mjs` evidence reveal to un-hide via class removal in the same commit. | `frontend/src/ui/terminal.js:48-51`, `frontend/scripts/studio-screenshots.mjs:158-172` | terminal-e2e, installed-app step 07, studio-screenshots terminal frame |
| 1.4 | HUD stats labels align with the physical buttons: `KEY 1..4`→`K1..K4`, `SW shared`→`S1..S4 shared`, non-shared `SW 0..n` kept (matches `SW${i}` buttons). | `frontend/src/ui/stats.js:57-60`, buttons `frontend/src/main.js:459-464` | no script reads these spans (rg verified); HUD overflow ≤ 0 |

## Phase 2 — render path (medium risk; e2e band + invariants guard it)

| # | Action | Citation | Verify |
| --- | --- | --- | --- |
| 2.1 | Tighter auto-fit: `_fitDistance` margin 1.15→1.08 (keep HUD factor). Target ratio ≈ 1.15–1.25 — inside the installed-app band `[needed, 1.8×needed]`, board ~20 % larger, sphere fit still guarantees zero clipping on collapse/splitter/window resize. | `frontend/src/board/index.js:704-714` | installed-app step 01 framing; geometry probe at both resolutions + right-collapsed |
| 2.2 | Selective bloom on hardware GPUs at `balanced` (same UnrealBloomPass 0.45/0.3/threshold 4.0 as `high`); software rasterizer keeps the plain path. Lit segments (HDR r≈5.2) cross threshold → vivid glow; LEDs keep their sprite halo. | `frontend/src/board/index.js:841-877` (`setQuality`, `_ensureComposer`), `mount()` `index.js:272-311`, quality choice `frontend/src/main.js:171-174` | close-up screenshot of DISP1 + SP1; renderer probe `composer:true`; software path unchanged |
| 2.3 | Palette: SP1 pulse ring → studio-red HDR (was cyan `0x7fd4ff`); focus pulse ring → white (was `0x66d9ff`); pin highlight sprite → white HDR (was cyan). Ring opacity/visibility contract (≥0.85) untouched. | `frontend/src/board/index.js:1101-1119` (`_ensureBuzzerRing`), `796-804` (focus), `813-825` (highlight) | installed-app step 02 ring checks; transport-controls-e2e; visual |
| 2.4 | Demand-driven rendering: dirty-flag wake/sleep. Render only when state changed, controls damping/tween/pulse active, capture streaming, or IO transitions in flight; sleep (cancel rAF) after 1.5 s fully static, wake on any mutator/DOM event. 10 Hz IO timer becomes a no-op when nothing moves (no buffer uploads). Software caps preserved. Key/DIP press still paints synchronously and renders next frame (≤16 ms). | `frontend/src/board/index.js:85-91` (wake wrapper), `296-307` (loop+IO timer), `942-1011` (`_loop`), `1013-1099` (`_updateIO`) | idle render count ≈ 0 over 10 s (was ~60); press→pixel ≤ 16 ms; all 8 web e2e + installed-app green |
| 2.5 | xterm refit: ResizeObserver on the terminal host (rAF-debounced `fit()`), plus `showTab("terminal")` hook. Covers dock drag, collapse, window resize, tab show. | `frontend/src/ui/terminal.js:84-112,207-210`, `frontend/src/ui/bottomPanel.js:93-103`, hooks `frontend/src/main.js:534-546` | terminal-e2e; resize probe: cols/rows track the pane |

## Phase 3 — backend compile/sweep speed (QA-protected)

| # | Action | Citation | Verify |
| --- | --- | --- | --- |
| 3.1 | `parse_vcd` hot loop: binary line iteration, scalar fast path without per-line `strip()`/regex, duration tracked on `#` timestamps only, interned scalar values. **Output identical** (byte-for-byte VcdData equivalence on a real buzz1 dump before/after). | `backend/vcd_parser.py:119-247` | scratch equivalence check; `tests/test_vcd.py`; full QA (differential cases); re-profile: target ≥ 2× parse speed |

### Rejected / deferred (with evidence)

- **Exclude the free-running clock from the VCD** (would shrink dumps ~10×):
  rejected — `pov_clock_edges()` and the Waveform tab's clock row consume clock
  transitions (`backend/waveform.py`), QA CLK cases assert them; behavior risk
  outweighs the gain once 3.1 lands.
- **Lower the buzzer capture floor (3.9 M cycles)** in `frontend/src/main.js:885`:
  deferred — it feeds frequency decode + countdown-slope detection asserted by
  `tests/test_buzzer.py` and the buzz e2e; not worth touching the invariant path
  this pass.
- **Peripherals "icon inconsistency"**: not a defect — live data cards
  (`sidebar.js:249-256`, plain headers) vs static info groups (`sidebar.js:149`,
  icon+title) is a deliberate hierarchy. No change.
- **Waveform toolbar split (zoom left / Export VCD right)**: functional and
  conventional; no change.

## Guardrails

- Invariants: `<16 ms` zero-HTTP play, exact tones/release timers, instant
  Power Off/Reset/On, monochrome chrome `#0a0a0b/#111113/#161618–#1f1f23`,
  `#111315` PCB, zero fog, ConPTY terminal with bundled GHDL, dynamic multi-board
  SDK, zero hardcoded `PIN_<digits>` in UI JS.
- Gates: `python tests/run_all.py` (169 unit + 231 QA), `npm --prefix frontend
  run test:unit` (43), 8 web e2e suites, rebuild + in-place upgrade +
  `installed-app-e2e.mjs` (30 checks) + uninstall/reinstall lifecycle.
- Audit scaffolding (`frontend/scripts/audit-studio.mjs`, `probe-display.mjs`,
  `probe-displays.mjs`) deleted once measurements are merged here.
- No push. Tag `v0.1.0` re-aligned to final HEAD. Tree 100 % clean.