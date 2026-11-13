-- Continuous UART transmitter (8N1), sending 0x55 ("U") back to back.
-- TX_DIV is deliberately small so the frame is visible in a short simulation;
-- for a real 50 MHz board use 434 (115200 baud) or 5208 (9600 baud).
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity uart_tx is
    generic (
        TX_DIV : integer := 10
    );
    port (
        clk   : in  std_logic;
        reset : in  std_logic;
        tx    : out std_logic;
        busy  : out std_logic;
        led   : out std_logic_vector(7 downto 0)
    );
end entity uart_tx;

architecture rtl of uart_tx is
    constant DATA : std_logic_vector(7 downto 0) := x"55";
    signal shift : std_logic_vector(9 downto 0) := (others => '1');
    signal bit_index : unsigned(3 downto 0) := (others => '0');
    signal divider : unsigned(15 downto 0) := (others => '0');
    signal sending : std_logic := '0';
begin
    process (clk, reset)
    begin
        if reset = '1' then
            shift <= (others => '1');
            bit_index <= (others => '0');
            divider <= (others => '0');
            sending <= '0';
        elsif rising_edge(clk) then
            if sending = '0' then
                -- start bit, 8 data bits (LSB first), stop bit
                shift <= '1' & DATA & '0';
                sending <= '1';
                divider <= (others => '0');
                bit_index <= (others => '0');
            elsif divider = to_unsigned(TX_DIV - 1, divider'length) then
                divider <= (others => '0');
                shift <= '1' & shift(shift'high downto 1);
                if bit_index = 9 then
                    sending <= '0';
                else
                    bit_index <= bit_index + 1;
                end if;
            else
                divider <= divider + 1;
            end if;
        end if;
    end process;

    tx <= shift(0);
    busy <= sending;
    led <= shift(7 downto 0);
end architecture rtl;