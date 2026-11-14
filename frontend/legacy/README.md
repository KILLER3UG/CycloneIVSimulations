# Cyclone IV Studio frontend

Dependency-free browser IDE served by the Python backend at `/`.

## Files

- `index.html` — IDE shell (top bar, editor, board, controls, console, waveforms)
- `styles.css` — dark dev-board theme
- `app.js` — editor highlighting, API client, board renderer, waveform canvas, playback

## Run

```powershell
python -m backend serve --port 8000
```

Then open <http://127.0.0.1:8000>.

No npm install and no build step: the backend mounts this directory at `/static`
and serves `index.html` at `/`.

## UI

- **Editor** — syntax highlighting, line numbers, Tab indentation, `Ctrl+Enter`
  to compile, `F5` to simulate.
- **Dev board** — LEDs, 7-segment displays, DIP switches and push buttons mapped
  from port names.  Click switches/keys to set input values, then Run.
- **Simulation** — duration, clock period, reset cycles, reset polarity, and a
  stimulus row per free input (`constant`, `toggle`, `pulse`, `sequence`).
- **Waveforms** — canvas viewer with zoom (wheel / buttons), pan (drag), cursor,
  hex vector values, and an internals toggle.
- **Playback** — `Play` steps through captured rising-edge cycles and updates the
  board LEDs in sync.

## Future

- Three.js 3D board model
- Pin/pinout profile for the 144-pin EQFP
- Multi-file projects and waveform export