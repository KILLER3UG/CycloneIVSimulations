-- HD44780 8-bit init + "HELLO" for the A2.2 LCD socket model.
-- Wiring per board.json: RS=141, RW=138, E=143, D0..D7=142/1/144/3/2/10/7/11.
-- The model dumps the visible text to lcd_state.txt; the test checks it.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity lcd_hello is
    port (
        CLOCK_50 : in  std_logic;
        LCD_RS   : out std_logic;
        LCD_RW   : out std_logic;
        LCD_E    : out std_logic;
        LCD_D    : inout std_logic_vector(7 downto 0)
    );
end entity;

architecture rtl of lcd_hello is
    signal data : std_logic_vector(7 downto 0) := (others => 'Z');
begin
    LCD_D <= data;

    driver : process
        procedure pulse_e is
        begin
            LCD_E <= '1';
            wait for 1 us;
            LCD_E <= '0';
            wait for 50 us;
        end procedure;
        procedure write_cmd(cmd : natural) is
        begin
            LCD_RS <= '0';
            LCD_RW <= '0';
            data   <= std_logic_vector(to_unsigned(cmd, 8));
            wait for 1 us;
            pulse_e;
        end procedure;
        procedure write_data(c : character) is
        begin
            LCD_RS <= '1';
            LCD_RW <= '0';
            data   <= std_logic_vector(to_unsigned(character'pos(c), 8));
            wait for 1 us;
            pulse_e;
        end procedure;
    begin
        LCD_RS <= '0';
        LCD_RW <= '0';
        LCD_E  <= '0';
        data   <= (others => 'Z');
        wait for 20 ms;             -- power-on wait
        write_cmd(16#38#);          -- 8-bit interface, 2 lines
        write_cmd(16#0C#);          -- display on, cursor off
        write_cmd(16#01#);          -- clear display
        wait for 2 ms;              -- clear takes 1.52 ms
        write_cmd(16#06#);          -- entry mode: increment, no shift
        write_data('H');
        write_data('E');
        write_data('L');
        write_data('L');
        write_data('O');
        wait;
    end process;
end architecture;
