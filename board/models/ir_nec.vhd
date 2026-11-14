-- NEC infrared remote behavioural model (A2.2, U10 IR receiver).
-- The receiver module demodulates the 38 kHz carrier: its output is LOW
-- during a burst and HIGH during a space.  NEC frame:
--   9 ms burst + 4.5 ms space,
--   32 bits LSB first: address, ~address, command, ~command
--   bit 0 = 560 us burst + 560 us space, bit 1 = 560 us burst + 1690 us space
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ir_nec is
    generic (
        ADDRESS : natural := 16#00#;
        COMMAND : natural := 16#01#;
        START   : time    := 3 ms
    );
    port (
        ir : out std_logic            -- open collector: '0' = burst, 'Z' = idle
    );
end entity ir_nec;

architecture behavioural of ir_nec is
    signal ir_int : std_logic := 'Z';
begin
    ir <= '0' when ir_int = '0' else 'Z';

    sender : process
        variable frame : unsigned(31 downto 0);
        variable bit_v : std_logic;
    begin
        ir_int <= 'Z';
        wait for START;
        -- lead: 9 ms burst + 4.5 ms space
        ir_int <= '0';
        wait for 9 ms;
        ir_int <= 'Z';
        wait for 4_500 us;
        -- 32 bits LSB first: address, ~address, command, ~command.
        -- Built as unsigned: a natural is 31-bit in VHDL and overflows.
        frame := to_unsigned(ADDRESS mod 256, 32)
                 or shift_left(to_unsigned(255 - (ADDRESS mod 256), 32), 8)
                 or shift_left(to_unsigned(COMMAND mod 256, 32), 16)
                 or shift_left(to_unsigned(255 - (COMMAND mod 256), 32), 24);
        for i in 0 to 31 loop
            if (shift_right(frame, i)(0)) = '1' then
                bit_v := '1';
            else
                bit_v := '0';
            end if;
            ir_int <= '0';
            wait for 560 us;
            ir_int <= 'Z';
            if bit_v = '1' then
                wait for 1_690 us;
            else
                wait for 560 us;
            end if;
        end loop;
        ir_int <= 'Z';
        wait;                       -- one frame per run
    end process;
end architecture behavioural;