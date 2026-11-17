"""Board-peripheral decoding layer.

Turns the captured pin waveforms into the behaviour of the on-board devices
so the simulator can show what the physical board would do:

* UART (MAX3232E): decode the frames the design transmits on UART_TXD.
* Buzzer: measure the toggle frequency on FPGA_BUZZER (passive speaker).
* VGA: reconstruct the picture from the sync + RGB pins (8 colours).
* Device-model dumps: EEPROM contents and LCD text written by the VHDL
  device models during the run.
"""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _as_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if all(c in "01" for c in text) and text:
            try:
                return int(text, 2)
            except ValueError:
                return None
        if text in ("x", "z", "u", "-"):
            return None
    return None


def decode_uart(transitions: List[Tuple[float, Any]], idle_high: bool = True) -> Dict[str, Any]:
    """Decode 8N1 frames from a UART TX pin.

    The bit time is auto-detected from the edge spacing.  A first estimate
    comes from the shortest inter-edge delta; edges closer together than a
    quarter of the *median* spacing are then treated as glitches (a single
    glitch pair would otherwise destroy the estimate and every frame after
    it) and the estimate is recomputed from the debounced edges.
    """
    levels: List[Tuple[float, int]] = []
    for t, v in transitions:
        n = _as_int(v)
        if n is None:
            continue
        levels.append((float(t), n & 1))
    if idle_high is False:
        levels = [(t, (v & 1) ^ 1) for t, v in levels]
    if len(levels) < 2:
        return {"bytes": [], "baud": None, "frames": 0}

    deltas = [b[0] - a[0] for a, b in zip(levels, levels[1:]) if b[0] > a[0]]
    if not deltas:
        return {"bytes": [], "baud": None, "frames": 0}

    # Debounce glitch pairs: anything much closer than the typical edge
    # spacing cannot be a real UART transition (edges occur at bit bounds).
    ordered = sorted(deltas)
    median = ordered[len(ordered) // 2]
    threshold = max(median / 4.0, 1e-9)
    filtered: List[Tuple[float, int]] = [levels[0]]
    for item in levels[1:]:
        if item[0] - filtered[-1][0] < threshold:
            filtered[-1] = item  # keep the settled level of the glitch pair
            continue
        filtered.append(item)

    widths = [b[0] - a[0] for a, b in zip(filtered, filtered[1:]) if b[0] > a[0]]
    if not widths:
        return {"bytes": [], "baud": None, "frames": 0}
    bit_time = min(widths)
    if bit_time <= 0:
        return {"bytes": [], "baud": None, "frames": 0}

    baud = int(round(1e9 / bit_time))
    bytes_out: List[int] = []
    frames = 0
    i = 0
    while i < len(filtered):
        # look for a falling edge (start bit) while idle
        if i > 0 and filtered[i - 1][1] == 1 and filtered[i][1] == 0:
            start_t = filtered[i][0]
            # sample the 8 data bits at 1.5, 2.5 ... 8.5 bit times
            value = 0
            ok = True
            for k in range(8):
                sample_t = start_t + bit_time * (1.5 + k)
                level = None
                for j in range(i, len(filtered)):
                    if filtered[j][0] > sample_t:
                        level = filtered[j - 1][1] if j > i else filtered[i][1]
                        break
                    level = filtered[j][1]
                if level is None:
                    ok = False
                    break
                value |= (level & 1) << k
            # stop bit: line must be back high at 9.5 bit times
            stop_t = start_t + bit_time * 9.5
            stop_level = 1
            for j in range(i, len(filtered)):
                if filtered[j][0] > stop_t:
                    stop_level = filtered[j - 1][1] if j > i else filtered[i][1]
                    break
                stop_level = filtered[j][1]
            if ok and stop_level == 1:
                bytes_out.append(value)
                frames += 1
                # skip past this frame
                while i < len(filtered) and filtered[i][0] < stop_t:
                    i += 1
                continue
        i += 1
    return {"bytes": bytes_out, "baud": baud, "frames": frames}


def decode_buzzer(
    transitions: List[Tuple[float, Any]],
    clock_ns: float = 20.0,
    active_low: bool = True,
    max_edges: int = 20000,
) -> Dict[str, Any]:
    """Measure the buzzer drive in **simulated** time (never wall-clock).

    The board's BEEP net is active-low (0 = transistor ON). A passive 2-terminal
    speaker needs the FPGA to toggle the pin, so a real tone is a square wave
    whose period is measured from transition timestamps (ns) and converted to
    FPGA clock cycles with ``clock_ns`` (20 ns = 50 MHz).

    Returns frequency, duty, cycles-per-period, the full edge list (capped)
    and the final level. DC levels are reported with ``tone=False``.
    """
    edges: List[List[float]] = []
    last: Optional[int] = None
    for t, v in transitions:
        n = _as_int(v)
        if n is None:
            continue
        if last is None:
            edges.append([round(float(t), 3), n & 1])
        elif n != last:
            edges.append([round(float(t), 3), n & 1])
        last = n
    if len(edges) > max_edges:
        # Keep the first and last plus an even sample; enough for frequency and
        # for scheduling, bounded payload.
        edges = edges[: max_edges - 1] + [edges[-1]]

    base = {
        "tone": False,
        "frequency": 0,
        "cycles": max(0, len(edges) - 1),
        "stable": False,
        "edges": edges,
        "clockNs": float(clock_ns),
        "cyclesPerPeriod": 0.0,
        "halfPeriodNs": 0.0,
        "duty": 0.0,
        "level": int(last) if last is not None else 0,
        "activeLow": bool(active_low),
    }
    if len(edges) < 2:
        return base

    # Half periods from every consecutive edge pair. The first interval is
    # usually the power-on edge (X -> 1 -> first level) and the last is
    # truncated by the capture end; both are excluded from the frequency
    # estimate so a 1.31 ms capture still measures 800 Hz correctly.
    halves = [edges[i + 1][0] - edges[i][0] for i in range(len(edges) - 1)]
    halves = [h for h in halves if h > 0]
    if not halves:
        return base
    core = halves[1:-1] if len(halves) >= 3 else []
    if not core:
        return base
    ordered = sorted(core)
    mid = len(ordered) // 2
    half = ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2.0
    freq = 1e9 / (2.0 * half) if half > 0 else 0.0
    period_cycles = (2.0 * half) / clock_ns if clock_ns > 0 else 0.0

    # Duty = fraction of the period the ON level is asserted. For an
    # active-low PNP driver, ON = logic 0.
    on_level = 0 if active_low else 1
    active_ns = 0.0
    total_ns = 0.0
    for i in range(len(edges) - 1):
        dt = edges[i + 1][0] - edges[i][0]
        if dt <= 0:
            continue
        total_ns += dt
        if edges[i][1] == on_level:
            active_ns += dt
    duty = active_ns / total_ns if total_ns > 0 else 0.0

    # Jitter over the core intervals that agree with the median.
    central = [h for h in core if abs(h - half) <= 0.2 * half]
    jitter = (max(central) - min(central)) / half if central and half > 0 else 1.0
    base.update({
        "tone": freq > 0,
        "frequency": int(round(freq)),
        "stable": jitter < 0.05,
        "cyclesPerPeriod": round(period_cycles, 3),
        "halfPeriodNs": round(half, 3),
        "duty": round(max(0.0, min(1.0, duty)), 4),
    })
    return base


def decode_vga(hs: List[Tuple[float, Any]], vs: List[Tuple[float, Any]],
               r: List[Tuple[float, Any]], g: List[Tuple[float, Any]],
               b: List[Tuple[float, Any]], lines: int = 240) -> Dict[str, Any]:
    """Reconstruct a coarse picture from the VGA sync + colour pins.

    Samples the RGB value between successive HSYNC pulses (colour bars and
    solid backgrounds are constant per line, which this samples faithfully).
    """
    def as_list(seq: List[Tuple[float, Any]]) -> List[Tuple[float, int]]:
        out = []
        for t, v in seq:
            n = _as_int(v)
            if n is not None:
                out.append((float(t), n & 1))
        return out

    hs_l, vs_l = as_list(hs), as_list(vs)
    r_l, g_l, b_l = as_list(r), as_list(g), as_list(b)

    # vsync: frame boundaries on falling edges
    frame_starts = [t for i, (t, v) in enumerate(vs_l) if i > 0 and vs_l[i - 1][1] == 1 and v == 0]
    if len(frame_starts) < 2:
        return {"lines": 0, "frame": False, "png": None, "hsync": len(hs_l)}
    f0, f1 = frame_starts[0], frame_starts[1]

    # hsync pulses inside the frame
    hs_edges = [t for t, v in hs_l if f0 <= t < f1 and v == 0]
    if len(hs_edges) < 4:
        return {"lines": 0, "frame": False, "png": None, "hsync": len(hs_l)}
    line_count = len(hs_edges)

    def colour_at(t: float) -> Tuple[int, int, int]:
        def value(seq: List[Tuple[float, int]]) -> int:
            last = 0
            for tt, vv in seq:
                if tt <= t:
                    last = vv
                else:
                    break
            return last
        return (value(r_l), value(g_l), value(b_l))

    samples: Dict[int, Tuple[int, int, int]] = {}
    probe_lines = [int(line_count * k / max(1, lines)) for k in range(lines)]
    for li, line in enumerate(probe_lines):
        if line + 1 >= len(hs_edges):
            continue
        t0, t1 = hs_edges[line], hs_edges[line + 1]
        # sample in the visible part (roughly 80% of the line)
        for k in range(16):
            t = t0 + (t1 - t0) * (0.1 + 0.05 * k)
            col = int((t - t0) / (t1 - t0) * 640)
            samples[col] = colour_at(t)
    return {"lines": line_count, "frame": True, "png": None,
            "samples": {str(k): list(v) for k, v in sorted(samples.items())[:32] if k % 64 == 0}}


def read_model_dumps(workdir: Path) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for name, key in (("eeprom_dump.txt", "eeprom"), ("lcd_state.txt", "lcd")):
        path = workdir / name
        if path.exists():
            try:
                out[key] = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass
    return out


__all__ = ["decode_uart", "decode_buzzer", "decode_vga", "read_model_dumps"]