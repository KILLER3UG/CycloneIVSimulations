import pytest

from backend.vhdl_parser import parse, tokenize


COUNTER = """library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter is
    port (
        clk   : in  std_logic;
        reset : in  std_logic;
        led   : out std_logic_vector(7 downto 0)
    );
end entity counter;

architecture rtl of counter is
    signal count : unsigned(7 downto 0) := (others => '0');
begin
    process (clk, reset)
    begin
        if reset = '1' then
            count <= (others => '0');
        elsif rising_edge(clk) then
            count <= count + 1;
        end if;
    end process;
    led <= std_logic_vector(count);
end architecture rtl;
"""


def test_counter_interface():
    design = parse(COUNTER)
    assert design.errors == []
    entity = design.primary
    assert entity is not None
    assert entity.name == "counter"
    assert [(p.name, p.direction, p.width) for p in entity.ports] == [
        ("clk", "in", 1),
        ("reset", "in", 1),
        ("led", "out", 8),
    ]


def test_multiple_names_and_generics():
    source = """
    entity thing is
        generic (
            WIDTH : integer := 4;
            DEPTH : integer := 16
        );
        port (
            a, b : in  std_logic;
            c    : out unsigned(WIDTH-1 downto 0);
            d    : out std_logic_vector(0 to 3)
        );
    end entity thing;
    """
    design = parse(source)
    assert design.errors == []
    entity = design.primary
    assert [g.name for g in entity.generics] == ["WIDTH", "DEPTH"]
    assert [p.name for p in entity.ports] == ["a", "b", "c", "d"]
    assert entity.ports[1].width == 1
    assert entity.ports[3].width == 4


def test_comments_and_strings_do_not_break_tokenizer():
    source = """
    -- entity fake is port (x : in std_logic); end entity;
    entity real is
        port (s : in string(1 to 3); c : in character);
    end entity real;
    """
    design = parse(source)
    assert design.errors == []
    assert [e.name for e in design.entities] == ["real"]


def test_tokenizer_records_line_numbers():
    tokens = tokenize("entity foo is\n  port (clk : in std_logic);\nend entity;")
    entity_token = next(t for t in tokens if t.value == "entity")
    assert entity_token.line == 1
    port_token = next(t for t in tokens if t.value == "port")
    assert port_token.line == 2


def test_integer_range_port():
    source = """
    entity digit is
        port (value : in integer range 0 to 9);
    end entity digit;
    """
    design = parse(source)
    assert design.primary.ports[0].left == 0
    assert design.primary.ports[0].right == 9
    assert design.primary.ports[0].width is None