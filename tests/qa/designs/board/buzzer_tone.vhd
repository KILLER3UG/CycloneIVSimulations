-- Passive buzzer on FPGA_BUZZER (PIN_110, active low through the 8550).
-- Toggles the pin every 25,000 cycles at 50 MHz: a 1 kHz square wave,
-- i.e. a 1 kHz tone on the passive speaker.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity buzzer_tone is
    port (
        CLOCK_50     : in    std_logic;
        FPGA_BUZZER  : out   std_logic
    );
end entity buzzer_tone;

architecture rtl of buzzer_tone is
    signal div  : natural range 0 to 24_999 := 0;
    signal level : std_logic := '1';         -- idle = silent
begin
    process (CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            if div = 24_999 then
                div   <= 0;
                level <= not level;
            else
                div <= div + 1;
            end if;
        end if;
    end process;
    FPGA_BUZZER <= level;
end architecture rtl;
