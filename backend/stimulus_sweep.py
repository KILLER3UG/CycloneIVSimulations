"""Pre-computed multi-vector stimulus sweep engine (Slice 1.1).

Given the parsed interface of a design and the resolved board pin map, this
module runs ONE event-driven GHDL testbench that instantiates every steady
state of the interactive board channels (plus a release-edge instance per
bound channel when a buzzer is present), measures the resulting board image
with transition-driven monitors and returns a compact ``stimulusMap`` the UI
can replay without re-running GHDL per keypress.

All pins and polarities come from ``board/board.json`` through ``BOARD`` and
``BoardMap`` — this module never embeds a pin literal.
"""

from __future__ import annotations

import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .device import BOARD
from .ghdl_tool import GhdlTool
from .peripherals import decode_buzzer
from .testbench_gen import detect_clock, detect_reset, _generic_literal
from .vhdl_parser import Entity, Port
from .vcd_parser import parse_vcd
from .waveform import BoardMap, WaveformModel, _detect_down_counter

_SANITIZE_RE = re.compile(r"[^A-Za-z0-9_]")


def _sn(name: str) -> str:
    """VHDL-safe identifier for a port name."""
    text = _SANITIZE_RE.sub("_", str(name))
    if not text or text[0].isdigit():
        text = "p_" + text
    return text.lower()


def _channels_from_board() -> List[dict]:
    """Build the interactive channel list from the single board profile."""
    btn_cfg = BOARD.get("buttons") or {}
    btn_pins = [str(p).upper() for p in (btn_cfg.get("pins") or [])]
    btn_active_low = bool(btn_cfg.get("activeLow", True))
    sw_cfg = BOARD.get("switches") or {}
    sw_pins = [str(p).upper() for p in (sw_cfg.get("pins") or [])]
    sw_active_low = bool(sw_cfg.get("activeLow", True))
    shared = bool(sw_cfg.get("sharedWithButtons", False))

    if shared:
        pins = list(btn_pins)
    else:
        pins = list(btn_pins) + [p for p in sw_pins if p not in btn_pins]

    channels: List[dict] = []
    for index, pin in enumerate(pins):
        is_btn = index < len(btn_pins)
        channels.append({
            "index": index,
            "pin": pin,
            "activeLow": btn_active_low if is_btn else sw_active_low,
            "kind": "shared" if shared else ("button" if is_btn else "switch"),
            "targets": [],
        })
    return channels


def _bind_channels(
    entity: Entity,
    board_map: BoardMap,
    channels: List[dict],
    clock_name: Optional[str],
    reset_name: Optional[str],
) -> List[int]:
    """Attach board channels to input ports using the resolved pin map."""
    by_pin = {ch["pin"]: ch for ch in channels}
    for port in entity.inputs:
        if port.name == clock_name or port.name == reset_name:
            continue
        plist = (board_map.pins or {}).get(port.name, []) or []
        for bit_offset, raw_pin in enumerate(plist):
            ch = by_pin.get(str(raw_pin or "").upper())
            if ch is not None:
                ch["targets"].append({
                    "port": port.name,
                    "bitOffset": bit_offset,
                    "width": port.width or 1,
                })
    return [ch["index"] for ch in channels if ch["targets"]]


def _resolved_type(port: Port, generics: Dict[str, Any]) -> str:
    """Concrete (generics substituted) VHDL type for a port signal array."""
    text = (port.type_text or port.type_name or "std_logic").strip()
    # Substitute simple generic references such as WIDTH inside constraints.
    for name, value in generics.items():
        if isinstance(value, int) and not isinstance(value, bool):
            text = re.sub(rf"\b{re.escape(name)}\b", str(value), text)
    return text


def _routes(board_map: BoardMap) -> Tuple[List[Tuple[str, int, int]], List[Tuple[str, int, int]], Dict[int, Tuple[str, int]], Optional[Tuple[str, int]]]:
    """Collect (port, src_bit, hw_index) routes for SEG/DIG/LED/BEEP."""
    led_pin_idx = {str(p).upper(): i for i, p in enumerate((BOARD.get("leds") or {}).get("pins") or [])}
    dig_pin_idx = {
        str(p).upper(): i
        for i, p in enumerate(((BOARD.get("displays") or {}).get("pins") or {}).get("DIG") or [])
    }
    seg_pin_idx = {
        str(p).upper(): i
        for i, p in enumerate(((BOARD.get("displays") or {}).get("pins") or {}).get("SEG") or [])
    }
    buz_pin = str((BOARD.get("buzzer") or {}).get("pin") or "").upper()

    seg_routes: List[Tuple[str, int, int]] = []
    dig_routes: List[Tuple[str, int, int]] = []
    led_routes: Dict[int, Tuple[str, int]] = {}
    buz_route: Optional[Tuple[str, int]] = None
    for port, plist in (board_map.pins or {}).items():
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
    return seg_routes, dig_routes, led_routes, buz_route


def _elem(port_name: str, bit: int, width: int) -> str:
    signal = f"p_{_sn(port_name)}(k)"
    return signal if width == 1 else f"{signal}({bit})"


def _bit_elem(port: Port, bit: int) -> int:
    """Map a value-bit index (LSB = 0) to the port's VHDL element index.

    The pins lists in ``BoardMap`` are ordered by *value bit* (bit 0 = LSB of
    the integer the VCD delivers).  For a ``downto`` range the element index
    equals ``right + bit``; for an ascending ``to`` range the rightmost
    element is the LSB, so the element index is ``right - bit``.  Using the
    raw bit as an element index misdrove every non-zero ascending range
    (``N to M``).
    """
    if port.left is None or port.right is None or (port.width or 1) == 1:
        return bit
    return (port.right + bit) if port.downto else (port.right - bit)


def _driver_literal(port: Port, level: str) -> str:
    """VHDL literal that drives one bit/level of ``port`` (typed scalars too)."""
    t = (port.type_name or "").lower()
    if t in ("integer", "natural", "positive"):
        return str(int(level))
    if t == "boolean":
        return "true" if level == "1" else "false"
    if t == "real":
        return str(float(level))
    if t == "time":
        return f"{int(level)} ns"
    return f"'{level}'"


def _final_expr(port: Port) -> str:
    sn = _sn(port.name)
    t = (port.type_name or "").lower()
    sig = f"p_{sn}(k)"
    if t in ("std_logic_vector", "bit_vector"):
        return f"to_integer(unsigned({sig}))"
    if t in ("unsigned",):
        return f"to_integer(unsigned({sig}))"
    if t in ("signed",):
        return f"to_integer(signed({sig}))"
    if t in ("std_logic", "bit"):
        return f"sl_to_int({sig})"
    if t in ("boolean",):
        return f"bool_to_int({sig})"
    if t in ("integer", "natural", "positive"):
        return sig
    return "0"


def _gen_sweep_tb(
    entity: Entity,
    generics: Dict[str, Any],
    channels: List[dict],
    bound: List[int],
    n_vec: int,
    n_rel: int,
    period_ns: float,
    reset_cycles: int,
    reset_active_high: bool,
    clock_name: Optional[str],
    reset_name: Optional[str],
    seg_routes: List[Tuple[str, int, int]],
    dig_routes: List[Tuple[str, int, int]],
    led_routes: Dict[int, Tuple[str, int]],
    buz_route: Optional[Tuple[str, int]],
    n_dig: int,
    n_led: int,
    capture_cycles: int,
    constant_inputs: Dict[str, Any],
) -> Tuple[str, Dict[str, Any]]:
    """Generate the single multi-vector VHDL-2008 sweep testbench."""
    n_tot = n_vec + n_rel
    settle_ns = int(round((reset_cycles + 6) * period_ns))
    ent = entity.name
    tb_name = f"tb_sweep_{_sn(ent)}"
    seg_active_low = bool(((BOARD.get("displays") or {}).get("segmentActiveLow", True)))
    dig_active_low = bool(((BOARD.get("displays") or {}).get("digitActiveLow", True)))
    seg_level = "0" if seg_active_low else "1"
    dig_level = "0" if dig_active_low else "1"
    buz_active_low = bool((BOARD.get("buzzer") or {}).get("activeLow", True))
    buz_active = "0" if buz_active_low else "1"

    assert_val = "1" if reset_active_high else "0"
    release_val = "0" if reset_active_high else "1"

    clk_reset = {n for n in (clock_name, reset_name) if n is not None}
    ports = [p for p in entity.ports if p.name not in clk_reset]
    in_ports = [p for p in ports if p.is_input]

    # channel level (logic level driven on the physical net) per instance
    def steady_level(ch_index: int, vec: int) -> str:
        for b, ch in enumerate(bound):
            if ch == ch_index:
                return str((vec >> b) & 1)
        return "1" if channels[ch_index]["activeLow"] else "0"

    def idle_level(ch_index: int) -> str:
        return "1" if channels[ch_index]["activeLow"] else "0"

    def active_level(ch_index: int) -> str:
        return "0" if channels[ch_index]["activeLow"] else "1"

    # target lookup: channel index -> list of (port, bit, width)
    chan_targets: Dict[int, List[Tuple[str, int, int]]] = {}
    for ch in channels:
        chan_targets[ch["index"]] = [
            (t["port"], int(t["bitOffset"]), int(t.get("width") or 1))
            for t in ch["targets"]
        ]

    def default_level(port: Port, bit: int) -> str:
        if port.name in constant_inputs:
            value = constant_inputs[port.name]
            if isinstance(value, str):
                text = value.strip()
                if text.lower().startswith("0x"):
                    try:
                        value = int(text, 16)
                    except ValueError:
                        value = 0
                elif re.fullmatch(r"[01]+", text):
                    value = int(text, 2)
            try:
                return str((int(value) >> bit) & 1)
            except (TypeError, ValueError):
                return "0"
        return "0"

    lines: List[str] = []
    add = lines.append
    add("library ieee;")
    add("use ieee.std_logic_1164.all;")
    add("use ieee.numeric_std.all;")
    add("use std.textio.all;")
    add("")
    add(f"entity {tb_name} is end entity;")
    add("")
    add(f"architecture sweep of {tb_name} is")
    add(f"  constant CLK_PERIOD : time := {period_ns:g} ns;")
    add(f"  constant N_TOT : integer := {n_tot};")
    add(f"  constant N_VEC : integer := {n_vec};")
    add(f"  constant N_DIG : integer := {n_dig};")
    add(f"  constant N_LED : integer := {n_led};")
    add(f"  constant SETTLE_NS : integer := {settle_ns};")
    add(f"  constant RESET_CYCLES : integer := {reset_cycles};")
    for g in entity.generics:
        lit = _generic_literal(g, generics)
        if lit is None:
            continue
        gtype = (g.type_text or g.type_name or "integer").strip()
        add(f"  constant {g.name} : {gtype} := {lit};")
    if clock_name:
        add("  signal clk : std_logic := '0';")
    if reset_name:
        add(f"  signal rst : std_logic := '{assert_val}';")
    add("  signal sim_done : boolean := false;")
    add("  signal settle : boolean := false;")
    add("")
    add("  function sl_to_int(v : std_logic) return integer is")
    add("  begin")
    add("    if v = '1' then return 1; else return 0; end if;")
    add("  end function;")
    add("  function bool_to_int(v : boolean) return integer is")
    add("  begin")
    add("    if v then return 1; else return 0; end if;")
    add("  end function;")
    add("")
    for port in ports:
        sn = _sn(port.name)
        add(f"  type arr_{sn} is array (0 to N_TOT-1) of {_resolved_type(port, generics)};")
        add(f"  signal p_{sn} : arr_{sn};")
    add("")
    add("  type int_arr is array (0 to N_TOT-1) of integer;")
    for sig in ("edges_cnt", "first_ns", "last_ns", "active_ns", "scan_cnt", "scan_first", "scan_last"):
        add(f"  signal {sig} : int_arr := (others => 0);")
    add("  type lit_row is array (0 to N_DIG*8-1) of integer;")
    add("  type lit_arr is array (0 to N_TOT-1) of lit_row;")
    add("  signal lit_ns : lit_arr := (others => (others => 0));")
    if seg_routes or dig_routes:
        add("  type arr_seg8 is array (0 to N_TOT-1) of std_logic_vector(7 downto 0);")
        add("  type arr_dig is array (0 to N_TOT-1) of std_logic_vector(N_DIG-1 downto 0);")
        add("  signal seg_vec : arr_seg8;")
        add("  signal dig_vec : arr_dig;")
    if led_routes:
        add("  type arr_led_norm is array (0 to N_TOT-1) of std_logic_vector(N_LED-1 downto 0);")
        add("  signal led_vec : arr_led_norm;")
    if buz_route is not None:
        add("  signal buz_w : std_logic_vector(0 to N_TOT-1);")
    add("")
    add("begin")
    if clock_name:
        add("  clk_proc: clk <= not clk after CLK_PERIOD / 2 when not sim_done else '0';")
    if reset_name:
        add(f"  rst_proc: process begin rst <= '{assert_val}'; wait for RESET_CYCLES * CLK_PERIOD; rst <= '{release_val}'; wait; end process;")
    add("  settle_proc: process begin wait for SETTLE_NS * 1 ns; settle <= true; wait; end process;")
    add("")
    # DUT instances
    add(f"  gen_dut: for k in 0 to N_TOT-1 generate")
    add(f"    uut: entity work.{ent}")
    if entity.generics:
        gmap = ", ".join(f"{g.name} => {g.name}" for g in entity.generics if _generic_literal(g, generics) is not None)
        if gmap:
            add(f"      generic map ({gmap})")
    add("      port map (")
    pm = []
    for port in entity.ports:
        if port.name == clock_name:
            pm.append(f"{port.name} => clk")
        elif port.name == reset_name:
            pm.append(f"{port.name} => rst")
        else:
            pm.append(f"{port.name} => p_{_sn(port.name)}(k)")
    add("        " + ",\n        ".join(pm))
    add("      )")
    add("    ;")
    add("  end generate;")
    add("")

    # normalized output signals
    gen_norm = False
    if seg_routes or dig_routes or led_routes or buz_route is not None:
        gen_norm = True
        add("  gen_norm: for k in 0 to N_TOT-1 generate")
        if (seg_routes or dig_routes):
            seg_by_hw = {hw: (p, b) for p, b, hw in seg_routes}
            dig_by_hw = {hw: (p, b) for p, b, hw in dig_routes}
            for hw in range(8):
                route = seg_by_hw.get(hw)
                if route:
                    pname, bit = route
                    width = next((pp.width or 1 for pp in ports if pp.name == pname), 1)
                    expr = f"'1' when {_elem(pname, bit, width)} = '{seg_level}' else '0'"
                else:
                    expr = "'0'"
                add(f"    seg_vec(k)({hw}) <= {expr};")
            for hw in range(n_dig):
                route = dig_by_hw.get(hw)
                if route:
                    pname, bit = route
                    width = next((pp.width or 1 for pp in ports if pp.name == pname), 1)
                    expr = f"'1' when {_elem(pname, bit, width)} = '{dig_level}' else '0'"
                else:
                    expr = "'0'"
                add(f"    dig_vec(k)({hw}) <= {expr};")
        if led_routes:
            for hw in range(n_led):
                route = led_routes.get(hw)
                if route:
                    pname, bit = route
                    width = next((pp.width or 1 for pp in ports if pp.name == pname), 1)
                    expr = _elem(pname, bit, width)
                else:
                    expr = "'0'"
                add(f"    led_vec(k)({hw}) <= {expr};")
        if buz_route is not None:
            pname, bit = buz_route
            width = next((pp.width or 1 for pp in ports if pp.name == pname), 1)
            add(f"    buz_w(k) <= {_elem(pname, bit, width)};")
        add("  end generate;")
        add("")

    clock_tick = "CLK_PERIOD" if clock_name else "20 ns"

    # buzzer monitor
    if buz_route is not None:
        add("  gen_buz_mon: for k in 0 to N_TOT-1 generate")
        add("    buz_mon: process(buz_w(k))")
        add("      variable v_edges : integer := 0;")
        add("      variable v_first : integer := 0;")
        add("      variable v_last : integer := 0;")
        add("      variable v_active : integer := 0;")
        add("      variable v_prev_t : integer := 0;")
        add("      variable v_prev_lvl : std_logic := 'U';")
        add("      variable v_t : integer;")
        add("    begin")
        add("      v_t := integer(now / 1 ns);")
        add("      if v_t >= SETTLE_NS then")
        add(f"        if v_prev_lvl = '{buz_active}' and v_t > v_prev_t then")
        add("          v_active := v_active + (v_t - v_prev_t);")
        add("        end if;")
        add("        v_edges := v_edges + 1;")
        add("        if v_first = 0 then v_first := v_t; end if;")
        add("        v_last := v_t;")
        add("        v_prev_t := v_t;")
        add("        v_prev_lvl := buz_w(k);")
        add("        edges_cnt(k) <= v_edges;")
        add("        first_ns(k) <= v_first;")
        add("        last_ns(k) <= v_last;")
        add("        active_ns(k) <= v_active;")
        add("      else")
        add("        v_prev_t := v_t;")
        add("        v_prev_lvl := buz_w(k);")
        add("      end if;")
        add("    end process;")
        add("  end generate;")
        add("")

    # display monitor
    if seg_routes or dig_routes:
        add("  gen_disp_mon: for k in 0 to N_TOT-1 generate")
        add("    disp_mon: process(dig_vec(k), seg_vec(k), sim_done, settle)")
        add("      variable v_t : integer;")
        add("      variable v_last_t : integer := 0;")
        add("      variable v_lit : lit_row := (others => 0);")
        add("      variable v_prev_dig : std_logic_vector(N_DIG-1 downto 0) := (others => '0');")
        add("      variable v_prev_seg : std_logic_vector(7 downto 0) := (others => '0');")
        add("      variable v_scan_cnt : integer := 0;")
        add("      variable v_scan_first : integer := 0;")
        add("      variable v_scan_last : integer := 0;")
        add("      variable d, s : integer;")
        add("    begin")
        add("      v_t := integer(now / 1 ns);")
        add("      if v_t >= SETTLE_NS then")
        add("        if v_last_t > 0 and v_t > v_last_t then")
        add("          for d in 0 to N_DIG-1 loop")
        add("            if v_prev_dig(d) = '1' then")
        add("              for s in 0 to 7 loop")
        add("                if v_prev_seg(s) = '1' then")
        add("                  v_lit(d*8+s) := v_lit(d*8+s) + (v_t - v_last_t);")
        add("                end if;")
        add("              end loop;")
        add("            end if;")
        add("          end loop;")
        add("        end if;")
        add("        if dig_vec(k)(0) = '1' and v_prev_dig(0) = '0' then")
        add("          v_scan_cnt := v_scan_cnt + 1;")
        add("          if v_scan_first = 0 then v_scan_first := v_t; end if;")
        add("          v_scan_last := v_t;")
        add("        end if;")
        add("        v_prev_dig := dig_vec(k);")
        add("        v_prev_seg := seg_vec(k);")
        add("        v_last_t := v_t;")
        add("        lit_ns(k) <= v_lit;")
        add("        scan_cnt(k) <= v_scan_cnt;")
        add("        scan_first(k) <= v_scan_first;")
        add("        scan_last(k) <= v_scan_last;")
        add("      end if;")
        add("    end process;")
        add("  end generate;")
        add("")

    port_by_name = {p.name: p for p in entity.ports}
    # stimulus driver
    add("  stim: process")
    add("  begin")
    for k in range(n_tot):
        for port in in_ports:
            sn = _sn(port.name)
            if (port.width or 1) == 1:
                ch_for_port = None
                for ch in channels:
                    for (pname, bit, width) in chan_targets[ch["index"]]:
                        if pname == port.name and bit == 0:
                            ch_for_port = ch["index"]
                level = (steady_level(ch_for_port, k) if k < n_vec else idle_level(ch_for_port)) if ch_for_port is not None else default_level(port, 0)
                add(f"    p_{sn}({k}) <= {_driver_literal(port, level)};")
            else:
                for bit in range(port.width or 1):
                    ch_for_bit = None
                    for ch in channels:
                        for (pname, b, width) in chan_targets[ch["index"]]:
                            if pname == port.name and b == bit:
                                ch_for_bit = ch["index"]
                    level = (steady_level(ch_for_bit, k) if k < n_vec else idle_level(ch_for_bit)) if ch_for_bit is not None else default_level(port, bit)
                    add(f"    p_{sn}({k})({_bit_elem(port, bit)}) <= {_driver_literal(port, level)};")
    if n_rel:
        if reset_cycles:
            add(f"    wait for {reset_cycles} * CLK_PERIOD;")
        for r in range(n_rel):
            k = n_vec + r
            ch = bound[r]
            for (pname, bit, width) in chan_targets[ch]:
                add(f"    p_{_sn(pname)}({k})" + ("" if width == 1 else f"({_bit_elem(port_by_name[pname], bit)})") + f" <= {_driver_literal(port_by_name[pname], active_level(ch))};")
        add(f"    wait for 4 * CLK_PERIOD;")
        for r in range(n_rel):
            k = n_vec + r
            ch = bound[r]
            for (pname, bit, width) in chan_targets[ch]:
                add(f"    p_{_sn(pname)}({k})" + ("" if width == 1 else f"({_bit_elem(port_by_name[pname], bit)})") + f" <= {_driver_literal(port_by_name[pname], idle_level(ch))};")
    add("    wait;")
    add("  end process;")
    add("")

    # main process / output
    add("  main: process")
    add('    file f : text open write_mode is "sweep_out.txt";')
    add("    variable l : line;")
    add("  begin")
    add(f"    wait for {capture_cycles} * {clock_tick};")
    add("    sim_done <= true;")
    add("    wait for 1 ns;")
    add("    for k in 0 to N_TOT-1 loop")
    write_fields = [
        "k", "edges_cnt(k)", "first_ns(k)", "last_ns(k)", "active_ns(k)",
        "scan_cnt(k)", "scan_first(k)", "scan_last(k)",
    ]
    for expr in write_fields:
        add(f"      write(l, {expr}); write(l, ' ');")
    add("      for s in 0 to N_DIG*8-1 loop")
    add("        write(l, lit_ns(k)(s)); write(l, ' ');")
    add("      end loop;")
    add("      for s in 0 to N_LED-1 loop")
    if led_routes:
        add("        write(l, sl_to_int(led_vec(k)(s))); write(l, ' ');")
    else:
        add("        write(l, 0); write(l, ' ');")
    add("      end loop;")
    if buz_route is not None:
        add("      write(l, sl_to_int(buz_w(k))); write(l, ' ');")
    else:
        add("      write(l, 0); write(l, ' ');")
    for port in entity.ports:
        if port.name == clock_name:
            expr = "sl_to_int(clk)"
        elif port.name == reset_name:
            expr = "sl_to_int(rst)"
        else:
            expr = _final_expr(port)
        add(f"      write(l, {expr}); write(l, ' ');")
    add("      writeline(f, l);")
    add("    end loop;")
    add("    file_close(f);")
    add("    wait;")
    add("  end process;")
    add("end architecture;")

    info = {
        "n_tot": n_tot,
        "n_vec": n_vec,
        "n_rel": n_rel,
        "n_dig": n_dig,
        "n_led": n_led,
        "tb_name": tb_name,
        "captures": len(write_fields) + n_dig * 8 + n_led + 1 + len(entity.ports),
        "port_names": [p.name for p in entity.ports],
    }
    return "\n".join(lines) + "\n", info


def _gen_release_tb(
    entity: Entity,
    generics: Dict[str, Any],
    period_ns: float,
    reset_cycles: int,
    reset_active_high: bool,
    clock_name: Optional[str],
    reset_name: Optional[str],
    channels: List[dict],
    bound: List[int],
    constant_inputs: Dict[str, Any],
) -> str:
    """Small VCD testbench that presses one key to expose the note down-counter."""
    ent = entity.name
    assert_val = "1" if reset_active_high else "0"
    release_val = "0" if reset_active_high else "1"
    clk_reset = {n for n in (clock_name, reset_name) if n is not None}
    target = channels[bound[0]] if bound else channels[0]
    active = "0" if target["activeLow"] else "1"

    lines: List[str] = []
    add = lines.append
    add("library ieee;")
    add("use ieee.std_logic_1164.all;")
    add("use ieee.numeric_std.all;")
    add("")
    add("entity tb_rel is end entity;")
    add("architecture sim of tb_rel is")
    add(f"  constant CLK_PERIOD : time := {period_ns:g} ns;")
    for g in entity.generics:
        lit = _generic_literal(g, generics)
        if lit is None:
            continue
        gtype = (g.type_text or g.type_name or "integer").strip()
        add(f"  constant {g.name} : {gtype} := {lit};")
    if clock_name:
        add("  signal clk : std_logic := '0';")
    if reset_name:
        add(f"  signal rst : std_logic := '{assert_val}';")
    for port in entity.ports:
        if port.name in clk_reset:
            continue
        t = _resolved_type(port, generics)
        init = "'0'" if (port.width or 1) == 1 else "(others => '0')"
        if (port.type_name or "").lower() in ("integer", "natural", "positive"):
            init = "0"
        if (port.type_name or "").lower() == "boolean":
            init = "false"
        add(f"  signal s_{_sn(port.name)} : {t} := {init};")
    add("begin")
    if clock_name:
        add("  clk <= not clk after CLK_PERIOD / 2;")
    if reset_name:
        add(f"  rst <= '{assert_val}'; wait for {reset_cycles} * CLK_PERIOD; rst <= '{release_val}'; wait;")
    chan_targets = {
        ch["index"]: [(t["port"], int(t["bitOffset"]), int(t.get("width") or 1)) for t in ch["targets"]]
        for ch in channels
    }
    active_bits: Dict[str, set] = {}
    for (pname, bit, width) in chan_targets[target["index"]]:
        active_bits.setdefault(pname, set()).add(bit)
    # Every channel-bound input has an idle level from its board polarity;
    # other inputs idle at 0.  Drive them ALL so no key stays pressed.
    chan_idle: Dict[str, Dict[int, str]] = {}
    for ch in channels:
        ch_idle = "1" if ch["activeLow"] else "0"
        for (pname, bit, width) in chan_targets[ch["index"]]:
            chan_idle.setdefault(pname, {})[bit] = ch_idle

    def input_level(port: Port, bit: int, phase: str) -> str:
        if phase == "active" and bit in active_bits.get(port.name, set()):
            return active
        return chan_idle.get(port.name, {}).get(bit, "0")

    add("  rel_stim: process")
    add("  begin")
    for phase in ("active", "idle"):
        for port in entity.ports:
            if not port.is_input or port.name in clk_reset:
                continue
            tname = (port.type_name or "").lower()
            if tname in ("integer", "natural", "positive", "boolean", "time", "real"):
                continue
            sn = _sn(port.name)
            if (port.width or 1) == 1:
                add(f"    s_{sn} <= '{input_level(port, 0, phase)}';")
            else:
                for bit in range(port.width or 1):
                    add(f"    s_{sn}({_bit_elem(port, bit)}) <= '{input_level(port, bit, phase)}';")
        if phase == "active":
            add("    wait for 4 * CLK_PERIOD;")
    add("    wait;")
    add("  end process;")
    add(f"  uut: entity work.{ent}")
    if entity.generics:
        gmap = ", ".join(f"{g.name} => {g.name}" for g in entity.generics if _generic_literal(g, generics) is not None)
        if gmap:
            add(f"    generic map ({gmap})")
    add("    port map (")
    pm = []
    for port in entity.ports:
        if port.name == clock_name:
            pm.append(f"{port.name} => clk")
        elif port.name == reset_name:
            pm.append(f"{port.name} => rst")
        else:
            pm.append(f"{port.name} => s_{_sn(port.name)}")
    add("    " + ",\n    ".join(pm))
    add("    )")
    add("  ;")
    add("end architecture;")
    return "\n".join(lines) + "\n"


def _synthetic_buzzer(edges: int, first: int, last: int, clock_period: float, active_low: bool) -> dict:
    """Build a clean square wave matching the measured half period."""
    idle = 1 if active_low else 0
    on = 0 if active_low else 1
    if edges < 2 or last <= first:
        return decode_buzzer([(0.0, idle)], clock_ns=clock_period, active_low=active_low)
    half = (last - first) / (edges - 1)
    if half <= 0:
        return decode_buzzer([(0.0, idle)], clock_ns=clock_period, active_low=active_low)
    t0 = float(first)
    levels = [on, 1 - on, on, 1 - on, on]  # 5 edges -> 4 equal intervals -> 50% duty
    synth = [(t0 + i * half, levels[i]) for i in range(5)]
    return decode_buzzer(synth, clock_ns=clock_period, active_low=active_low)


def _entry_from_initial(
    initial_board_image: Optional[dict],
    initial_peripherals: Optional[dict],
    initial_final_values: Optional[dict],
    active_low: bool,
) -> dict:
    image = initial_board_image or {}
    buzzer = (initial_peripherals or {}).get("buzzer") or {}
    final = initial_final_values or {}
    level = int(buzzer.get("level", 0))
    return {
        "pov": list(image.get("pov") or [0.0] * 32),
        "povBits": list(image.get("povBits") or [0] * 32),
        "scanHz": float(image.get("scanHz") or 0.0),
        "leds": list(image.get("leds") or [0] * 4),
        "buzzer": 1 if ((level == 0) == active_low) else 0,
        "buzzerDecode": dict(buzzer) or {
            "tone": False, "frequency": 0, "cyclesPerPeriod": 0.0,
            "halfPeriodNs": 0.0, "duty": 0.0, "activeLow": active_low, "edges": [],
        },
        "finalValues": {
            str(k): int(v) for k, v in final.items()
            if isinstance(v, (int, bool)) and not isinstance(v, bool)
        },
    }


def build_stimulus_map(
    ghdl: GhdlTool,
    entity: Entity,
    sources: List[tuple[str, str]],
    board_map: BoardMap,
    clock_period: float,
    reset_cycles: int,
    reset_active_high: bool,
    reset_port: Optional[str],
    clock_port: Optional[str],
    constant_inputs: Dict[str, Any],
    generics: Dict[str, Any],
    stimuli: List[Any],
    initial_board_image: Optional[dict] = None,
    initial_peripherals: Optional[dict] = None,
    initial_final_values: Optional[dict] = None,
    cancel_token: Optional[dict] = None,
) -> Optional[dict]:
    """Pre-compute the interactive board response for every channel vector.

    Returns ``None`` (never raises into the caller) when the design cannot be
    swept — the caller keeps the normal simulation result unchanged.
    """
    try:
        return _build_stimulus_map(
            ghdl, entity, sources, board_map, clock_period, reset_cycles,
            reset_active_high, reset_port, clock_port, constant_inputs,
            generics, stimuli, initial_board_image, initial_peripherals,
            initial_final_values, cancel_token,
        )
    except Exception:
        return None


def _build_stimulus_map(
    ghdl: GhdlTool,
    entity: Entity,
    sources: List[tuple[str, str]],
    board_map: BoardMap,
    clock_period: float,
    reset_cycles: int,
    reset_active_high: bool,
    reset_port: Optional[str],
    clock_port: Optional[str],
    constant_inputs: Dict[str, Any],
    generics: Dict[str, Any],
    stimuli: List[Any],
    initial_board_image: Optional[dict],
    initial_peripherals: Optional[dict],
    initial_final_values: Optional[dict],
    cancel_token: Optional[dict],
) -> Optional[dict]:
    def cancelled() -> bool:
        return bool(isinstance(cancel_token, dict) and cancel_token.get("cancelled"))

    channels = _channels_from_board()

    # Clock/reset port names (exclude them from channel binding).
    clock = next((p for p in entity.ports if clock_port and p.name == clock_port), None)
    if clock is None:
        clock = detect_clock(entity)
    reset = next((p for p in entity.ports if reset_port and p.name == reset_port), None)
    if reset is None:
        detected = detect_reset(entity)
        reset = detected[0] if detected else None
    clock_name = clock.name if clock is not None else None
    reset_name = reset.name if reset is not None else None

    bound = _bind_channels(entity, board_map, channels, clock_name, reset_name)
    seg_routes, dig_routes, led_routes, buz_route = _routes(board_map)
    n_dig = max(1, len(dig_routes)) if dig_routes else int(
        (BOARD.get("displays") or {}).get("count") or len(board_map.digits) or 4
    )
    n_led = int(
        (BOARD.get("leds") or {}).get("count")
        or len((BOARD.get("leds") or {}).get("pins") or [])
        or 4
    )

    if not bound:
        entry = _entry_from_initial(
            initial_board_image, initial_peripherals, initial_final_values,
            bool((BOARD.get("buzzer") or {}).get("activeLow", True)),
        )
        count = 1 << min(len(channels), 6)
        return {
            "meta": {
                "channelCount": len(channels),
                "boundChannels": [],
                "channels": channels,
                "partial": False,
            },
            "vectors": {str(mask): dict(entry) for mask in range(count)},
            "releases": {},
        }

    partial = len(bound) > 4
    sweep_bound = bound[:4]
    n_vec = 1 << len(sweep_bound)
    n_rel = len(sweep_bound) if buz_route is not None else 0

    if len(dig_routes) >= 2:
        capture_cycles = 65540
    elif buz_route is not None:
        capture_cycles = 102500
    else:
        capture_cycles = 64
    if n_rel:
        capture_cycles = max(capture_cycles, 102500)

    period = float(clock_period) if clock is not None else 20.0

    tb_source, info = _gen_sweep_tb(
        entity, generics, channels, sweep_bound, n_vec, n_rel, period,
        reset_cycles, reset_active_high, clock_name, reset_name,
        seg_routes, dig_routes, led_routes, buz_route, n_dig, n_led,
        capture_cycles, constant_inputs,
    )

    workdir = Path(tempfile.mkdtemp(prefix="cyclone_sweep_"))
    keep = os.environ.get("CYCLESIM_KEEP_DIR", "") not in ("", "0", "false", "False")
    try:
        work = workdir / "work"
        work.mkdir(parents=True, exist_ok=True)
        paths = []
        for name, content in sources:
            path = workdir / Path(name).name
            path.write_text(content, encoding="utf-8")
            paths.append(path)
        tb_path = workdir / "tb_sweep.vhd"
        tb_path.write_text(tb_source, encoding="utf-8")

        analyze = ghdl.analyze(paths + [tb_path], work, cwd=workdir, token=cancel_token)
        if not analyze.ok or cancelled():
            return None
        elaborate = ghdl.elaborate(info["tb_name"], work, cwd=workdir, token=cancel_token)
        if not elaborate.ok or cancelled():
            return None
        run_args = [
            ghdl.executable, "-r", f"--std={ghdl.std}",
            f"--workdir={work}", "--work=work", info["tb_name"],
        ]
        run = ghdl._run(
            run_args, cwd=workdir,
            timeout=ghdl._run_timeout(capture_cycles * period), token=cancel_token,
        )
        if not run.ok or cancelled():
            return None
        out_file = workdir / "sweep_out.txt"
        if not out_file.exists():
            return None
        rows = []
        for line in out_file.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = line.split()
            if len(parts) < info["captures"]:
                continue
            rows.append([int(v) for v in parts[: info["captures"]]])
        if len(rows) < info["n_tot"]:
            return None

        # Down-counter capture on a focused release testbench (buzzer designs).
        countdown: Optional[dict] = None
        if n_rel and any(row[1] >= 2 for row in rows[n_vec:]):
            rel_source = _gen_release_tb(
                entity, generics, period, reset_cycles, reset_active_high,
                clock_name, reset_name, channels, sweep_bound, constant_inputs,
            )
            rel_path = workdir / "tb_rel.vhd"
            rel_path.write_text(rel_source, encoding="utf-8")
            rel_an = ghdl.analyze([rel_path], work, cwd=workdir, token=cancel_token)
            if rel_an.ok and not cancelled():
                rel_el = ghdl.elaborate("tb_rel", work, cwd=workdir, token=cancel_token)
                if rel_el.ok and not cancelled():
                    rel_vcd = workdir / "rel.vcd"
                    rel_run = ghdl.run(
                        "tb_rel", work, rel_vcd, 64 * period,
                        cwd=workdir, token=cancel_token,
                    )
                    if rel_run.ok and rel_vcd.exists():
                        try:
                            vcd = parse_vcd(str(rel_vcd))
                            model = WaveformModel(vcd, entity, root=None, max_cycles=64)
                            countdown = _detect_down_counter(model)
                        except Exception:
                            countdown = None
        release_cycles = int(countdown["cycles"]) if countdown else 0

        # Convert rows into board-image entries.
        total_ns = capture_cycles * period
        led_active_low = bool((BOARD.get("leds") or {}).get("activeLow", True))
        buz_active_low = bool((BOARD.get("buzzer") or {}).get("activeLow", True))
        port_names = info["port_names"]
        head = 8
        lit_start = head
        lit_end = lit_start + n_dig * 8
        led_end = lit_end + n_led
        buz_idx = led_end
        final_start = buz_idx + 1

        entries: List[dict] = []
        for row in rows[: info["n_tot"]]:
            edges = row[1]
            first = row[2]
            last = row[3]
            active_ns = row[4]
            scan_cnt = row[5]
            scan_first = row[6]
            scan_last = row[7]
            lit = row[lit_start:lit_end]
            leds_raw = row[lit_end:led_end]
            buz_raw = row[buz_idx]
            final_vals = {
                name: int(row[final_start + i]) for i, name in enumerate(port_names)
            }
            pov = [round(value / total_ns, 4) if total_ns > 0 else 0.0 for value in lit]
            pov_bits = [1 if value else 0 for value in lit]
            if scan_cnt >= 2 and scan_last > scan_first:
                scan_period = (scan_last - scan_first) / (scan_cnt - 1)
                scan_hz = round(1e9 / scan_period, 3)
            else:
                scan_hz = 0.0
            decode = _synthetic_buzzer(edges, first, last, period, buz_active_low)
            entries.append({
                "pov": pov,
                "povBits": pov_bits,
                "scanHz": scan_hz,
                "leds": [
                    1 if (led_routes and ((level == 0) == led_active_low)) else 0
                    for level in leds_raw
                ],
                "buzzer": 1 if (buz_route is not None and ((buz_raw == 0) == buz_active_low)) else 0,
                "buzzerDecode": decode,
                "finalValues": final_vals,
                "_active_ns": active_ns,
            })

        # Expand steady-state entries across all full-channel masks.
        vectors: Dict[str, dict] = {}
        full_count = 1 << len(channels)
        for mask in range(full_count):
            v = 0
            for b, ch in enumerate(sweep_bound):
                if (mask >> ch) & 1:
                    v |= 1 << b
            vectors[str(mask)] = dict(entries[v])

        releases: Dict[str, dict] = {}
        for r in range(n_rel):
            ch = sweep_bound[r]
            release = dict(entries[n_vec + r])
            release["releaseCycles"] = release_cycles
            releases[str(ch)] = release

        for entry in list(vectors.values()) + list(releases.values()):
            entry.pop("_active_ns", None)

        return {
            "meta": {
                "channelCount": len(channels),
                "boundChannels": list(sweep_bound),
                "channels": channels,
                "partial": bool(partial),
            },
            "vectors": vectors,
            "releases": releases,
        }
    finally:
        if not keep:
            shutil.rmtree(workdir, ignore_errors=True)


__all__ = ["build_stimulus_map"]
