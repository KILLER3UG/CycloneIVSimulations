-- LM75 temperature read on its OWN bus (RZ-EasyFPGA A2.2, board_spec.md §0c):
-- the LM75 sits on FPGA_SCL = pin 112 / FPGA_SDA = pin 113 (address 0x48),
-- separate from the EEPROM bus (I2C_SCL/I2C_SDA = 99/98).
-- RESULT = raw 16-bit temperature register; the model is set to 25.0 C,
-- which the LM75 encodes as round(25.0 * 2) * 256 = 0x3200.
-- PROBE(0) records the ACK level for the EEPROM address (0xA0) on this bus:
-- the EEPROM lives on the OTHER bus, so it must NACK here (probe reads 1).
-- Bit-banged I2C at ~100 kHz; open drain: drive '0' or release to the pull-up.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity i2c_lm75_read is
    generic (
        HALFPERIOD : time := 5 us            -- ~100 kHz SCL
    );
    port (
        FPGA_SCL  : inout std_logic;
        FPGA_SDA  : inout std_logic;
        RESULT    : out   std_logic_vector(15 downto 0);
        PROBE     : out   std_logic_vector(7 downto 0)
    );
end entity i2c_lm75_read;

architecture rtl of i2c_lm75_read is
    signal scl_oe   : std_logic := '0';        -- drives '0' when 1
    signal sda_oe   : std_logic := '0';
    signal sda_in   : std_logic := '1';
    signal result_i : std_logic_vector(15 downto 0) := (others => '0');
    signal probe_i  : std_logic_vector(7 downto 0)  := (others => '0');
begin
    FPGA_SCL <= '0' when scl_oe = '1' else 'Z';
    FPGA_SDA <= '0' when sda_oe = '1' else 'Z';
    sda_in   <= to_x01(FPGA_SDA);
    RESULT   <= result_i;
    PROBE    <= probe_i;

    driver : process
        variable ack     : std_logic := '1';
        variable hi      : natural := 0;
        variable lo      : natural := 0;
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
        -- set the pointer to the temperature register (0x00), then read 2 bytes
        i2c_start;
        put_byte(16#90#, ack);       -- LM75 write: 0x48 << 1
        put_byte(16#00#, ack);       -- pointer = temperature register
        i2c_repstart;
        put_byte(16#91#, ack);       -- LM75 read
        get_byte(hi);
        sda_oe <= '1';               -- master ACK (drive SDA low)
        wait for HALFPERIOD;
        scl_high;
        scl_low;
        wait for HALFPERIOD;
        get_byte(lo);
        sda_oe <= '0';               -- master NACK (release SDA)
        wait for HALFPERIOD;
        scl_high;
        scl_low;
        wait for HALFPERIOD;
        i2c_stop;
        result_i <= std_logic_vector(to_unsigned((hi mod 256) * 256 + (lo mod 256), 16));
        -- the EEPROM (0xA0) must NOT answer on the LM75 bus
        i2c_start;
        put_byte(16#A0#, ack);
        probe_i(0) <= ack;
        i2c_stop;
        wait;
    end process;
end architecture rtl;
