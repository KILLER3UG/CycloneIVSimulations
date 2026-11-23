library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use IEEE.NUMERIC_STD.ALL;

entity buzzb is
    Port (
        clk     : in  STD_LOGIC;
        btn1    : in  STD_LOGIC;
        btn2    : in  STD_LOGIC;
        btn3    : in  STD_LOGIC;
        btn4    : in  STD_LOGIC;
        buzzerb : out STD_LOGIC
    );
end buzzb;

architecture tingog of buzzb is
    constant tone1_500Hz  : integer := 50000;
    constant tone2_800Hz  : integer := 31250;
    constant tone3_1000Hz : integer := 25000;
    constant tone4_1600Hz : integer := 15625;

    signal audibles       : integer range 0 to tone1_500Hz := tone2_800Hz;
    signal tone_counter   : integer range 0 to tone1_500Hz := 0;
    signal tone_wave      : STD_LOGIC := '0';

    constant fivesec      : integer := 250000000; -- also verify 50000000 (1.0 s)
    signal sec_counter    : integer range 0 to fivesec := 0;
    signal timer_active   : STD_LOGIC := '0';

    signal orcombi        : STD_LOGIC;
begin
    orcombi <= (not btn1) or (not btn2) or (not btn3) or (not btn4);

    process(clk)
    begin
        if rising_edge(clk) then
            if btn1 = '0' then
                audibles <= tone1_500Hz;
            elsif btn2 = '0' then
                audibles <= tone2_800Hz;
            elsif btn3 = '0' then
                audibles <= tone3_1000Hz;
            elsif btn4 = '0' then
                audibles <= tone4_1600Hz;
            end if;

            if tone_counter >= audibles - 1 then
                tone_counter <= 0;
                tone_wave    <= not tone_wave;
            else
                tone_counter <= tone_counter + 1;
            end if;

            if orcombi = '1' then
                sec_counter  <= fivesec - 1;
                timer_active <= '1';
            elsif sec_counter > 0 then
                sec_counter  <= sec_counter - 1;
                timer_active <= '1';
            else
                timer_active <= '0';
            end if;
        end if;
    end process;

    buzzerb <= tone_wave or (not timer_active);
end tingog;
