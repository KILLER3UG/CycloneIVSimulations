"""Waveform model for the web UI.

Turns a parsed VCD into the JSON structure the frontend renders: per-signal
transitions, cycle samples taken on the rising edge of the clock, a final
state, and a mapping of entity ports to Cyclone IV dev-board peripherals.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .device import BOARD, board_pin_map
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
        }


def map_board(entity: Entity) -> BoardMap:
    board = BoardMap()
    for port in entity.ports:
        name = port.name
        lower = name.lower()
        if "led" in lower:
            board.leds.append(name)
        elif re.fullmatch(r"(?:dig|digit|an|anode|ca|cc|sel|scan|com)\d*", lower):
            board.digits.append(name)
        elif any(token in lower for token in ("sw", "switch", "dip")):
            board.switches.append(name)
        elif any(token in lower for token in ("key", "btn", "button", "push")):
            board.buttons.append(name)
        elif any(token in lower for token in ("hex", "seg", "seven", "display")):
            board.displays.append(name)

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
    # RZ-EasyFPGA A2.2 profile (LED/KEY/SEG/DIG/CLOCK_50/...).
    profile_pins = board_pin_map()
    pins: Dict[str, List[str]] = {}
    for name in (
        board.leds + board.switches + board.buttons + board.displays + board.digits
        + ([board.clock] if board.clock else [])
        + ([board.reset] if board.reset else [])
    ):
        match = profile_pins.get(name.upper())
        if match:
            pins[name] = match
    board.pins = pins
    board.profile = BOARD["name"]
    board.clock_hz = BOARD["clockHz"]

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

    def value_at(self, time_ns: float) -> Any:
        if not self.transitions:
            return 0
        value = self.transitions[0][1]
        for timestamp, item in self.transitions:
            if timestamp <= time_ns:
                value = item
            else:
                break
        return value

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
                [time, _normalize_value(value)] for time, value in self.transitions
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

    def clock_times(self) -> List[float]:
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
            previous = current
        return times

    def cycles(self) -> List[dict]:
        times = self.clock_times()[: self.max_cycles]
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
) -> dict:
    model = WaveformModel(vcd, entity, root, max_cycles=max_cycles, duration_cap=duration_cap)
    data = model.to_dict()
    data["board"] = map_board(entity).as_dict()
    return data


__all__ = [
    "BoardMap",
    "WaveformModel",
    "WaveformSignal",
    "build_waveform",
    "map_board",
]