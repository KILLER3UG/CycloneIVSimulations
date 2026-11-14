-- AT24C08 model protocol test (wp = '0' so writes are enabled).
-- Checks, per the AT24C08 datasheet:
--   * address ACK at 0x50
--   * 5 ms write cycle: the device NACKs while busy after a page write
--   * a page write of 20 bytes wraps inside the 16-byte page
--   * readback returns the committed data
-- Open-drain SDA/SCL: the testbench supplies the 'H' pull-ups and drives '0'.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_eeprom_model is
end entity;

architecture sim of tb_eeprom_model is
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
        variable i   : natural := 0;
        variable exp : natural := 0;

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
            wait for 5 us;       -- data set while SCL is low
            scl_high;            -- the slave samples on the rising edge
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
            -- ACK slot: release SDA and sample on the rising edge.  The model
            -- drives ACK on the falling edge that ends the last data bit, so
            -- the level is valid at this rising edge.
            sda_oe <= '0';
            wait for 5 us;
            scl_high;
            ack_out := sda_in;
            scl_low;
            wait for 5 us;
        end procedure;
        procedure get_byte(value : out natural; ack : std_logic) is
        begin
            sda_oe <= '0';
            value  := 0;
            for k in 7 downto 0 loop
                scl_high;        -- the slave shifts on the falling edge
                if sda_in = '1' then
                    value := value * 2 + 1;
                else
                    value := value * 2;
                end if;
                scl_low;
                wait for 5 us;
            end loop;
            -- master ACK/NACK slot: pull low to continue, release to stop
            if ack = '1' then
                sda_oe <= '1';
            else
                sda_oe <= '0';
            end if;
            wait for 5 us;
            scl_high;
            scl_low;
            wait for 5 us;
        end procedure;
        procedure i2c_start is
        begin
            sda_oe <= '1';       -- SDA falls while SCL is high
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
            sda_oe <= '0';       -- SDA rises while SCL is high: STOP
            wait for 5 us;
        end procedure;
    begin
        wait for 10 us;
        -- 1. write 0x5A to word address 0 (device address 0xA0)
        i2c_start;
        put_byte(16#A0#, ack);
        result(0) <= ack;                       -- ACK expected (0)
        put_byte(16#00#, ack);
        put_byte(16#5A#, ack);
        i2c_stop;

        -- 2. immediately address the device: it must NACK during the 5 ms cycle
        i2c_start;
        put_byte(16#A0#, ack);
        result(1) <= ack;                       -- NACK expected (1)
        i2c_stop;

        -- 3. after the write cycle it must ACK again and return 0x5A
        wait for 6 ms;
        i2c_start;
        put_byte(16#A0#, ack);
        result(2) <= ack;                       -- ACK expected (0)
        put_byte(16#00#, ack);
        i2c_repstart;
        put_byte(16#A1#, ack);
        get_byte(rv, '0');
        if rv = 16#5A# then
            result(3) <= '1';
        end if;
        i2c_stop;

        -- 4. page write of 20 bytes: 0..15 fill the page, 16..19 wrap to 0..3
        wait for 10 us;
        i2c_start;
        put_byte(16#A0#, ack);
        put_byte(16#00#, ack);
        for i in 0 to 19 loop
            put_byte(i, ack);
        end loop;
        i2c_stop;
        wait for 6 ms;
        i2c_start;
        put_byte(16#A0#, ack);
        put_byte(16#00#, ack);
        i2c_repstart;
        put_byte(16#A1#, ack);
        for i in 0 to 19 loop
            if i < 19 then
                get_byte(rv, '1');
            else
                get_byte(rv, '0');
            end if;
            if i < 4 then
                exp := 16 + i;                  -- wrapped bytes
            elsif i < 16 then
                exp := i;                       -- first page
            else
                exp := 0;                       -- untouched (fresh array)
            end if;
            if rv /= exp then
                result(4) <= '1';
            end if;
        end loop;
        i2c_stop;
        wait;
    end process;
end architecture;
