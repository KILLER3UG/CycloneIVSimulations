from backend.testbench_gen import TestbenchConfig, generate_testbench
from backend.vhdl_parser import parse


COUNTER = """library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity counter is
    port (clk : in std_logic; reset : in std_logic; led : out std_logic_vector(7 downto 0));
end entity counter;
architecture rtl of counter is
begin
    led <= (others => '0');
end architecture rtl;
"""


def test_counter_testbench_structure():
    entity = parse(COUNTER).primary
    tb = generate_testbench(entity, TestbenchConfig(duration_ns=200, clock_period_ns=10, reset_cycles=2))
    assert "entity tb_counter is" in tb
    assert "architecture sim of tb_counter is" in tb
    assert "uut : entity work.counter" in tb
    assert "clk => clk" in tb and "reset => reset" in tb and "led => led" in tb
    assert "clk_gen : process" in tb
    assert "reset_gen : process" in tb
    assert "wait for 200 ns" in tb
    assert "signal clk : std_logic := '0';" in tb


def test_reset_active_low_detection():
    source = COUNTER.replace("reset : in std_logic", "reset_n : in std_logic")
    entity = parse(source).primary
    tb = generate_testbench(entity, TestbenchConfig(duration_ns=100, clock_period_ns=10, reset_cycles=2))
    assert "reset_n <= '0';" in tb
    assert "reset_n <= '1';" in tb


def test_combinational_design_has_no_clock_process():
    source = """library ieee;
use ieee.std_logic_1164.all;
entity seven_segment is
    port (sw : in std_logic_vector(3 downto 0); hex0 : out std_logic_vector(6 downto 0));
end entity seven_segment;
architecture rtl of seven_segment is
begin
    hex0 <= (others => '0');
end architecture rtl;
"""
    entity = parse(source).primary
    tb = generate_testbench(entity, TestbenchConfig(duration_ns=20))
    assert "clk_gen : process" not in tb
    assert "sw <= " in tb
    assert "STEP_TIME" in tb


def test_generic_dependent_range_is_resolved():
    source = """library ieee;
use ieee.std_logic_1164.all;
entity wide is
    generic (WIDTH : integer := 4);
    port (clk : in std_logic; led : out std_logic_vector(WIDTH-1 downto 0));
end entity wide;
architecture rtl of wide is
begin
    led <= (others => '0');
end architecture rtl;
"""
    entity = parse(source).primary
    tb = generate_testbench(entity, TestbenchConfig(generics={"WIDTH": 8}))
    assert "signal led : std_logic_vector(7 downto 0);" in tb
    assert "generic map (" in tb
    assert "WIDTH => 8" in tb