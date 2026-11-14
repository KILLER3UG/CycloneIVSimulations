-- 4-digit 7-segment display driven by the DIP/keys (s1..s4 -> KEY nets).
-- A tube lights only while S1 is closed and any of S2..S4 is closed; the
-- lit glyph rotates through the four tubes with the counter's top bits.
-- Uses textbook port names (seven_seg/dtube) — the backend resolves them
-- to the board's SEG/DIG pins automatically.
library IEEE;
use IEEE.STD_LOGIC_1164.all;
use IEEE.NUMERIC_STD.all;

entity sevseg is
	port (
		clk       : in  std_logic;
		s1        : in  std_logic;
		s2        : in  std_logic;
		s3        : in  std_logic;
		s4        : in  std_logic;
		dtube     : out std_logic_vector(3 downto 0);
		seven_seg : out std_logic_vector(6 downto 0)
	);
end sevseg;

architecture logicgate of sevseg is
	signal cnt : unsigned(15 downto 0) := (others => '0');
	signal k1, k2, k3, k4 : std_logic;
	signal ge : std_logic;
	signal p3, p2, p1, p0 : std_logic;
	signal en3, en2, en1, en0 : std_logic;
	signal sa, sb, sc, sd, se, sf, sg : std_logic;
begin

	process(clk)
	begin
		if rising_edge(clk) then
			cnt <= cnt + 1;
		end if;
	end process;

	k1 <= not s1;
	k2 <= not s2;
	k3 <= not s3;
	k4 <= not s4;

	ge <= k1 and (k2 or k3 or k4);

	p3 <= (not cnt(15)) and (not cnt(14));
	p2 <= (not cnt(15)) and cnt(14);
	p1 <= cnt(15) and (not cnt(14));
	p0 <= cnt(15) and cnt(14);

	en3 <= ge and p3;
	en2 <= ge and p2;
	en1 <= ge and p1;
	en0 <= ge and p0;

	dtube(3) <= not en3;
	dtube(2) <= not en2;
	dtube(1) <= not en1;
	dtube(0) <= not en0;

	sa <= p3 or p2 or p0;
	sb <= p3 or p2;
	sc <= p3 or p2 or p1;
	sd <= p3 or p1 or p0;
	se <= p2 or p1 or p0;
	sf <= p3 or p2 or p1 or p0;
	sg <= p3 or p2 or p1;

	seven_seg(0) <= not sa;
	seven_seg(1) <= not sb;
	seven_seg(2) <= not sc;
	seven_seg(3) <= not sd;
	seven_seg(4) <= not se;
	seven_seg(5) <= not sf;
	seven_seg(6) <= not sg;

end logicgate;
