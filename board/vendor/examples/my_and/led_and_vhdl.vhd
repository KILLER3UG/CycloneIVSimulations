-- VHDL form of the vendor example my_and (the vendor ships both my_and.v
-- with an OR body and my_and.vhd with an AND body; this keeps the .vhd).
library ieee;
use ieee.std_logic_1164.all;

entity led_and is
    port (
        a : in  std_logic;  -- PIN_88 (KEY1)
        b : in  std_logic;  -- PIN_89 (KEY2)
        c : out std_logic   -- PIN_87 (LED1, active low)
    );
end entity led_and;

architecture led_and of led_and is
begin
    c <= a and b;
end architecture led_and;
