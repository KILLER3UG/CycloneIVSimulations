-- Three ALTPLL instantiations (BLK-03 fixture): exceeds the 2 PLLs of the
-- EP4CE6E22C8, so the static resource estimator must emit a PLL-limit
-- warning in the result payload.  The component stays unbound (GHDL has no
-- Altera simulation libraries), so the run itself still fails with the usual
-- clear binding error after the warnings - BLK-01/BLK-02 behaviour.
library ieee;
use ieee.std_logic_1164.all;

entity pll_limit is
    port (inclk0 : in  std_logic;
          rst    : in  std_logic;
          c0     : out std_logic;
          locked0 : out std_logic;
          c1     : out std_logic;
          locked1 : out std_logic;
          c2     : out std_logic;
          locked2 : out std_logic);
end entity pll_limit;

architecture rtl of pll_limit is
    component altpll
        generic (
            inclk0_input_frequency : natural := 50;
            intended_device_family : string  := "Cyclone IV E";
            operation_mode         : string  := "normal";
            pll_type               : string  := "auto";
            compensate_clock       : string  := "clk0";
            feedback_source        : string  := "fpll_feedback";
            clk0_multiply_by       : natural := 1;
            clk0_divide_by         : natural := 1;
            clk0_phase_shift       : string  := "0"
        );
        port (
            inclk0 : in  std_logic;
            areset : in  std_logic := '0';
            c0     : out std_logic;
            locked : out std_logic
        );
    end component altpll;
begin
    u_pll1 : altpll
        generic map (
            inclk0_input_frequency => 50,
            intended_device_family => "Cyclone IV E",
            operation_mode         => "normal",
            pll_type               => "auto",
            compensate_clock       => "clk0",
            feedback_source        => "fpll_feedback",
            clk0_multiply_by       => 1,
            clk0_divide_by         => 1,
            clk0_phase_shift       => "0"
        )
        port map (
            inclk0 => inclk0,
            areset => rst,
            c0     => c0,
            locked => locked0
        );

    u_pll2 : altpll
        generic map (
            inclk0_input_frequency => 50,
            intended_device_family => "Cyclone IV E",
            operation_mode         => "normal",
            pll_type               => "auto",
            compensate_clock       => "clk0",
            feedback_source        => "fpll_feedback",
            clk0_multiply_by       => 1,
            clk0_divide_by         => 1,
            clk0_phase_shift       => "0"
        )
        port map (
            inclk0 => inclk0,
            areset => rst,
            c0     => c1,
            locked => locked1
        );

    u_pll3 : altpll
        generic map (
            inclk0_input_frequency => 50,
            intended_device_family => "Cyclone IV E",
            operation_mode         => "normal",
            pll_type               => "auto",
            compensate_clock       => "clk0",
            feedback_source        => "fpll_feedback",
            clk0_multiply_by       => 1,
            clk0_divide_by         => 1,
            clk0_phase_shift       => "0"
        )
        port map (
            inclk0 => inclk0,
            areset => rst,
            c0     => c2,
            locked => locked2
        );
end architecture rtl;
