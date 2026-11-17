library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- STOP 1B generic-timer proof.
-- Deliberately uses NO signal names from buzz1.vhd:
--   cnt_delay   (was sec_counter)
--   gate_en     (was timer_active)
--   half_period (was audibles)
-- Four keys select 500 / 800 / 1000 / 1600 Hz; release gives a 0.5 s note
-- (25,000,000 cycles at 50 MHz).
entity buzz_4tone is
    port (
        clk     : in  std_logic;
        btn1    : in  std_logic;
        btn2    : in  std_logic;
        btn3    : in  std_logic;
        btn4    : in  std_logic;
        buzzerb : out std_logic
    );
end entity buzz_4tone;

architecture rtl of buzz_4tone is
    constant delay_max : integer := 25_000_000;
    constant tone_max  : integer := 50_000;

    signal cnt_delay   : integer range 0 to delay_max := 0;
    signal gate_en     : std_logic := '0';
    signal tone_acc    : integer range 0 to tone_max := 0;
    signal tone_state  : std_logic := '0';
    signal half_period : integer range 0 to tone_max := 31_250;
    signal key_any     : std_logic;
begin

    key_any <= (not btn1) or (not btn2) or (not btn3) or (not btn4);

    process (clk)
    begin
        if rising_edge(clk) then
            if tone_acc >= half_period - 1 then
                tone_acc   <= 0;
                tone_state <= not tone_state;
            else
                tone_acc <= tone_acc + 1;
            end if;

            if key_any = '1' then
                -- latch the selected tone for the whole release note
                if btn1 = '0' then
                    half_period <= 50_000;      -- 500 Hz
                elsif btn2 = '0' then
                    half_period <= 31_250;      -- 800 Hz
                elsif btn3 = '0' then
                    half_period <= 25_000;      -- 1000 Hz
                elsif btn4 = '0' then
                    half_period <= 15_625;      -- 1600 Hz
                end if;
                cnt_delay <= delay_max - 1;
                gate_en   <= '1';
            elsif cnt_delay > 0 then
                cnt_delay <= cnt_delay - 1;
                gate_en   <= '1';
            else
                gate_en <= '0';
            end if;
        end if;
    end process;

    buzzerb <= tone_state or (not gate_en);

end architecture rtl;