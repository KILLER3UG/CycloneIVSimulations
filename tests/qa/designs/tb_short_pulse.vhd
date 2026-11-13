-- A 1 ns key pulse placed between rising clock edges must be missed by a
-- clocked edge detector.  This documents the defined simulator result.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_short_pulse is
end entity tb_short_pulse;

architecture sim of tb_short_pulse is
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

    pulse : process
    begin
        wait for 12 ns;
        key <= '1';
        wait for 1 ns;
        key <= '0';
        wait;
    end process;

    check : process
    begin
        wait for 101 ns;
        assert led = 0 report "short pulse unexpectedly counted" severity failure;
        report "SHORT_PULSE_MISSED count=" & integer'image(to_integer(led)) severity note;
        wait;
    end process;
end architecture sim;