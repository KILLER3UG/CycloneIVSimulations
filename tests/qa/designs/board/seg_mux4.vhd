library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M3/M7b (fast scan): four DIFFERENT glyphs ('1','2','3','4') on
-- digit indexes 0..3, scanning every 4 cycles (phase = cnt(3 downto 2)).
entity seg_mux4 is
    port (
        clk       : in  std_logic;
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_mux4;

architecture rtl of seg_mux4 is
    signal cnt   : unsigned(15 downto 0) := (others => '0');
    signal phase : unsigned(1 downto 0)  := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;

    phase <= cnt(3 downto 2);

    process (phase)
    begin
        dtube <= "1111";
        dtube(to_integer(phase)) <= '0';
    end process;

    process (phase)
    begin
        case phase is
            when "00" => {seg_expr(N["1"])}
            when "01" => {seg_expr(N["2"])}
            when "10" => {seg_expr(N["3"])}
            when others => {seg_expr(N["4"])}
        end case;
    end process;
end architecture;
