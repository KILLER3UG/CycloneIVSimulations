-- RZ-EasyFPGA A2.2 demo: every on-board peripheral, REAL board polarity.
-- CLOCK_50 = 50 MHz.  KEY[3:0] and the DIP share pins (active low, 10k pull-ups).
-- LED[3:0] are active LOW (lit = 0).  The display is a 4-digit common-anode
-- multiplexed tube: DIG[x] = 0 selects the digit, SEG[x] = 0 lights a segment.
-- SEG bit order per the schematic: SEG0=b, SEG1=a, SEG2=c, SEG3=d,
-- SEG4=e, SEG5=f, SEG6=g, SEG7=dp.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity a22_demo is
    port (
        CLOCK_50 : in    std_logic;
        KEY      : in    std_logic_vector(3 downto 0);
        LED      : out   std_logic_vector(3 downto 0);
        SEG      : out   std_logic_vector(7 downto 0);
        DIG      : out   std_logic_vector(3 downto 0)
    );
end entity a22_demo;

architecture rtl of a22_demo is
    signal count : unsigned(13 downto 0) := (others => '0');

    -- a..g pattern, 1 = segment lit (standard hex digit shapes)
    function hexpat(x : std_logic_vector(3 downto 0)) return std_logic_vector is
        variable pat : std_logic_vector(6 downto 0);
    begin
        case x is
            when "0000" => pat := "1111110";
            when "0001" => pat := "0110000";
            when "0010" => pat := "1101101";
            when "0011" => pat := "1111001";
            when "0100" => pat := "0110011";
            when "0101" => pat := "1011011";
            when "0110" => pat := "1011111";
            when "0111" => pat := "1110000";
            when "1000" => pat := "1111111";
            when "1001" => pat := "1111011";
            when "1010" => pat := "1110111";
            when "1011" => pat := "0011111";
            when "1100" => pat := "1001110";
            when "1101" => pat := "0111101";
            when "1110" => pat := "1001111";
            when others => pat := "1000111";
        end case;
        return pat;
    end function hexpat;

    -- Map a..g onto the SEG bits and invert: SEG = 0 lights the segment.
    -- SEG0=b, SEG1=a, SEG2=c, SEG3=d, SEG4=e, SEG5=f, SEG6=g, SEG7=dp.
    function seg7(x : std_logic_vector(3 downto 0)) return std_logic_vector is
        variable pat : std_logic_vector(6 downto 0);
        variable v   : std_logic_vector(7 downto 0);
    begin
        pat := hexpat(x);
        v(0) := not pat(1); -- b
        v(1) := not pat(0); -- a
        v(2) := not pat(2); -- c
        v(3) := not pat(3); -- d
        v(4) := not pat(4); -- e
        v(5) := not pat(5); -- f
        v(6) := not pat(6); -- g
        v(7) := '1';        -- dp off
        return v;
    end function seg7;
begin
    process (CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            count <= count + 1;
        end if;
    end process;

    -- LEDs are active low: they show the inverted counter bits.
    LED <= not std_logic_vector(count(13 downto 10)) when KEY(0) = '1' else "1111";

    -- Multiplexing: DIG one-cold (0 selects the digit).
    DIG <= "1110" when count(1 downto 0) = "00" else
           "1101" when count(1 downto 0) = "01" else
           "1011" when count(1 downto 0) = "10" else
           "0111";

    with count(1 downto 0) select SEG <=
        seg7(std_logic_vector(count(5 downto 2)))  when "00",
        seg7(std_logic_vector(count(7 downto 4)))  when "01",
        seg7(std_logic_vector(count(9 downto 6)))  when "10",
        seg7(std_logic_vector(count(11 downto 8))) when others;
end architecture rtl;
