-- VHDL translation of the vendor example key_led.v (Verilog original kept
-- in this folder).  Vendor behaviour: pressing KEY1 lights LED1, KEY2 lights
-- LED1..LED2, ... KEY4 lights all four.  Keys and LEDs are active low.
library ieee;
use ieee.std_logic_1164.all;

entity key_led is
    port (
        key : in  std_logic_vector(3 downto 0);  -- KEY1..KEY4 (active low)
        led : out std_logic_vector(3 downto 0)   -- LED1..LED4 (active low)
    );
end entity key_led;

architecture rtl of key_led is
begin
    -- Vendor case table, expressed combinationally:
    --   KEY1 pressed (1110) -> 1110
    --   KEY2 pressed (1101) -> 1100
    --   KEY3 pressed (1011) -> 1000
    --   KEY4 pressed (0111) -> 0000
    --   otherwise           -> 1111
    led <= "1110" when key = "1110" else
           "1100" when key = "1101" else
           "1000" when key = "1011" else
           "0000" when key = "0111" else
           "1111";
end architecture rtl;
