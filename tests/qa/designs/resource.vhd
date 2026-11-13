-- Resource-limit probe: 92 output pins, one more than the EP4CE6E22C8's 91.
library ieee;
use ieee.std_logic_1164.all;

entity wide_io is
    port (clk : in  std_logic;
          q   : out std_logic_vector(91 downto 0));
end entity wide_io;
architecture rtl of wide_io is
begin
    q <= (others => '0');
end architecture rtl;
