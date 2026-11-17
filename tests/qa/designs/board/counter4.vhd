library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M9: clock-driven counter with the board's active-low reset,
-- 4-bit output on the LEDs.
entity counter4 is
    port (
        clk   : in  std_logic;
        reset : in  std_logic;
        led   : out std_logic_vector(3 downto 0)
    );
end counter4;

architecture rtl of counter4 is
    signal count : unsigned(15 downto 0) := (others => '0');
begin
    process (clk, reset)
    begin
        if reset = '0' then            -- board reset key: active-low
            count <= (others => '0');
        elsif rising_edge(clk) then
            count <= count + 1;
        end if;
    end process;

    led <= std_logic_vector(count(3 downto 0));
end architecture;
