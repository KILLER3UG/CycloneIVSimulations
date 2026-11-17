library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Matrix test M7a (slow scan): phase = cnt(15 downto 14) -> each digit stays
-- selected for 16384 cycles (~164 us); within the 1.5 ms capture the scan
-- advances through all four digits.
entity seg_mux_slow is
    port (
        clk       : in  std_logic;
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_mux_slow;

architecture rtl of seg_mux_slow is
    signal cnt   : unsigned(15 downto 0) := (others => '0');
    signal phase : unsigned(1 downto 0)  := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;

    phase <= cnt(15 downto 14);

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
