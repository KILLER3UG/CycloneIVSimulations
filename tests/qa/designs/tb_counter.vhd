-- Load 5, then count down: checks load and down-count in one run.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_counter is
end entity tb_counter;

architecture sim of tb_counter is
    signal clk : std_logic := '0';
    signal rst : std_logic := '1';
    signal up_down : std_logic := '0';
    signal load : std_logic := '0';
    signal load_val : unsigned(7 downto 0) := "00000101";
    signal count : unsigned(7 downto 0);
begin
    uut : entity work.counter_updown
        port map (clk => clk, rst => rst, up_down => up_down, load => load,
                  load_val => load_val, count => count);

    clk_gen : process
    begin
        for i in 0 to 17 loop
            clk <= not clk;
            wait for 5 ns;
        end loop;
        wait;
    end process;

    stim : process
    begin
        wait for 15 ns;
        rst <= '0';
        wait for 7 ns;
        load <= '1';
        wait for 10 ns;
        load <= '0';
        wait;
    end process;

    check : process
    begin
        wait for 75 ns;
        assert count = 1 report "down counter expected 1 got " & integer'image(to_integer(count)) severity failure;
        report "COUNTER_OK count=1" severity note;
        wait;
    end process;
end architecture sim;
