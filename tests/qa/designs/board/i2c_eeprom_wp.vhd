-- AT24C08 write-protection test (RZ-EasyFPGA A2.2, board_spec.md §0d).
-- The board ties the EEPROM's WP pin to VCC, so writes must be blocked:
--   1. attempt a page write of 0x5A to word address 0x00 on the EEPROM bus
--      (I2C_SCL = pin 99, I2C_SDA = pin 98, device address 0xA0)
--   2. wait out the 5 ms write cycle
--   3. read address 0x00 back: it must still be 0x00 (the fresh array),
--      proving the write never programmed the cell.
-- PROBE(0) records the ACK level for the LM75 address (0x90) on this bus:
-- the LM75 lives on the OTHER I2C bus (FPGA_SCL/FPGA_SDA = 112/113), so it
-- must NACK here (probe reads 1).
-- Bit-banged I2C at ~100 kHz; open drain: drive '0' or release to the pull-up.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity i2c_eeprom_wp is
    generic (
        HALFPERIOD : time := 5 us            -- ~100 kHz SCL
    );
    port (
        I2C_SCL   : inout std_logic;
        I2C_SDA   : inout std_logic;
        RESULT    : out   std_logic_vector(7 downto 0);
        PROBE     : out   std_logic_vector(7 downto 0)
    );
end entity i2c_eeprom_wp;

architecture rtl of i2c_eeprom_wp is
    signal scl_oe   : std_logic := '0';        -- drives '0' when 1
    signal sda_oe   : std_logic := '0';
    signal sda_in   : std_logic := '1';
    signal result_i : std_logic_vector(7 downto 0) := (others => '0');
    signal probe_i  : std_logic_vector(7 downto 0)  := (others => '0');
begin
    I2C_SCL <= '0' when scl_oe = '1' else 'Z';
    I2C_SDA <= '0' when sda_oe = '1' else 'Z';
    sda_in  <= to_x01(I2C_SDA);
    RESULT  <= result_i;
    PROBE   <= probe_i;

    driver : process
        variable ack     : std_logic := '1';
        variable rv      : natural := 0;
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
        procedure put_byte(v : natural; ack_out : out std_logic) is
        begin
            for i in 7 downto 0 loop
                if (v / (2 ** i)) mod 2 = 1 then
                    sda_oe <= '0';           -- release: pull-up gives 1
                else
                    sda_oe <= '1';           -- drive 0
                end if;
                wait for HALFPERIOD;         -- data set while SCL low
                scl_high;                    -- slave samples on the rising edge
                scl_low;
            end loop;
            -- ACK slot: release SDA and sample what the slave drives
            sda_oe <= '0';
            wait for HALFPERIOD;
            scl_high;
            ack_out := sda_in;
            scl_low;
            wait for HALFPERIOD;
        end procedure;
        procedure get_byte(value : out natural) is
        begin
            sda_oe <= '0';
            for i in 7 downto 0 loop
                scl_high;                    -- slave shifts on the falling edge;
                if sda_in = '1' then         -- sample while SCL is high
                    value := value * 2 + 1;
                else
                    value := value * 2;
                end if;
                scl_low;
                wait for HALFPERIOD;
            end loop;
        end procedure;
        procedure i2c_start is
        begin
            sda_oe <= '1';       -- SDA falls while SCL stays high
            wait for HALFPERIOD;
            scl_low;             -- leave SCL low so the first data bit is
        end procedure;           -- sampled on the next SCL rising edge
        procedure i2c_repstart is
        begin
            -- repeated START: SDA must fall while SCL is HIGH, so raise both
            -- lines first (after an ACK slot SCL is low)
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
        wait for 10 us;
        -- 1. write attempt: START 1010_000_0, word addr 0x00, data 0x5A, STOP
        i2c_start;
        put_byte(16#A0#, ack);
        put_byte(16#00#, ack);
        put_byte(16#5A#, ack);
        i2c_stop;
        -- 2. wait out the 5 ms write cycle before touching the device again
        wait for 6 ms;
        -- 3. read address 0x00 back: START, 0xA0, 0x00, rep-START, 0xA1, byte, NACK, STOP
        i2c_start;
        put_byte(16#A0#, ack);
        put_byte(16#00#, ack);
        i2c_repstart;
        put_byte(16#A1#, ack);
        get_byte(rv);
        sda_oe <= '0';           -- master NACK: release SDA
        wait for HALFPERIOD;
        scl_high;
        scl_low;
        wait for HALFPERIOD;
        i2c_stop;
        result_i <= std_logic_vector(to_unsigned(rv mod 256, 8));
        -- the LM75 (0x90) must NOT answer on the EEPROM bus
        i2c_start;
        put_byte(16#90#, ack);
        probe_i(0) <= ack;
        i2c_stop;
        wait;
    end process;
end architecture rtl;
