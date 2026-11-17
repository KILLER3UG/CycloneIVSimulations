"""Unit tests for the combinational-loop lint (OUT-13)."""
from backend.lint import lint_combinational_loops


def test_vhdl_self_reference_is_flagged():
    source = """
architecture rtl of x is
    signal a : std_logic := '0';
begin
    a <= not a;
end architecture rtl;
"""
    warnings = lint_combinational_loops([("x.vhd", source)])
    assert warnings, "self-referential concurrent assignment not flagged"
    assert "loop" in warnings[0]["message"].lower()
    assert warnings[0]["line"] == 5


def test_vhdl_clocked_self_reference_is_not_a_loop():
    source = """
architecture rtl of x is
    signal q : unsigned(3 downto 0) := (others => '0');
begin
    process(clk)
    begin
        if rising_edge(clk) then
            q <= q + 1;
        end if;
    end process;
end architecture rtl;
"""
    assert lint_combinational_loops([("x.vhd", source)]) == []


def test_verilog_continuous_self_reference_is_flagged():
    source = """
module x(output a);
assign a = ~a;
endmodule
"""
    warnings = lint_combinational_loops([("x.v", source)])
    assert warnings and "loop" in warnings[0]["message"].lower()


def test_verilog_clock_about_not_flagged():
    source = """
module x(input clk, output reg [3:0] q);
always @(posedge clk) q <= q + 1;
endmodule
"""
    assert lint_combinational_loops([("x.v", source)]) == []


def test_no_false_positive_on_simple_wire():
    source = "architecture rtl of x is signal a, b : std_logic; begin b <= not a; end architecture rtl;"
    assert lint_combinational_loops([("x.vhd", source)]) == []