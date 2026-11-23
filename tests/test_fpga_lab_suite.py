"""Adapted test suite from https://github.com/cmpj-21/fpga-lab.git.

Runs the behavioral tests from fpga-lab's test/ directory (engine.mjs,
demo.mjs, formats.mjs, importers.mjs, native.mjs, api.mjs) against our
simulator, QSF parser, VCD parser, UART decoder, and FastAPI server —
adapting only paths/routes/payload schemas while keeping all behavioral
assertions intact.
"""
from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.peripherals import decode_uart
from backend.qsf_parser import parse_qsf
from backend.server import app, get_simulator
from backend.simulator import SimulationRequest
from backend.vcd_parser import parse_vcd_text


def _sim():
    return get_simulator()


def _run_vhdl(
    source: str,
    *,
    top: str | None = None,
    files: list[dict] | None = None,
    duration: float = 1000.0,
    clock_period: float = 20.0,
    reset_cycles: int = 0,
    reset_active_high: bool = True,
    stimuli: list[dict] | None = None,
    generics: dict | None = None,
    clock_port: str | None = None,
    reset_port: str | None = None,
) -> dict:
    req = SimulationRequest.from_dict({
        "vhdl": source,
        "top": top,
        "files": files,
        "duration": duration,
        "clockPeriod": clock_period,
        "resetCycles": reset_cycles,
        "resetActiveHigh": reset_active_high,
        "stimuli": stimuli or [],
        "generics": generics or {},
        "clockPort": clock_port,
        "resetPort": reset_port,
        "maxCycles": 4096,
    })
    res = _sim().simulate(req)
    wf = res.get("waveforms") or {}
    res["final"] = wf.get("final") or {}
    res["cycles"] = wf.get("cycles") or []
    res["signals"] = wf.get("signals") or []
    return res


def _norm_bin(val, width: int = 1) -> str:
    if isinstance(val, int):
        return format(val & ((1 << width) - 1), f"0{width}b")
    s = str(val).strip()
    if len(s) < width and set(s) <= {"0", "1"}:
        return s.zfill(width)
    return s


# ===========================================================================
# Adapted from fpga-lab/test/engine.mjs (T1 - T10)
# ===========================================================================


def test_engine_t1_concurrent_dataflow_golden_vectors():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all;
        entity t is port(A,B,C: in std_logic; y1,y2: out std_logic); end t;
        architecture a of t is
        begin
          y1 <= (not A) and (B or C);
          y2 <= A and (B or C);
        end a;
    """)
    combos = [(0,0,0),(0,0,1),(0,1,0),(0,1,1),(1,0,0),(1,0,1),(1,1,0),(1,1,1)]
    e1 = [0,1,1,1,0,0,0,0]
    e2 = [0,0,0,0,0,1,1,1]
    for i, (a, b, c) in enumerate(combos):
        res = _run_vhdl(
            src,
            top="t",
            duration=40.0,
            stimuli=[
                {"port": "A", "kind": "constant", "value": a},
                {"port": "B", "kind": "constant", "value": b},
                {"port": "C", "kind": "constant", "value": c},
            ],
        )
        assert res["ok"] is True, res
        assert _norm_bin(res["final"]["y1"]) == str(e1[i])
        assert _norm_bin(res["final"]["y2"]) == str(e2[i])


def test_engine_t2_dff_async_reset_and_rising_edge():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all;
        entity t is port(clk,reset,d: in std_logic; q: out std_logic); end t;
        architecture a of t is
        begin
          process(clk,reset)
          begin
            if reset='1' then q <= '0';
            elsif rising_edge(clk) then q <= d;
            end if;
          end process;
        end a;
    """)
    res = _run_vhdl(
        src,
        top="t",
        duration=120.0,
        clock_period=20.0,
        reset_cycles=2,
        reset_active_high=True,
        stimuli=[{"port": "d", "kind": "constant", "value": 1}],
    )
    assert res["ok"] is True, res
    assert _norm_bin(res["final"]["q"]) == "1"


def test_engine_t3_numeric_std_counter_aggregate():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
        entity t is port(clk,rst: in std_logic; cnt: out std_logic_vector(7 downto 0)); end t;
        architecture a of t is
          signal r : unsigned(7 downto 0) := (others => '0');
        begin
          process(clk)
          begin
            if rising_edge(clk) then
              if rst='1' then r <= (others => '0');
              else r <= r + 1;
              end if;
            end if;
          end process;
          cnt <= std_logic_vector(r);
        end a;
    """)
    # 2 reset cycles (40ns) + 5 active cycles (100ns) = 140ns -> cnt = 5
    res = _run_vhdl(
        src,
        top="t",
        duration=140.0,
        clock_period=20.0,
        reset_cycles=2,
        reset_active_high=True,
    )
    assert res["ok"] is True, res
    assert int(res["final"]["cnt"]) == 5


def test_engine_t5_selected_signal_assign():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all;
        entity t is port(sel: in std_logic_vector(1 downto 0); y: out std_logic_vector(3 downto 0)); end t;
        architecture a of t is
        begin
          with sel select y <=
            "0001" when "00",
            "0010" when "01",
            "0100" when "10",
            "1000" when others;
        end a;
    """)
    for sel_val, expected in [(0, "0001"), (1, "0010"), (2, "0100"), (3, "1000")]:
        res = _run_vhdl(
            src,
            top="t",
            duration=40.0,
            stimuli=[{"port": "sel", "kind": "constant", "value": sel_val}],
        )
        assert res["ok"] is True, res
        assert _norm_bin(res["final"]["y"], 4) == expected


def test_engine_t6_component_instantiation_double_inverter():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all;
        entity inv is port(a: in std_logic; b: out std_logic); end inv;
        architecture x of inv is begin b <= not a; end x;
        library ieee; use ieee.std_logic_1164.all;
        entity t is port(i: in std_logic; o: out std_logic); end t;
        architecture a of t is
          component inv port(a: in std_logic; b: out std_logic); end component;
          signal mid : std_logic;
        begin
          u1: inv port map(a => i, b => mid);
          u2: inv port map(a => mid, b => o);
        end a;
    """)
    for v in (1, 0):
        res = _run_vhdl(src, top="t", duration=40.0, stimuli=[{"port": "i", "kind": "constant", "value": v}])
        assert res["ok"] is True, res
        assert _norm_bin(res["final"]["o"]) == str(v)


def test_engine_t7_variables_and_range_loop_popcount():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
        entity t is port(d: in std_logic_vector(7 downto 0); ones: out std_logic_vector(3 downto 0)); end t;
        architecture a of t is
        begin
          process(d)
            variable c : integer := 0;
          begin
            c := 0;
            for i in d'range loop
              if d(i)='1' then c := c + 1; end if;
            end loop;
            ones <= std_logic_vector(to_unsigned(c,4));
          end process;
        end a;
    """)
    for val, exp in [(0b10110010, 4), (0b11111111, 8)]:
        res = _run_vhdl(src, top="t", duration=40.0, stimuli=[{"port": "d", "kind": "constant", "value": val}])
        assert res["ok"] is True, res
        assert int(res["final"]["ones"]) == exp


def test_engine_t8_jk_counter_per_element_drivers():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all;
        entity t is port(clk,rst: in std_logic; q: out std_logic_vector(2 downto 0)); end t;
        architecture a of t is
          signal qr : std_logic_vector(2 downto 0) := "000";
        begin
          process(clk,rst)
          begin
            if rst='1' then qr <= "000";
            elsif rising_edge(clk) then
              qr(0) <= not qr(0);
              qr(1) <= qr(1) xor qr(0);
              qr(2) <= qr(2) xor (qr(1) and qr(0));
            end if;
          end process;
          q <= qr;
        end a;
    """)
    res = _run_vhdl(src, top="t", duration=180.0, clock_period=20.0, reset_cycles=1, reset_active_high=True)
    assert res["ok"] is True, res
    # 1 reset cycle + 8 active rising edges -> wraps back to 000 after 001..111
    vals = [c["values"]["q"] for c in res["cycles"]]
    assert vals[-8:] == [1, 2, 3, 4, 5, 6, 7, 0]


def test_engine_t9_signed_arithmetic_and_integer_port():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
        entity t is port(a,b: in std_logic_vector(7 downto 0); s: out std_logic_vector(7 downto 0); diff: out integer); end t;
        architecture a of t is
        begin
          s <= std_logic_vector(signed(a) + signed(b));
          diff <= to_integer(signed(a)) - to_integer(signed(b));
        end a;
    """)
    res = _run_vhdl(
        src,
        top="t",
        duration=40.0,
        stimuli=[
            {"port": "a", "kind": "constant", "value": 0b11111011},  # -5
            {"port": "b", "kind": "constant", "value": 0b00000011},  # 3
        ],
    )
    assert res["ok"] is True, res
    assert _norm_bin(res["final"]["s"], 8) == "11111110"
    assert int(res["final"]["diff"]) == -8


def test_engine_t10_package_function_and_constant():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all;
        package p is
          constant W : integer := 4;
          function dbl(x: integer) return integer;
        end p;
        package body p is
          function dbl(x: integer) return integer is begin return x*2; end function;
        end p;
        library ieee; use ieee.std_logic_1164.all; use work.p.all;
        entity t is port(a: in integer; y: out integer); end t;
        architecture x of t is begin y <= dbl(a) + W; end x;
    """)
    res = _run_vhdl(src, top="t", duration=40.0, stimuli=[{"port": "a", "kind": "constant", "value": 3}])
    assert res["ok"] is True, res
    assert int(res["final"]["y"]) == 10


# ===========================================================================
# Adapted from fpga-lab/test/demo.mjs (bench_demo.vhd)
# ===========================================================================

BENCH_DEMO_SRC = textwrap.dedent("""\
    library ieee;
    use ieee.std_logic_1164.all;
    use ieee.numeric_std.all;

    entity bench_demo is
      port (
        clk       : in  std_logic;
        reset_btn : in  std_logic;
        s1        : in  std_logic;
        s2        : in  std_logic;
        s3        : in  std_logic;
        s4        : in  std_logic;
        led1      : out std_logic;
        led2      : out std_logic;
        led3      : out std_logic;
        led4      : out std_logic;
        dtube1    : out std_logic;
        dtube2    : out std_logic;
        dtube3    : out std_logic;
        dtube4    : out std_logic;
        seven_seg : out std_logic_vector(7 downto 0);
        beep      : out std_logic;
        uart_txd  : out std_logic
      );
    end entity bench_demo;

    architecture rtl of bench_demo is
      signal count : unsigned(23 downto 0) := (others => '0');
      signal scan  : unsigned(1 downto 0) := (others => '0');
      function hex_seg(n : unsigned(3 downto 0)) return std_logic_vector is
        variable s : std_logic_vector(7 downto 0);
      begin
        case to_integer(n) is
          when 0 => s := "11000000"; when 1 => s := "11111001";
          when 2 => s := "10100100"; when 3 => s := "10110000";
          when 4 => s := "10011001"; when 5 => s := "10010010";
          when 6 => s := "10000010"; when 7 => s := "11111000";
          when 8 => s := "10000000"; when 9 => s := "10010000";
          when 10 => s := "10001000"; when 11 => s := "10000011";
          when 12 => s := "11000110"; when 13 => s := "10100001";
          when 14 => s := "10000110"; when others => s := "10001110";
        end case;
        return s;
      end function hex_seg;
      signal nibble : unsigned(3 downto 0);
    begin
      uart_txd <= '1';
      process(clk)
      begin
        if rising_edge(clk) then
          if reset_btn = '0' then
            count <= (others => '0');
            scan <= (others => '0');
          else
            scan <= scan + 1;
            if s3 = '0' then count <= count - 1;
            elsif s1 = '0' then count <= count + 1;
            end if;
            if s2 = '0' then count(7 downto 0) <= (others => '0'); end if;
          end if;
        end if;
      end process;
      led1 <= '0' when s4 = '0' else not count(4);
      led2 <= '0' when s4 = '0' else not count(5);
      led3 <= '0' when s4 = '0' else not count(6);
      led4 <= '0' when s4 = '0' else not count(7);
      beep <= '1' when count(7 downto 0) = "11111111" else '0';
      with scan select dtube1 <= '0' when "00", '1' when others;
      with scan select dtube2 <= '0' when "01", '1' when others;
      with scan select dtube3 <= '0' when "10", '1' when others;
      with scan select dtube4 <= '0' when "11", '1' when others;
      with scan select nibble <=
        count(15 downto 12) when "00", count(11 downto 8) when "01",
        count(7 downto 4) when "10", count(3 downto 0) when others;
      seven_seg <= "10000000" when s4 = '0' else hex_seg(nibble);
    end architecture rtl;
""")


def test_demo_bench_demo_counter_display_leds_and_beep():
    # Run 300 enabled cycles (6000 ns at 20 ns clock) + 2 reset cycles (40 ns)
    res = _run_vhdl(
        BENCH_DEMO_SRC,
        top="bench_demo",
        duration=6040.0,
        clock_period=20.0,
        reset_cycles=2,
        reset_active_high=False,
        reset_port="reset_btn",
        stimuli=[
            {"port": "s1", "kind": "constant", "value": 0},
            {"port": "s2", "kind": "constant", "value": 1},
            {"port": "s3", "kind": "constant", "value": 1},
            {"port": "s4", "kind": "constant", "value": 1},
        ],
    )
    assert res["ok"] is True, res
    # Check active-low one-hot digit selection on every captured cycle
    for cyc in res["cycles"]:
        v = cyc["values"]
        active_digits = sum(1 for k in ("dtube1", "dtube2", "dtube3", "dtube4") if int(v[k]) == 0)
        assert active_digits == 1, f"expected 1 active digit, got {v}"
    # Overflow beep asserted when low byte hits 0xFF (cycle 255)
    beep_sig = next(s for s in res["signals"] if s["name"].lower() == "beep")
    assert any(int(val) == 1 for _, val in beep_sig["transitions"])

    # Lamp test (s4 = 0) lights all 7 segments + all active-low LEDs
    lamp = _run_vhdl(
        BENCH_DEMO_SRC,
        top="bench_demo",
        duration=80.0,
        clock_period=20.0,
        reset_cycles=1,
        reset_active_high=False,
        reset_port="reset_btn",
        stimuli=[
            {"port": "s1", "kind": "constant", "value": 1},
            {"port": "s2", "kind": "constant", "value": 1},
            {"port": "s3", "kind": "constant", "value": 1},
            {"port": "s4", "kind": "constant", "value": 0},
        ],
    )
    assert lamp["ok"] is True, lamp
    assert _norm_bin(lamp["final"]["seven_seg"], 8) == "10000000"
    for led in ("led1", "led2", "led3", "led4"):
        assert int(lamp["final"][led]) == 0


# ===========================================================================
# Adapted from fpga-lab/test/formats.mjs & importers.mjs
# ===========================================================================


def test_formats_vcd_qsf_and_uart():
    vcd_text = (
        "$date 0bad b101 fake #900 $end\n"
        "$comment Values in metadata must never become events: 1! #20 $end\n"
        "$timescale\n 10 ps\n$end\n"
        "$scope module tb $end\n"
        "$scope module dut $end\n"
        "$var wire 4 ! data [4:7] $end\n"
        "$var wire 1 # led1 $end\n"
        "$upscope $end $upscope $end $enddefinitions $end\n"
        "$dumpvars b1 ! 0# $end\n"
        "#2 bX !\n"
        "#4 b10 ! 1#\n"
    )
    vcd = parse_vcd_text(vcd_text)
    assert abs(vcd.timescale_ns - 0.01) < 1e-9
    data_sig = next(s for s in vcd.signals if "data" in s.name)
    assert data_sig.width == 4
    assert data_sig.transitions[-1][1] == 2  # b10 -> 2

    qsf_text = textwrap.dedent("""\
        set_global_assignment -name FAMILY "Cyclone IV E" # ignored
        set_global_assignment -name TOP_LEVEL_ENTITY {dut}
        set_global_assignment -name VHDL_FILE {folder/my # design.vhd} -library support
        set_location_assignment PIN_87 -to {leds[4]} -comment "Output LED"
        set_location_assignment -to "seven_seg[0]" PIN_128
        set_location_assignment PIN_88 \\
         -to {keys[4]}
    """)
    qsf = parse_qsf(qsf_text)
    assert qsf.ok is True, qsf.errors
    assert qsf.family == "Cyclone IV E"
    assert qsf.top == "dut"
    assert qsf.files[0][1] == "folder/my # design.vhd"
    assert qsf.bit_pins["leds"][4] == "PIN_87"
    assert qsf.bit_pins["seven_seg"][0] == "PIN_128"
    assert qsf.bit_pins["keys"][4] == "PIN_88"

    bad_qsf = parse_qsf("set_location_assignment PIN_145 -to a")
    assert not bad_qsf.ok or len(bad_qsf.errors) > 0

    # UART sparse transitions: 0x41 ('A'), 0x00, 0xFF at 100000 baud (10000 ns bit period)
    baud = 100000
    bit_ns = 1e9 / baud
    transitions = [(0.0, 1)]
    for i, byte in enumerate([0x41, 0x00, 0xFF]):
        t0 = (1 + i * 11) * bit_ns
        transitions.append((t0, 0))  # start bit
        for b in range(8):
            transitions.append((t0 + (b + 1) * bit_ns, (byte >> b) & 1))
        transitions.append((t0 + 9 * bit_ns, 1))  # stop bit
    transitions.append((40 * bit_ns, 1))
    uart = decode_uart(transitions, bit_time_ns=bit_ns)
    assert uart["bytes"] == [0x41, 0x00, 0xFF], uart
    uart_auto = decode_uart(transitions)
    assert uart_auto["bytes"] == [0x41, 0x00, 0xFF], uart_auto


def test_importers_snakegame_qsf():
    qsf_path = Path(
        r"C:\Users\rober\.gemini\antigravity\brain\84f62b85-ab96-4814-87b5-7a22d28b43ba\scratch\fpga-lab\research\SnakeGame.qsf"
    )
    if not qsf_path.is_file():
        pytest.skip("fpga-lab SnakeGame.qsf fixture not present")
    q = parse_qsf(qsf_path.read_text(encoding="utf-8", errors="replace"))
    assert q.family == "Cyclone IV E"
    assert q.device == "EP4CE6E22C8"
    assert q.top == "SnakeGame"
    assert q.pins.get("clk") == ["PIN_23"]
    assert q.pins.get("VGA_B") == ["PIN_144"]
    assert q.pins.get("reset") == ["PIN_58"]


# ===========================================================================
# Adapted from fpga-lab/test/native.mjs
# ===========================================================================


def test_native_64bit_unsigned_and_signed_arithmetic():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all; use ieee.numeric_std.all;
        entity dut is
          generic (W: positive := 64);
          port(a,b: in unsigned(W-1 downto 0); total: out unsigned(W-1 downto 0); signed_sum: out signed(W-1 downto 0));
        end;
        architecture rtl of dut is begin total <= a + b; signed_sum <= signed(a) + signed(b); end;
    """)
    res = _run_vhdl(
        src,
        top="dut",
        duration=40.0,
        generics={"W": 64},
        stimuli=[
            {"port": "a", "kind": "constant", "value": "0x" + "f" * 16},
            {"port": "b", "kind": "constant", "value": 1},
        ],
    )
    assert res["ok"] is True, res
    assert int(res["final"]["total"]) == 0
    assert int(res["final"]["signed_sum"]) == 0


def test_native_transport_delay_between_sampling_boundaries():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all;
        entity dut is port(a: in std_logic; y: out std_logic); end;
        architecture rtl of dut is begin y <= transport not a after 3 ns; end;
    """)
    res = _run_vhdl(src, top="dut", duration=10.0, stimuli=[{"port": "a", "kind": "constant", "value": 0}])
    assert res["ok"] is True, res
    y_sig = next(s for s in res["signals"] if s["name"].lower() == "y")
    assert any(abs(float(t) - 3.0) < 0.01 and int(v) == 1 for t, v in y_sig["transitions"]), y_sig


def test_native_nested_component_hierarchy():
    src = textwrap.dedent("""\
        entity child is port(a: in bit; y: out bit); end;
        architecture rtl of child is begin y <= a; end;
        entity dut is port(a: in bit; y: out bit); end;
        architecture rtl of dut is begin u: entity work.child port map(a,y); end;
    """)
    res = _run_vhdl(src, top="dut", duration=40.0, stimuli=[{"port": "a", "kind": "constant", "value": 1}])
    assert res["ok"] is True, res
    assert int(res["final"]["y"]) == 1


def test_native_syntax_error_rejected():
    res = _run_vhdl("entity dut is invalid syntax; end;", top="dut")
    assert res["ok"] is False
    assert len(res.get("errors") or []) > 0


def test_native_std_logic_9_value_semantics():
    src = textwrap.dedent("""\
        library ieee; use ieee.std_logic_1164.all;
        entity dut is port(a,b: in std_logic; y: out std_logic); end;
        architecture rtl of dut is begin y <= a and b; end;
    """)
    for a, b, expected in [("0", "X", "0"), ("1", "X", "X"), ("H", "L", "0"), ("Z", "1", "X")]:
        res = _run_vhdl(
            src,
            top="dut",
            duration=40.0,
            stimuli=[
                {"port": "a", "kind": "constant", "value": a},
                {"port": "b", "kind": "constant", "value": b},
            ],
        )
        assert res["ok"] is True, res
        assert str(res["final"]["y"]).upper() == expected


def test_native_scalar_generics_negative_bool_char_string():
    src = textwrap.dedent("""\
        entity dut is
          generic(N: integer := 1; FLAG: boolean := false; LETTER: character := 'x'; LABEL_TEXT: string := "none");
          port(y: out bit);
        end;
        architecture rtl of dut is
        begin
          y <= '1' when N=-2 and FLAG and LETTER='a' and LABEL_TEXT="hello, world" else '0';
        end;
    """)
    res = _run_vhdl(
        src,
        top="dut",
        duration=40.0,
        generics={"N": -2, "FLAG": True, "LETTER": "'a'", "LABEL_TEXT": "hello, world"},
    )
    assert res["ok"] is True, res
    assert int(res["final"]["y"]) == 1


# ===========================================================================
# Adapted from fpga-lab/test/api.mjs
# ===========================================================================


def test_api_health_compile_validation_and_traversal():
    with TestClient(app) as client:
        h = client.get("/api/health")
        assert h.status_code == 200
        assert h.json()["ok"] is True

        # Empty source produces structured 400 error
        empty = client.post("/api/compile", json={"vhdl": "", "files": []})
        assert empty.status_code == 400
        assert empty.json()["ok"] is False

        # Malformed JSON returns 422/400 without crashing
        malformed = client.post("/api/compile", content="{", headers={"Content-Type": "application/json"})
        assert malformed.status_code in (400, 422)

        # Static path traversal cannot escape frontend root
        trav = client.get("/%2e%2e/backend/server.py")
        assert trav.status_code in (400, 403, 404)

        # Valid compile + simulate works end to end
        src = "library ieee; use ieee.std_logic_1164.all; entity dut is port(a: in std_logic; y: out std_logic); end; architecture rtl of dut is begin y <= not a; end;"
        sim_res = client.post(
            "/api/simulate",
            json={"vhdl": src, "top": "dut", "duration": 40, "stimuli": [{"port": "a", "kind": "constant", "value": 0}]},
        )
        assert sim_res.status_code == 200
        assert sim_res.json()["ok"] is True
        assert int(sim_res.json()["waveforms"]["final"]["y"]) == 1
