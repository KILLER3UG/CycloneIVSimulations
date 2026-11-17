library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M5: WRONG polarity on purpose. The board's display is
-- common-anode with active-low segments AND active-low digit selects; this
-- design drives everything active-high, so on the real board every tube
-- stays dark. The simulator must match that.
entity seg_polarity_inverted is
    port (
        clk       : in  std_logic;
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_polarity_inverted;

architecture rtl of seg_polarity_inverted is
begin
    dtube     <= "1111";      -- all digit lines high = no tube selected
    seven_seg <= "1111111";   -- all segment lines high = no segment lit
end architecture;
