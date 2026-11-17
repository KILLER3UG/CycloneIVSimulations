library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M6: all four digits selected, all seven segments lit.
-- Note: SEG[7] (dp) is undriven here. Unused pins are weak-pull-up
-- tri-stated (vendor .qsf RESERVE_ALL_UNUSED_PINS), so dp stays OFF on the
-- real board — 28 of 32 board segments light, not 32.
entity seg_allon is
    port (
        clk       : in  std_logic;
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_allon;

architecture rtl of seg_allon is
begin
    dtube     <= "0000";        -- all digits selected
    seven_seg <= not "1111111"; -- all seven segments lit (active-low)
end architecture;
