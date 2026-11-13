-- One clean press/release, offset from the clock edges so the edge detector
-- samples the key while it is stable.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_edge is
end entity tb_edge;

architecture sim of tb_edge is
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

    press : process
    begin
        wait for 7 ns;
        key <= '1';
        wait for 10 ns;
        key <= '0';
        wait;
    end process;

    check : process
    begin
        wait for 101 ns;
        assert led = 1 report "edge count expected 1 got " & integer'image(to_integer(led)) severity failure;
        report "EDGE_OK count=1" severity note;
        wait;
    end process;
end architecture sim;
