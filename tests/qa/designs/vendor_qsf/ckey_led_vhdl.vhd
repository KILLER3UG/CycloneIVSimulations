-- VHDL translation of the vendor example ckey_led.v (Verilog original kept
-- in this folder; the simulator engine is VHDL-only).  Behaviour identical:
-- LED = ckey.  On this board both are active low: a DIP switched ON (0)
-- lights the matching LED (anode at 3.3 V, cathode driven by the FPGA).
library ieee;
use ieee.std_logic_1164.all;

entity ckey_led is
    port (
        ckey : in  std_logic_vector(4 downto 1);  -- DIP1..DIP4 (shares KEY pins)
        LED  : out std_logic_vector(4 downto 1)   -- LED1..LED4 (active low)
    );
end entity ckey_led;

architecture rtl of ckey_led is
begin
    LED <= ckey;
end architecture rtl;
