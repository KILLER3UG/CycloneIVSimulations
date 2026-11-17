library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M2: the rightmost tube (digit 0) shows the hex glyph of
-- cnt(3 downto 0), so stepping one cycle at a time walks glyphs 0-F.
-- Glyph patterns are numeric (bit0 = segment a, 1 = lit); the port drives
-- the active-low cathodes through the inversion.
entity seg_hex_digit is
    port (
        clk       : in  std_logic;
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_hex_digit;

architecture rtl of seg_hex_digit is
    signal cnt : unsigned(15 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;

    dtube <= "1110";  -- digit 0 selected continuously (active-low)

    process (cnt(3 downto 0))
    begin
        case cnt(3 downto 0) is
            when "0000" => seven_seg <= not std_logic_vector(to_unsigned(63, 7));
            when "0001" => seven_seg <= not std_logic_vector(to_unsigned(6, 7));
            when "0010" => seven_seg <= not std_logic_vector(to_unsigned(109, 7));
            when "0011" => seven_seg <= not std_logic_vector(to_unsigned(121, 7));
            when "0100" => seven_seg <= not std_logic_vector(to_unsigned(51, 7));
            when "0101" => seven_seg <= not std_logic_vector(to_unsigned(91, 7));
            when "0110" => seven_seg <= not std_logic_vector(to_unsigned(95, 7));
            when "0111" => seven_seg <= not std_logic_vector(to_unsigned(112, 7));
            when "1000" => seven_seg <= not std_logic_vector(to_unsigned(127, 7));
            when "1001" => seven_seg <= not std_logic_vector(to_unsigned(123, 7));
            when "1010" => seven_seg <= not std_logic_vector(to_unsigned(119, 7));
            when "1011" => seven_seg <= not std_logic_vector(to_unsigned(31, 7));
            when "1100" => seven_seg <= not std_logic_vector(to_unsigned(78, 7));
            when "1101" => seven_seg <= not std_logic_vector(to_unsigned(61, 7));
            when "1110" => seven_seg <= not std_logic_vector(to_unsigned(79, 7));
            when others => seven_seg <= not std_logic_vector(to_unsigned(71, 7));
        end case;
    end process;
end architecture;
