from pathlib import Path

import pytest

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.simulator import SimulationRequest, Simulator

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


@pytest.fixture(scope="module")
def simulator():
    try:
        GhdlTool()
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")
    return Simulator()


def test_counter_simulation(simulator):
    source = (EXAMPLES / "counter.vhd").read_text(encoding="utf-8")
    result = simulator.simulate(SimulationRequest.from_dict({"vhdl": source, "duration": 200}))
    assert result["ok"], result.get("errors")
    waveform = result["waveforms"]
    assert waveform["duration"] == 200
    assert result["entity"]["name"] == "counter"
    assert [s["name"] for s in waveform["signals"]][:3] == ["clk", "reset", "led"]
    assert len(waveform["cycles"]) > 0
    assert waveform["final"]["led"] == waveform["final"]["count"]


def test_seven_segment_stimulus(simulator):
    source = (EXAMPLES / "seven_segment.vhd").read_text(encoding="utf-8")
    result = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": source,
                "duration": 20,
                "stimuli": [{"port": "sw", "kind": "constant", "value": 1}],
            }
        )
    )
    assert result["ok"], result.get("errors")
    assert result["waveforms"]["final"]["hex0"] == 0b1111001


def test_gated_counter_toggle(simulator):
    source = (EXAMPLES / "gated_counter.vhd").read_text(encoding="utf-8")
    result = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": source,
                "duration": 200,
                "stimuli": [{"port": "enable", "kind": "toggle", "periodCycles": 3}],
            }
        )
    )
    assert result["ok"], result.get("errors")
    enable = next(s for s in result["waveforms"]["signals"] if s["name"] == "enable")
    assert len(enable["transitions"]) > 2
    assert result["waveforms"]["final"]["count"] > 0


def test_custom_testbench(simulator):
    design = (EXAMPLES / "counter.vhd").read_text(encoding="utf-8")
    testbench = """library ieee;
use ieee.std_logic_1164.all;
entity tb_custom is
end entity tb_custom;
architecture sim of tb_custom is
    signal clk : std_logic := '0';
    signal reset : std_logic := '1';
    signal led : std_logic_vector(7 downto 0);
begin
    uut : entity work.counter port map (clk => clk, reset => reset, led => led);
    clk_proc : process
    begin
        clk <= not clk;
        wait for 5 ns;
    end process;
    stim : process
    begin
        wait for 25 ns;
        reset <= '0';
        wait;
    end process;
end architecture sim;
"""
    result = simulator.simulate(
        SimulationRequest.from_dict({"vhdl": design, "testbench": testbench, "top": "tb_custom", "duration": 100})
    )
    assert result["ok"], result.get("errors")
    assert result["top"] == "tb_custom"
    assert result["waveforms"]["final"]["led"] > 0


def test_mixed_case_ports_and_board_mapping(simulator):
    source = """library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity de0_nano is
    port (
        CLOCK_50 : in  std_logic;
        KEY      : in  std_logic_vector(1 downto 0);
        LED      : out std_logic_vector(9 downto 0);
        HEX0     : out std_logic_vector(6 downto 0)
    );
end entity de0_nano;
architecture rtl of de0_nano is
    signal counter : unsigned(25 downto 0) := (others => '0');
begin
    process (CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            counter <= counter + 1;
        end if;
    end process;
    LED <= std_logic_vector(counter(25 downto 16));
    HEX0 <= "1000000";
end architecture rtl;
"""
    result = simulator.simulate(SimulationRequest.from_dict({"vhdl": source, "duration": 100}))
    assert result["ok"], result.get("errors")
    assert result["board"]["clock"] == "CLOCK_50"
    assert result["board"]["leds"] == ["LED"]
    assert result["board"]["buttons"] == ["KEY"]
    assert result["board"]["displays"] == ["HEX0"]
    assert len(result["waveforms"]["cycles"]) == 10
    assert result["waveforms"]["final"]["HEX0"] == 0b1000000


def test_compile_error_is_reported(simulator):
    result = simulator.compile_source("entity broken is end entity")
    assert result["ok"] is False
    assert result["errors"]


def test_no_entity_is_reported(simulator):
    result = simulator.compile_source("-- only a comment")
    assert result["ok"] is False
    assert any("entity" in e["message"].lower() for e in result["errors"])