-- FSM coverage: Moore traffic light, Mealy sequence detector, enumerated states.
library ieee;
use ieee.std_logic_1164.all;

entity traffic_moore is
    port (clk, rst : in  std_logic;
          red, yellow, green : out std_logic);
end entity traffic_moore;
architecture rtl of traffic_moore is
    type state_t is (S_RED, S_RED_YELLOW, S_GREEN, S_YELLOW);
    signal state : state_t := S_RED;
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                state <= S_RED;
            else
                case state is
                    when S_RED        => state <= S_RED_YELLOW;
                    when S_RED_YELLOW => state <= S_GREEN;
                    when S_GREEN      => state <= S_YELLOW;
                    when S_YELLOW     => state <= S_RED;
                end case;
            end if;
        end if;
    end process;

    red    <= '1' when state = S_RED or state = S_RED_YELLOW else '0';
    yellow <= '1' when state = S_RED_YELLOW or state = S_YELLOW else '0';
    green  <= '1' when state = S_GREEN else '0';
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity seq_mealy is
    port (clk, rst, din : in  std_logic;
          detected     : out std_logic);
end entity seq_mealy;
architecture rtl of seq_mealy is
    type state_t is (S0, S1, S2, S3);
    signal state : state_t := S0;
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                state <= S0;
            else
                case state is
                    when S0 => if din = '1' then state <= S1; else state <= S0; end if;
                    when S1 => if din = '0' then state <= S2; else state <= S1; end if;
                    when S2 => if din = '1' then state <= S3; else state <= S0; end if;
                    when S3 => if din = '1' then state <= S1; else state <= S2; end if;
                end case;
            end if;
        end if;
    end process;

    detected <= '1' when (state = S3 and din = '1') else '0';
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity enum_fsm is
    port (clk, rst, start : in  std_logic;
          busy, done       : out std_logic);
end entity enum_fsm;
architecture rtl of enum_fsm is
    type state_t is (IDLE, RUN, FINISH);
    signal state : state_t := IDLE;
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                state <= IDLE;
            else
                case state is
                    when IDLE   => if start = '1' then state <= RUN; end if;
                    when RUN    => state <= FINISH;
                    when FINISH => state <= IDLE;
                end case;
            end if;
        end if;
    end process;

    busy <= '1' when state = RUN else '0';
    done <= '1' when state = FINISH else '0';
end architecture rtl;
