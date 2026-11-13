-- I2C master that writes one byte (0x5A) to the AT24C08 at word address
-- 0x00, waits for the 5 ms write cycle, then reads it back and shows the
-- read value on the four LEDs (LED = not read_byte, active-low board).
-- Bit-banged I2C on I2C_SCL/I2C_SDA at ~100 kHz.  Open drain: the pins
-- drive '0' and release ('Z') with the board's 5.1 k pull-ups.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity i2c_eeprom_test is
    generic (
        HALFPERIOD : time := 5 us            -- ~100 kHz SCL
    );
    port (
        CLOCK_50  : in    std_logic;
        I2C_SCL   : inout std_logic;
        I2C_SDA   : inout std_logic;
        LED       : out   std_logic_vector(3 downto 0)
    );
end entity i2c_eeprom_test;

architecture rtl of i2c_eeprom_test is
    signal scl_oe : std_logic := '0';        -- drives '0' when 1
    signal sda_oe : std_logic := '0';
    signal sda_in   : std_logic := '1';
    signal done     : std_logic := '0';
    signal readback : natural range 0 to 255 := 0;
begin
    I2C_SCL <= '0' when scl_oe = '1' else 'Z';
    I2C_SDA <= '0' when sda_oe = '1' else 'Z';
    sda_in  <= to_x01(I2C_SDA);
    LED     <= not std_logic_vector(to_unsigned(readback, 4)) when done = '1' else "1111";

    driver : process
        variable rv : natural := 0;
        procedure scl_high is
        begin
            scl_oe <= '0';
            wait for HALFPERIOD;
        end procedure;
        procedure scl_low is
        begin
            scl_oe <= '1';
            wait for HALFPERIOD;
        end procedure;
        procedure put_bit(v : std_logic) is
        begin
            sda_oe <= '1' when v = '0' else '0';
            wait for HALFPERIOD;   -- data set while SCL low
            scl_high;              -- released; the slave samples now
            scl_low;
        end procedure;
        procedure put_byte(v : natural) is
            variable b : natural := v;
        begin
            for i in 7 downto 0 loop
                if (b / (2 ** i)) mod 2 = 1 then
                    put_bit('1');
                else
                    put_bit('0');
                end if;
            end loop;
            -- ACK slot: release SDA, sample
            sda_oe <= '0';
            wait for HALFPERIOD;
            scl_high;
            scl_low;
            wait for HALFPERIOD;
        end procedure;
        procedure i2c_start is
        begin
            sda_oe <= '1';       -- SDA low while SCL high
            wait for HALFPERIOD;
            scl_low;             -- leave SCL low so the first data bit is
        end procedure;           -- sampled on the next SCL rising edge
        procedure i2c_repstart is
        begin
            -- repeated START: SDA must fall while SCL is HIGH
            scl_low;
            sda_oe <= '0';
            wait for HALFPERIOD;
            scl_high;
            sda_oe <= '1';
            wait for HALFPERIOD;
            scl_low;
        end procedure;
        procedure i2c_stop is
        begin
            scl_low;
            sda_oe <= '1';       -- SDA low
            scl_high;
            wait for HALFPERIOD;
            sda_oe <= '0';       -- SDA rises while SCL high: STOP
            wait for HALFPERIOD;
        end procedure;
    begin
        -- wait for the power-on
        wait for 10 us;
        -- write: START 1010_000_0, addr 0x00, data 0x5A, STOP
        i2c_start;
        put_byte(16#A0#);
        put_byte(16#00#);
        put_byte(16#5A#);
        i2c_stop;
        -- 5 ms write cycle (poll: send START + device address until ACKed)
        wait for 6 ms;
        -- random read: START, 0xA0, addr 0x00, repeated START, 0xA1, read, NACK, STOP
        i2c_start;
        put_byte(16#A0#);
        put_byte(16#00#);
        i2c_repstart;
        put_byte(16#A1#);
        -- read one byte, NACK it: sample each bit while SCL is high (the
        -- slave shifts the next bit out on every SCL falling edge)
        sda_oe <= '0';
        rv := 0;
        for i in 7 downto 0 loop
            scl_high;
            if sda_in = '1' then
                rv := rv * 2 + 1;
            else
                rv := rv * 2;
            end if;
            scl_low;
            wait for HALFPERIOD;
        end loop;
        readback := rv;
        i2c_stop;
        done <= '1';
        wait;
    end process;
end architecture rtl;