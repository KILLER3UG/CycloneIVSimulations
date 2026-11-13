-- Exhaustive switch-to-LED check: all 256 values in one simulation.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_switches_all is
end entity tb_switches_all;

architecture sim of tb_switches_all is
    signal sw  : std_logic_vector(7 downto 0) := (others => '0');
    signal led : std_logic_vector(7 downto 0);
begin
    uut : entity work.sw_led8
        port map (sw => sw, led => led);

    process
    begin
        for v in 0 to 255 loop
            sw <= std_logic_vector(to_unsigned(v, 8));
            wait for 1 ns;
            assert led = std_logic_vector(to_unsigned(v, 8))
                report "switch mismatch at " & integer'image(v) severity failure;
        end loop;
        report "ALL_SWITCHES_OK" severity note;
        wait;
    end process;
end architecture sim;