library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use IEEE.NUMERIC_STD.ALL;

entity buzz1 is
    Port (
        clk     : in  STD_LOGIC;
        btn1    : in  STD_LOGIC;
        btn2    : in  STD_LOGIC;
        buzzerb : out STD_LOGIC
    );
end buzz1;

architecture tingog of buzz1 is

    constant audibles     : integer := 31250;
    signal tone_counter   : integer range 0 to audibles := 0;
    signal tone_wave      : STD_LOGIC := '0';

    constant fivesec      : integer := 50000000;
    signal sec_counter    : integer range 0 to fivesec := 0;
    signal timer_active   : STD_LOGIC := '0';

    signal orcombi        : STD_LOGIC;
begin

    orcombi <= (not btn1) or (not btn2);

    process(clk)
    begin
        if rising_edge(clk) then

            if tone_counter = audibles - 1 then
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