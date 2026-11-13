-- Sequential coverage: DFF, up/down counter with load, universal shifter, LFSR.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity dff is
    port (clk, d, rst_n : in  std_logic;
          q             : out std_logic);
end entity dff;
architecture rtl of dff is
begin
    process (clk, rst_n)
    begin
        if rst_n = '0' then
            q <= '0';
        elsif rising_edge(clk) then
            q <= d;
        end if;
    end process;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter_updown is
    port (clk      : in  std_logic;
          rst      : in  std_logic;
          up_down  : in  std_logic;
          load     : in  std_logic;
          load_val : in  unsigned(7 downto 0);
          count    : out unsigned(7 downto 0));
end entity counter_updown;
architecture rtl of counter_updown is
    signal c : unsigned(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                c <= (others => '0');
            elsif load = '1' then
                c <= load_val;
            elsif up_down = '1' then
                c <= c + 1;
            else
                c <= c - 1;
            end if;
        end if;
    end process;
    count <= c;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity shift_universal is
    port (clk        : in  std_logic;
          rst        : in  std_logic;
          mode       : in  std_logic_vector(1 downto 0);
          serial_in  : in  std_logic;
          parallel_in: in  std_logic_vector(7 downto 0);
          q          : out std_logic_vector(7 downto 0));
end entity shift_universal;
architecture rtl of shift_universal is
    signal r : std_logic_vector(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                r <= (others => '0');
            else
                case mode is
                    when "00"   => null;
                    when "01"   => r <= serial_in & r(7 downto 1);
                    when "10"   => r <= r(6 downto 0) & serial_in;
                    when others => r <= parallel_in;
                end case;
            end if;
        end if;
    end process;
    q <= r;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity lfsr8 is
    port (clk : in  std_logic;
          rst : in  std_logic;
          q   : out std_logic_vector(7 downto 0));
end entity lfsr8;
architecture rtl of lfsr8 is
    signal r : std_logic_vector(7 downto 0) := (others => '0');
begin
    process (clk)
        variable next_bit : std_logic;
    begin
        if rising_edge(clk) then
            if rst = '1' then
                r <= "00000001";
            else
                next_bit := r(7) xor r(5) xor r(4) xor r(3);
                r <= r(6 downto 0) & next_bit;
            end if;
        end if;
    end process;
    q <= r;
end architecture rtl;