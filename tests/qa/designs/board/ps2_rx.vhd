-- PS/2 receiver: samples DATA on the falling CLOCK edges and checks the
-- frame format (start=0, 8 data bits LSB first, odd parity, stop=1).
-- The board model (ps2_keyboard) sends 0x5A, 0xF0, 0x5A.
-- NOTE: written with VHDL-93-compatible sequential statements only (no
-- conditional signal assignments inside the process), so it analyzes under
-- any --std the backend may pick (93/93c/08).
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ps2_rx is
    port (
        CLOCK_50 : in  std_logic;
        PS_CLOCK : in  std_logic;
        PS_DATA  : in  std_logic;
        RESULT   : out std_logic_vector(7 downto 0);
        STATUS   : out std_logic_vector(3 downto 0)
    );
end entity;

architecture rtl of ps2_rx is
    signal last_clk  : std_logic := '1';
    signal shift     : std_logic_vector(10 downto 0) := (others => '1');
    signal bitcount  : unsigned(3 downto 0) := (others => '0');
    signal frames    : unsigned(7 downto 0) := (others => '0');
    signal data_reg  : std_logic_vector(7 downto 0) := (others => '0');
    signal parity_ok : std_logic := '0';
    signal start_ok  : std_logic := '0';
    signal stop_ok   : std_logic := '0';
    signal frames_ok : std_logic := '0';
begin
    process (CLOCK_50)
        variable d : std_logic_vector(7 downto 0);
        variable p : std_logic;
        variable xd : std_logic;
        variable new_shift : std_logic_vector(10 downto 0);
    begin
        if rising_edge(CLOCK_50) then
            last_clk <= to_x01(PS_CLOCK);
            if last_clk = '1' and to_x01(PS_CLOCK) = '0' then
                new_shift := to_x01(PS_DATA) & shift(10 downto 1);
                shift <= new_shift;
                if bitcount = 10 then
                    bitcount <= (others => '0');
                    d := new_shift(8 downto 1);   -- data bits after the start bit
                    p := new_shift(9);             -- parity bit
                    xd := '0';
                    for i in d'range loop
                        if d(i) = '1' then
                            xd := not xd;
                        end if;
                    end loop;
                    data_reg  <= d;
                    frames    <= frames + 1;
                    if xd /= p then
                        parity_ok <= '1';      -- odd parity: p must be ~xor(d)
                    else
                        parity_ok <= '0';
                    end if;
                    if new_shift(0) = '0' then
                        start_ok <= '1';
                    else
                        start_ok <= '0';
                    end if;
                    if new_shift(10) = '1' then
                        stop_ok <= '1';
                    else
                        stop_ok <= '0';
                    end if;
                    if frames + 1 >= 2 then
                        frames_ok <= '1';
                    else
                        frames_ok <= '0';
                    end if;
                else
                    bitcount <= bitcount + 1;
                end if;
            end if;
        end if;
    end process;

    RESULT <= data_reg;
    STATUS <= parity_ok & start_ok & stop_ok & frames_ok;
end architecture;
