"""Automatic testbench generation.

GHDL can only simulate a design when it is instantiated by a testbench.  For a
dev-board style workflow the user should not have to write VHDL boilerplate
just to see an LED blink, so the backend synthesises a testbench from the
entity interface and a small stimulus description (clock, reset and input
values).
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

from .device import BOARD
from .vhdl_parser import Entity, Port, VHDLParser

_CLOCK_NAMES = {
    "clk",
    "clock",
    "clk50",
    "clk_50",
    "clk50m",
    "clk_50m",
    "clock50",
    "clock_50",
    "clock50m",
    "clock_50m",
    "sysclk",
    "sys_clk",
    "clk_in",
    "clk_i",
    "clock_in",
    "clock_i",
    "mclk",
    "master_clk",
    "master_clock",
    # Altera/Intel PLL input names (altpll-style designs)
    "inclk0",
    "inclk",
}

_RESET_NAMES = {
    "rst",
    "reset",
    "rst_n",
    "reset_n",
    "nreset",
    "nrst",
    "areset",
    "arst",
    "aresetn",
    "resetn",
    "rstn",
    "reset_async",
    "por",
}

_VECTOR_TYPES = {"std_logic_vector", "unsigned", "signed", "bit_vector"}


def _normalize(name: str) -> str:
    return name.strip().lower()


def detect_clocks(entity: Entity) -> List[Port]:
    """All input ports that look like clocks, in declaration order.

    Used to drive every clock domain of the design from the auto testbench
    (a single undriven clock would freeze that whole domain at '0').
    """
    found: List[Port] = []
    seen: set = set()
    for port in entity.ports:
        if not port.is_input or port.name.lower() in seen:
            continue
        name = _normalize(port.name)
        if name in _CLOCK_NAMES or re.fullmatch(r"(?:sys_?)?clk\d+[a-z]?", name):
            found.append(port)
            seen.add(port.name.lower())
            continue
        if (
            (name.startswith("clk") or name.startswith("clock"))
            and (port.width or 1) == 1
            and not name.endswith(("en", "enable", "out", "by", "div", "gate"))
        ):
            found.append(port)
            seen.add(port.name.lower())
    return found


def detect_clock(entity: Entity) -> Optional[Port]:
    """Find the clock port: exact/board names first, then clk*/clock* stems.

    Ports whose name only *starts* with clk/clock are accepted only when they
    are not obviously something else (clock enable, clock output, divider...),
    so ``clk_en``/``clk_out`` are never mistaken for the clock (audit m3).
    """
    clocks = detect_clocks(entity)
    return clocks[0] if clocks else None


def _is_active_low(name: str) -> bool:
    n = _normalize(name)
    if n.endswith("_n") or n.endswith("n") and "reset" in n:
        return True
    if n.startswith("n") and ("reset" in n or n in {"nrst"}):
        return True
    return n in {"aresetn", "resetn", "rstn", "nreset", "nrst"}


def detect_reset(entity: Entity) -> Optional[tuple[Port, bool]]:
    """Find the reset port by exact name (or the board profile's reset port).

    Substring matching is deliberately avoided: an input like ``reset_req``
    is not a reset the testbench should drive (audit m4).

    Polarity is a property of the DESIGN, inferred from the port name
    (``rst_n``/``resetn`` -> active-low, bare ``reset``/``rst`` -> active-high).
    The board's own active-low RESET key is applied by the UI, which passes
    ``resetActiveHigh=false`` + ``resetPort`` explicitly; this heuristic only
    drives the bare-API path where no board polarity is supplied.
    """
    board_reset = _normalize(BOARD.get("resetPort", ""))
    board_active_high = not BOARD.get("resetActiveLow", True)
    for port in entity.ports:
        if not port.is_input:
            continue
        name = _normalize(port.name)
        if name in _RESET_NAMES:
            return port, not _is_active_low(port.name)
        if board_reset != "" and name == board_reset:
            return port, board_active_high   # board profile knows the polarity
    return None


@dataclass
class Stimulus:
    """Description of how an input port should be driven."""

    port: str
    kind: str = "constant"  # constant | toggle | pulse | sequence | pulse_once
    value: Any = 0
    values: List[Any] = field(default_factory=list)
    period_cycles: int = 1
    pulse_cycles: int = 1
    hold_cycles: int = 1

    def as_dict(self) -> dict:
        return {
            "port": self.port,
            "kind": self.kind,
            "value": self.value,
            "values": list(self.values),
            "periodCycles": self.period_cycles,
            "pulseCycles": self.pulse_cycles,
            "holdCycles": self.hold_cycles,
        }


@dataclass
class TestbenchConfig:
    duration_ns: float = 1000.0
    clock_port: Optional[str] = None
    clock_period_ns: float = 10.0
    reset_port: Optional[str] = None
    reset_active_high: bool = True
    reset_cycles: int = 2
    stimuli: List[Stimulus] = field(default_factory=list)
    constant_inputs: Dict[str, Any] = field(default_factory=dict)
    generics: Dict[str, Any] = field(default_factory=dict)
    testbench_name: Optional[str] = None
    models: List[Dict[str, Any]] = field(default_factory=list)

    __test__ = False  # not a pytest test class

    def as_dict(self) -> dict:
        return {
            "durationNs": self.duration_ns,
            "clockPort": self.clock_port,
            "clockPeriodNs": self.clock_period_ns,
            "resetPort": self.reset_port,
            "resetActiveHigh": self.reset_active_high,
            "resetCycles": self.reset_cycles,
            "stimuli": [s.as_dict() for s in self.stimuli],
            "constantInputs": dict(self.constant_inputs),
            "generics": dict(self.generics),
        }


def stimulus_from_dict(data: dict) -> Stimulus:
    return Stimulus(
        port=str(data.get("port", "")),
        kind=str(data.get("kind", "constant")),
        value=data.get("value", 0),
        values=list(data.get("values", []) or []),
        period_cycles=max(1, int(data.get("periodCycles", 1) or 1)),
        pulse_cycles=max(1, int(data.get("pulseCycles", 1) or 1)),
        hold_cycles=max(1, int(data.get("holdCycles", data.get("pulseCycles", 1)) or 1)),
    )


# ---------------------------------------------------------------------------
# VHDL emission helpers
# ---------------------------------------------------------------------------


_ALLOWED_EXPR_NODES = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.Constant,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.FloorDiv,
    ast.Mod,
    ast.Pow,
    ast.USub,
    ast.UAdd,
)


def _eval_const_expr(text: str, generics: Dict[str, Any]) -> Optional[int]:
    """Evaluate a locally-static expression such as ``WIDTH-1``."""

    def substitute(match: re.Match) -> str:
        name = match.group(0)
        if name in generics:
            try:
                return str(int(generics[name]))
            except (TypeError, ValueError):
                return name
        return name

    substituted = re.sub(r"\b[A-Za-z_]\w*\b", substitute, text)
    try:
        tree = ast.parse(substituted, mode="eval")
        for node in ast.walk(tree):
            if not isinstance(node, _ALLOWED_EXPR_NODES):
                return None
        value = eval(compile(tree, "<testbench>", "eval"), {"__builtins__": {}}, {})  # noqa: S307
        return int(value)
    except (SyntaxError, TypeError, ValueError, ZeroDivisionError):
        return None


def _resolve_type(port: Port, generics: Dict[str, Any]) -> Optional[str]:
    """Resolve generic-dependent vector ranges for the testbench signals."""
    if not generics or port.type_name not in _VECTOR_TYPES:
        return None
    match = re.search(r"\((.*)\)\s*$", port.type_text or "")
    if not match:
        return None
    parts = re.split(r"\s+(downto|to)\s+", match.group(1), maxsplit=1, flags=re.IGNORECASE)
    if len(parts) != 3:
        return None
    left = _eval_const_expr(parts[0], generics)
    right = _eval_const_expr(parts[2], generics)
    if left is None or right is None:
        return None
    return f"{port.type_name}({left} {parts[1].lower()} {right})"


def _resolve_port_width(port: Port, generics: Dict[str, Any]) -> int:
    if generics and port.type_name in _VECTOR_TYPES:
        match = re.search(r"\((.*)\)\s*$", port.type_text or "")
        if match:
            parts = re.split(r"\s+(downto|to)\s+", match.group(1), maxsplit=1, flags=re.IGNORECASE)
            if len(parts) == 3:
                left = _eval_const_expr(parts[0], generics)
                right = _eval_const_expr(parts[2], generics)
                if left is not None and right is not None:
                    return abs(left - right) + 1
    return port.width or 1


def _signal_declaration(port: Port, init: bool = False, type_text: Optional[str] = None) -> str:
    declaration_type = type_text or port.type_text or port.type_name
    if type_text is None and port.type_name == "integer" and port.left is not None and port.right is not None:
        direction = "to" if not port.downto else "downto"
        declaration_type = f"integer range {port.left} {direction} {port.right}"
    declaration = f"signal {port.name} : {declaration_type}"
    if init:
        if port.type_name == "integer":
            declaration += " := 0"
        elif port.type_name == "boolean":
            declaration += " := false"
        elif (port.width or 1) == 1:
            declaration += " := '0'"
        else:
            declaration += " := (others => '0')"
    return declaration + ";"


def _bit_literal(value: Any, width: int) -> str:
    if isinstance(value, str):
        text = value.strip()
        if text.lower().startswith("0x"):
            text = format(int(text, 16), f"0{width}b")
        elif text.lower().startswith("b"):
            text = text[1:]
        text = "".join(ch for ch in text if ch in "01xXzZwW")
        if not text:
            text = "0"
        if len(text) < width:
            text = text.rjust(width, "0")
        return f'"{text[-width:]}"'
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = 0
    if number < 0:
        number &= (1 << width) - 1
    return f'"{format(number, f"0{width}b")}"'


def _value_literal(port: Port, value: Any, width_override: Optional[int] = None) -> str:
    width = width_override if width_override is not None else (port.width or 1)
    if port.type_name in ("integer",):
        return str(int(value))
    if port.type_name in ("boolean",):
        return "true" if str(value).lower() in ("1", "true", "t") else "false"
    if width == 1:
        text = str(value).strip().upper()
        if text in ("0", "1", "X", "Z", "W", "L", "H", "U", "-"):
            return f"'{text}'"
        try:
            return f"'{int(value) & 1}'"
        except (TypeError, ValueError):
            return "'0'"
    return _bit_literal(value, width)


def _increment_statement(port: Port, signal_name: Optional[str] = None) -> str:
    name = signal_name or port.name
    if port.type_name == "std_logic_vector":
        return f"{name} <= std_logic_vector(unsigned({name}) + 1);"
    if port.type_name in ("unsigned", "signed", "integer"):
        return f"{name} <= {name} + 1;"
    return f"{name} <= not {name};"


def _wait_cycles(cycles: int, clock: Optional[Port]) -> str:
    if clock is not None:
        return f"wait for {cycles} * CLK_PERIOD;"
    return f"wait for {cycles} * STEP_TIME;"


def _generic_literal(generic, values: Dict[str, Any]) -> Optional[str]:
    """Render a generic's value as a VHDL constant declaration.

    The auto-testbench declares signals using the entity's constrained types
    (e.g. ``unsigned(WIDTH-1 downto 0)``), so the generic must exist as a
    constant in the testbench scope or analysis fails with "no declaration".
    """
    if generic.name in values:
        value = values[generic.name]
    elif generic.default is not None:
        value = generic.default
    else:
        return None

    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    text = str(value).strip()
    if re.fullmatch(r"[-+]?\d+", text):
        return text
    if re.fullmatch(r"[-+]?\d*\.\d+(?:[eE][-+]?\d+)?", text):
        return text
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return text
    if re.fullmatch(r"'.'", text):
        return text
    if generic.type_name == "character":
        return f"'{text[:1]}'" if text else "' '"
    if generic.type_name in ("string",):
        return f'"{text}"'
    # time/real/integer-style defaults (e.g. "5 us") must stay unquoted
    if generic.type_name in ("time", "real", "integer", "natural", "positive", "boolean"):
        return text
    if re.fullmatch(r"[A-Za-z_]\w*", text):
        return text
    return f'"{text}"'


def generate_testbench(entity: Entity, config: TestbenchConfig,
                       notes: Optional[List[dict]] = None) -> str:
    """Return the VHDL source of an automatically generated testbench.

    ``notes`` optionally collects user-facing warning dicts produced while
    generating (e.g. multiple clock inputs driven with the same period).
    """
    clock = next((p for p in entity.ports if p.name == config.clock_port), None) if config.clock_port else None
    reset = next((p for p in entity.ports if p.name == config.reset_port), None) if config.reset_port else None

    if clock is None:
        clock = detect_clock(entity)
    # Drive EVERY clock input: a design with a second, undriven clock would
    # simulate with that whole domain frozen at '0' (audit probe K).
    clocks = detect_clocks(entity)
    if clock is not None and all(c.name != clock.name for c in clocks):
        clocks.insert(0, clock)
    if notes is not None and len(clocks) > 1:
        names = ", ".join(c.name for c in clocks)
        notes.append({
            "file": "testbench", "line": 0, "column": 0, "severity": "warning",
            "message": (
                f"{len(clocks)} clock inputs detected ({names}); the auto "
                f"testbench drives all of them with the same "
                f"{max(0.1, float(config.clock_period_ns)):g} ns period. Use a "
                "custom testbench for independent clock domains."
            ),
        })
    if reset is None and config.reset_port is None:
        detected = detect_reset(entity)
        if detected:
            reset, config.reset_active_high = detected

    # The generated testbench must not drive output ports.
    driven = {p.name for p in entity.inputs}

    # Ports owned by an on-board device model (EEPROM/LM75/PS2/LCD/IR) are
    # driven by that model; the testbench must not add a second driver.
    model_ports = set()
    for model in config.models:
        for key in ("clock", "data", "scl", "sda", "ir", "rs", "rw", "e"):
            if key in model:
                model_ports.add(str(model[key]).lower())

    stimuli: Dict[str, Stimulus] = {}
    for item in config.stimuli:
        if item.port in driven:
            stimuli[item.port] = item
    for name, value in config.constant_inputs.items():
        if name in driven:
            stimuli[name] = Stimulus(port=name, kind="constant", value=value)
    clock_names = {c.name for c in clocks}
    for port in entity.inputs:
        if port.name in driven and port.name not in stimuli and port.name not in clock_names and port.name != (reset.name if reset else None):
            if port.name.lower() in model_ports:
                continue   # the device model drives this pin
            stimuli[port.name] = Stimulus(port=port.name, kind="constant", value=0)

    top = config.testbench_name or f"tb_{entity.name}"

    period = max(0.1, float(config.clock_period_ns))
    duration = max(period, float(config.duration_ns))
    reset_cycles = max(0, int(config.reset_cycles))
    reset_time = reset_cycles * period if reset else 0.0
    active_time = max(period, duration - reset_time)

    lines: List[str] = []
    lines.append("-- Auto-generated testbench for Cyclone IV simulator")
    lines.append(f"-- Entity: {entity.name}")
    lines.append("library ieee;")
    lines.append("use ieee.std_logic_1164.all;")
    lines.append("use ieee.numeric_std.all;")
    lines.append("")
    lines.append(f"entity {top} is")
    lines.append(f"end entity {top};")
    lines.append("")
    lines.append(f"architecture sim of {top} is")

    # RZ-EasyFPGA A2.2 on-board devices: model-side signals and overrides
    model_decls: List[str] = []
    model_insts: List[str] = []
    port_overrides: Dict[str, str] = {}
    for model in config.models:
        kind = model["kind"]
        if kind == "i2c_eeprom":
            # EEPROM bus: I2C_SCL(99)/I2C_SDA(98), pull-ups R25/R26 5.1k.
            scl_b = model["scl"] + "_bus"
            sda_b = model["sda"] + "_bus"
            model_decls += [f"    signal {scl_b} : std_logic := 'H';",
                            f"    signal {sda_b} : std_logic := 'H';"]
            port_overrides[model["scl"].lower()] = scl_b
            port_overrides[model["sda"].lower()] = sda_b
            # board_spec.md §0d: WP (U8 pin 7) is tied to VCC on the A2.2, so
            # the real EEPROM is write-protected — model the same, derived
            # from the board.json writeProtected fact (not a literal).
            wp = "1" if BOARD["i2c"]["eeprom"].get("writeProtected", True) else "0"
            model_insts += [
                f"    {scl_b} <= 'H';   -- EEPROM bus pull-ups (R25/R26)",
                f"    {sda_b} <= 'H';",
                f"    u_eeprom : entity work.at24c08 port map (scl => {scl_b}"
                          + f", sda => {sda_b}, wp => '{wp}');",
            ]
        elif kind == "i2c_lm75":
            # LM75 bus: FPGA_SCL(112)/FPGA_SDA(113), pull-ups R27/R28 5.1k.
            scl_b = model["scl"] + "_bus"
            sda_b = model["sda"] + "_bus"
            model_decls += [f"    signal {scl_b} : std_logic := 'H';",
                            f"    signal {sda_b} : std_logic := 'H';"]
            port_overrides[model["scl"].lower()] = scl_b
            port_overrides[model["sda"].lower()] = sda_b
            model_insts += [
                f"    {scl_b} <= 'H';   -- LM75 bus pull-ups (R27/R28)",
                f"    {sda_b} <= 'H';",
                "    u_lm75 : entity work.lm75 generic map (TEMPERATURE => "
                          + str(model["lm75"]["temperature"]) + ") port map (scl => " + scl_b
                          + ", sda => " + sda_b
                          + ", ambient_c => " + str(int(float(model["lm75"]["temperature"]))) + ");",
            ]
        elif kind == "ps2":
            clk_b = model["clock"] + "_bus"
            dat_b = model["data"] + "_bus"
            model_decls += [f"    signal {clk_b} : std_logic := 'Z';",
                            f"    signal {dat_b} : std_logic := 'Z';"]
            port_overrides[model["clock"].lower()] = clk_b
            port_overrides[model["data"].lower()] = dat_b
            model_insts += [
                f"    {clk_b} <= 'H';   -- PS/2 pull-ups",
                f"    {dat_b} <= 'H';",
                "    u_ps2 : entity work.ps2_keyboard port map (ps_clock => " + clk_b
                          + ", ps_data => " + dat_b + ");",
            ]
        elif kind == "lcd":
            d_b = model["data"] + "_bus"
            model_decls += [f"    signal {d_b} : std_logic_vector(7 downto 0) := (others => 'Z');"]
            port_overrides[model["data"].lower()] = d_b
            model_insts += [
                "    u_lcd : entity work.hd44780 port map (lcd_rs => " + model["rs"]
                          + ", lcd_rw => " + model["rw"] + ", lcd_e => " + model["e"]
                          + ", lcd_d => " + d_b + ");",
            ]
        elif kind == "ir":
            ir_b = model["ir"] + "_bus"
            model_decls += [f"    signal {ir_b} : std_logic := 'Z';"]
            port_overrides[model["ir"].lower()] = ir_b
            model_insts += [
                f"    {ir_b} <= 'H';   -- IR receiver output idles high",
                "    u_ir : entity work.ir_nec port map (ir => " + ir_b + ");",
            ]

    for decl in model_decls:
        lines.append(decl)
    if model_decls:
        lines.append("")

    # Generics must be visible to the testbench itself because the signal
    # declarations below use the entity's constrained types.
    effective_generics: Dict[str, Any] = {}
    for generic in entity.generics:
        if generic.name in config.generics:
            effective_generics[generic.name] = config.generics[generic.name]
        elif generic.default is not None:
            effective_generics[generic.name] = generic.default
        literal = _generic_literal(generic, config.generics)
        if literal is not None:
            lines.append(f"    constant {generic.name} : {generic.type_text} := {literal};")

    type_by_port = {port.name: _resolve_type(port, effective_generics) for port in entity.ports}
    width_by_port = {port.name: _resolve_port_width(port, effective_generics) for port in entity.ports}
    for port in entity.ports:
        lines.append("    " + _signal_declaration(port, init=port.name in driven, type_text=type_by_port[port.name]))

    lines.append(f"    constant CLK_PERIOD : time := {period:g} ns;")
    lines.append("    constant STEP_TIME : time := 10 ns;")
    lines.append("    signal sim_done : boolean := false;")
    lines.append("begin")

    # DUT instantiation -----------------------------------------------------
    lines.append(f"    uut : entity work.{entity.name}")
    has_generic_map = False
    if entity.generics and config.generics:
        entries: List[str] = []
        for gen in entity.generics:
            if gen.name not in config.generics:
                continue
            rendered = _generic_literal(gen, config.generics)
            if rendered is not None:
                entries.append(f"            {gen.name} => {rendered}")
        if entries:
            lines.append("        generic map (")
            lines.append(",\n".join(entries))
            lines.append("        )")
            has_generic_map = True

    if entity.ports:
        lines.append("        port map (")
        port_lines = []
        for p_ in entity.ports:
            signal_name = port_overrides.get(p_.name.lower(), p_.name)
            port_lines.append(f"            {p_.name} => {signal_name}")
        lines.append(",\n".join(port_lines))
        lines.append("        );")
        for inst in model_insts:
            lines.append(inst)
        if model_insts:
            lines.append("")
    elif has_generic_map:
        lines[-1] += ";"
    else:
        lines[-1] += ";"
    lines.append("")

    # Clock generation ------------------------------------------------------
    # One independent 50 %-duty process per clock input.
    for clk_index, clk_port in enumerate(clocks):
        label = "clk_gen" if clk_index == 0 else f"clk_gen_{clk_index}"
        lines.append(f"    {label} : process")
        lines.append("    begin")
        lines.append("        while not sim_done loop")
        lines.append(f"            {clk_port.name} <= '0';")
        lines.append("            wait for CLK_PERIOD / 2;")
        lines.append(f"            {clk_port.name} <= '1';")
        lines.append("            wait for CLK_PERIOD / 2;")
        lines.append("        end loop;")
        lines.append("        wait;")
        lines.append(f"    end process {label};")
        lines.append("")

    # Reset generation ------------------------------------------------------
    if reset is not None:
        assert_value = "'1'" if config.reset_active_high else "'0'"
        release_value = "'0'" if config.reset_active_high else "'1'"
        lines.append("    reset_gen : process")
        lines.append("    begin")
        lines.append(f"        {reset.name} <= {assert_value};")
        lines.append(f"        wait for {reset_cycles} * CLK_PERIOD;")
        lines.append(f"        {reset.name} <= {release_value};")
        lines.append("        wait;")
        lines.append("    end process reset_gen;")
        lines.append("")

    # Stimulus processes ----------------------------------------------------
    for port in entity.inputs:
        if port.name in clock_names:
            continue  # driven by its own clk_gen process
        if port.name == (reset.name if reset else None):
            continue
        stimulus = stimuli.get(port.name)
        if stimulus is None:
            continue

        # When a board-device model overrides the port (e.g. PS_DATA is
        # connected to PS_DATA_bus so the model and the user stimulus share
        # the same resolved bus), the stimulus must drive the *bus* signal —
        # driving the original port-named signal would write to a shadow
        # signal connected to nothing (audit M6).
        signal_name = port_overrides.get(port.name.lower(), port.name)
        port_w = width_by_port.get(port.name, port.width or 1)

        if stimulus.kind == "constant":
            lines.append(f"    {signal_name} <= {_value_literal(port, stimulus.value, port_w)};")
            continue

        lines.append(f"    stim_{port.name} : process")
        lines.append("    begin")
        if reset_time:
            lines.append(f"        wait for {reset_cycles} * CLK_PERIOD;")
        if clock is not None:
            lines.append(f"        wait until rising_edge({clock.name});")

        if stimulus.kind == "toggle":
            lines.append("        loop")
            lines.append(f"            {_increment_statement(port, signal_name)}")
            lines.append(f"            {_wait_cycles(max(1, stimulus.period_cycles), clock)}")
            lines.append("        end loop;")
        elif stimulus.kind == "pulse":
            pulse = max(1, stimulus.pulse_cycles)
            period_cycles = max(pulse + 1, stimulus.period_cycles)
            lines.append("        loop")
            lines.append(f"            {signal_name} <= {_value_literal(port, 1, port_w)};")
            lines.append(f"            wait for {pulse} * CLK_PERIOD;")
            lines.append(f"            {signal_name} <= {_value_literal(port, 0, port_w)};")
            lines.append(f"            wait for {period_cycles - pulse} * CLK_PERIOD;")
            lines.append("        end loop;")
        elif stimulus.kind == "sequence":
            values = list(stimulus.values)
            if not values:
                values = [stimulus.value, 0]
            lines.append("        loop")
            for value in values:
                lines.append(f"            {signal_name} <= {_value_literal(port, value, port_w)};")
                lines.append(f"            {_wait_cycles(max(1, stimulus.period_cycles), clock)}")
            lines.append("        end loop;")
        elif stimulus.kind == "pulse_once":
            # One press followed by a permanent release — used to model a key
            # press+release without a multi-second simulation. The release edge
            # starts the design's own countdown (e.g. buzz1's 1 s timer).
            seq = list(stimulus.values) or [stimulus.value, 0]
            first = seq[0]
            second = seq[1] if len(seq) > 1 else 0
            lines.append(f"        {signal_name} <= {_value_literal(port, first, port_w)};")
            lines.append(f"        wait for {max(1, stimulus.hold_cycles)} * CLK_PERIOD;")
            lines.append(f"        {signal_name} <= {_value_literal(port, second, port_w)};")
            lines.append("        wait;")
        else:
            lines.append(f"        {signal_name} <= {_value_literal(port, stimulus.value, port_w)};")
            lines.append("        wait;")

        lines.append("    end process;")
        lines.append("")

    # Simulation control ----------------------------------------------------
    lines.append("    sim_control : process")
    lines.append("    begin")
    lines.append(f"        wait for {duration:g} ns;")
    lines.append("        sim_done <= true;")
    lines.append("        wait;")
    lines.append("    end process sim_control;")
    lines.append("")
    lines.append(f"end architecture sim;")
    lines.append("")

    return "\n".join(lines)


def detect_top_entity(source: str, requested: Optional[str] = None) -> tuple[Optional[str], List[dict]]:
    """Return the top entity name for a source file.

    If *requested* is given it is returned as-is (the caller is responsible for
    its validity).  Otherwise the first entity that is not a testbench is used.
    """
    design = VHDLParser().parse(source)
    if requested:
        return requested, design.errors
    if not design.entities:
        return None, design.errors
    for entity in design.entities:
        if not entity.name.lower().startswith("tb_"):
            return entity.name, design.errors
    return design.entities[0].name, design.errors


__all__ = [
    "Stimulus",
    "TestbenchConfig",
    "detect_clock",
    "detect_clocks",
    "detect_reset",
    "detect_top_entity",
    "generate_testbench",
    "stimulus_from_dict",
]