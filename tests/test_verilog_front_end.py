"""Phase 3 regressions: Verilog front-end lowering defects.

Each test pins a construct that used to be mistranslated to VHDL:

* ``{N{item}}`` replication — the count was never evaluated, so every
  replication expanded exactly once.
* scalar + scalar arithmetic — the context width was dropped (dead line), so
  ``a + b`` truncated to one bit (1+1 -> 0) instead of the assignment width.
* ``**`` in constant bounds — the tokenizer split it into two ``*`` tokens and
  the range silently collapsed to ``[0:0]`` (width 1).
"""
from __future__ import annotations

import pytest

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.simulator import SimulationRequest, Simulator

REP_DESIGN = """
module rep_test(input clk, output wire [11:0] led);
assign led = {3{4'b0011}};
endmodule
"""

REP_PARAM_DESIGN = """
module rep_param_test(input clk, output wire [7:0] led);
parameter W = 2;
assign led = {W{2'b10}};
endmodule
"""

ADD_DESIGN = """
module add_test(input clk, input [3:0] sw, output reg [7:0] led);
always @(*) led = sw[0] + sw[1];
endmodule
"""

ADD_WIDE_DESIGN = """
module add_wide_test(input clk, input [7:0] a, input [7:0] b, output reg [8:0] sum);
always @(*) sum = a + b;
endmodule
"""

POWER_DESIGN = """
module power_test(input clk, output reg [(2**3)-1:0] led);
always @(*) led = 8'hFF;
endmodule
"""


@pytest.fixture(scope="module")
def simulator():
    try:
        return Simulator()
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")


def _simulate(simulator: Simulator, source: str, name: str) -> dict:
    request = SimulationRequest.from_dict({
        "vhdl": source, "duration": 2000, "clockPeriod": 20,
    })
    result = simulator.simulate(request)
    assert result["ok"], (name, result.get("errors"))
    return result


def test_replication_expands_full_count(simulator):
    result = _simulate(simulator, REP_DESIGN, "rep_test")
    # {3{4'b0011}} = 0011_0011_0011 = 0x333 = 819
    assert result["waveforms"]["final"]["led"] == 0b001100110011


def test_replication_with_parameter_count(simulator):
    result = _simulate(simulator, REP_PARAM_DESIGN, "rep_param_test")
    # {2{2'b10}} = 1010 (zero-extended into led[7:0])
    assert result["waveforms"]["final"]["led"] == 0b1010


def test_scalar_add_uses_context_width(simulator):
    result = _simulate(simulator, ADD_DESIGN, "add_test")
    # sw = 0b0011 (default constant 0 inputs are overridden below) -> 1 + 1 = 2
    request = SimulationRequest.from_dict({
        "vhdl": ADD_DESIGN, "duration": 2000, "clockPeriod": 20,
        "constantInputs": {"sw": 0b0011},
    })
    result = simulator.simulate(request)
    assert result["ok"], result.get("errors")
    assert result["waveforms"]["final"]["led"] == 2, result["waveforms"]["final"]


def test_vector_add_extends_to_target_width(simulator):
    request = SimulationRequest.from_dict({
        "vhdl": ADD_WIDE_DESIGN, "duration": 2000, "clockPeriod": 20,
        "constantInputs": {"a": 200, "b": 100},
    })
    result = simulator.simulate(request)
    assert result["ok"], result.get("errors")
    # 200 + 100 = 300 needs all 9 bits of sum — no truncation to 8 bits.
    assert result["waveforms"]["final"]["sum"] == 300, result["waveforms"]["final"]


def test_power_operator_in_constant_bounds(simulator):
    result = _simulate(simulator, POWER_DESIGN, "power_test")
    final = result["waveforms"]["final"]
    # The port itself must be 8 bits wide ([2**3-1:0]) and hold 255.
    led_port = next(p for p in result["entity"]["ports"] if p["name"] == "led")
    assert led_port["width"] == 8, led_port
    assert final["led"] == 255, final
