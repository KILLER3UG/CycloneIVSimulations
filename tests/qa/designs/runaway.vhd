-- Zero-delay process: should be caught as a runaway/infinite loop.
library ieee;
use ieee.std_logic_1164.all;

entity runaway is
    port (y : out std_logic);
end entity runaway;
architecture rtl of runaway is
    signal a : std_logic := '0';
begin
    process
    begin
        a <= not a;
    end process;
    y <= a;
end architecture rtl;
