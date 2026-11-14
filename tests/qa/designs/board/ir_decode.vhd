-- NEC IR decoder/timing probe for the A2.2 IR receiver model (active-low).
-- Measures the 9 ms leading burst and the first data bit's trailing space
-- (560 us for bit 0, 1690 us for bit 1; the model sends ADDRESS=0x00, so the
-- first transmitted bit is address bit 0 = 0 and its trailing space is 560 us).
-- Also counts bursts: lead + 32 data = 33.
-- NOTE: the architecture signal is named space1_reg (not space1) because the
-- entity already declares the output port SPACE1 and VHDL identifiers are
-- case-insensitive; reusing "space1" is an "identifier already used" error.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ir_decode is
    port (
        CLOCK_50 : in  std_logic;
        IR       : in  std_logic;
        LEAD     : out std_logic_vector(31 downto 0);
        COUNT    : out std_logic_vector(7 downto 0);
        SPACE1   : out std_logic_vector(31 downto 0)
    );
end entity;

architecture rtl of ir_decode is
    signal last_ir    : std_logic := '1';
    signal cnt        : unsigned(31 downto 0) := (others => '0');
    signal bursts     : unsigned(7 downto 0) := (others => '0');
    signal rises      : unsigned(7 downto 0) := (others => '0');
    signal lead_width  : unsigned(31 downto 0) := (others => '0');
    signal space1_reg  : unsigned(31 downto 0) := (others => '0');
begin
    process (CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            last_ir <= to_x01(IR);
            cnt <= cnt + 1;
            if last_ir = '1' and to_x01(IR) = '0' then
                bursts <= bursts + 1;
                cnt <= (others => '0');
            elsif last_ir = '0' and to_x01(IR) = '1' then
                rises <= rises + 1;
                if rises = 0 then
                    lead_width <= cnt;        -- 9 ms leading burst
                end if;
                if rises = 2 then
                    space1_reg <= cnt;        -- trailing space of the first data bit
                end if;
                cnt <= (others => '0');
            end if;
        end if;
    end process;

    LEAD   <= std_logic_vector(lead_width);
    COUNT  <= std_logic_vector(bursts);
    SPACE1 <= std_logic_vector(space1_reg);
end architecture;
