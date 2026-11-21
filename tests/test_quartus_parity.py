"""Quartus parity regression suite (audit TB-1 .. TB-8).

Each test replays a differential-verification case from the Quartus parity
audit through the real pipeline (parse -> auto testbench -> GHDL -> VCD ->
waveforms) and asserts the cycle-exact behaviour that ModelSim/Questa would
produce for the same RTL.  These are the always-runnable regressions; the
licenced ModelSim cross-check lives in tests/qa/test_quartus_differential.py.

Covered fixes:
* VCD vector metavalues (bUUUU / b1X0Z) survive parsing          (TB-6)
* signed buses render sign-extended                              (signed)
* incomplete-sensitivity lint + IEEE stale-output semantics      (TB-1)
* async active-low reset counters, VHDL and Verilog              (TB-2/TB-3)
* Moore FSM cycle outputs                                        (TB-4)
* common-anode 7-segment polarity + POV duty                     (TB-5)
* Verilog: casex wildcards, x/z literals, initial seeding,
  same-cycle clocked blocking assignments, '#' diagnostics       (TB-7)
* altpll multiply/divide ratio + delayed locked + inclk0 clock   (TB-8)
* multi-clock auto testbench drives every clock domain           (clocks)
* ascending (N to M) port-to-pin bit mapping                     (pins)
"""
from __future__ import annotations

import pytest

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.simulator import SimulationRequest, Simulator
from backend.vcd_parser import parse_vcd_text
from backend.vhdl_parser import VHDLParser
from backend.qsf_parser import parse_qsf
from backend.waveform import map_board


@pytest.fixture(scope="module")
def simulator():
    try:
        GhdlTool()
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")
    return Simulator()


def _collapse(transitions, cap=None):
    """Last value per timestamp (<= cap), consecutive duplicates removed."""
    out = []
    for t, v in sorted(transitions, key=lambda item: item[0]):
        if cap is not None and t > cap:
            break
        if isinstance(v, str):
            v = v.upper()
        if out and out[-1][0] == t:
            out[-1] = (t, v)
        else:
            out.append((t, v))
    deduped = []
    for t, v in out:
        if deduped and deduped[-1][1] == v:
            continue
        deduped.append((t, v))
    return deduped


def _signal(result, name):
    return next(s for s in result["waveforms"]["signals"] if s["name"] == name)


def _warnings(result):
    return [w.get("message", "") for w in result.get("warnings", [])]


# ---------------------------------------------------------------------------
# TB-1: combinational decoder with an incomplete sensitivity list (VHDL)
# ---------------------------------------------------------------------------

TB1_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
entity tb1_dec is
  port (sel : in std_logic_vector(1 downto 0);
        en  : in std_logic;
        y   : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of tb1_dec is
begin
  process (sel)   -- 'en' deliberately missing: the sim-vs-synthesis trap
  begin
    if en = '1' then
      case sel is
        when "00" => y <= "0001";
        when "01" => y <= "0010";
        when "10" => y <= "0100";
        when others => y <= "1000";
      end case;
    else
      y <= "0000";
    end if;
  end process;
end architecture;
"""


def test_tb1_incomplete_sensitivity_vhdl(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": TB1_VHDL,
        "duration": 150,
        "stimuli": [
            {"port": "sel", "kind": "sequence", "values": [0, 1, 2, 3], "periodCycles": 2},
            {"port": "en", "kind": "pulse_once", "values": [1, 0], "holdCycles": 5},
        ],
    }))
    assert result["ok"], result.get("errors")

    # New lint: the process reads 'en' but lists only (sel).
    assert any("incomplete sensitivity list" in m and "'en'" in m
               for m in _warnings(result)), _warnings(result)

    # IEEE semantics (== ModelSim): the process only resumes on 'sel' events,
    # so dropping 'en' at t=50 must NOT update y (stale 4) — the next update
    # happens at the next 'sel' change (t=60, with en already low -> 0).
    y = _signal(result, "y")["transitions"]
    assert _collapse(y) == [(0.0, 0), (20.0, 2), (40.0, 4), (60.0, 0)], _collapse(y)


# ---------------------------------------------------------------------------
# TB-2 / TB-3: 4-bit counter with asynchronous active-low reset
# ---------------------------------------------------------------------------

TB2_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity tb2_cnt is
  port (clk : in std_logic; rst_n : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of tb2_cnt is
  signal c : unsigned(3 downto 0) := (others => '0');
begin
  process (clk, rst_n)
  begin
    if rst_n = '0' then
      c <= (others => '0');
    elsif rising_edge(clk) then
      c <= c + 1;
    end if;
  end process;
  q <= c;
end architecture;
"""

TB3_VERILOG = """
module tb3_cnt(input clk, input rst_n, output reg [3:0] q);
always @(posedge clk or negedge rst_n) begin
  if (!rst_n) q <= 4'd0;
  else q <= q + 1;
end
endmodule
"""


def _counter_request(vhdl=None, files=None):
    payload = {
        "duration": 120,
        "clockPeriod": 10,
        "resetCycles": 2,
        "resetActiveHigh": False,
        "resetPort": "rst_n",
        "maxCycles": 16,
    }
    if vhdl is not None:
        payload["vhdl"] = vhdl
    if files is not None:
        payload["files"] = files
    return SimulationRequest.from_dict(payload)


def _assert_counter_cycles(result):
    assert result["ok"], result.get("errors")
    cycles = result["waveforms"]["cycles"]
    values = [c["values"]["q"] for c in cycles]
    # Reset released after 2 cycles (t=20 ns): q stays 0 for the first two
    # rising edges, then counts 1, 2, 3, ... — identical in ModelSim.
    assert values[:10] == [0, 0, 1, 2, 3, 4, 5, 6, 7, 8], values[:10]


def test_tb2_async_rstn_counter_vhdl(simulator):
    _assert_counter_cycles(simulator.simulate(_counter_request(vhdl=TB2_VHDL)))


def test_tb3_async_rstn_counter_verilog(simulator):
    _assert_counter_cycles(simulator.simulate(
        _counter_request(files=[{"name": "tb3_cnt.v", "content": TB3_VERILOG}])))


# ---------------------------------------------------------------------------
# TB-4: Moore FSM (red -> green -> yellow -> red), cycle-exact outputs
# ---------------------------------------------------------------------------

TB4_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
entity tb4_fsm is
  port (clk : in std_logic; rst : in std_logic; led : out std_logic_vector(2 downto 0));
end entity;
architecture rtl of tb4_fsm is
  type state_t is (RED, GREEN, YELLOW);
  signal state : state_t := RED;
begin
  process (clk, rst)
  begin
    if rst = '1' then
      state <= RED;
    elsif rising_edge(clk) then
      case state is
        when RED => state <= GREEN;
        when GREEN => state <= YELLOW;
        when YELLOW => state <= RED;
      end case;
    end if;
  end process;
  led <= "100" when state = RED else "010" when state = GREEN else "001";
end architecture;
"""


def test_tb4_moore_fsm_cycles(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": TB4_VHDL, "duration": 100, "clockPeriod": 10, "resetCycles": 1,
    }))
    assert result["ok"], result.get("errors")
    cycles = result["waveforms"]["cycles"]
    values = [c["values"]["led"] for c in cycles]
    # Reset (1 cycle) then RED -> GREEN -> YELLOW -> ... one state per edge.
    assert values[:7] == [4, 2, 1, 4, 2, 1, 4], values[:7]


# ---------------------------------------------------------------------------
# TB-5: common-anode 7-segment multiplexer — polarity + POV duty
# ---------------------------------------------------------------------------

TB5_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity tb5_seg is
  port (clk : in std_logic;
        dtube : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0));
end entity;
architecture rtl of tb5_seg is
  signal cnt : unsigned(1 downto 0) := (others => '0');
begin
  process (clk)
  begin
    if rising_edge(clk) then
      cnt <= cnt + 1;
    end if;
  end process;
  process (cnt)
  begin
    dtube <= "1111";
    dtube(to_integer(cnt)) <= '0';          -- active-low digit select
  end process;
  process (cnt)
  begin
    case cnt is
      when "00" => seven_seg <= "1111001";  -- 1  (b,c)
      when "01" => seven_seg <= "0100100";  -- 2  (a,b,d,e,g)
      when "10" => seven_seg <= "0110000";  -- 3  (a,b,c,d,g)
      when others => seven_seg <= "0011001";  -- 4 (b,c,f,g)
    end case;
  end process;
end architecture;
"""


def test_tb5_sevseg_polarity_and_pov(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": TB5_VHDL, "duration": 320, "clockPeriod": 10,
    }))
    assert result["ok"], result.get("errors")
    image = result["waveforms"]["boardImage"]
    # Each tube shows its own digit (tube d <- digit d+1) at ~25 % duty (the
    # capture spans whole 4-edge scans plus the 2-cycle run-out, so the duty
    # is within a few percent of exactly 1/4).  Assert the lit-segment SET per
    # tube (polarity + segBitMap) and the approximate duty.
    digit_segments = {
        0: {1, 2},          # digit 1 -> segments b, c
        1: {0, 1, 3, 4, 6},  # digit 2 -> a, b, d, e, g
        2: {0, 1, 2, 3, 6},  # digit 3 -> a, b, c, d, g
        3: {1, 2, 5, 6},     # digit 4 -> b, c, f, g
    }
    pov = image["pov"]
    for tube in range(4):
        for seg in range(8):
            duty = pov[tube * 8 + seg]
            if seg in digit_segments[tube]:
                assert 0.2 <= duty <= 0.3, (tube, seg, duty)
            else:
                assert duty == 0.0, (tube, seg, duty)
    assert image["povBits"][1 * 8 + 0] == 1
    # Full scan = 4 clock edges = 40 ns -> 25 MHz refresh.
    assert abs(image["scanHz"] - 25_000_000.0) < 1.0, image["scanHz"]


# ---------------------------------------------------------------------------
# TB-6: metavalues — uninitialized vectors, tri-state, contention
# ---------------------------------------------------------------------------

TB6_UNINIT = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity tb6_uninit is
  port (clk : in std_logic; q : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of tb6_uninit is
  signal cnt : std_logic_vector(3 downto 0);
begin
  process (clk)
  begin
    if rising_edge(clk) then
      cnt <= std_logic_vector(unsigned(cnt) + 1);
    end if;
  end process;
  q <= cnt;
end architecture;
"""

TB6_TRISTATE = """
library ieee;
use ieee.std_logic_1164.all;
entity tb6_tri is
  port (d : in std_logic; en : in std_logic; q : out std_logic);
end entity;
architecture rtl of tb6_tri is
begin
  q <= d when en = '1' else 'Z';
end architecture;
"""

TB6_CONTENTION = """
library ieee;
use ieee.std_logic_1164.all;
entity tb6_contend is
  port (q : out std_logic);
end entity;
architecture rtl of tb6_contend is
  signal s : std_logic;
begin
  s <= '1';
  s <= '0';
  q <= s;
end architecture;
"""


def test_tb6_uninitialized_vector_visible(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": TB6_UNINIT, "duration": 60, "clockPeriod": 10}))
    assert result["ok"], result.get("errors")
    q = _signal(result, "q")["transitions"]
    # The VCD's initial bUUUU dump must survive parsing (was silently dropped).
    assert _collapse(q)[:2] == [(0.0, "UUUU"), (5.0, "XXXX")], _collapse(q)


def test_tb6_tristate_z(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": TB6_TRISTATE, "duration": 50, "constantInputs": {"d": 0, "en": 0}}))
    assert result["ok"], result.get("errors")
    assert _collapse(_signal(result, "q")["transitions"]) == [(0.0, "Z")]


def test_tb6_contention_x_and_warning(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": TB6_CONTENTION, "duration": 50}))
    assert result["ok"], result.get("errors")
    assert _collapse(_signal(result, "q")["transitions"]) == [(0.0, "X")]
    assert any("multiple drivers" in m for m in _warnings(result)), _warnings(result)


# ---------------------------------------------------------------------------
# TB-7: Verilog parity bundle
# ---------------------------------------------------------------------------

TB7_CASEX = """
module casex_probe(input [1:0] sel, output reg y);
always @(*) begin
  casex (sel)
    2'b1x: y = 1'b1;
    default: y = 1'b0;
  endcase
end
endmodule
"""

TB7_XZ = """
module xz_probe(input [3:0] a, output reg [3:0] y);
always @(*) y = 4'b1x0z & a;
endmodule
"""

TB7_INITIAL = """
module init_probe(input clk, output reg [3:0] q);
initial q = 4'b1010;
always @(posedge clk) q <= q + 1;
endmodule
"""

TB7_BLOCKING = """
module blk2(input clk, output reg [3:0] a = 0, output reg [3:0] b = 0);
always @(posedge clk) begin
  a = a + 1;
  b = a;
end
endmodule
"""

TB7_DELAY = """
module dly_probe(output reg clk, output reg [1:0] cnt);
always #5 clk = ~clk;
always @(posedge clk) cnt <= cnt + 1;
endmodule
"""


def test_tb7_casex_wildcard_matches(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "files": [{"name": "casex_probe.v", "content": TB7_CASEX}],
        "duration": 100, "constantInputs": {"sel": 2},  # 2'b10 matches 2'b1x
    }))
    assert result["ok"], result.get("errors")
    assert result["waveforms"]["final"]["y"] == 1


def test_tb7_casex_non_match_uses_default(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "files": [{"name": "casex_probe.v", "content": TB7_CASEX}],
        "duration": 100, "constantInputs": {"sel": 1},  # 2'b01 does not match 2'b1x
    }))
    assert result["ok"], result.get("errors")
    assert result["waveforms"]["final"]["y"] == 0


def test_tb7_xz_literal_compiles_and_evaluates(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "files": [{"name": "xz_probe.v", "content": TB7_XZ}],
        "duration": 100, "constantInputs": {"a": 15},
    }))
    assert result["ok"], result.get("errors")
    # 4'b1x0z & 4'b1111 = 1,X,0,X — same as ModelSim's bitwise meta-table.
    assert result["waveforms"]["final"]["y"] == "1X0X"


def test_tb7_initial_seeding(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "files": [{"name": "init_probe.v", "content": TB7_INITIAL}],
        "duration": 100, "clockPeriod": 10,
    }))
    assert result["ok"], result.get("errors")
    q = _collapse(_signal(result, "q")["transitions"])
    # initial q = 4'b1010 -> counts 10, 11, 12, ... (was silently dropped before).
    assert q[:4] == [(0.0, 10), (5.0, 11), (15.0, 12), (25.0, 13)], q[:4]


def test_tb7_blocking_same_cycle(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "files": [{"name": "blk2.v", "content": TB7_BLOCKING}],
        "duration": 120, "clockPeriod": 10,
    }))
    assert result["ok"], result.get("errors")
    a = _collapse(_signal(result, "a")["transitions"])
    b = _collapse(_signal(result, "b")["transitions"])
    # Blocking semantics: b sees the NEW a in the same cycle (b == a always),
    # exactly like ModelSim.  Before the fix b lagged a by one cycle.
    assert a == b
    assert a[:4] == [(0.0, 0), (5.0, 1), (15.0, 2), (25.0, 3)], a[:4]


def test_tb7_delay_diagnostic(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "files": [{"name": "dly_probe.v", "content": TB7_DELAY}],
        "duration": 100,
    }))
    assert not result["ok"]
    messages = [e.get("message", "") for e in result.get("errors", [])]
    assert any("#' delays are not supported" in m for m in messages), messages


# ---------------------------------------------------------------------------
# TB-8: altpll ratio, inclk0 clock detection, delayed locked
# ---------------------------------------------------------------------------

TB8_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
entity pll_user is
  port (inclk0 : in std_logic; c0 : out std_logic; locked : out std_logic);
end entity;
architecture rtl of pll_user is
  component altpll is
    generic (inclk0_input_frequency : natural := 50;
             clk0_multiply_by : natural := 1;
             clk0_divide_by : natural := 1);
    port (inclk0 : in std_logic; areset : in std_logic := '0';
          c0 : out std_logic; locked : out std_logic);
  end component;
begin
  u : altpll generic map (inclk0_input_frequency => 50, clk0_multiply_by => 2, clk0_divide_by => 1)
             port map (inclk0 => inclk0, c0 => c0, locked => locked);
end architecture;
"""


def test_tb8_altpll_ratio_and_lock(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": TB8_VHDL, "duration": 400, "clockPeriod": 20,
    }))
    assert result["ok"], result.get("errors")
    c0 = _collapse(_signal(result, "c0")["transitions"])
    # c0 = inclk0 * 2: 20 ns input -> 10 ns output period (5 ns half period).
    # The oscillator starts after the two measurement edges (t=30 ns).
    late = [t for t, _v in c0 if t >= 40]
    diffs = [round(b - a, 3) for a, b in zip(late, late[1:])]
    assert diffs, c0
    assert all(abs(d - 5.0) < 1e-6 for d in diffs), diffs
    # locked asserts after 8 clean input edges (t = 10 + 7*20 = 150 ns).
    locked = _collapse(_signal(result, "locked")["transitions"])
    assert locked == [(0.0, 0), (150.0, 1)], locked


# ---------------------------------------------------------------------------
# Clock detection: inclk0 recognized + multi-clock warning + both driven
# ---------------------------------------------------------------------------

DUAL_CLK_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity dual_clk is
  port (clk_a, clk_b : in std_logic;
        qa : out unsigned(3 downto 0);
        qb : out unsigned(3 downto 0));
end entity;
architecture rtl of dual_clk is
  signal ca, cb : unsigned(3 downto 0) := (others => '0');
begin
  process (clk_a) begin
    if rising_edge(clk_a) then ca <= ca + 1; end if;
  end process;
  process (clk_b) begin
    if rising_edge(clk_b) then cb <= cb + 1; end if;
  end process;
  qa <= ca; qb <= cb;
end architecture;
"""


def test_multi_clock_domains_both_driven(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": DUAL_CLK_VHDL, "duration": 120, "clockPeriod": 10,
    }))
    assert result["ok"], result.get("errors")
    assert any("2 clock inputs detected" in m and "clk_a" in m and "clk_b" in m
               for m in _warnings(result)), _warnings(result)
    # Before the fix clk_b was never driven and qb stayed frozen at 0.
    assert result["waveforms"]["final"]["qb"] > 0
    assert result["waveforms"]["final"]["qa"] == result["waveforms"]["final"]["qb"]


def test_inclk0_detected_as_clock(simulator):
    # The altpll design above names its clock 'inclk0' — it must be detected
    # and driven by the auto testbench without an explicit clockPort.
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": TB8_VHDL, "duration": 200, "clockPeriod": 20,
    }))
    assert result["ok"], result.get("errors")
    inclk0 = _collapse(_signal(result, "inclk0")["transitions"])
    assert len([t for t, _v in inclk0 if t > 0]) >= 5  # really toggling


# ---------------------------------------------------------------------------
# Signed bus rendering
# ---------------------------------------------------------------------------

SIGNED_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity sgn_cnt is
  port (clk : in std_logic; q : out signed(7 downto 0));
end entity;
architecture rtl of sgn_cnt is
  signal c : signed(7 downto 0) := to_signed(-3, 8);
begin
  process (clk)
  begin
    if rising_edge(clk) then
      c <= c + 1;
    end if;
  end process;
  q <= c;
end architecture;
"""


def test_signed_bus_renders_negative_values(simulator):
    result = simulator.simulate(SimulationRequest.from_dict({
        "vhdl": SIGNED_VHDL, "duration": 100, "clockPeriod": 10,
    }))
    assert result["ok"], result.get("errors")
    sig = _signal(result, "q")
    assert sig.get("signed") is True
    values = _collapse(sig["transitions"])
    # -3, -2, -1, 0, 1 ... — not 253, 254, 255 (raw two's-complement bytes).
    assert values[:5] == [(0.0, -3), (5.0, -2), (15.0, -1), (25.0, 0), (35.0, 1)], values[:5]


# ---------------------------------------------------------------------------
# Ascending (N to M) port-to-pin mapping
# ---------------------------------------------------------------------------

ASC_VHDL = """
entity asc_probe is
  port (key : in std_logic_vector(2 to 5);
        led : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of asc_probe is
begin
  led <= not key;
end architecture;
"""

ASC_QSF = """
set_location_assignment PIN_88 -to key[2]
set_location_assignment PIN_89 -to key[3]
set_location_assignment PIN_90 -to key[4]
set_location_assignment PIN_91 -to key[5]
set_location_assignment PIN_87 -to led[0]
set_location_assignment PIN_86 -to led[1]
set_location_assignment PIN_85 -to led[2]
set_location_assignment PIN_84 -to led[3]
"""


def test_ascending_range_pin_mapping():
    entity = VHDLParser().parse(ASC_VHDL).entities[0]
    parsed = parse_qsf(ASC_QSF)
    board = map_board(entity, parsed.pins, bit_pins=parsed.bit_pins)
    # pins lists are ordered by VALUE bit (bit 0 = LSB).  For (2 to 5) the
    # LSB is element 5, so value-bit 0 -> key[5] -> PIN_91.
    assert board.pins["key"] == ["PIN_91", "PIN_90", "PIN_89", "PIN_88"]
    assert board.pins["led"] == ["PIN_87", "PIN_86", "PIN_85", "PIN_84"]
    # Element 2 (the MSB, value bit 3) must land on the pin the QSF gave key[2].
    assert board.pins["key"][3] == "PIN_88"


# ---------------------------------------------------------------------------
# VCD parser: 9-state vector values survive
# ---------------------------------------------------------------------------

def test_vcd_vector_metavalues_survive():
    text = "\n".join([
        "$timescale", "  1 fs", "$end",
        "$scope module tb $end",
        "$var reg 4 ! q[3:0] $end",
        "$enddefinitions $end",
        "#0",
        "bUUUU !",
        "#5000000",
        "b1X0Z !",
        "#10000000",
        "b01WL !",
        "",
    ])
    data = parse_vcd_text(text)
    signal = data.signals[0]
    values = [(t, v.upper() if isinstance(v, str) else v) for t, v in signal.transitions]
    assert values == [(0.0, "UUUU"), (5.0, "1X0Z"), (10.0, "01WL")]
