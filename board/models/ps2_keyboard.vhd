-- PS/2 keyboard behavioural model (A2.2 PS2-6PIN connector).
-- The keyboard is the host of the PS/2 link: it generates the clock and
-- drives DATA open-collector.  Frame per the PS/2 protocol:
--   start(0), 8 data bits LSB first, odd parity, stop(1)
-- The clock runs at a keyboard-like 20 kHz (30 us half period).  The host
-- (FPGA design) samples DATA on the falling clock edges.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ps2_keyboard is
    generic (
        BYTE1      : natural := 16#5A#;  -- Enter (make)
        BYTE2      : natural := 16#F0#;  -- break prefix (0 = skip)
        BYTE3      : natural := 16#5A#;
        BYTE4      : natural := 0;
        START      : time    := 1 ms;
        HALFPERIOD : time    := 30 us
    );
    port (
        ps_clock : out std_logic;        -- open collector: '0' or 'Z'
        ps_data  : out std_logic
    );
end entity ps2_keyboard;

architecture behavioural of ps2_keyboard is
    signal ps_clock_int : std_logic := '1';
    signal ps_data_int  : std_logic := '1';
begin
    ps_clock <= '0' when ps_clock_int = '0' else 'Z';
    ps_data  <= '0' when ps_data_int  = '0' else 'Z';

    sender : process
        type byte_list is array (natural range <>) of natural;
        constant bytes : byte_list := (1 => BYTE1, 2 => BYTE2, 3 => BYTE3, 4 => BYTE4);
        constant SETUP : time := 5 us;   -- data must be valid before the clock falls
        variable count : natural := 0;
        variable b     : natural := 0;
        variable parity : std_logic := '0';
        variable bit_v  : std_logic := '0';
        variable uv     : unsigned(7 downto 0) := (others => '0');
    begin
        ps_clock_int <= '1';
        ps_data_int  <= '1';
        wait for START;
        for which in 1 to 4 loop
            b := bytes(which);
            if b = 0 then
                exit;                    -- 0 = no more bytes
            end if;
            count := count + 1;
            -- start bit
            ps_data_int <= '0';
            wait for SETUP;
            ps_clock_int <= '0';
            wait for HALFPERIOD - SETUP;
            ps_clock_int <= '1';
            wait for HALFPERIOD;
            -- 8 data bits, LSB first
            parity := '0';
            uv := to_unsigned(b, 8);
            for i in 0 to 7 loop
                if uv(i) = '1' then
                    bit_v := '1';
                else
                    bit_v := '0';
                end if;
                ps_data_int <= bit_v;
                parity   := parity xor bit_v;
                wait for SETUP;
                ps_clock_int <= '0';
                wait for HALFPERIOD - SETUP;
                ps_clock_int <= '1';
                wait for HALFPERIOD;
            end loop;
            -- odd parity
            ps_data_int <= not parity;
            wait for SETUP;
            ps_clock_int <= '0';
            wait for HALFPERIOD - SETUP;
            ps_clock_int <= '1';
            wait for HALFPERIOD;
            -- stop bit
            ps_data_int <= '1';
            wait for SETUP;
            ps_clock_int <= '0';
            wait for HALFPERIOD - SETUP;
            ps_clock_int <= '1';
            wait for HALFPERIOD;
            -- inter-frame gap
            wait for 200 us;
        end loop;
        wait;                            -- done
    end process;
end architecture behavioural;