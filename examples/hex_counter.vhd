-- 4-digit multiplexed hexadecimal counter.
-- One 7-segment bus (`hex`) and a one-hot digit select (`dig`) drive all four
-- tubes: only one digit is lit at a time, fast enough that the eye blends them.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity hex_counter is
    port (
        clk   : in  std_logic;
        reset : in  std_logic;
        hex   : out std_logic_vector(6 downto 0);
        dig   : out std_logic_vector(3 downto 0)
    );
end entity hex_counter;

architecture rtl of hex_counter is
    signal count : unsigned(15 downto 0) := (others => '0');
    signal scan  : unsigned(1 downto 0)  := (others => '0');
    signal nib   : std_logic_vector(3 downto 0) := (others => '0');
begin
    process (clk, reset)
    begin
        if reset = '1' then
            count <= (others => '0');
            scan  <= (others => '0');
        elsif rising_edge(clk) then
            count <= count + 1;
            scan  <= scan + 1;
        end if;
    end process;

    with scan select nib <=
        std_logic_vector(count(3 downto 0))   when "00",
        std_logic_vector(count(7 downto 4))   when "01",
        std_logic_vector(count(11 downto 8))  when "10",
        std_logic_vector(count(15 downto 12)) when others;

    with scan select dig <=
        "0001" when "00",
        "0010" when "01",
        "0100" when "10",
        "1000" when others;

    with nib select hex <=
        "1000000" when "0000", -- 0
        "1111001" when "0001", -- 1
        "0100100" when "0010", -- 2
        "0110000" when "0011", -- 3
        "0011001" when "0100", -- 4
        "0010010" when "0101", -- 5
        "0000010" when "0110", -- 6
        "1111000" when "0111", -- 7
        "0000000" when "1000", -- 8
        "0010000" when "1001", -- 9
        "0001000" when "1010", -- A
        "0000011" when "1011", -- B
        "1000110" when "1100", -- C
        "0100001" when "1101", -- D
        "0000110" when "1110", -- E
        "0001110" when others; -- F
end architecture rtl;