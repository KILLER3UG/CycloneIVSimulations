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
    if "led" in lower:
        return "led"
    if any(token in lower for token in ("sw", "switch", "dip")):
        return "switch"
    if any(token in lower for token in ("key", "btn", "button", "push")):
        return "button"
    if any(token in lower for token in ("hex", "seg", "seven", "display")):
        return "display"
    return None


def map_board(entity: Entity) -> BoardMap:
    board = BoardMap()
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
    ports_with_pins: set = set()
    pins: Dict[str, List[str]] = {}
    for name, kind in (
        *[(n, "led") for n in board.leds],
        *[(n, "switch") for n in board.switches],
        *[(n, "button") for n in board.buttons],
        *[(n, "display") for n in board.displays],
        *[(n, "digit") for n in board.digits],
        *([(board.clock, None)] if board.clock else []),
        *([(board.reset, None)] if board.reset else []),
    ):
        match = resolve_port_pins(name, kind)
        if match:
            ports_with_pins.add(name)
            pins[name] = match

    # Scalar ports outside the classified groups (textbook "s1".."s4" key
    # inputs, "led2"-style scalars, a bare "reset") get the alias resolver
    # too, so designs that avoid vendor bus names still map to real pins.
    for port in entity.ports:
        if port.name in ports_with_pins:
            continue
        match = resolve_port_pins(port.name, _classify_port(port.name))
        if match:
            pins[port.name] = match
    board.pins = pins
    board.profile = BOARD["name"]
    board.clock_hz = BOARD["clockHz"]

    # Per-device polarity and part parameters come from board.json; the UI
    # reads them from here instead of hard-coding a polarity or a bit map.
    board.led_config = {
        "activeLow": BOARD["leds"].get("activeLow", False),
        "count": BOARD["leds"].get("count", len(board.leds)),
        "seriesResistor": BOARD["leds"].get("seriesResistor"),
        # LED index -> package pin (e.g. "0" -> "PIN_87"), from board.json.
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

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "path": self.path,
            "scope": self.scope,
            "width": self.width,
            "type": self.kind,
            "direction": self.direction,
            "typeName": self.type_name,
            "isPort": self.is_port,
            "isInternal": self.is_internal,
            "transitions": [
                [time, _normalize_value(value)]
                for time, value in _decimate_transitions(
                    self.transitions, MAX_SERIALIZED_TRANSITIONS
                )
            ],
        }


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
        cycles: List[dict] = []
        for index, time in enumerate(times):
            values: Dict[str, Any] = {}
            for signal in self.signals:
                values[signal.name] = _normalize_value(signal.value_at(time))
            cycles.append({"cycle": index, "time": time, "values": values})
        return cycles

    # -- serialization ----------------------------------------------------
    def to_dict(self) -> dict:
        duration = self.duration_cap if self.duration_cap is not None else self.vcd.duration_ns
        return {
            "timescaleNs": self.vcd.timescale_ns,
            "duration": duration,
            "signals": [signal.to_dict() for signal in self.signals],
            "cycles": self.cycles(),
            "final": self.final_values(),
        }


def build_waveform(
    vcd: VcdData,
    entity: Entity,
    root: Optional[str] = None,
    max_cycles: int = 256,
    duration_cap: Optional[float] = None,
) -> tuple[dict, Dict[str, List[Tuple[float, Any]]]]:
    """Build the UI payload plus the full transition lists.

    Returns ``(payload, transitions_by_name)``.  The payload's per-signal
    ``transitions`` are capped at ``MAX_SERIALIZED_TRANSITIONS`` for the
    client (audit N2); ``transitions_by_name`` carries the complete,
    normalized lists for the post-run peripheral decoders (UART / buzzer /
    VGA), which must never see a decimated timeline.
    """
    model = WaveformModel(vcd, entity, root, max_cycles=max_cycles, duration_cap=duration_cap)
    data = model.to_dict()
    data["board"] = map_board(entity).as_dict()
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