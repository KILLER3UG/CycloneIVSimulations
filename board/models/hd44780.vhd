-- HD44780-style character LCD behavioural model (A2.2 LCD socket,
-- 1602 8-bit interface).  Wiring per the schematic: LCD_RS 141, LCD_RW 138,
-- LCD_E 143, LCD_D0..7 on pins 142/1/144/3/2/10/7/11, 10 k contrast trimmer.
-- Behaviour per the HD44780 datasheet:
--   * commands execute when E falls with RS=0 RW=0
--   * data writes when E falls with RS=1 RW=0
--   * the busy flag + address are output on D7..D0 when E is high with RW=1
--   * an E high pulse shorter than PWEH (450 ns) is ignored by the chip
--   * clear/home take 1.52 ms, other commands 37 us (busy flag held meanwhile)
-- The visible 2x16 text is dumped to a file for the host application.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.textio.all;

entity hd44780 is
    generic (
        DUMP      : string := "lcd_state.txt";
        ROWS      : natural := 2;
        COLS      : natural := 16
    );
    port (
        lcd_rs : in    std_logic;
        lcd_rw : in    std_logic;
        lcd_e  : in    std_logic;
        lcd_d  : inout std_logic_vector(7 downto 0)
    );
end entity hd44780;

architecture behavioural of hd44780 is
    -- 1602 DDRAM: line 1 = 0x00..0x27 (ddr 1..40), line 2 = 0x40..0x67 (ddr 65..104)
    signal ddr       : string(1 to 104) := (others => ' ');
    signal addr      : natural := 0;
    signal busy      : boolean := false;
    signal busy_end  : time    := 0 ns;
    signal d_out     : std_logic_vector(7 downto 0) := (others => 'Z');
    signal state_txt : string(1 to 2 * COLS) := (others => ' ');
begin
    -- drive the data bus while reading the busy flag / address
    lcd_d <= d_out when lcd_e = '1' and lcd_rw = '1' else (others => 'Z');

    -- visible text of the two lines
    row1 : process (ddr)
    begin
        state_txt(1 to COLS) <= ddr(1 to COLS);
    end process;

    row2 : process (ddr)
    begin
        state_txt(COLS + 1 to 2 * COLS) <= ddr(65 to 64 + COLS);
    end process;

    logger : process (state_txt)
        file f     : text;
        variable l : line;
        variable first : boolean := true;
    begin
        if not first then
            file_open(f, DUMP, write_mode);
            write(l, string'("LCD:"));
            writeline(f, l);
            write(l, string'(state_txt(1 to COLS)));
            writeline(f, l);
            write(l, string'(state_txt(COLS + 1 to 2 * COLS)));
            writeline(f, l);
            file_close(f);
        end if;
        first := false;
    end process;

    execute : process (lcd_e)
        variable last_e : std_logic := '0';
        variable e_high : time := 0 ns;
        variable cmd    : natural := 0;

    begin
        if rising_edge(lcd_e) then
            e_high := now;
        elsif falling_edge(lcd_e) then
            if (now - e_high) < 450 ns then
                null;                        -- pulse too short: the chip ignores it
            elsif to_x01(lcd_rw) = '0' then
                if to_x01(lcd_rs) = '0' then
                    cmd := to_integer(unsigned(to_x01(lcd_d)));
                    if cmd = 16#01# then
                        ddr   <= (others => ' ');
                        addr  <= 0;
                        busy  <= true;
                        busy_end <= now + 1520 us;
                    elsif cmd = 16#02# or cmd = 16#03# then
                        addr <= 0;
                        busy  <= true;
                        busy_end <= now + 1520 us;
                    elsif cmd = 16#04# or cmd = 16#06# or cmd = 16#05# or cmd = 16#07# then
                        busy_end <= now + 37 us;
                    elsif cmd = 16#08# or cmd = 16#0C# or cmd = 16#0D# or cmd = 16#0E# or cmd = 16#0F# then
                        busy_end <= now + 37 us;
                    elsif cmd = 16#10# or cmd = 16#14# or cmd = 16#18# or cmd = 16#1C# then
                        busy_end <= now + 37 us;   -- shifts
                    elsif cmd = 16#80# or (cmd >= 16#90# and cmd <= 16#9F#) then
                        addr <= cmd - 16#80#;
                        busy_end <= now + 37 us;
                    elsif (cmd >= 16#A0# and cmd <= 16#AF#) or (cmd >= 16#C0# and cmd <= 16#CF#) then
                        addr <= cmd;
                        busy_end <= now + 37 us;
                    end if;
                else
                    ddr(addr + 1) <= character'val(to_integer(unsigned(to_x01(lcd_d))));
                    if addr < 39 then
                        addr <= addr + 1;
                    elsif addr = 39 then
                        addr <= 64;              -- line 1 wraps into line 2
                    elsif addr < 103 then
                        addr <= addr + 1;
                    else
                        addr <= 0;               -- end of line 2: wrap around
                    end if;
                    busy  <= true;
                    busy_end <= now + 37 us;
                end if;
            else
                -- RW=1 read: the busy flag and address go on D7..D0 while E is high
                null;
            end if;
        end if;
    end process;

    busy_out : process (busy, lcd_e)
        variable addr_v : natural := 0;
    begin
        if busy = true then
            if lcd_e = '1' and to_x01(lcd_rw) = '1' then
                d_out <= (others => '1');   -- busy flag set
            else
                d_out <= (others => 'Z');
            end if;
        else
            addr_v := addr;
            if lcd_e = '1' and to_x01(lcd_rw) = '1' then
                d_out(7) <= '0';
                d_out(6 downto 0) <= std_logic_vector(to_unsigned(addr_v mod 128, 7));
            else
                d_out <= (others => 'Z');
            end if;
        end if;
    end process;

    busy_clear : process
    begin
        wait on busy, busy_end;
        if busy and now >= busy_end then
            busy <= false;
        end if;
        wait for 0 ns;
    end process;
end architecture behavioural;