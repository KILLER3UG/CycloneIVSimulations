-- Intel megafunction instantiations.  GHDL has no Altera simulation libraries,
-- so these should fail with a clear binding error rather than silently pass.
library ieee;
use ieee.std_logic_1164.all;

entity altpll_top is
    port (inclk0 : in  std_logic;
          rst    : in  std_logic;
          c0     : out std_logic;
          locked : out std_logic);
end entity altpll_top;
architecture rtl of altpll_top is
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
    u_pll : altpll
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
            locked => locked
        );
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity altsyncram_top is
    port (clock0  : in  std_logic;
          wren    : in  std_logic;
          address : in  std_logic_vector(2 downto 0);
          data    : in  std_logic_vector(7 downto 0);
          q       : out std_logic_vector(7 downto 0));
end entity altsyncram_top;
architecture rtl of altsyncram_top is
    component altsyncram
        generic (
            width_a          : natural := 8;
            widthad_a        : natural := 3;
            numwords_a       : natural := 8;
            operation_mode   : string  := "single-port";
            outdata_reg_a    : string  := "clock0";
            init_file        : string  := "UNUSED";
            intended_device_family : string := "Cyclone IV E"
        );
        port (
            clock0  : in  std_logic;
            wren_a  : in  std_logic;
            address_a : in std_logic_vector(2 downto 0);
            data_a  : in  std_logic_vector(7 downto 0);
            q_a     : out std_logic_vector(7 downto 0)
        );
    end component altsyncram;
begin
    u_ram : altsyncram
        generic map (
            width_a => 8,
            widthad_a => 3,
            numwords_a => 8,
            operation_mode => "single-port",
            outdata_reg_a => "clock0",
            init_file => "UNUSED",
            intended_device_family => "Cyclone IV E"
        )
        port map (
            clock0 => clock0,
            wren_a => wren,
            address_a => address,
            data_a => data,
            q_a => q
        );
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity lpm_top is
    port (clock : in  std_logic;
          sclr  : in  std_logic;
          q     : out std_logic_vector(7 downto 0));
end entity lpm_top;
architecture rtl of lpm_top is
    component lpm_counter
        generic (LPM_WIDTH : natural := 8);
        port (clock : in  std_logic;
              sclr  : in  std_logic;
              q     : out std_logic_vector(7 downto 0));
    end component lpm_counter;
begin
    u_counter : lpm_counter
        generic map (LPM_WIDTH => 8)
        port map (clock => clock, sclr => sclr, q => q);
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity many_muls is
    port (a, b : in  unsigned(17 downto 0);
          p0, p1, p2, p3, p4, p5, p6, p7,
          p8, p9, p10, p11, p12, p13, p14, p15 : out unsigned(35 downto 0));
end entity many_muls;
architecture rtl of many_muls is
begin
    p0 <= a * b; p1 <= a * b; p2 <= a * b; p3 <= a * b;
    p4 <= a * b; p5 <= a * b; p6 <= a * b; p7 <= a * b;
    p8 <= a * b; p9 <= a * b; p10 <= a * b; p11 <= a * b;
    p12 <= a * b; p13 <= a * b; p14 <= a * b; p15 <= a * b;
end architecture rtl;
