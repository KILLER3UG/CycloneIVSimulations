-- AT24C08 block-select test.  Per the datasheet the control byte is
-- 1010 A2 A1 A0 R/W where A2 is the only physical address pin and A1/A0 are
-- word-address bits 9/8.  All four blocks (0xA0-0xA7) must ACK and map to
-- word addresses 0, 256, 512, 768.
--   write 0x11 to block 0 (0xA0), 0x22 to block 2 (0xA4)
--   read back blocks 0..3: expect 0x11, 0x00, 0x22, 0x00
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_eeprom_blocks is
end entity;

architecture sim of tb_eeprom_blocks is
    signal scl     : std_logic := 'H';
    signal sda     : std_logic := 'H';
    signal scl_oe  : std_logic := '0';
    signal sda_oe  : std_logic := '0';
    signal sda_in  : std_logic := '1';
    signal result  : std_logic_vector(7 downto 0) := (others => '0');
begin
    scl <= 'H';
    scl <= '0' when scl_oe = '1' else 'Z';
    sda <= 'H';
    sda <= '0' when sda_oe = '1' else 'Z';
    sda_in <= to_x01(sda);

    u_eeprom : entity work.at24c08
        generic map (DUMP => "eeprom_dump.txt")
        port map (scl => scl, sda => sda, wp => '0');

    driver : process
        variable ack : std_logic := '1';
        variable rv  : natural := 0;

        procedure scl_high is
        begin
            scl_oe <= '0';
            wait for 5 us;
        end procedure;
        procedure scl_low is
        begin
            scl_oe <= '1';
            wait for 5 us;
        end procedure;
        procedure put_bit(v : std_logic) is
        begin
            if v = '0' then
                sda_oe <= '1';
            else
                sda_oe <= '0';
            end if;
            wait for 5 us;
            scl_high;
            scl_low;
        end procedure;
        procedure put_byte(v : natural; ack_out : out std_logic) is
            variable b : natural := v;
        begin
            for k in 7 downto 0 loop
                if (b / 2 ** k) mod 2 = 1 then
                    put_bit('1');
                else
                    put_bit('0');
                end if;
            end loop;
            sda_oe <= '0';
            wait for 5 us;
            scl_high;
            ack_out := sda_in;
            scl_low;
            wait for 5 us;
        end procedure;
        procedure get_byte(value : out natural) is
        begin
            sda_oe <= '0';
            value  := 0;
            for k in 7 downto 0 loop
                scl_high;
                if sda_in = '1' then
                    value := value * 2 + 1;
                else
                    value := value * 2;
                end if;
                scl_low;
                wait for 5 us;
            end loop;
            sda_oe <= '0';       -- NACK: last byte
            wait for 5 us;
            scl_high;
            scl_low;
            wait for 5 us;
        end procedure;
        procedure i2c_start is
        begin
            sda_oe <= '1';
            wait for 5 us;
            scl_low;
        end procedure;
        procedure i2c_repstart is
        begin
            scl_low;
            sda_oe <= '0';
            wait for 5 us;
            scl_high;
            sda_oe <= '1';
            wait for 5 us;
            scl_low;
        end procedure;
        procedure i2c_stop is
        begin
            scl_low;
            sda_oe <= '1';
            scl_high;
            wait for 5 us;
            sda_oe <= '0';
            wait for 5 us;
        end procedure;
        procedure write_block(ctrl : natural; addr : natural; data : natural) is
        begin
            i2c_start;
            put_byte(ctrl, ack);
            put_byte(addr, ack);
            put_byte(data, ack);
            i2c_stop;
        end procedure;
        procedure read_block(ctrl : natural; addr : natural; value : out natural) is
        begin
            i2c_start;
            put_byte(ctrl, ack);
            put_byte(addr, ack);
            i2c_repstart;
            put_byte(ctrl + 1, ack);
            get_byte(value);
            i2c_stop;
        end procedure;
    begin
        wait for 10 us;
        write_block(16#A0#, 16#00#, 16#11#);   -- block 0
        wait for 6 ms;                         -- write cycle before the next transfer
        write_block(16#A4#, 16#00#, 16#22#);   -- block 2
        wait for 6 ms;
        read_block(16#A0#, 16#00#, rv);
        if rv = 16#11# then result(0) <= '1'; end if;
        read_block(16#A2#, 16#00#, rv);
        if rv = 16#00# then result(1) <= '1'; end if;
        read_block(16#A4#, 16#00#, rv);
        if rv = 16#22# then result(2) <= '1'; end if;
        read_block(16#A6#, 16#00#, rv);
        if rv = 16#00# then result(3) <= '1'; end if;
        wait;
    end process;
end architecture;
