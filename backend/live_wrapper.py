"""VHDL-2008 live-stepping co-simulation wrapper generator.

Generates a wrapper entity that instantiates the user design and talks over
``std.textio`` (``readline(input)`` / ``writeline(output, l)`` + VHDL-2008
``flush(output)``) so it runs natively on the bundled GHDL 6.0.0 (mcode)
binary with zero external C compiler/DLL dependencies.

Wire protocol (fixed-width fields, trivial to parse in VHDL):

stdin commands (one per line):
    S<iii><bb><v>         drive input port #<iii>, bit <bb> (2 digits), to <v>
    I<iii><s><vvvvvvvv>   drive integer input #<iii> to <+/-><magnitude>
    T<nnnnnnn>            step <n> clock cycles (state persists!), then
                          emit one telemetry frame on stdout
    U<baud8><hex2>        bit-bang one 8N1 UART frame onto the RXD pin
    P<hex2>               bit-bang one PS/2 scancode frame (device-clocked)
    R<addr2><cmd2>        bit-bang one NEC IR frame (active-low bursts)
    M<s><magnitude8>      set the live LM75 ambient temperature (°C, signed)
    Q                     quit (process ends cleanly)

Telemetry frame (several stdout lines, terminated by "END"):
    F <sim_time_ns>
    N <cycles_in_frame>
    V <port>=<metachars>          final value of every output port, one char
                                  per bit: U X 0 1 Z W L H -  (no coercion)
    D <port> <p0>,<p1>,...        per-bit high-duty permille over the frame
                                  (exact within-frame integration)
    B <toggles> <active_cycles>   buzzer pin toggles + active (low) cycles
    L <rs> <rw> <db>              HD44780 E falling-edge bus event
    END

Sampling discipline (zero off-by-one): input commands take effect with a
1 ns settle wait, and the frame integrates the output pins sampled at every
FALLING clock edge (mid-cycle, stable for synchronous outputs) across the N
edges of the frame.  Simulated time freezes while the wrapper blocks on
``readline`` — the design does not run away between frames.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional

from .vhdl_parser import Entity, Port

_MAX_TRACK_BITS = 256
_MAX_LCD_EVENTS_PER_FRAME = 64
_MAX_STEP_DIGITS = 7


def _sn(name: str) -> str:
    """VHDL-safe identifier for a port name."""
    out = []
    for ch in name:
        out.append(ch if (ch.isalnum() or ch == "_") else "_")
    text = "".join(out)
    if not text or text[0].isdigit():
        text = "p_" + text
    return text.lower()


class LiveWrapperBuildError(RuntimeError):
    """Raised when a design cannot be wrapped for live stepping."""


def _is_std(port: Port) -> bool:
    return (port.type_name or "").lower() in ("std_logic", "std_logic_vector")


def _is_trackable(port: Port) -> bool:
    """Outputs we can bit-sample: std_logic-based vectors and scalars."""
    return (port.type_name or "").lower() in ("std_logic", "std_logic_vector",
                                              "unsigned", "signed")


def _sl(expr: str, port: Port) -> str:
    """Wrap an unsigned/signed expression into std_logic_vector."""
    if (port.type_name or "").lower() in ("unsigned", "signed"):
        return f"std_logic_vector({expr})"
    return expr


def build_live_wrapper(
    entity: Entity,
    clock_port: str,
    clock_period_ns: float,
    buzzer_port: Optional[str] = None,
    buzzer_bit: int = 0,
    lcd_ports: Optional[dict] = None,
    seg_dig_map: Optional[dict] = None,
    live_peripherals: Optional[dict] = None,
) -> dict:
    """Generate the live-stepping wrapper VHDL for ``entity``.

    Returns ``{"vhdl": str, "inputs": [port names], "int_inputs": [...],
    "outputs": [port names], "widths": {port: width}, "total_bits": int,
    "buzzer_index": int|None, "entity": entity.name}`` — the bridge needs the
    layout to decode frames and to map semantic inputs onto indices.
    """
    if not entity.ports:
        raise LiveWrapperBuildError("design has no ports to wrap")
    clock = next((p for p in entity.ports if p.name.lower() == clock_port.lower()), None)
    if clock is None or clock.direction != "in" or not _is_std(clock):
        raise LiveWrapperBuildError(f"clock input '{clock_port}' not found")

    inputs = [p for p in entity.ports if p.is_input and _is_std(p) and p is not clock]
    int_inputs = [p for p in entity.ports if p.is_input
                  and (p.type_name or "").lower() in ("integer", "natural", "positive")]
    outputs = [p for p in entity.ports if (not p.is_input) and _is_trackable(p)]
    total_bits = sum(p.width or 1 for p in outputs)
    if total_bits > _MAX_TRACK_BITS:
        raise LiveWrapperBuildError(
            f"design exposes {total_bits} output bits; live mode tracks up to {_MAX_TRACK_BITS}")

    # Observed-vector layout: (port, bit_index_within_port, flat_index).
    layout: List[tuple] = []
    for p in outputs:
        w = p.width or 1
        for b in range(w):
            layout.append((p, b, len(layout)))

    buzzer_index = None
    if buzzer_port:
        for p, b, flat in layout:
            if p.name.lower() == buzzer_port.lower() and b == buzzer_bit:
                buzzer_index = flat
                break

    lcd = lcd_ports or {}
    lcd_e = lcd.get("e")
    lcd_rs = lcd.get("rs")
    lcd_rw = lcd.get("rw")
    lcd_data = lcd.get("data")
    port_lowers = {p.name.lower() for p in entity.ports}
    has_lcd = bool(lcd_e and lcd_rs and lcd_data
                   and str(lcd_e).lower() in port_lowers
                   and str(lcd_rs).lower() in port_lowers
                   and str(lcd_data).lower() in port_lowers)

    # DIG×SEG coincidence tracking: the wrapper counts, per (digit, segment)
    # cell, the clock cycles where BOTH lines are active — the exact POV duty
    # a real multiplexed display integrates (dimming, flicker, ghosting).
    sdm = seg_dig_map or {}
    seg_port = sdm.get("seg_port")
    dig_port = sdm.get("dig_port")
    seg_act = "'1'" if sdm.get("seg_active_high") else "'0'"
    dig_act = "'1'" if sdm.get("dig_active_high") else "'0'"
    n_dig = int(sdm.get("n_dig", 4))
    n_seg = int(sdm.get("n_seg", 8))
    has_coin = bool(seg_port and dig_port
                    and seg_port.lower() in port_lowers
                    and dig_port.lower() in port_lowers)
    n_coin = n_dig * n_seg
    # Clamp the sampling loops to the ports' actual widths (a 7-bit SEG port
    # must not sample bit 7 — GHDL raises a runtime bound-check failure).
    if has_coin:
        _seg_p = next(p for p in entity.ports if p.name.lower() == seg_port.lower())
        _dig_p = next(p for p in entity.ports if p.name.lower() == dig_port.lower())
        coin_dig_w = max(1, min(n_dig, _dig_p.width or 1))
        coin_seg_w = max(1, min(n_seg, _seg_p.width or 1))
    else:
        coin_dig_w = coin_seg_w = 0

    # Live peripheral injection/capture wiring (Phase 5).
    lp = live_peripherals or {}
    uart_rx_port = lp.get("uart_rx_port")
    uart_tx_port = lp.get("uart_tx_port")
    ps2_clk_port = lp.get("ps2_clk_port")
    ps2_data_port = lp.get("ps2_data_port")
    ir_port = lp.get("ir_port")
    i2c_buses = lp.get("i2c_buses") or []
    vga_ports = lp.get("vga_ports") or {}
    vga_hs = vga_ports.get("hs")
    vga_vs = vga_ports.get("vs")
    vga_r = vga_ports.get("r")
    vga_g = vga_ports.get("g")
    vga_b = vga_ports.get("b")

    # Name-based fallback: when the pin-map route is missing (a design may
    # name its ports vga_hs instead of VGA_HSYNC), resolve by port-name
    # pattern against the entity interface.
    def _resolve_port(patterns, current, direction=None):
        if current and str(current).lower() in port_lowers:
            return current
        for p in entity.ports:
            if direction == "in" and not p.is_input:
                continue
            if direction == "out" and p.is_input:
                continue
            for pat in patterns:
                if re.search(pat, p.name, re.IGNORECASE):
                    return p.name
        return None

    uart_rx_port = _resolve_port([r"uart_rxd", r"(^|_)rxd"], uart_rx_port, "in")
    uart_tx_port = _resolve_port([r"uart_txd", r"(^|_)txd"], uart_tx_port, "out")
    ps2_clk_port = _resolve_port([r"ps_clock", r"ps_clk"], ps2_clk_port, "in")
    ps2_data_port = _resolve_port([r"ps_data"], ps2_data_port, "in")
    ir_port = _resolve_port([r"^ir$", r"_ir$", r"^ir_"], ir_port, "in")
    vga_hs = _resolve_port([r"vga_hs", r"vga_hsync"], vga_hs, "out")
    vga_vs = _resolve_port([r"vga_vs", r"vga_vsync"], vga_vs, "out")
    vga_r = _resolve_port([r"vga_r"], vga_r, "out")
    vga_g = _resolve_port([r"vga_g"], vga_g, "out")
    vga_b = _resolve_port([r"vga_b"], vga_b, "out")

    has_uart_rx = bool(uart_rx_port and uart_rx_port.lower() in port_lowers)
    has_uart_tx = bool(uart_tx_port and uart_tx_port.lower() in port_lowers)
    has_ps2 = bool(ps2_clk_port and ps2_data_port
                   and ps2_clk_port.lower() in port_lowers
                   and ps2_data_port.lower() in port_lowers)
    has_ir = bool(ir_port and ir_port.lower() in port_lowers)
    # VGA (8-color): track HSYNC/VSYNC/RGB lines when all five pins exist.
    has_vga = all(x and x.lower() in port_lowers
                  for x in (vga_hs, vga_vs, vga_r, vga_g, vga_b))
    # I²C buses whose ports exist on the design (model + 'H' pull-up wiring).
    i2c_wired = []
    for bus in i2c_buses:
        scl, sda = bus.get("scl_port"), bus.get("sda_port")
        if scl and sda and scl.lower() in port_lowers and sda.lower() in port_lowers:
            i2c_wired.append(bus)
    # Ports tied to a model bus are resolved by the bus itself — they are not
    # S-command targets (a pushed level would fight the open-drain bus).
    bus_port_lowers = {b.lower() for bus in i2c_wired
                       for b in (bus.get("scl_port"), bus.get("sda_port"))}
    inputs = [p for p in inputs if p.name.lower() not in bus_port_lowers]

    sn = {p.name: _sn(p.name) for p in entity.ports}
    lines: List[str] = []
    add = lines.append

    add("-- Auto-generated live-stepping co-simulation wrapper (Cyclone IV Studio).")
    add("-- Driven over stdin/stdout textio; see backend/live_wrapper.py.")
    add("library ieee;")
    add("use ieee.std_logic_1164.all;")
    add("use ieee.numeric_std.all;")
    add("use std.textio.all;")
    add("")
    add(f"entity live_{_sn(entity.name)} is")
    add("end entity;")
    add("")
    add(f"architecture sim of live_{_sn(entity.name)} is")
    add("    constant CLK_HALF : time := %.4f ns;" % (float(clock_period_ns) / 2.0))
    # Time-split constants for overflow-free timestamps (see F-line note):
    # integer(now / 1 ns) overflows the 32-bit VHDL integer at 2^31 ns
    # (~2.147 s of simulated time) and aborts every long live session.
    add("    constant ONE_S  : time := 1000000000 ns;")
    add("    constant ONE_NS : time := 1 ns;")
    add("    signal clk   : std_logic := '0';")
    add("    signal done  : boolean := false;")
    for p in entity.ports:
        lname = p.name.lower()
        if p.direction == "inout":
            default = "(others => 'Z')" if (p.width or 1) > 1 else "'Z'"
        elif p.is_input and (lname in ("ps_clock", "ps_data", "ir") or lname.endswith(("rxd", "_rxd"))
                             or lname in ("ps_clk", "ir_in")):
            default = "'1'"   # idle-high peripherals (PS/2, IR, UART RX)
        elif not p.is_input and uart_tx_port and lname == str(uart_tx_port).lower():
            default = "'1'"   # UART TX idles high
        elif (p.width or 1) == 1:
            default = "'0'"
        else:
            default = "(others => '0')"
        add(f"    signal p_{sn[p.name]} : {p.type_text} := {default};")
    for p in int_inputs:
        add(f"    signal p_{sn[p.name]} : {p.type_text} := 0;")
    # I²C model buses (open-drain 'H' pull-ups, same wiring as the batch TB):
    # the DUT port connects straight to the resolved bus signal.
    ambient_signals = []
    ambient_by_bus = {}
    for bus in i2c_wired:
        ssn, dsn = _sn(bus["scl_port"]), _sn(bus["sda_port"])
        add(f"    signal bus_{ssn} : std_logic := 'H';")
        add(f"    signal bus_{dsn} : std_logic := 'H';")
        if str(bus.get("model", "")).lower() == "lm75":
            ambient = f"ambient_{ssn}"
            add(f"    signal {ambient} : integer := {int(bus.get('temperature', 25))};")
            ambient_signals.append((bus, ambient))
            ambient_by_bus[id(bus)] = ambient
    if has_vga:
        add("    signal vga_tracked : std_logic_vector(4 downto 0) := (others => '0');")
    if total_bits:
        add(f"    signal obs : std_logic_vector(0 to {total_bits - 1});")
    if has_lcd:
        add("    signal lcd_e_prev : std_logic := '0';")

    # Meta-string + parsing helpers live in the architecture declarative
    # region (VHDL requires them before `begin`).
    helpers: List[str] = []
    hadd = helpers.append
    hadd("")
    hadd("    function metastr(v : std_logic_vector) return string is")
    hadd("        variable s : string(1 to v'length);")
    hadd("    begin")
    hadd("        for i in v'range loop")
    hadd("            -- abs(i - v'left) = position from the left edge, valid")
    hadd("            -- for both ascending and descending ranges.")
    hadd("            s(1 + abs(i - v'left)) := std_logic'image(v(i))(2);")
    hadd("        end loop;")
    hadd("        return s;")
    hadd("    end function;")
    hadd("")
    hadd("    function dig(s : string; pos : natural) return integer is")
    hadd("    begin")
    hadd("        if pos <= s'length and s(pos) >= '0' and s(pos) <= '9' then")
    hadd("            return character'pos(s(pos)) - character'pos('0');")
    hadd("        end if;")
    hadd("        return 0;")
    hadd("    end function;")
    hadd("")
    hadd("    function num(s : string; from : natural; len : natural) return integer is")
    hadd("        variable v : integer := 0;")
    hadd("    begin")
    hadd("        for j in from to from + len - 1 loop")
    hadd("            v := v * 10 + dig(s, j);")
    hadd("        end loop;")
    hadd("        return v;")
    hadd("    end function;")
    hadd("")
    hadd("    function hexd(c : character) return integer is")
    hadd("    begin")
    hadd("        if c >= '0' and c <= '9' then")
    hadd("            return character'pos(c) - character'pos('0');")
    hadd("        end if;")
    hadd("        if c >= 'a' and c <= 'f' then")
    hadd("            return character'pos(c) - character'pos('a') + 10;")
    hadd("        end if;")
    hadd("        if c >= 'A' and c <= 'F' then")
    hadd("            return character'pos(c) - character'pos('A') + 10;")
    hadd("        end if;")
    hadd("        return 0;")
    hadd("    end function;")
    hadd("")
    hadd("    function hexbyte(s : string; pos : natural) return integer is")
    hadd("    begin")
    hadd("        return hexd(s(pos)) * 16 + hexd(s(pos + 1));")
    hadd("    end function;")
    add("\n".join(helpers))
    add("begin")
    add("")
    add("    clk <= not clk after CLK_HALF when not done else '0';")
    add("")
    add(f"    uut : entity work.{entity.name}")
    if entity.ports:
        add("        port map (")
        # The clock port is driven by the wrapper's own toggling clock; the
        # I²C bus ports connect to the resolved open-drain bus signals; the
        # S-command input signals drive everything else.
        bus_by_port = {}
        for bus in i2c_wired:
            bus_by_port[bus["scl_port"].lower()] = f"bus_{_sn(bus['scl_port'])}"
            bus_by_port[bus["sda_port"].lower()] = f"bus_{_sn(bus['sda_port'])}"
        pm = []
        for p in entity.ports:
            if p is clock:
                driver = "clk"
            elif p.name.lower() in bus_by_port:
                driver = bus_by_port[p.name.lower()]
            else:
                driver = f"p_{sn[p.name]}"
            pm.append(f"            {p.name} => {driver}")
        add(",\n".join(pm))
        add("        );")
    if total_bits:
        for p, b, flat in layout:
            # Element/scalar accesses are std_logic already — no conversion.
            if (p.width or 1) == 1:
                add(f"    obs({flat}) <= p_{sn[p.name]};")
            else:
                add(f"    obs({flat}) <= p_{sn[p.name]}({b});")
    add("")

    # I²C device models on their open-drain buses ('H' pull-ups, exactly like
    # the batch testbench): the DUT is the master, the model responds.
    models_used = set()
    for bus in i2c_wired:
        ssn, dsn = _sn(bus["scl_port"]), _sn(bus["sda_port"])
        add(f"    bus_{ssn} <= 'H';   -- I²C pull-ups")
        add(f"    bus_{dsn} <= 'H';")
        if str(bus.get("model", "")).lower() == "lm75":
            models_used.add("lm75")
            temp = float(bus.get("temperature", 25) or 25)
            amb = ambient_by_bus.get(id(bus), "25")
            add(f"    u_lm75_{ssn} : entity work.lm75 generic map (TEMPERATURE => {temp})")
            add(f"        port map (scl => bus_{ssn}, sda => bus_{dsn}, ambient_c => {amb});")
        else:
            models_used.add("at24c08")
            add(f"    u_eeprom_{ssn} : entity work.at24c08")
            add(f"        port map (scl => bus_{ssn}, sda => bus_{dsn}, wp => '1');")
    add("")

    add("    main : process")
    add("        variable l        : line;")
    add("        variable buf      : string(1 to 256);")
    add("        variable blen     : natural := 0;")
    add("        variable n        : natural := 0;")
    add("        variable nv       : integer := 0;")
    add("        variable pi       : integer := 0;")
    add("        variable bi       : integer := 0;")
    add("        variable vi       : integer := 0;")
    if total_bits:
        add(f"        type intarr_t is array (0 to {total_bits - 1}) of integer;")
        add("        variable highv : intarr_t := (others => 0);")
    if has_coin:
        add(f"        type coinar_t is array (0 to {n_coin - 1}) of integer;")
        add("        variable coin : coinar_t := (others => 0);")
    add("        variable buzz_prev    : std_logic := 'U';")
    add("        variable buzz_toggles : integer := 0;")
    add("        variable buzz_active  : integer := 0;")
    if has_lcd:
        add("        variable lcd_events : integer := 0;")
    if has_uart_rx:
        add("        variable bit_time : time := 8680 ns;")
    if has_uart_rx or has_ps2 or has_ir:
        add("        variable bval  : integer := 0;")
        add("        variable pbit  : integer := 0;")
        add("        variable ones  : integer := 0;")
    if has_ir:
        add("        variable ir_addr : integer := 0;")
        add("        variable ir_cmd  : integer := 0;")
        add("        variable ir_byte : integer := 0;")
    if has_vga:
        add("        variable vs_now : std_logic := '0';")
        add("        variable hs_now : std_logic := '0';")
        add("        variable vs_prev : std_logic := '0';")
        add("        variable hs_prev : std_logic := '0';")
        add("        variable vga_line  : integer := 0;")
        add("        variable vga_slice : integer := 0;")
        add("        variable vga_col   : integer := 0;")
        add(f"        type vgasamp_t is array (0 to 7) of integer;")
        add("        variable vga_samp : vgasamp_t := (others => 0);")
    if has_uart_tx:
        add("        variable utx_prev  : std_logic := 'U';")
        add("        variable utx_now   : std_logic := 'U';")
        add("        variable utx_count : integer := 0;")
    add("    begin")
    add("        loop")
    add("            -- blocking readline: simulated time freezes while waiting")
    add("            -- for the next command (no runaway clock between frames)")
    add("            readline(input, l);")
    add("            blen := l'length;")
    add("            if blen > 256 then")
    add("                blen := 256;")
    add("            end if;")
    add("            for j in 1 to blen loop")
    add("                buf(j) := l(j);")
    add("            end loop;")
    add("            if l'length >= 1 and l(1) = 'S' then")
    add("                -- S<iii><bb><v>: drive one input bit")
    add("                pi := num(buf, 2, 3);")
    add("                bi := num(buf, 5, 2);")
    add("                vi := dig(buf, 7);")
    add("                if vi = 0 then")
    add("                    vi := 0;")
    add("                else")
    add("                    vi := 1;")
    add("                end if;")
    for i, p in enumerate(inputs):
        cond = "if" if i == 0 else "elsif"
        # Element index for value-bit `bi`: right + bi (downto) or
        # right - bi (ascending) — matches the value-bit convention.
        elem = f"{p.right} + bi" if p.downto else f"{p.right} - bi"
        if (p.width or 1) == 1:
            add(f"                {cond} pi = {i} then")
            add(f"                    p_{sn[p.name]} <= '1' when vi = 1 else '0';")
        else:
            add(f"                {cond} pi = {i} then")
            add("                    if vi = 1 then")
            add(f"                        p_{sn[p.name]}({elem}) <= '1';")
            add("                    else")
            add(f"                        p_{sn[p.name]}({elem}) <= '0';")
            add("                    end if;")
    if inputs:
        add("                end if;")
    add("                wait for 1 ns;  -- settle: the next frame sees the new input")
    add("            elsif l'length >= 1 and l(1) = 'I' then")
    add("                -- I<iii><s><magnitude>: drive an integer input")
    add("                pi := num(buf, 2, 3);")
    add("                nv := num(buf, 6, 8);")
    add("                if dig(buf, 5) = 1 then")
    add("                    nv := -nv;")
    add("                end if;")
    for i, p in enumerate(int_inputs):
        cond = "if" if i == 0 else "elsif"
        add(f"                {cond} pi = {1000 + i} then")
        add(f"                    p_{sn[p.name]} <= nv;")
    if int_inputs:
        add("                end if;")
    add("                wait for 1 ns;")
    add("            elsif l'length >= 1 and l(1) = 'T' then")
    add("                -- T<nnnnnnn>: advance n clock cycles, then report")
    add("                n := num(buf, 2, %d);" % _MAX_STEP_DIGITS)
    add("                if n > 0 then")
    if total_bits:
        add("                    for i in obs'range loop")
        add("                        highv(i) := 0;  -- per-frame duty window")
        add("                    end loop;")
    if has_coin:
        add("                    for i in coin'range loop")
        add("                        coin(i) := 0;  -- per-frame coincidence window")
        add("                    end loop;")
    add("                    for k in 1 to n loop")
    add("                        wait until falling_edge(clk);")
    if total_bits:
        add("                        for i in obs'range loop")
        add("                            if obs(i) = '1' then")
        add("                                highv(i) := highv(i) + 1;")
        add("                            end if;")
        add("                        end loop;")
    if has_coin:
        add(f"                        for dd in 0 to {coin_dig_w - 1} loop")
        add(f"                            for ss in 0 to {coin_seg_w - 1} loop")
        add(f"                                if p_{sn[dig_port]}(dd) = {dig_act} and p_{sn[seg_port]}(ss) = {seg_act} then")
        add(f"                                    coin(dd * {n_seg} + ss) := coin(dd * {n_seg} + ss) + 1;")
        add("                                end if;")
        add("                            end loop;")
        add("                        end loop;")
    if buzzer_index is not None:
        add(f"                        if obs({buzzer_index}) = '0' then")
        add("                            buzz_active := buzz_active + 1;")
        add("                        end if;")
        add(f"                        if buzz_prev /= obs({buzzer_index}) then")
        add("                            buzz_toggles := buzz_toggles + 1;")
        add(f"                            buzz_prev := obs({buzzer_index});")
        add("                        end if;")
    if has_lcd:
        add(f"                        if lcd_e_prev = '1' and to_x01(p_{sn[lcd_e]}) = '0' then")
        add("                            -- HD44780 strobe captured mid-burst")
        add("                            lcd_events := lcd_events + 1;")
        add("                            if lcd_events <= %d then" % _MAX_LCD_EVENTS_PER_FRAME)
        add("                            l := null;")
        add("                            write(l, string'(\"L \"));")
        add(f"                            write(l, std_logic'image(p_{sn[lcd_rs]})(2));")
        add("                            write(l, string'(\" \"));")
        add(f"                            write(l, std_logic'image(p_{sn[lcd_rw]})(2));")
        add("                            write(l, string'(\" \"));")
        add("                            nv := 0;")
        add("                            for i in 0 to 7 loop")
        add(f"                                if to_x01(p_{sn[lcd_data]}(i)) = '1' then")
        add("                                    nv := nv + 2 ** i;")
        add("                                end if;")
        add("                            end loop;")
        add("                            write(l, nv);")
        add("                            writeline(output, l);")
        add("                            end if;")
        add("                        end if;")
        add(f"                        lcd_e_prev <= to_x01(p_{sn[lcd_e]});")
    if has_vga:
        add(f"                        vs_now := to_x01(p_{sn[vga_vs]});")
        add(f"                        hs_now := to_x01(p_{sn[vga_hs]});")
        add("                        if vs_prev = '1' and vs_now = '0' then")
        add("                            vga_line := 0; vga_slice := 0;")
        add("                        end if;")
        add("                        if hs_prev = '1' and hs_now = '0' then")
        add("                            -- completed line: emit 8 packed 3-bit samples")
        add("                            if vga_slice >= 8 and vga_line < 525 then")
        add("                                vga_col := 0;")
        add("                                for s in 0 to 7 loop")
        add("                                    vga_col := vga_col * 8 + vga_samp(s);")
        add("                                end loop;")
        add("                                l := null;")
        add("                                write(l, string'(\"G \"));")
        add("                                write(l, vga_line);")
        add("                                write(l, string'(\" \"));")
        add("                                write(l, vga_col);")
        add("                                writeline(output, l);")
        add("                            end if;")
        add("                            vga_line := vga_line + 1;")
        add("                            vga_slice := 0;")
        add("                            for s in 0 to 7 loop")
        add("                                vga_samp(s) := 0;")
        add("                            end loop;")
        add("                        elsif vga_slice < 8 then")
        add("                            vga_samp(vga_slice) := 0;")
        add(f"                            if to_x01(p_{sn[vga_r]}) = '1' then vga_samp(vga_slice) := vga_samp(vga_slice) + 4; end if;")
        add(f"                            if to_x01(p_{sn[vga_g]}) = '1' then vga_samp(vga_slice) := vga_samp(vga_slice) + 2; end if;")
        add(f"                            if to_x01(p_{sn[vga_b]}) = '1' then vga_samp(vga_slice) := vga_samp(vga_slice) + 1; end if;")
        add("                            vga_slice := vga_slice + 1;")
        add("                        end if;")
        add("                        vs_prev := vs_now; hs_prev := hs_now;")
    if has_uart_tx:
        add(f"                        utx_now := to_x01(p_{sn[uart_tx_port]});")
        add("                        if utx_prev /= utx_now then")
        add("                            utx_count := utx_count + 1;")
        add("                            if utx_count <= 512 then")
        add("                                l := null;")
        add("                                write(l, string'(\"X \"));")
        add("                                write(l, integer(now / ONE_S));")
        add("                                write(l, string'(\" \"));")
        add("                                write(l, integer((now mod ONE_S) / ONE_NS));")
        add("                                write(l, string'(\" \"));")
        add("                                write(l, std_logic'image(utx_now)(2));")
        add("                                writeline(output, l);")
        add("                            end if;")
        add("                            utx_prev := utx_now;")
        add("                        end if;")
    add("                    end loop;")
    add("                end if;")
    # ----- frame emission -----
    add("                l := null;")
    add("                write(l, string'(\"F \"));")
    # Simulated time as TWO integers (seconds, ns-within-second).  A plain
    # integer(now / 1 ns) overflows the 32-bit VHDL integer once sim time
    # passes 2^31 ns (~2.147 s) — "ghdl:error: overflow detected" — killing
    # every long-running live session.  now / 1 ns stays integer-typed in
    # GHDL even through textio write(), so split it instead; the Python
    # frame reader reassembles exact nanoseconds as a double.
    add("                write(l, integer(now / ONE_S));")
    add("                write(l, string'(\" \"));")
    add("                write(l, integer((now mod ONE_S) / ONE_NS));")
    add("                writeline(output, l);")
    add("                write(l, string'(\"N \"));")
    add("                write(l, n);")
    add("                writeline(output, l);")
    for p in outputs:
        is_meta_vec = (p.width or 1) > 1 or (p.type_name or "").lower() in ("unsigned", "signed")
        if not is_meta_vec:
            add(f"                write(l, string'(\"V {p.name}=\" & std_logic'image(p_{sn[p.name]})(2)));")
        else:
            add(f"                write(l, string'(\"V {p.name}=\" & metastr({_sl(f'p_{sn[p.name]}', p)})));")
        add("                writeline(output, l);")
    if total_bits:
        add("                if n > 0 then")
        for p in outputs:
            w = p.width or 1
            base = next(flat for pp, _b, flat in layout if pp is p)
            add(f"                write(l, string'(\"D {p.name} \"));")
            for b in range(w):
                idx = base + b
                add(f"                write(l, highv({idx}) * 1000 / n);")
                if b < w - 1:
                    add("                write(l, string'(\",\"));")
            add("                writeline(output, l);")
        add("                end if;")
    if has_coin:
        add("                if n > 0 then")
        add("                write(l, string'(\"C \"));")
        add("                for i in coin'range loop")
        add("                    write(l, coin(i) * 1000 / n);")
        add(f"                    if i < {n_coin - 1} then")
        add("                        write(l, string'(\",\"));")
        add("                    end if;")
        add("                end loop;")
        add("                writeline(output, l);")
        add("                end if;")
    if buzzer_index is not None:
        add("                write(l, string'(\"B \"));")
        add("                write(l, buzz_toggles);")
        add("                write(l, string'(\" \"));")
        add("                write(l, buzz_active);")
        add("                writeline(output, l);")
        add("                buzz_toggles := 0;")
        add("                buzz_active := 0;")
    add("                write(l, string'(\"END\"));")
    add("                writeline(output, l);")
    add("                flush(output);")
    if has_uart_rx:
        add("            elsif l'length >= 11 and l(1) = 'U' then")
        add("                -- U<baud8><hex2>: one 8N1 frame onto the RXD pin")
        add("                nv := num(buf, 2, 8);")
        add("                if nv > 0 then")
        add("                    bit_time := (1_000_000_000 / nv) * 1 ns;")
        add("                    bval := hexbyte(buf, 10);")
        add(f"                    p_{sn[uart_rx_port]} <= '0';           -- start bit")
        add("                    wait for bit_time;")
        add("                    for b in 0 to 7 loop")
        add("                        if ((bval / 2 ** b) mod 2) = 1 then")
        add(f"                            p_{sn[uart_rx_port]} <= '1';")
        add("                        else")
        add(f"                            p_{sn[uart_rx_port]} <= '0';")
        add("                        end if;")
        add("                        wait for bit_time;")
        add("                    end loop;")
        add(f"                    p_{sn[uart_rx_port]} <= '1';           -- stop bit")
        add("                    wait for bit_time;")
        add("                    wait for bit_time;                 -- inter-frame gap")
        add("                end if;")
    if has_ps2:
        add("            elsif l'length >= 3 and l(1) = 'P' then")
        add("                -- P<hex2>: one PS/2 scancode frame (device-clocked,")
        add("                -- start + 8 data LSB-first + odd parity + stop)")
        add("                bval := hexbyte(buf, 2);")
        add("                ones := 0;")
        add("                for b in 0 to 7 loop")
        add("                    ones := ones + ((bval / 2 ** b) mod 2);")
        add("                end loop;")
        add(f"                p_{sn[ps2_data_port]} <= '0';          -- start bit")
        add("                wait for 5 us;")
        add(f"                p_{sn[ps2_clk_port]} <= '0';")
        add("                wait for 30 us;")
        add(f"                p_{sn[ps2_clk_port]} <= '1';")
        add("                wait for 30 us;")
        add("                for b in 0 to 7 loop")
        add("                    if ((bval / 2 ** b) mod 2) = 1 then")
        add(f"                        p_{sn[ps2_data_port]} <= '1';")
        add("                    else")
        add(f"                        p_{sn[ps2_data_port]} <= '0';")
        add("                    end if;")
        add("                    wait for 5 us;")
        add(f"                    p_{sn[ps2_clk_port]} <= '0';")
        add("                    wait for 30 us;")
        add(f"                    p_{sn[ps2_clk_port]} <= '1';")
        add("                    wait for 30 us;")
        add("                end loop;")
        add("                -- odd parity (total ones including parity = odd)")
        add("                if (ones mod 2) = 0 then")
        add(f"                    p_{sn[ps2_data_port]} <= '1';")
        add("                else")
        add(f"                    p_{sn[ps2_data_port]} <= '0';")
        add("                end if;")
        add("                wait for 5 us;")
        add(f"                p_{sn[ps2_clk_port]} <= '0';")
        add("                wait for 30 us;")
        add(f"                p_{sn[ps2_clk_port]} <= '1';")
        add("                wait for 30 us;")
        add("                -- stop bit")
        add(f"                p_{sn[ps2_data_port]} <= '1';")
        add("                wait for 5 us;")
        add(f"                p_{sn[ps2_clk_port]} <= '0';")
        add("                wait for 30 us;")
        add(f"                p_{sn[ps2_clk_port]} <= '1';")
        add("                wait for 30 us;")
        add("                wait for 200 us;                   -- inter-frame gap")
    if has_ir:
        add("            elsif l'length >= 5 and l(1) = 'R' then")
        add("                -- R<addr hex2><cmd hex2>: one NEC frame, active-low bursts")
        add("                ir_addr := hexbyte(buf, 2);")
        add("                ir_cmd := hexbyte(buf, 4);")
        add(f"                p_{sn[ir_port]} <= '0';")
        add("                wait for 9000 us;                  -- 9 ms leader burst")
        add(f"                p_{sn[ir_port]} <= '1';")
        add("                wait for 4500 us;                  -- 4.5 ms space")
        add("                for b in 0 to 31 loop")
        add("                    if b < 8 then ir_byte := ir_addr;")
        add("                    elsif b < 16 then ir_byte := 255 - ir_addr;")
        add("                        elsif b < 24 then ir_byte := ir_cmd;")
        add("                            else ir_byte := 255 - ir_cmd; end if;")
        add("                    pbit := (ir_byte / 2 ** (b mod 8)) mod 2;")
        add(f"                    p_{sn[ir_port]} <= '0';")
        add("                    wait for 560 us;")
        add(f"                    p_{sn[ir_port]} <= '1';")
        add("                    if pbit = 1 then")
        add("                        wait for 1690 us;")
        add("                    else")
        add("                        wait for 560 us;")
        add("                    end if;")
        add("                end loop;")
        add(f"                p_{sn[ir_port]} <= '1';")
        add("                wait for 5000 us;                  -- trailing gap")
    if i2c_wired and any(str(b.get("model", "")).lower() == "lm75" for b in i2c_wired):
        add("            elsif l'length >= 9 and l(1) = 'M' then")
        add("                -- M<sign><magnitude8>: live LM75 ambient temperature (C)")
        add("                nv := num(buf, 3, 8);")
        add("                if dig(buf, 2) = 1 then")
        add("                    nv := -nv;")
        add("                end if;")
        for _bus, amb in ambient_signals:
            add(f"                {amb} <= nv;")
        add("                wait for 1 us;")
    add("            elsif l'length >= 1 and l(1) = 'Q' then")
    add("                exit;")
    add("            end if;")
    add("        end loop;")
    add("        done <= true;")
    add("        wait;")
    add("    end process;")
    add("end architecture;")

    return {
        "vhdl": "\n".join(lines) + "\n",
        "entity": entity.name,
        "inputs": [p.name for p in inputs],
        "int_inputs": [p.name for p in int_inputs],
        "outputs": [p.name for p in outputs],
        "widths": {p.name: (p.width or 1) for p in outputs},
        "total_bits": total_bits,
        "buzzer_index": buzzer_index,
        "models": sorted(models_used),
    }
