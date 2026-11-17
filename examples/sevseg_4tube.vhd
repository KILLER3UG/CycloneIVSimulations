-- 4-tube multiplexed 7-segment demo: shows 1 / 2 / 3 / 4 across the four
-- tubes. A free-running counter's top two bits select the active tube and the
-- matching glyph, so each tube is driven 1/4 of the scan period. At the
-- board's 50 MHz clock the full scan takes 65,536 cycles (~1.31 ms, ~763 Hz),
-- well above the ~60 Hz persistence-of-vision threshold -- the eye sees all
-- four digits lit at once, each at ~25% duty-cycle brightness.
-- Uses textbook port names (seven_seg/dtube) -- the backend resolves them to
-- the board's SEG/DIG pins automatically (SEG1..SEG7 active-low, DIG1..DIG4
-- digit selects active-low).
library IEEE;
use IEEE.STD_LOGIC_1164.all;
use IEEE.NUMERIC_STD.all;

entity sevseg_4tube is
	port (
		clk       : in  std_logic;
		dtube     : out std_logic_vector(3 downto 0);
		seven_seg : out std_logic_vector(6 downto 0)
	);
end sevseg_4tube;

architecture rtl of sevseg_4tube is
	signal cnt   : unsigned(15 downto 0) := (others => '0');
	signal phase : unsigned(1 downto 0)  := (others => '0');
begin

	-- free-running scan counter
	process(clk)
	begin
		if rising_edge(clk) then
			cnt <= cnt + 1;
		end if;
	end process;

	-- 1-of-4 digit select: 16,384 clock cycles per tube
	phase <= cnt(15 downto 14);

	-- active-low digit enables: only the selected tube's common cathode is low
	process(phase)
	begin
		dtube <= "1111";
		dtube(to_integer(phase)) <= '0';
	end process;

	-- active-low segment drive (bit 0 = 'a' ... bit 6 = 'g'), one glyph per tube
	process(phase)
	begin
		case phase is
			when "00" => seven_seg <= "1111001"; -- 1  (segments b,c)
			when "01" => seven_seg <= "0100100"; -- 2  (a,b,d,e,g)
			when "10" => seven_seg <= "0110000"; -- 3  (a,b,c,d,g)
			when others => seven_seg <= "0011001"; -- 4 (b,c,f,g)
		end case;
	end process;

end rtl;
