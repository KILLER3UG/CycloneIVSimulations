-- LM75 register read on the A2.2's second I2C bus (FPGA_SCL/FPGA_SDA = 112/113,
-- address 0x48).  Reads the temperature register (0x00) and the configuration
-- register (0x01).  The model is set to 25.0 C -> 0x3200; config powers up 0x0000.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity i2c_lm75_regs is
    generic (
        HALFPERIOD : time := 5 us            -- ~100 kHz SCL
    );
    port (
        FPGA_SCL  : inout std_logic;
        FPGA_SDA  : inout std_logic;
        TEMP      : out   std_logic_vector(15 downto 0);
        CONF      : out   std_logic_vector(15 downto 0);
        THYST     : out   std_logic_vector(15 downto 0);
        TOS       : out   std_logic_vector(15 downto 0)
    );
end entity;

architecture rtl of i2c_lm75_regs is
    signal scl_oe : std_logic := '0';
    signal sda_oe : std_logic := '0';
    signal sda_in : std_logic := '1';
    signal temp_i : std_logic_vector(15 downto 0) := (others => '0');
    signal conf_i : std_logic_vector(15 downto 0) := (others => '0');
    signal thyst_i: std_logic_vector(15 downto 0) := (others => '0');
    signal tos_i  : std_logic_vector(15 downto 0) := (others => '0');
begin
    FPGA_SCL <= '0' when scl_oe = '1' else 'Z';
    FPGA_SDA <= '0' when sda_oe = '1' else 'Z';
    sda_in   <= to_x01(FPGA_SDA);
    TEMP     <= temp_i;
    CONF     <= conf_i;
    THYST    <= thyst_i;
    TOS      <= tos_i;

    driver : process
        variable ack : std_logic := '1';
        variable hi  : natural := 0;
        variable lo  : natural := 0;

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
                    sda_oe <= '0';
                else
                    sda_oe <= '1';
                end if;
                wait for HALFPERIOD;
                scl_high;
                scl_low;
            end loop;
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
                scl_high;
                if sda_in = '1' then
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
            sda_oe <= '1';
            wait for HALFPERIOD;
            scl_low;
        end procedure;
        procedure i2c_repstart is
        begin
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
            sda_oe <= '1';
            scl_high;
            wait for HALFPERIOD;
            sda_oe <= '0';
            wait for HALFPERIOD;
        end procedure;
        procedure read_reg(reg : natural; value : out natural) is
        begin
            i2c_start;
            put_byte(16#90#, ack);
            put_byte(reg, ack);
            i2c_repstart;
            put_byte(16#91#, ack);
            get_byte(hi);
            sda_oe <= '1';               -- master ACK: continue to the low byte
            wait for HALFPERIOD;
            scl_high;
            scl_low;
            wait for HALFPERIOD;
            get_byte(lo);
            sda_oe <= '0';               -- master NACK: last byte
            wait for HALFPERIOD;
            scl_high;
            scl_low;
            wait for HALFPERIOD;
            i2c_stop;
            value := (hi mod 256) * 256 + (lo mod 256);
        end procedure;
    begin
        wait for 10 us;
        read_reg(16#00#, hi);
        temp_i <= std_logic_vector(to_unsigned(hi, 16));
        read_reg(16#01#, hi);
        conf_i <= std_logic_vector(to_unsigned(hi, 16));
        read_reg(16#02#, hi);
        thyst_i <= std_logic_vector(to_unsigned(hi, 16));
        read_reg(16#03#, hi);
        tos_i <= std_logic_vector(to_unsigned(hi, 16));
        wait;
    end process;
end architecture rtl;
