library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M8: LEDs mirror the keys raw (active-low in, active-low out):
-- a closed key (reads 0) lights its LED, exactly like the real board.
entity key_led4 is
    port (
        clk : in  std_logic;
        key : in  std_logic_vector(3 downto 0);
        led : out std_logic_vector(3 downto 0)
    );
end key_led4;

architecture rtl of key_led4 is
begin
    led <= key;
end architecture;
