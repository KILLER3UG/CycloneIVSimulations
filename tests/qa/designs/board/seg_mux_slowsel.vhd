library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity seg_mux_slowsel is
    port (
        clk       : in  std_logic;
        sw        : in  std_logic_vector(3 downto 0);
        dtube     : out std_logic_vector(3 downto 0);
        seven_seg : out std_logic_vector(6 downto 0)
    );
end seg_mux_slowsel;

architecture rtl of seg_mux_slowsel is
    signal cnt   : unsigned(15 downto 0) := (others => '0');
    signal phase : unsigned(1 downto 0)  := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;

    phase <= cnt(15 downto 14) + unsigned(sw(1 downto 0));

    process (phase)
    begin
        dtube <= "1111";
        dtube(to_integer(phase)) <= '0';
    end process;

    process (phase)
    begin
        case phase is
            when "00" => seven_seg <= not std_logic_vector(to_unsigned(6, 7));
            when "01" => seven_seg <= not std_logic_vector(to_unsigned(91, 7));
            when "10" => seven_seg <= not std_logic_vector(to_unsigned(79, 7));
            when others => seven_seg <= not std_logic_vector(to_unsigned(102, 7));
        end case;
    end process;
end architecture;
