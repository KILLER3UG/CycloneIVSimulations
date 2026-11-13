-- Exhaustive hex decoder check for digits 0..F.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tb_hex_all is
end entity tb_hex_all;

architecture sim of tb_hex_all is
    signal sw   : std_logic_vector(3 downto 0) := (others => '0');
    signal hex0 : std_logic_vector(6 downto 0);
    type table_t is array (0 to 15) of std_logic_vector(6 downto 0);
    constant expected : table_t := (
        0 => "1000000", 1 => "1111001", 2 => "0100100", 3 => "0110000",
        4 => "0011001", 5 => "0010010", 6 => "0000010", 7 => "1111000",
        8 => "0000000", 9 => "0010000", 10 => "0001000", 11 => "0000011",
        12 => "1000110", 13 => "0100001", 14 => "0000110", 15 => "0001110"
    );
begin
    uut : entity work.hex_dec
        port map (sw => sw, hex0 => hex0);

    process
    begin
        for v in 0 to 15 loop
            sw <= std_logic_vector(to_unsigned(v, 4));
            wait for 1 ns;
            assert hex0 = expected(v)
                report "hex mismatch at " & integer'image(v) severity failure;
        end loop;
        report "ALL_HEX_OK" severity note;
        wait;
    end process;
end architecture sim;