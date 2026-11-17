library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M4a: digit 0 (rightmost tube) with ONLY segment 'a' lit.
entity seg_order_a_d0 is
    port (
        clk       : in  std_logic;
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_order_a_d0;

architecture rtl of seg_order_a_d0 is
begin
    dtube     <= "1110";  -- digit 0 selected
    seven_seg <= not std_logic_vector(to_unsigned(1, 7));  -- only segment a
end architecture;
