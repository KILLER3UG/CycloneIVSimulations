library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M4b: digit 3 (leftmost tube) with ONLY segment 'g' lit.
entity seg_order_g_d3 is
    port (
        clk       : in  std_logic;
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_order_g_d3;

architecture rtl of seg_order_g_d3 is
begin
    dtube     <= "0111";  -- digit 3 selected
    seven_seg <= not std_logic_vector(to_unsigned(64, 7));  -- only segment g
end architecture;
