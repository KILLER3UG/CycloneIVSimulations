-- 4-tube multiplexed 7-segment demo, interactive: the four shared key/DIP
-- inputs (key = K1..K4 on PIN_88/89/90/91, active-low) select the displayed
-- digit. Idle (all keys open) multiplexes 1 / 2 / 3 / 4 across the tubes
-- (D1="1", D2="2", D3="3", D4="4"); holding K1..K4 immediately shows
-- 1111 / 2222 / 3333 / 4444 on ALL four tubes (the studio's pre-computed
-- stimulus map applies the new state in < 1 ms, no re-run needed).
-- A free-running counter's top two bits select the active tube, so each tube
-- is driven 1/4 of the scan period. At the board's 50 MHz clock the full scan
-- takes 65,536 cycles (~1.31 ms, ~763 Hz), well above the ~60 Hz persistence-
-- of-vision threshold -- the eye sees all four digits lit at once, each at
-- ~25% duty-cycle brightness.
-- Uses textbook port names (seven_seg/dtube) -- the backend resolves them to
-- the board's SEG/DIG pins automatically (SEG1..SEG7 active-low, DIG1..DIG4
-- digit selects active-low). The decimal point (PIN_127) is intentionally
-- left unassigned and stays dark.
library IEEE;
use IEEE.STD_LOGIC_1164.all;
use IEEE.NUMERIC_STD.all;

entity sevseg_4tube is
	port (
		clk       : in  std_logic;
		key       : in  std_logic_vector(3 downto 0); -- K1..K4 / S1..S4 (active-low)
		dtube     : out std_logic_vector(3 downto 0); -- D1..D4 digit selects (active-low)
		seven_seg : out std_logic_vector(6 downto 0)  -- a..g segments (active-low)
	);
end sevseg_4tube;

architecture rtl of sevseg_4tube is
	signal cnt    : unsigned(15 downto 0) := (others => '0');
	signal phase  : unsigned(1 downto 0)  := (others => '0');
	signal win    : integer range 0 to 4   := 0; -- 0 = idle (per-tube digits)
	signal glyph  : integer range 0 to 4   := 0; -- digit on the selected tube
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

	-- key priority: the lowest-numbered held key wins; none held -> idle
	process(key)
	begin
		if key(0) = '0' then
			win <= 1;
		elsif key(1) = '0' then
			win <= 2;
		elsif key(2) = '0' then
			win <= 3;
		elsif key(3) = '0' then
			win <= 4;
		else
			win <= 0;
		end if;
	end process;

	-- active-low digit enables: only the selected tube's common cathode is low
	process(phase)
	begin
		dtube <= "1111";
		dtube(to_integer(phase)) <= '0';
	end process;

	-- per-tube digit: idle shows 1/2/3/4 on D1/D2/D3/D4; a held key forces
	-- that digit on ALL four tubes
	process(phase, win)
	begin
		if win /= 0 then
			glyph <= win;
		else
			case phase is
				when "11" => glyph <= 1; -- D1 (dtube(3))
				when "10" => glyph <= 2; -- D2 (dtube(2))
				when "01" => glyph <= 3; -- D3 (dtube(1))
				when others => glyph <= 4; -- D4 (dtube(0))
			end case;
		end if;
	end process;

	-- active-low segment drive (bit 0 = 'a' ... bit 6 = 'g')
	process(glyph)
	begin
		case glyph is
			when 1 => seven_seg <= "1111001"; -- 1  (segments b,c)
			when 2 => seven_seg <= "0100100"; -- 2  (a,b,d,e,g)
			when 3 => seven_seg <= "0110000"; -- 3  (a,b,c,d,g)
			when 4 => seven_seg <= "0011001"; -- 4  (b,c,f,g)
			when others => seven_seg <= "1111111"; -- blank (defensive)
		end case;
	end process;

end rtl;
