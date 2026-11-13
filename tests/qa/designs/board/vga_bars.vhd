-- VGA 640x480@60 colour bars on the A2.2 (8 colours, 1-bit RGB).
-- Pixel clock 25 MHz (period 40 ns in the simulator; the real board uses
-- 25.175 MHz from the PLL).  VGA_R/G/B = 104/105/106, HS = 101, VS = 103.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity vga_bars is
    port (
        CLOCK_50   : in    std_logic;          -- pixel clock (25 MHz in the sim)
        VGA_HSYNC  : out   std_logic;
        VGA_VSYNC  : out   std_logic;
        VGA_R      : out   std_logic;
        VGA_G      : out   std_logic;
        VGA_B      : out   std_logic
    );
end entity vga_bars;

architecture rtl of vga_bars is
    signal hcount : unsigned(9 downto 0) := (others => '0');
    signal vcount : unsigned(9 downto 0) := (others => '0');
begin
    process (CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            if hcount = 799 then
                hcount <= (others => '0');
                if vcount = 524 then
                    vcount <= (others => '0');
                else
                    vcount <= vcount + 1;
                end if;
            else
                hcount <= hcount + 1;
            end if;
        end if;
    end process;

    VGA_HSYNC <= '0' when hcount >= 656 and hcount < 752 else '1';
    VGA_VSYNC <= '0' when vcount >= 490 and vcount < 492 else '1';

    process (hcount)
        variable band : unsigned(2 downto 0);
    begin
        if hcount < 640 then
            band := resize(hcount(8 downto 6), 3);
            VGA_R <= band(2);
            VGA_G <= band(1);
            VGA_B <= band(0);
        else
            VGA_R <= '0';
            VGA_G <= '0';
            VGA_B <= '0';
        end if;
    end process;
end architecture rtl;
