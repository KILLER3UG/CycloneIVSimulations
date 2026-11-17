"""Unit tests for the combinational-loop lint (OUT-13)."""
from backend.lint import lint_combinational_loops, lint_non_ascii, lint_sources


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

def test_non_ascii_code_character_is_flagged_with_position():
    # U+00A0 non-breaking space between 'y' and '<=' (invisible in the editor)
    source = "architecture rtl of x is signal y : std_logic; begin y\u00a0<= '1'; end architecture rtl;"
    warnings = lint_non_ascii([("x.vhd", source)])
    assert warnings, "non-breaking space in code not flagged"
    assert "U+00A0" in warnings[0]["message"]
    assert warnings[0]["line"] == 1 and warnings[0]["column"] > 1


def test_non_ascii_inside_comment_is_allowed():
    source = "architecture rtl of x is begin\n    y <= '1'; -- note: 5 \u00b5s pulse\nend architecture rtl;"
    assert lint_non_ascii([("x.vhd", source)]) == []


def test_smart_quote_is_flagged():
    source = "architecture rtl of x is begin\n    y <= \u20191\u2019;\nend architecture rtl;"
    warnings = lint_non_ascii([("x.vhd", source)])
    assert warnings and "U+2019" in warnings[0]["message"]


def test_clean_ascii_source_has_no_warnings():
    source = "architecture rtl of x is signal y : std_logic; begin y <= '1'; end architecture rtl;"
    assert lint_non_ascii([("x.vhd", source)]) == []


def test_verilog_comment_prefix_respected():
    source = "module x(output y); assign y = 1'b1; // \u00a0ok in comment\nendmodule"
    assert lint_non_ascii([("x.v", source)]) == []
