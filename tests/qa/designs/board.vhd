-- Board-level designs whose ports map to LEDs, switches, keys and 7-segment digits.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity sw_led8 is
    port (sw  : in  std_logic_vector(7 downto 0);
          led : out std_logic_vector(7 downto 0));
end entity sw_led8;
architecture rtl of sw_led8 is
begin
    led <= sw;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity key_edge is
    port (clk : in  std_logic;
          key : in  std_logic;
          led : out unsigned(7 downto 0));
end entity key_edge;
architecture rtl of key_edge is
    signal key_q : std_logic := '0';
    signal count : unsigned(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            key_q <= key;
            if key = '1' and key_q = '0' then
                count <= count + 1;
            end if;
        end if;
    end process;
    led <= count;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity hex_dec is
    port (sw   : in  std_logic_vector(3 downto 0);
          hex0 : out std_logic_vector(6 downto 0));
end entity hex_dec;
architecture rtl of hex_dec is
begin
    with sw select hex0 <=
        "1000000" when "0000",
        "1111001" when "0001",
        "0100100" when "0010",
        "0110000" when "0011",
        "0011001" when "0100",
        "0010010" when "0101",
        "0000010" when "0110",
        "1111000" when "0111",
        "0000000" when "1000",
        "0010000" when "1001",
        "0001000" when "1010",
        "0000011" when "1011",
        "1000110" when "1100",
        "0100001" when "1101",
        "0000110" when "1110",
        "0001110" when others;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity seg_multiplex is
    port (clk    : in  std_logic;
          value  : in  std_logic_vector(15 downto 0);
          dig    : out std_logic_vector(1 downto 0);
          seg    : out std_logic_vector(6 downto 0));
end entity seg_multiplex;
architecture rtl of seg_multiplex is
    signal d : unsigned(1 downto 0) := (others => '0');
    function hexval(v : std_logic_vector(3 downto 0)) return std_logic_vector is
    begin
        case v is
            when "0000" => return "1000000";
            when "0001" => return "1111001";
            when "0010" => return "0100100";
            when "0011" => return "0110000";
            when "0100" => return "0011001";
            when "0101" => return "0010010";
            when "0110" => return "0000010";
            when "0111" => return "1111000";
            when "1000" => return "0000000";
            when "1001" => return "0010000";
            when "1010" => return "0001000";
            when "1011" => return "0000011";
            when "1100" => return "1000110";
            when "1101" => return "0100001";
            when "1110" => return "0000110";
            when others => return "0001110";
        end case;
    end function hexval;
begin
    process (clk)
    begin
        if rising_edge(clk) then
            d <= d + 1;
        end if;
    end process;
    dig <= std_logic_vector(d);
    with d select seg <=
        hexval(value(3 downto 0))  when "00",
        hexval(value(7 downto 4))  when "01",
        hexval(value(11 downto 8)) when "10",
        hexval(value(15 downto 12)) when others;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity led_patterns is
    port (mode : in  std_logic_vector(1 downto 0);
          led  : out std_logic_vector(7 downto 0));
end entity led_patterns;
architecture rtl of led_patterns is
begin
    with mode select led <=
        "10000000" when "00",
        "01000000" when "01",
        "11111111" when "10",
        "00000000" when others;
end architecture rtl;
