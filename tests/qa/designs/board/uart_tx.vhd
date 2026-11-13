-- UART transmitter at a real 115200 baud on the A2.2 UART_TXD pin (114).
-- Sends the ASCII byte 0x55 ('U') ten times, then stops.
-- 50 MHz clock / 115200 baud = 434 clock cycles per bit.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity uart_tx_board is
    generic (
        BAUD_DIV : natural := 434            -- 50e6 / 115200
    );
    port (
        CLOCK_50  : in    std_logic;
        UART_TXD  : out   std_logic
    );
end entity uart_tx_board;

architecture rtl of uart_tx_board is
    constant FRAME  : natural := 10;         -- start + 8 data + stop
    constant FRAMES : natural := 3;          -- frames to send
    signal div     : natural range 0 to BAUD_DIV - 1 := 0;
    signal tick    : std_logic := '0';
    -- start at 10 so the line idles high before the first start bit
    signal pos     : natural range 0 to FRAMES * 17 + 10 := 10;
    signal shifter : std_logic_vector(9 downto 0) := "1111111111";
begin
    process (CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            if div = BAUD_DIV - 1 then
                div  <= 0;
                tick <= '1';
            else
                div  <= div + 1;
                tick <= '0';
            end if;
        end if;
    end process;

    process (CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            if tick = '1' then
                if pos < FRAMES * 17 + 10 then
                    case pos mod 17 is
                        when 0 =>
                            -- frame load tick: start bit now, then the frame
                            -- bits (stop, data LSB first) shift out on the
                            -- following ticks; the rest of the 17-tick period
                            -- idles high so a receiver can re-sync per frame
                            shifter  <= "11" & "01010101";
                            UART_TXD <= '0';
                        when 1 to 9 =>
                            UART_TXD <= shifter(0);
                            shifter  <= '1' & shifter(9 downto 1);
                        when others =>
                            UART_TXD <= '1';       -- idle between frames
                    end case;
                    pos <= pos + 1;
                else
                    UART_TXD <= '1';
                end if;
            end if;
        end if;
    end process;
end architecture rtl;
