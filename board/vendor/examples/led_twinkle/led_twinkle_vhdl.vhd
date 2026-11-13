-- VHDL translation of the vendor example led_twinkle.v (Verilog original
-- kept in this folder).  Vendor behaviour: 25-bit counter at 50 MHz toggles
-- all four LEDs every 25,000,000 cycles = 0.5 s (1 Hz blink).  No reset.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity led_twinkle is
    port (
        clk : in  std_logic;             -- PIN_23, 50 MHz
        led : out std_logic_vector(3 downto 0)  -- active low
    );
end entity led_twinkle;

architecture rtl of led_twinkle is
    signal counter : unsigned(24 downto 0) := (others => '0');
    signal led_r   : std_logic_vector(3 downto 0) := "1111";
begin
    process (clk)
    begin
        if rising_edge(clk) then
            counter <= counter + 1;
            if counter = 25_000_000 then
                led_r <= not led_r;
                counter <= (others => '0');
            end if;
        end if;
    end process;
    led <= led_r;
end architecture rtl;
