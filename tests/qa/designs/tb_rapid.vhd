-- Rapid switch toggling at the clock rate: 10 transitions, 10 sampled edges,
-- exactly 5 rising edges must be counted (no misses, no duplicates).
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_rapid is
end entity tb_rapid;

architecture sim of tb_rapid is
    signal clk : std_logic := '0';
    signal key : std_logic := '0';
    signal led : unsigned(7 downto 0);
begin
    uut : entity work.key_edge
        port map (clk => clk, key => key, led => led);

    clk_gen : process
    begin
        for i in 0 to 20 loop
            clk <= not clk;
            wait for 5 ns;
        end loop;
        wait;
    end process;

    key_gen : process
    begin
        wait for 7 ns;
        for i in 0 to 9 loop
            key <= not key;
            wait for 10 ns;
        end loop;
        wait;
    end process;

    check : process
    begin
        wait for 101 ns;
        assert led = 5 report "rapid toggle count expected 5 got " & integer'image(to_integer(led)) severity failure;
        report "RAPID_TOGGLE_OK count=" & integer'image(to_integer(led)) severity note;
        wait;
    end process;
end architecture sim;