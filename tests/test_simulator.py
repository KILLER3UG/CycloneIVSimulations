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


def test_compact_board_image_static(simulator):
    """Compact refresh returns a board image, not per-cycle samples."""
    source = """library ieee;
use ieee.std_logic_1164.all;
entity seg_static is
    port (
        clk : in  std_logic;
        seg : out std_logic_vector(6 downto 0);
        dig : out std_logic_vector(3 downto 0)
    );
end entity seg_static;
architecture rtl of seg_static is
begin
    seg <= "0000000";   -- all seven segments active (active-low)
    dig <= "1110";      -- tube 0 selected (active-low)
end architecture rtl;
"""
    result = simulator.simulate(
        SimulationRequest.from_dict({"vhdl": source, "duration": 100, "compactBoard": True})
    )
    assert result["ok"], result.get("errors")
    waveform = result["waveforms"]
    assert waveform.get("cycles", []) == []  # compact: no per-cycle samples shipped
    image = waveform["boardImage"]
    assert len(image["pov"]) == 32
    # tube 0 shows a-g, dp (SEG7) is undriven (weak pull-up = off); others dark
    assert image["povBits"][0:8] == [1, 1, 1, 1, 1, 1, 1, 0]
    assert image["povBits"][8:32] == [0] * 24
    # static (non-multiplexed) drive -> 100% duty on the lit segments
    assert image["pov"][0:7] == [1.0] * 7
    assert image["digits"] == [1, 0, 0, 0]
    assert image["scanHz"] == 0.0


def test_compact_board_image_multiplexed(simulator):
    """A multiplexed design integrates four different glyphs into the POV."""
    design = Path(__file__).resolve().parent / "qa" / "designs" / "board" / "seg_mux4sel.vhd"
    if not design.exists():
        pytest.skip("seg_mux4sel design not present")
    result = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": design.read_text(encoding="utf-8"),
                "top": "seg_mux4sel",
                "duration": 400,
                "compactBoard": True,
                "maxCycles": 100,
            }
        )
    )
    assert result["ok"], result.get("errors")
    image = result["waveforms"]["boardImage"]
    assert result["waveforms"].get("cycles", []) == []
    bits = image["povBits"]
    tubes = [tuple(bits[d * 8 : d * 8 + 8]) for d in range(4)]
    # four distinct, non-empty tube patterns -> persistence of vision
    assert len(set(tubes)) == 4
    assert all(any(t) for t in tubes)
    # A3: 1-of-4 multiplexing -> each lit segment is on ~25% of its tube's
    # enabled time (duty-cycle brightness, not binary).
    duty = image["pov"]
    for d in range(4):
        lit = [duty[d * 8 + b] for b in range(8) if bits[d * 8 + b]]
        assert lit, f"tube {d} has no lit segments"
        assert all(0.2 <= v <= 0.3 for v in lit), (d, lit)
    assert image["scanHz"] > 0


def test_board_image_ghosting_without_blanking(simulator):
    """A3: digit select and segments changing on the same edge bleed.

    Without dead-time blanking the new segment pattern appears on the tube
    that was selected for the overlap sample. The image must record those
    ghost samples instead of hiding them.
    """
    source = """
library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use IEEE.NUMERIC_STD.ALL;
entity seg_ghost is
    port (
        clk : in  STD_LOGIC;
        seg : out STD_LOGIC_VECTOR(6 downto 0);
        dig : out STD_LOGIC_VECTOR(3 downto 0)
    );
end entity seg_ghost;
architecture rtl of seg_ghost is
    signal cnt : unsigned(1 downto 0) := (others => '0');
begin
    process(clk)
    begin
        if rising_edge(clk) then cnt <= cnt + 1; end if;
    end process;
    dig <= "1110" when cnt = "00" else
           "1101" when cnt = "01" else
           "1011" when cnt = "10" else
           "0111";
    with cnt select seg <= "0000000" when "00",
                          "1111111" when "01",
                          "0101010" when "10",
                          "1010101" when others;
end architecture rtl;
"""
    result = simulator.simulate(
        SimulationRequest.from_dict(
            {"vhdl": source, "duration": 120, "compactBoard": True, "maxCycles": 40}
        )
    )
    assert result["ok"], result.get("errors")
    image = result["waveforms"]["boardImage"]
    assert image["ghosts"], "expected ghost samples when digits + segments change together"
    for d, bit, t, intensity in image["ghosts"][:20]:
        assert 0 <= d < 4 and 0 <= bit < 8 and t >= 0
        assert 0 < intensity <= 0.25


def test_compact_board_image_led_polarity(simulator):
    """Active-low LEDs: a closed key (reads 0) lights its LED (key_led4)."""
    design = Path(__file__).resolve().parent / "qa" / "designs" / "board" / "key_led4.vhd"
    if not design.exists():
        pytest.skip("key_led4 design not present")
    result = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": design.read_text(encoding="utf-8"),
                "top": "key_led4",
                "duration": 100,
                "compactBoard": True,
                # key = 0b1110: key0 closed (reads 0), key1..3 open (read 1)
                "stimuli": [{"port": "key", "kind": "constant", "value": 14}],
            }
        )
    )
    assert result["ok"], result.get("errors")
    leds = result["waveforms"]["boardImage"]["leds"]
    assert leds[0] == 1, leds   # key0 closed -> LED1 lit
    assert leds[1:] == [0, 0, 0], leds  # open keys -> their LEDs dark


_MOD_CLK_CNT = """library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use IEEE.NUMERIC_STD.ALL;

entity clk_cnt is
    Port (
        clk : in  std_logic;
        sel : out std_logic_vector(1 downto 0)
    );
end clk_cnt;

architecture Behavioral of clk_cnt is
    signal cnt : unsigned(3 downto 0) := (others => '0');
begin
    process(clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;
    sel <= std_logic_vector(cnt(3 downto 2));
end Behavioral;
"""

_MOD_SEG_DRIVER = """library IEEE;
use IEEE.STD_LOGIC_1164.ALL;

entity seg_driver is
    Port (
        en        : in  std_logic;
        sel       : in  std_logic_vector(1 downto 0);
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_driver;

architecture Behavioral of seg_driver is
begin
    process(en, sel)
    begin
        if en = '0' then
            dtube <= "1111";
            seven_seg <= "1111111";
        elsif sel = "00" then
            dtube <= "0111";
            seven_seg <= "0010010";
        elsif sel = "01" then
            dtube <= "1011";
            seven_seg <= "0000010";
        elsif sel = "10" then
            dtube <= "1101";
            seven_seg <= "1111000";
        else
            dtube <= "1110";
            seven_seg <= "0000000";
        end if;
    end process;
end Behavioral;
"""

_MOD_SEVSEG_TOP = """library IEEE;
use IEEE.STD_LOGIC_1164.ALL;

entity sevseg is
    Port (
        clk       : in  std_logic;
        sw        : in  std_logic_vector(3 downto 0);
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end sevseg;

architecture logicgate of sevseg is
    signal pressed : std_logic_vector(3 downto 0);
    signal ncombi  : std_logic;
    signal sel     : std_logic_vector(1 downto 0);
begin
    pressed <= not sw;
    ncombi <= pressed(3) or (pressed(2) and (pressed(1) or pressed(0)));

    u_cnt : entity work.clk_cnt
        port map (
            clk => clk,
            sel => sel
        );

    u_drv : entity work.seg_driver
        port map (
            en => ncombi,
            sel => sel,
            dtube => dtube,
            seven_seg => seven_seg
        );
end logicgate;
"""

# pov[d*8:(d+1)*8] is indexed by DIG[d] bit (d=0 is dtube(0) rightmost -> '8', d=3 is dtube(3) leftmost -> '5').
_EXPECTED_5678_POV = [
    (1, 1, 1, 1, 1, 1, 1, 0),  # DIG0: '8'
    (1, 1, 1, 0, 0, 0, 0, 0),  # DIG1: '7'
    (1, 0, 1, 1, 1, 1, 1, 0),  # DIG2: '6'
    (1, 0, 1, 1, 0, 1, 1, 0),  # DIG3: '5'
]


@pytest.mark.parametrize("reverse_order", [False, True])
def test_modular_multi_file_sevseg(simulator, reverse_order):
    files = [
        {"name": "sevseg.vhd", "content": _MOD_SEVSEG_TOP},
        {"name": "clk_cnt.vhd", "content": _MOD_CLK_CNT},
        {"name": "seg_driver.vhd", "content": _MOD_SEG_DRIVER},
    ]
    if reverse_order:
        files = list(reversed(files))
    result = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "files": files,
                "duration": 320,
                "clockPeriod": 10,
                "maxCycles": 200,
                "compactBoard": True,
                "stimuli": [{"port": "sw", "kind": "constant", "value": 7}],
            }
        )
    )
    assert result["ok"], result.get("errors")
    assert result["entity"]["name"].lower() == "sevseg"
    assert "sevseg" in [e.lower() for e in result.get("entities", [])]
    pov = result["waveforms"]["boardImage"]["povBits"]
    tubes = [tuple(pov[d * 8 : d * 8 + 8]) for d in range(4)]
    assert tubes == _EXPECTED_5678_POV


def test_modular_single_file_top_down_sevseg(simulator):
    combined = "\n\n".join([_MOD_SEVSEG_TOP, _MOD_CLK_CNT, _MOD_SEG_DRIVER])
    result = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": combined,
                "duration": 320,
                "clockPeriod": 10,
                "maxCycles": 200,
                "compactBoard": True,
                "stimuli": [{"port": "sw", "kind": "constant", "value": 7}],
            }
        )
    )
    assert result["ok"], result.get("errors")
    assert result["entity"]["name"].lower() == "sevseg"
    pov = result["waveforms"]["boardImage"]["povBits"]
    tubes = [tuple(pov[d * 8 : d * 8 + 8]) for d in range(4)]
    assert tubes == _EXPECTED_5678_POV


def test_verilog_compile_and_simulate_my_and(simulator):
    v_path = Path(__file__).resolve().parent.parent / "board" / "vendor" / "examples" / "my_and" / "my_and.v"
    src = v_path.read_text(encoding="utf-8")
    comp = simulator.compile_source("", files=[{"name": "my_and.v", "content": src}])
    assert comp["ok"], comp.get("errors")
    assert comp["entity"]["name"].lower() == "my_and"

    res = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": "",
                "files": [{"name": "my_and.v", "content": src}],
                "duration": 20,
                "constantInputs": {"s1": 0, "s2": 0},
            }
        )
    )
    assert res["ok"], res.get("errors")
    assert res["waveforms"]["final"]["led1"] == 0


def test_verilog_compile_and_simulate_key_led(simulator):
    v_path = Path(__file__).resolve().parent.parent / "board" / "vendor" / "examples" / "key_led" / "key_led.v"
    src = v_path.read_text(encoding="gb18030")
    res_idle = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": "",
                "files": [{"name": "key_led.v", "content": src}],
                "duration": 20,
                "constantInputs": {"key": 0b1111},
            }
        )
    )
    assert res_idle["ok"], res_idle.get("errors")
    assert res_idle["waveforms"]["final"]["led"] == 0b1111

    res_k1 = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": "",
                "files": [{"name": "key_led.v", "content": src}],
                "duration": 20,
                "constantInputs": {"key": 0b1110},
            }
        )
    )
    assert res_k1["ok"], res_k1.get("errors")
    assert res_k1["waveforms"]["final"]["led"] == 0b1110


def test_verilog_multimodule_and_error_line_mapping(simulator):
    sub_v = """module inv_sub(
    input wire a,
    output wire y
);
    assign y = ~a;
endmodule
"""
    top_v = """module top_v(
    input wire sw0,
    output wire led0
);
    inv_sub u0(.a(sw0), .y(led0));
endmodule
"""
    res = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": "",
                "top": "top_v",
                "files": [
                    {"name": "inv_sub.v", "content": sub_v},
                    {"name": "top_v.v", "content": top_v},
                ],
                "duration": 20,
                "constantInputs": {"sw0": 0},
            }
        )
    )
    assert res["ok"], res.get("errors")
    assert res["waveforms"]["final"]["led0"] == 1

    bad_v = """module bad(
    input wire a,
    output wire y
);
    assign y = ???;
endmodule
"""
    err_comp = simulator.compile_source("", files=[{"name": "bad.v", "content": bad_v}])
    assert not err_comp["ok"]
    assert err_comp["errors"]
    first_err = err_comp["errors"][0]
    assert first_err["file"] == "bad.v"
    assert first_err["line"] == 5


def test_strict_pins_unassigned_and_single_bit_qsf(simulator):
    vhdl = """library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
entity pin_check is
    port (
        clk : in  std_logic;
        led : out std_logic_vector(3 downto 0)
    );
end entity pin_check;
architecture rtl of pin_check is
begin
    led <= "0000";
end architecture rtl;
"""
    unassigned = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": vhdl,
                "duration": 20,
                "strictPins": True,
                "qsf": "",
            }
        )
    )
    assert unassigned["ok"], unassigned.get("errors")
    assert unassigned["board"]["pins"] == {}
    assert unassigned["waveforms"]["boardImage"]["leds"] == [0, 0, 0, 0]

    single_led = simulator.simulate(
        SimulationRequest.from_dict(
            {
                "vhdl": vhdl,
                "duration": 20,
                "strictPins": True,
                "qsf": "set_location_assignment PIN_85 -to led[2]\n",
            }
        )
    )
    assert single_led["ok"], single_led.get("errors")
    assert single_led["waveforms"]["boardImage"]["leds"] == [0, 0, 1, 0]
