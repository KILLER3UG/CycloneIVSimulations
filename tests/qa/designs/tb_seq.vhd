-- Mealy sequence detector: drive 1,0,1,1 and check the overlap output.
library ieee;
use ieee.std_logic_1164.all;

entity tb_seq is
end entity tb_seq;

architecture sim of tb_seq is
    signal clk : std_logic := '0';
    signal rst : std_logic := '1';
    signal din : std_logic := '0';
    signal detected : std_logic;
begin
    uut : entity work.seq_mealy
        port map (clk => clk, rst => rst, din => din, detected => detected);

    clk_gen : process
    begin
        for i in 0 to 12 loop
            clk <= not clk;
            wait for 5 ns;
        end loop;
        wait;
    end process;

    stim : process
    begin
        wait for 15 ns;
        rst <= '0';
        wait for 2 ns;
        din <= '1';
        wait for 10 ns;
        din <= '0';
        wait for 10 ns;
        din <= '1';
        wait for 10 ns;
        din <= '1';
        wait for 2 ns;
        assert detected = '1' report "sequence not detected" severity failure;
        report "SEQ_OK detected=1" severity note;
        wait;
    end process;
end architecture sim;
