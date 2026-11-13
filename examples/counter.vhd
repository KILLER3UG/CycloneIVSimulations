-- 8-bit counter wired to the board LEDs.
library ieee;
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