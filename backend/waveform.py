"""Waveform model for the web UI.

Turns a parsed VCD into the JSON structure the frontend renders: per-signal
transitions, cycle samples taken on the rising edge of the clock, a final
state, and a mapping of entity ports to Cyclone IV dev-board peripherals.
"""

from __future__ import annotations

import bisect
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .device import BOARD, resolve_port_pins
from .testbench_gen import detect_clock, detect_reset
from .vhdl_parser import Entity, Port
from .vcd_parser import VcdData, VcdSignal

_LIBRARY_SCOPES = {
    "standard",
    "textio",
    "std_logic_1164",
    "numeric_std",
    "ieee",
    "std",
    "env",
    "math_real",
    "math_complex",
    "fixed_pkg",
    "float_pkg",
}

_VECTOR_NAMES = re.compile(r"^(.*?)((?:\[\d+:\d+\])?)$")


def _normalize_value(value: Any) -> Any:
    if value in ("0", "1"):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        lowered = text.lower()
        if text and all(ch in "01xzwhul-" for ch in lowered) and any(ch in "xzwhul" for ch in lowered):
            return text.upper()
        if lowered in ("x", "z", "w", "l", "h", "u", "-"):
            return lowered.upper()
    return value


def _depth(path: str) -> int:
    return path.count(".")


def _scope_allowed(path: str, root: Optional[str]) -> bool:
    if not root:
        return True
    lowered = path.lower()
    prefix = root.lower()
    return lowered == prefix or lowered.startswith(prefix + ".")


def _strip_bit_range(name: str) -> str:
    return _VECTOR_NAMES.match(name).group(1) if "[" in name else name


def _clip(transitions: List[Tuple[float, Any]], cap: Optional[float]) -> List[Tuple[float, Any]]:
    if cap is None:
        return transitions
    if not transitions:
        return transitions
    clipped = [item for item in transitions if item[0] <= cap + 1e-9]
    if not clipped:
        clipped = [transitions[0]]
    return clipped


def natural_key(name: str) -> Tuple:
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", name)
    ]


# ---------------------------------------------------------------------------
# Board mapping
# ---------------------------------------------------------------------------


@dataclass
class BoardMap:
    leds: List[str] = field(default_factory=list)
    switches: List[str] = field(default_factory=list)
    buttons: List[str] = field(default_factory=list)
    displays: List[str] = field(default_factory=list)
    digits: List[str] = field(default_factory=list)
    clock: Optional[str] = None
    reset: Optional[str] = None
    reset_active_high: bool = True
    profile: Optional[str] = None
    clock_hz: Optional[int] = None
    pins: Dict[str, List[str]] = field(default_factory=dict)
    led_config: Dict[str, Any] = field(default_factory=dict)
    display_config: Dict[str, Any] = field(default_factory=dict)
    profile_parts: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "leds": self.leds,
            "switches": self.switches,
            "buttons": self.buttons,
            "displays": self.displays,
            "digits": self.digits,
            "clock": self.clock,
            "reset": self.reset,
            "resetActiveHigh": self.reset_active_high,
            "profile": self.profile,
            "clockHz": self.clock_hz,
            "pins": self.pins,
            # Per-device polarity/part parameters, all sourced from board.json
            # (backend/device.py) so the UI never hard-codes a polarity.
            "ledConfig": self.led_config,
            "displayConfig": self.display_config,
            "parts": self.profile_parts,
        }


def _classify_port(name: str) -> Optional[str]:
    """Classify a port name by exact board-style token (LED/KEY/SEG/DIG/...).

    Exact matches win (``LED``, ``LED3``, ``SEG7``, ``DIG0``, ``KEY``, ``SW1``);
    anything else falls back to a documented substring heuristic so oddly
    named ports (``LED_DONE``, ``DISPLAY_EN``) still surface somewhere useful.
    """
    lower = name.lower()
    if re.fullmatch(r"leds?\d*", lower):
        return "led"
    if re.fullmatch(r"(?:dig|digit|an|anode|ca|cc|sel|scan|com|tube|dtube)\d*", lower):
        return "digit"
    if re.fullmatch(r"(?:sw|switch|switches|dip)s?\d*", lower):
        return "switch"
    if re.fullmatch(r"(?:key|btn|button|push)s?\d*", lower):
        return "button"
    if re.fullmatch(r"(?:hex|seg|seven|sevenseg|display)s?\d*", lower):
        return "display"
    if re.fullmatch(r"(?:buzzerb?|beep|spk|speaker|buzz)\d*", lower):
        return "buzzer"
    if "led" in lower:
        return "led"
    if any(token in lower for token in ("sw", "switch", "dip")):
        return "switch"
    if any(token in lower for token in ("key", "btn", "button", "push")):
        return "button"
    if any(token in lower for token in ("hex", "seg", "seven", "display")):
        return "display"
    return None


def map_board(
    entity: Entity,
    qsf_pins: Optional[Dict[str, List[str]]] = None,
    strict_pins: bool = False,
    bit_pins: Optional[Dict[str, Dict[int, str]]] = None,
) -> BoardMap:
    board = BoardMap()
    if not strict_pins:
        for port in entity.ports:
            kind = _classify_port(port.name)
            if kind == "led":
                board.leds.append(port.name)
            elif kind == "digit":
                board.digits.append(port.name)
            elif kind == "switch":
                board.switches.append(port.name)
            elif kind == "button":
                board.buttons.append(port.name)
            elif kind == "display":
                board.displays.append(port.name)

        board.leds.sort(key=natural_key)
        board.digits.sort(key=natural_key)
        board.switches.sort(key=natural_key)
        board.buttons.sort(key=natural_key)
        board.displays.sort(key=natural_key)

        clock = detect_clock(entity)
        board.clock = clock.name if clock else None
        reset = detect_reset(entity)
        if reset:
            board.reset = reset[0].name
            board.reset_active_high = reset[1]

    # Attach the real board pin assignment where a port name matches the
    # RZ-EasyFPGA A2.2 profile (LED/KEY/SEG/DIG/CLOCK_50/...), including the
    # textbook aliases (seven_seg->SEG, dtube->DIG, s1..s4->KEY bits, ...).
    # When strict_pins=True (Pin Planner mode), ONLY explicit pin assignments are applied.
    # Port width: prefer the parsed width, but fall back to the declared
    # range (left/right). Some legal spellings (e.g. uppercase
    # STD_LOGIC_VECTOR) leave ``width`` unset; truncating those to one pin
    # silently dropped every segment but a0 / every LED but led0.
    def _port_width(port) -> int:
        if getattr(port, "width", None):
            return int(port.width)
        left, right = getattr(port, "left", None), getattr(port, "right", None)
        if left is not None and right is not None:
            return abs(int(left) - int(right)) + 1
        return 1

    port_width = {port.name: max(1, _port_width(port)) for port in entity.ports}
    ports_with_pins: set = set()
    pins: Dict[str, List[str]] = {}
    qsf_lookup = {k.upper(): [str(p).upper() if p else "" for p in v] for k, v in (qsf_pins or {}).items() if v}
    bit_lookup = {
        k.upper(): {int(bit): str(pin).upper() for bit, pin in bmap.items() if pin}
        for k, bmap in (bit_pins or {}).items()
        if bmap
    }
    if qsf_lookup or bit_lookup:
        led_pins = {str(p).upper() for p in BOARD.get("leds", {}).get("pins", [])}
        dig_pins = {str(p).upper() for p in BOARD.get("displays", {}).get("pins", {}).get("DIG", [])}
        seg_pins = {str(p).upper() for p in BOARD.get("displays", {}).get("pins", {}).get("SEG", [])}
        btn_pins = {str(p).upper() for p in BOARD.get("buttons", {}).get("pins", [])}
        clk_pin = str(BOARD.get("clockPin") or "").upper()
        rst_pin = str(BOARD.get("resetPin") or "").upper()
        for port in entity.ports:
            w = port_width.get(port.name, 1)
            bmap = bit_lookup.get(port.name.upper())
            width_pins: Optional[List[str]] = None
            if bmap:
                slots: List[str] = []
                for offset in range(w):
                    if port.right is not None and port.left is not None and w > 1:
                        bit_idx = (port.right + offset) if port.downto else (port.right - offset)
                    else:
                        bit_idx = offset
                    slots.append(bmap.get(bit_idx, bmap.get(offset, "")))
                if any(slots):
                    width_pins = slots
            if width_pins is None:
                assigned = qsf_lookup.get(port.name.upper())
                if assigned and any(assigned[:w]):
                    width_pins = assigned[:w]
            if not width_pins:
                continue
            ports_with_pins.add(port.name)
            pins[port.name] = width_pins
            if any(p in led_pins for p in width_pins) and port.name not in board.leds:
                board.leds.append(port.name)
            if any(p in dig_pins for p in width_pins) and port.name not in board.digits:
                board.digits.append(port.name)
            if any(p in seg_pins for p in width_pins) and port.name not in board.displays:
                board.displays.append(port.name)
            if any(p in btn_pins for p in width_pins) and port.name not in board.buttons:
                board.buttons.append(port.name)
            if clk_pin and clk_pin in width_pins and not board.clock:
                board.clock = port.name
            if rst_pin and rst_pin in width_pins and not board.reset:
                board.reset = port.name
                board.reset_active_high = not BOARD.get("resetActiveLow", True)

    if not strict_pins:
        for name, kind in (
            *[(n, "led") for n in board.leds],
            *[(n, "switch") for n in board.switches],
            *[(n, "button") for n in board.buttons],
            *[(n, "display") for n in board.displays],
            *[(n, "digit") for n in board.digits],
            *([(board.clock, None)] if board.clock else []),
            *([(board.reset, None)] if board.reset else []),
        ):
            if name in ports_with_pins:
                continue
            match = resolve_port_pins(name, kind)
            if match:
                ports_with_pins.add(name)
                pins[name] = match[: port_width.get(name, len(match))]

        # Scalar ports outside the classified groups (textbook "s1".."s4" key
        # inputs, "led2"-style scalars, a bare "reset") get the alias resolver
        # too, so designs that avoid vendor bus names still map to real pins.
        for port in entity.ports:
            if port.name in ports_with_pins:
                continue
            match = resolve_port_pins(port.name, _classify_port(port.name))
            if match:
                pins[port.name] = match[: port_width.get(port.name, len(match))]
    board.pins = pins
    board.profile = BOARD["name"]
    board.clock_hz = BOARD["clockHz"]

    # Per-device polarity and part parameters come from board.json; the UI
    # reads them from here instead of hard-coding a polarity or a bit map.
    board.led_config = {
        "activeLow": BOARD["leds"].get("activeLow", False),
        "count": BOARD["leds"].get("count", len(board.leds)),
        "seriesResistor": BOARD["leds"].get("seriesResistor"),
        # LED index -> package pin (e.g. index 0 -> PIN_87), from board.json.
        "pins": {str(index): pin for index, pin in enumerate(BOARD["leds"].get("pins", []))},
    }
    board.display_config = {
        "segBitMap": dict(BOARD["displays"].get("segBitMap", {})),
        "segmentActiveLow": BOARD["displays"].get("segmentActiveLow", False),
        "digitActiveLow": BOARD["displays"].get("digitActiveLow", False),
        "multiplexed": BOARD["displays"].get("multiplexed", False),
        "count": BOARD["displays"].get("count", len(board.digits)),
    }
    board.profile_parts = {
        "buzzer": BOARD.get("buzzer"),
        "i2c": BOARD.get("i2c"),
        "infrared": BOARD.get("infrared"),
        "ps2": BOARD.get("ps2"),
        "uart": BOARD.get("uart"),
        "vga": BOARD.get("vga"),
    }

    # On the A2.2 the DIP switch and the push keys share the same pins; expose
    # the DIP through the key port so both physical controls move in the UI.
    if board.buttons and BOARD["switches"].get("sharedWithButtons") and not board.switches:
        shared = BOARD["switches"]["port"]
        if shared in board.buttons:
            board.switches = [shared]

    # The board profile knows the reset polarity (the A2.2 reset is active low).
    if board.reset:
        profile_reset = BOARD.get("resetPort", "").upper()
        if board.reset.upper() == profile_reset:
            board.reset_active_high = not BOARD.get("resetActiveLow", False)
    return board


# ---------------------------------------------------------------------------
# Compact board image (live input-change refresh)
# ---------------------------------------------------------------------------


def _as_int(value: Any) -> int:
    """Coerce a normalized signal value to an int (vectors are already int)."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text and all(ch in "01" for ch in text):
            return int(text, 2)
    return 0


def _detect_down_counter(model: "WaveformModel", min_terminal: int = 1000) -> Optional[dict]:
    """Find a loaded down-counter generically, by register-slope analysis.

    Used to schedule a buzzer note without simulating the whole countdown.
    No signal-name filter: **any** internal integer signal that is loaded to a
    large value and then decrements by a constant step per clock is a
    candidate. ``step`` is the measured decrement per clock (usually 1) and
    ``cycles = terminal / step`` is the note length in FPGA clocks.

    The longest candidate wins (a 25M-cycle delay beats a 31k-cycle tone
    divider), so a student can name their counter ``cnt_delay``,
    ``timer_value`` or anything else and it still works.
    """
    from collections import Counter

    times = model.clock_times(limit=4096)
    if len(times) < 4:
        return None
    best: Optional[dict] = None
    for signal in model.signals:
        if signal.is_port or (signal.width or 1) <= 1:
            continue
        values = [signal.value_at(t) for t in times]
        if any(not isinstance(v, int) or isinstance(v, bool) for v in values):
            continue
        # A down-counter has values[i+1] < values[i] (negative slope).
        steps = [values[i + 1] - values[i] for i in range(len(values) - 1)]
        negative = [s for s in steps if s < 0]
        if not negative:
            continue
        step = Counter(negative).most_common(1)[0][0]
        # Longest run of consecutive clocks with that exact decrement.
        run = 0
        best_run = 0
        best_start = 0
        start = 0
        for i, s in enumerate(steps):
            if s == step:
                if run == 0:
                    start = i
                run += 1
                if run > best_run:
                    best_run = run
                    best_start = start
            else:
                run = 0
        if best_run < 2:
            continue
        terminal = values[best_start]
        if terminal < min_terminal:
            continue
        step_mag = abs(step)
        # +1: the load cycle itself is part of the note (buzz1 loads 49,999,999
        # and the gate stays asserted for 50,000,000 clocks).
        cycles = int(round(terminal / step_mag)) + 1 if step_mag else 0
        if cycles <= 1:
            continue
        start_ns = round(float(times[best_start]), 3)
        candidate = {
            "name": signal.name,
            "terminal": terminal,
            "step": step_mag,
            "cycles": cycles,
            "start_ns": start_ns,
            "capture_end_ns": round(float(times[-1]), 3),
            "run": best_run,
        }
        if best is None or candidate["cycles"] > best["cycles"]:
            best = candidate
    return best


def board_image_from_model(model: "WaveformModel", board_map: "BoardMap") -> dict:
    """Persistence-of-vision board image computed straight from transitions.

    Only the display/digit signals are sampled on the clock edges (a targeted
    merge-join), so the whole ~20 MB cycle materialisation is skipped — a
    switch flip repaints the board from a few hundred bytes in a few ms.

    Returns ``{"pov": [32], "povBits": [32], "scanHz": float, "ghosts": [...],
    "digits": [4], "leds": [...], "buzzer": 0|1}``:

    * ``pov`` — for each of the four tubes and eight segments, the **duty
      cycle** (0.0–1.0) of that segment being lit while its tube is selected
      over the capture. A 25%-duty multiplexed digit therefore reads 0.25,
      not a binary on/off — this is what makes the rendered brightness match
      a real common-anode tube.
    * ``povBits`` — the same image thresholded to 0/1 (ever lit), kept for
      callers/tests that only care about presence.
    * ``scanHz`` — full-scan refresh rate measured from digit-select rising
      edges (0 when the display is static / has no digit port).
    * ``ghosts`` — ``[digit, bit, t_ns, intensity]`` samples where the segment
      lines and the digit select changed on the same clock edge. Without
      dead-time blanking the new segments bleed onto the previously selected
      tube for that overlap; ``intensity`` is overlap/digit-dwell (0–0.25), so
      the simulator models a faint ghost instead of hiding it.
    * ``digits`` — the final digit-enable state (which tubes are selected).
    * ``leds`` / ``buzzer`` — the final steady-state output levels.

    Polarity, segment/digit mapping and undriven-digit handling all come from
    the board profile (``board.json``), so this matches the 3D board exactly.
    """
    cfg = board_map.display_config or {}
    seg_active_low = bool(cfg.get("segmentActiveLow", True))
    dig_active_low = bool(cfg.get("digitActiveLow", True))
    n_dig = int(cfg.get("count") or len(board_map.digits) or 4)
    n_seg = 8
    pov = [0.0] * (n_dig * n_seg)
    pov_bits = [0] * (n_dig * n_seg)

    pins = board_map.pins or {}
    led_pin_idx = {str(p).upper(): i for i, p in enumerate(BOARD.get("leds", {}).get("pins", []))}
    dig_pin_idx = {str(p).upper(): i for i, p in enumerate(BOARD.get("displays", {}).get("pins", {}).get("DIG", []))}
    seg_pin_idx = {str(p).upper(): i for i, p in enumerate(BOARD.get("displays", {}).get("pins", {}).get("SEG", []))}
    buz_pin = str((BOARD.get("buzzer") or {}).get("pin") or "").upper()

    # Collect explicit (port, src_bit, hw_idx) routes from board_map.pins so partial or
    # custom Pin Planner assignments drive the exact hardware LED/segment/digit pins.
    seg_routes: List[Tuple[str, int, int]] = []
    dig_routes: List[Tuple[str, int, int]] = []
    led_routes: Dict[int, Tuple[str, int]] = {}
    buz_route: Optional[Tuple[str, int]] = None
    has_pin_routes = any(pins.values())
    if has_pin_routes:
        for port, plist in pins.items():
            for bit, raw_pin in enumerate(plist or []):
                pin = str(raw_pin or "").upper()
                if not pin:
                    continue
                if pin in seg_pin_idx:
                    seg_routes.append((port, bit, seg_pin_idx[pin]))
                elif pin in dig_pin_idx:
                    dig_routes.append((port, bit, dig_pin_idx[pin]))
                elif pin in led_pin_idx:
                    led_routes[led_pin_idx[pin]] = (port, bit)
                elif buz_pin and pin == buz_pin:
                    buz_route = (port, bit)
    else:
        for port in board_map.displays:
            for bit in range(n_seg):
                seg_routes.append((port, bit, bit))
        for port in board_map.digits:
            for bit in range(n_dig):
                dig_routes.append((port, bit, bit))
        led_cursor = 0
        for port in board_map.leds:
            w = len(pins.get(port, [])) or 1
            for bit in range(w):
                if led_cursor < len(led_pin_idx):
                    led_routes[led_cursor] = (port, bit)
                    led_cursor += 1

    def _values_at(signal: Optional["WaveformSignal"], times: List[float], n: int) -> List[int]:
        """Merge-join a signal's transitions onto ``n`` clock edges."""
        out = [0] * n
        if signal is None or not signal.transitions:
            return out
        trans = signal.transitions
        ti = 0
        cur = _as_int(trans[0][1])
        nt = len(trans)
        for i, t in enumerate(times):
            while ti < nt and trans[ti][0] <= t:
                cur = _as_int(trans[ti][1])
                ti += 1
            out[i] = cur
        return out

    times = model.clock_times(limit=model.max_cycles)
    n = len(times)
    last_dig = [1] * n_dig if (seg_routes or dig_routes) else [0] * n_dig
    scan_periods: List[float] = []
    ghosts: List[List[float]] = []
    seg_cycles = [[0] * n_seg for _ in range(n_dig)]
    if n and (seg_routes or dig_routes):
        needed_ports = {p for p, _, _ in seg_routes} | {p for p, _, _ in dig_routes}
        port_vals = {p: _values_at(model.signal(p), times, n) for p in needed_ports}
        prev_dig: Optional[List[int]] = None
        prev_seg: Optional[List[int]] = None
        rise_at: Dict[int, float] = {}
        for i in range(n):
            seg_active = [0] * n_seg
            for port, src_bit, seg_idx in seg_routes:
                level = (port_vals[port][i] >> src_bit) & 1
                if (level == 0) == seg_active_low:
                    seg_active[seg_idx] = 1
            dig_on = [0] * n_dig
            any_dig = bool(dig_routes)
            for port, src_bit, dig_idx in dig_routes:
                level = (port_vals[port][i] >> src_bit) & 1
                if (level == 0) == dig_active_low:
                    dig_on[dig_idx] = 1
            if not any_dig and seg_routes:
                dig_on = [1] * n_dig  # static display: all tubes share the lines
            last_dig = dig_on

            # Ghosting without blanking: digit select and segment lines changed
            # on the same sample, so the new segments bleed onto the tube that
            # was selected. Recorded as a faint overlay (intensity below), NOT
            # folded into the intended POV — otherwise a fast mux would make
            # every tube show every segment.
            if prev_dig is not None and prev_seg is not None:
                if dig_on != prev_dig and seg_active != prev_seg:
                    for d in range(n_dig):
                        if not prev_dig[d]:
                            continue
                        for bit in range(n_seg):
                            if seg_active[bit] and not prev_seg[bit]:
                                if len(ghosts) < 200:
                                    ghosts.append([d, bit, round(float(times[i]), 3)])

            for d in range(n_dig):
                if not dig_on[d]:
                    continue
                for bit in range(n_seg):
                    if seg_active[bit]:
                        seg_cycles[d][bit] += 1

            # Full-scan refresh: rising edge of each digit select.
            for d in range(n_dig):
                if dig_on[d] and (prev_dig is None or not prev_dig[d]):
                    if d in rise_at:
                        period = float(times[i]) - rise_at[d]
                        if period > 0:
                            scan_periods.append(period)
                    rise_at[d] = float(times[i])
            prev_dig = dig_on
            prev_seg = seg_active

    # Perceived brightness = segment lit time / FULL capture time. A 1-of-4
    # multiplexed digit is enabled 25% of the refresh period, so its segments
    # read 0.25 (steady, dimmer) — not 1.0. A static display reads 1.0.
    denom = n
    for d in range(n_dig):
        base = d * n_seg
        for bit in range(n_seg):
            lit = seg_cycles[d][bit]
            pov[base + bit] = round(lit / denom, 4) if denom else 0.0
            pov_bits[base + bit] = 1 if lit else 0

    scan_hz = round(1e9 / (sum(scan_periods) / len(scan_periods)), 3) if scan_periods else 0.0

    # Ghost intensity = overlap / digit dwell. One clock period is the upper
    # bound on the overlap when there is no dead-time blanking; relative to the
    # digit's on-time this gives a faint bleed (25% at 4 cycles/digit, ~0% at
    # slow scan rates), matching what the eye integrates.
    if ghosts and n > 1:
        clock_ns = float(times[1] - times[0])
        scan_ns = (1e9 / scan_hz) if scan_hz else 0.0
        dwell_ns = (scan_ns / n_dig) if scan_ns else clock_ns
        intensity = round(min(0.25, clock_ns / dwell_ns), 4) if dwell_ns > 0 else 0.0
        ghosts = [g + [intensity] for g in ghosts]

    # Final LED / buzzer levels (steady state at the end of the capture).
    final_vals = model.final_values()
    led_cfg = board_map.led_config or {}
    led_active_low = bool(led_cfg.get("activeLow", True))
    n_board_leds = len(led_pin_idx) or 4
    leds: List[int] = [0] * n_board_leds
    for led_idx, (port, src_bit) in led_routes.items():
        if 0 <= led_idx < n_board_leds:
            level = (_as_int(final_vals.get(port)) >> src_bit) & 1
            leds[led_idx] = 1 if ((level == 0) == led_active_low) else 0

    buzzer = 0
    if buz_route is not None:
        bport, bbit = buz_route
        buzzer = 1 if ((_as_int(final_vals.get(bport)) >> bbit) & 1) == 0 else 0
    elif not has_pin_routes:
        buzzer_port = (BOARD.get("buzzer") or {}).get("port")
        if buzzer_port and buzzer_port in final_vals:
            buzzer = 1 if _as_int(final_vals.get(buzzer_port)) == 0 else 0

    return {
        "pov": pov,
        "povBits": pov_bits,
        "scanHz": scan_hz,
        "ghosts": ghosts,
        "countdown": _detect_down_counter(model),
        "digits": last_dig,
        "leds": leds,
        "buzzer": buzzer,
    }


# ---------------------------------------------------------------------------
# Waveform model
# ---------------------------------------------------------------------------

#: Maximum number of transitions serialized per signal by ``to_dict``
#: (audit N2).  A long simulation can hold hundreds of thousands of
#: transitions per signal; serializing all of them for the JSON payload is
#: unbounded cost.  Traces above the cap are deterministically decimated to
#: an evenly spaced sample that always keeps the first and the last
#: transition, so the payload size is bounded and identical runs produce
#: identical JSON.  Cycle sampling (``cycles()``) and final values always use
#: the full transition list — only the serialized payload is decimated.
MAX_SERIALIZED_TRANSITIONS = 2000


def _decimate_transitions(items: List[Tuple[float, Any]], cap: int) -> List[Tuple[float, Any]]:
    """Deterministic sample of at most ``cap`` transitions.

    Keeps the first and the last item plus an evenly spaced selection of the
    interior ones.  Pure function of the input, so two runs of the same
    waveform serialize identically.
    """
    if cap <= 0 or len(items) <= cap:
        return items
    kept: List[Tuple[float, Any]] = []
    last_index = -1
    for position in range(cap):
        index = round(position * (len(items) - 1) / (cap - 1))
        if index != last_index:
            kept.append(items[index])
            last_index = index
    return kept


@dataclass
class WaveformSignal:
    name: str
    path: str
    scope: str
    width: int
    kind: str
    direction: str
    type_name: str
    transitions: List[Tuple[float, Any]]
    is_port: bool
    is_internal: bool
    # Lazily built bisect index of transition times (audit N2: value_at used
    # to be a linear scan over every transition, per signal per cycle).
    _time_keys: List[float] = field(
        default_factory=list, init=False, repr=False, compare=False
    )

    def _time_index(self) -> List[float]:
        keys = self._time_keys
        if len(keys) != len(self.transitions):
            keys = [timestamp for timestamp, _value in self.transitions]
            self._time_keys = keys
        return keys

    def value_at(self, time_ns: float) -> Any:
        """Value of the signal at ``time_ns`` (bisect over the ordered times).

        Returns the value of the last transition at or before ``time_ns``.
        Before the first recorded transition it returns that first
        transition's value (the VCD's initial dump), matching the previous
        linear-scan behaviour that cycle sampling relies on.
        """
        if not self.transitions:
            return 0
        index = bisect.bisect_right(self._time_index(), time_ns)
        if index == 0:
            return self.transitions[0][1]
        return self.transitions[index - 1][1]

    def to_dict(self, compact: bool = False) -> dict:
        data = {
            "name": self.name,
            "path": self.path,
            "scope": self.scope,
            "width": self.width,
            "type": self.kind,
            "direction": self.direction,
            "typeName": self.type_name,
            "isPort": self.is_port,
            "isInternal": self.is_internal,
        }
        # Compact (live-refresh) runs never draw a waveform, so the per-signal
        # transition lists (~1.5 s of decimation for a 36-signal design) are
        # pure waste — omit them and keep only the signal metadata.
        if not compact:
            data["transitions"] = [
                [time, _normalize_value(value)]
                for time, value in _decimate_transitions(
                    self.transitions, MAX_SERIALIZED_TRANSITIONS
                )
            ]
        return data


class WaveformModel:
    def __init__(
        self,
        vcd: VcdData,
        entity: Entity,
        root: Optional[str],
        max_cycles: int = 256,
        duration_cap: Optional[float] = None,
    ) -> None:
        self.vcd = vcd
        self.entity = entity
        self.root = root
        self.max_cycles = max_cycles
        self.duration_cap = duration_cap
        self.signals: List[WaveformSignal] = self._build_signals()

    # -- construction -----------------------------------------------------
    def _build_signals(self) -> List[WaveformSignal]:
        port_by_lower = {port.name.lower(): port for port in self.entity.ports}

        selected: Dict[str, VcdSignal] = {}
        for signal in self.vcd.signals:
            path = signal.path
            if not _scope_allowed(path, self.root):
                continue
            if signal.scope.lower() in _LIBRARY_SCOPES:
                continue
            # Skip signals declared inside the standard libraries.
            if any(part.lower() in _LIBRARY_SCOPES for part in signal.scope.split(".")):
                continue

            name = _strip_bit_range(signal.name)
            if not name:
                continue
            key = name.lower()
            existing = selected.get(key)
            if existing is None or _depth(signal.scope) < _depth(existing.scope):
                selected[key] = signal

        signals: List[WaveformSignal] = []
        ordered_names = [port.name for port in self.entity.ports]
        port_keys = {port.name.lower() for port in self.entity.ports}
        for key, signal in selected.items():
            if key not in port_keys:
                ordered_names.append(signal.name)

        for name in ordered_names:
            key = name.lower()
            signal = selected.get(key)
            port = port_by_lower.get(key)
            display_name = port.name if port else (signal.name if signal else name)

            if signal is None:
                # Port exists in the interface but was not dumped; synthesize a
                # static signal so the UI still shows it.
                assert port is not None
                signals.append(
                    WaveformSignal(
                        name=display_name,
                        path=display_name,
                        scope=self.entity.name,
                        width=port.width or 1,
                        kind="reg",
                        direction=port.direction,
                        type_name=port.type_name,
                        transitions=[(0.0, 0)],
                        is_port=True,
                        is_internal=False,
                    )
                )
                continue

            signals.append(
                WaveformSignal(
                    name=display_name,
                    path=signal.path,
                    scope=signal.scope,
                    width=max(signal.width, (port.width if port else 1) or 1),
                    kind=signal.kind,
                    direction=port.direction if port else "internal",
                    type_name=port.type_name if port else "internal",
                    transitions=_clip(signal.transitions, self.duration_cap),
                    is_port=port is not None,
                    is_internal=port is None,
                )
            )

        return signals

    # -- queries ----------------------------------------------------------
    def signal(self, name: str) -> Optional[WaveformSignal]:
        for signal in self.signals:
            if signal.name.lower() == name.lower():
                return signal
        return None

    def final_values(self) -> Dict[str, Any]:
        values: Dict[str, Any] = {}
        for signal in self.signals:
            value = _normalize_value(signal.transitions[-1][1]) if signal.transitions else 0
            if signal.width == 1 and isinstance(value, int):
                value = value & 1
            values[signal.name] = value
        return values

    def clock_times(self, limit: Optional[int] = None) -> List[float]:
        """Rising-edge times of the detected clock port.

        Stops after ``limit`` edges so a multi-million-cycle VCD does not
        materialise millions of samples when only ``max_cycles`` are needed.
        """
        clock_port = detect_clock(self.entity)
        if not clock_port:
            return []
        signal = self.signal(clock_port.name)
        if not signal:
            return []
        times: List[float] = []
        previous = None
        for timestamp, value in signal.transitions:
            current = _normalize_value(value)
            if previous == 0 and current == 1:
                times.append(timestamp)
                if limit is not None and len(times) >= limit:
                    break
            previous = current
        return times

    def cycles(self) -> List[dict]:
        times = self.clock_times(limit=self.max_cycles)
        if not times:
            return []
        # Merge-join: walk each signal's transitions once alongside the sorted
        # clock times instead of bisecting per (signal, time) — the old
        # per-cycle bisect was O(signals * cycles * log transitions) and
        # dominated the run cost (~0.7 s for 65k cycles). Equivalent to
        # value_at: the value of the last transition at or before each time.
        n = len(times)
        per_signal: Dict[str, List[Any]] = {}
        for signal in self.signals:
            vals = [0] * n
            trans = signal.transitions
            if trans:
                ti = 0
                cur = trans[0][1]
                nt = len(trans)
                for i, t in enumerate(times):
                    while ti < nt and trans[ti][0] <= t:
                        cur = trans[ti][1]
                        ti += 1
                    vals[i] = _normalize_value(cur)
            per_signal[signal.name] = vals
        cycles: List[dict] = []
        for i, t in enumerate(times):
            cycles.append({
                "cycle": i,
                "time": t,
                "values": {name: per_signal[name][i] for name in per_signal},
            })
        return cycles

    # -- serialization ----------------------------------------------------
    def to_dict(self, cycles: Optional[List[dict]] = None, compact: bool = False) -> dict:
        duration = self.duration_cap if self.duration_cap is not None else self.vcd.duration_ns
        data = {
            "timescaleNs": self.vcd.timescale_ns,
            "duration": duration,
            "signals": [signal.to_dict(compact=compact) for signal in self.signals],
            "final": self.final_values(),
        }
        # Compact (live-refresh) runs omit the per-cycle samples — the client
        # repaints from the board image, not by replaying cycles.
        if not compact:
            data["cycles"] = self.cycles() if cycles is None else cycles
        return data


def build_waveform(
    vcd: VcdData,
    entity: Entity,
    root: Optional[str] = None,
    max_cycles: int = 256,
    duration_cap: Optional[float] = None,
    compact: bool = False,
    qsf_pins: Optional[Dict[str, List[str]]] = None,
    strict_pins: bool = False,
    bit_pins: Optional[Dict[str, Dict[int, str]]] = None,
) -> tuple[dict, Dict[str, List[Tuple[float, Any]]]]:
    """Build the UI payload plus the full transition lists.

    Returns ``(payload, transitions_by_name)``.  The payload's per-signal
    ``transitions`` are capped at ``MAX_SERIALIZED_TRANSITIONS`` for the
    client (audit N2); ``transitions_by_name`` carries the complete,
    normalized lists for the post-run peripheral decoders (UART / buzzer /
    VGA), which must never see a decimated timeline.

    With ``compact=True`` the ``cycles`` samples are omitted and a tiny
    ``boardImage`` (persistence-of-vision display + final LED/buzzer state) is
    attached instead, for the live input-change refresh path.
    """
    model = WaveformModel(vcd, entity, root, max_cycles=max_cycles, duration_cap=duration_cap)
    board_map = map_board(entity, qsf_pins, strict_pins=strict_pins, bit_pins=bit_pins)
    if compact:
        # Skip materialising the ~65k cycle dicts: the board image is computed
        # straight from the transitions, and the client paints that instead.
        data = model.to_dict(cycles=[], compact=True)
    else:
        cycles = model.cycles()
        data = model.to_dict(cycles=cycles, compact=False)
    data["board"] = board_map.as_dict()
    # Persistence-of-vision display image + final LED/buzzer state. Computed
    # from the transitions for both paths (a few ms) so the client can settle
    # the multiplexed display to the exact integrated image — identical whether
    # the run streamed cycles or was a compact refresh.
    data["boardImage"] = board_image_from_model(model, board_map)
    transitions = {
        signal.name.upper(): [
            (time, _normalize_value(value)) for time, value in signal.transitions
        ]
        for signal in model.signals
    }
    return data, transitions


__all__ = [
    "BoardMap",
    "MAX_SERIALIZED_TRANSITIONS",
    "WaveformModel",
    "WaveformSignal",
    "build_waveform",
    "map_board",
]