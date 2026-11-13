-- Counter that only advances while `enable` is high.
-- Use the "toggle" stimulus on `enable` in the UI to see it pause and resume.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity gated_counter is
    port (
        clk    : in  std_logic;
        reset  : in  std_logic;
        enable : in  std_logic;
        led    : out std_logic_vector(7 downto 0)
    );
end entity gated_counter;

architecture rtl of gated_counter is
    signal count : unsigned(7 downto 0) := (others => '0');
begin
    process (clk, reset)
    begin
        if reset = '1' then
            count <= (others => '0');
        elsif rising_edge(clk) then
            if enable = '1' then
                count <= count + 1;
            end if;
        end if;
    end process;

    led <= std_logic_vector(count);
end architecture rtl;