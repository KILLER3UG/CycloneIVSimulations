-- Long-run fixture for the stop/cancel tests: a free-running counter whose
-- requested duration keeps GHDL busy far longer than the test window, so a
-- sim_stop must actively kill the subprocess to return promptly.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity long_run is
    port (
        clk   : in  std_logic;
        count : out std_logic_vector(7 downto 0)
    );
end long_run;

architecture rtl of long_run is
    signal cnt : unsigned(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;

    count <= std_logic_vector(cnt);
end architecture;
