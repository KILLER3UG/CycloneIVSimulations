-- Two independent clock domains: 10 ns and 30 ns, checked against expected counts.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_two_clocks is
end entity tb_two_clocks;

architecture sim of tb_two_clocks is
    signal clk_a, clk_b, rst : std_logic := '0';
    signal qa, qb : unsigned(3 downto 0);
begin
    uut : entity work.multi_clock
        port map (clk_a => clk_a, clk_b => clk_b, rst => rst, qa => qa, qb => qb);

    rst <= '1' after 0 ns, '0' after 2 ns;

    a_gen : process
    begin
        for i in 0 to 19 loop
            clk_a <= not clk_a;
            wait for 5 ns;
        end loop;
        wait;
    end process;

    b_gen : process
    begin
        for i in 0 to 6 loop
            clk_b <= not clk_b;
            wait for 15 ns;
        end loop;
        wait;
    end process;

    check : process
    begin
        wait for 100 ns;
        assert qa = 9 report "qa expected 9 got " & integer'image(to_integer(qa)) severity failure;
        assert qb = 6 report "qb expected 6 got " & integer'image(to_integer(qb)) severity failure;
        report "TWO_CLOCKS_OK qa=" & integer'image(to_integer(qa)) &
               " qb=" & integer'image(to_integer(qb)) severity note;
        wait;
    end process;
end architecture sim;