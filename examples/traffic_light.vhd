-- Traffic-light Moore FSM: RED -> GREEN -> YELLOW -> RED.
-- led(0) = red, led(1) = yellow, led(2) = green.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity traffic_light is
    port (
        clk   : in  std_logic;
        reset : in  std_logic;
        led   : out std_logic_vector(2 downto 0)
    );
end entity traffic_light;

architecture rtl of traffic_light is
    type state_t is (RED, GREEN, YELLOW);
    signal state : state_t := RED;
    signal ticks : unsigned(3 downto 0) := (others => '0');
begin
    process (clk, reset)
    begin
        if reset = '1' then
            state <= RED;
            ticks <= (others => '0');
        elsif rising_edge(clk) then
            if ticks = 4 then
                ticks <= (others => '0');
                case state is
                    when RED =>
                        state <= GREEN;
                    when GREEN =>
                        state <= YELLOW;
                    when YELLOW =>
                        state <= RED;
                end case;
            else
                ticks <= ticks + 1;
            end if;
        end if;
    end process;

    with state select led <=
        "001" when RED,
        "010" when YELLOW,
        "100" when GREEN;
end architecture rtl;