library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M2: digit 0 (rightmost tube) shows the hex glyph selected by
-- the DIP/keys strip (sw = the 4 shared KEY nets; ON/closed reads 0). The
-- glyph is purely sw-selected (time-independent). Walking all 16 switch
-- combinations displays all 16 glyphs 0-F.
entity seg_hex_sw is
    port (
        clk       : in  std_logic;
        sw        : in  std_logic_vector(3 downto 0);
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_hex_sw;

architecture rtl of seg_hex_sw is
    signal cnt : unsigned(15 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;

    dtube <= "1110";  -- digit 0 selected continuously (active-low)

    process (sw)
        variable sel : unsigned(3 downto 0);
    begin
        sel := unsigned(sw);  -- glyph purely DIP-selected (stable, time-independent)
        case sel is
            when "0000" => seven_seg <= not std_logic_vector(to_unsigned(63, 7));
            when "0001" => seven_seg <= not std_logic_vector(to_unsigned(6, 7));
            when "0010" => seven_seg <= not std_logic_vector(to_unsigned(91, 7));
            when "0011" => seven_seg <= not std_logic_vector(to_unsigned(79, 7));
            when "0100" => seven_seg <= not std_logic_vector(to_unsigned(102, 7));
            when "0101" => seven_seg <= not std_logic_vector(to_unsigned(109, 7));
            when "0110" => seven_seg <= not std_logic_vector(to_unsigned(125, 7));
            when "0111" => seven_seg <= not std_logic_vector(to_unsigned(7, 7));
            when "1000" => seven_seg <= not std_logic_vector(to_unsigned(127, 7));
            when "1001" => seven_seg <= not std_logic_vector(to_unsigned(111, 7));
            when "1010" => seven_seg <= not std_logic_vector(to_unsigned(119, 7));
            when "1011" => seven_seg <= not std_logic_vector(to_unsigned(124, 7));
            when "1100" => seven_seg <= not std_logic_vector(to_unsigned(57, 7));
            when "1101" => seven_seg <= not std_logic_vector(to_unsigned(94, 7));
            when "1110" => seven_seg <= not std_logic_vector(to_unsigned(121, 7));
            when "1111" => seven_seg <= not std_logic_vector(to_unsigned(113, 7));
            when others => seven_seg <= (others => '1');
        end case;
    end process;
end architecture;
