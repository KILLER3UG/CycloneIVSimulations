-- Reference designs a student would run on a real EP4CE6E22C8 board.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity blinky is
    generic (CLK_HZ : natural := 50_000_000);
    port (clk : in  std_logic;
          rst : in  std_logic;
          led : out std_logic);
end entity blinky;
architecture rtl of blinky is
    constant HALF : natural := CLK_HZ / 2;
    signal c : unsigned(25 downto 0) := (others => '0');
    signal l : std_logic := '0';
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                c <= (others => '0');
                l <= '0';
            elsif c = HALF - 1 then
                c <= (others => '0');
                l <= not l;
            else
                c <= c + 1;
            end if;
        end if;
    end process;
    led <= l;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity debounce_counter is
    port (clk : in  std_logic;
          rst : in  std_logic;
          key : in  std_logic;
          led : out unsigned(7 downto 0));
end entity debounce_counter;
architecture rtl of debounce_counter is
    signal shift    : std_logic_vector(3 downto 0) := (others => '0');
    signal stable   : std_logic := '0';
    signal stable_q : std_logic := '0';
    signal count    : unsigned(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                shift <= (others => '0');
                stable <= '0';
                stable_q <= '0';
                count <= (others => '0');
            else
                shift <= shift(2 downto 0) & key;
                if shift = "1111" then
                    stable <= '1';
                elsif shift = "0000" then
                    stable <= '0';
                end if;
                stable_q <= stable;
                if stable = '1' and stable_q = '0' then
                    count <= count + 1;
                end if;
            end if;
        end if;
    end process;
    led <= count;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity knight_rider is
    port (clk : in  std_logic;
          rst : in  std_logic;
          led : out std_logic_vector(7 downto 0));
end entity knight_rider;
architecture rtl of knight_rider is
    signal r : std_logic_vector(7 downto 0) := "00000001";
    signal dir : std_logic := '1';
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                r <= "00000001";
                dir <= '1';
            elsif dir = '1' then
                if r(7) = '1' then
                    dir <= '0';
                    r <= r(6 downto 0) & '0';
                else
                    r <= r(6 downto 0) & '0';
                end if;
            else
                if r(0) = '1' then
                    dir <= '1';
                    r <= '0' & r(7 downto 1);
                else
                    r <= '0' & r(7 downto 1);
                end if;
            end if;
        end if;
    end process;
    led <= r;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity rom_display is
    port (addr : in  std_logic_vector(3 downto 0);
          hex0 : out std_logic_vector(6 downto 0));
end entity rom_display;
architecture rtl of rom_display is
    type rom_t is array (0 to 15) of std_logic_vector(6 downto 0);
    constant pattern : rom_t := (
        0 => "1000000", 1 => "1111001", 2 => "0100100", 3 => "0110000",
        4 => "0011001", 5 => "0010010", 6 => "0000010", 7 => "1111000",
        8 => "0000000", 9 => "0010000", 10 => "0001000", 11 => "0000011",
        12 => "1000110", 13 => "0100001", 14 => "0000110", 15 => "0001110"
    );
begin
    hex0 <= pattern(to_integer(unsigned(addr)));
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity pll_blinky is
    port (inclk0 : in  std_logic;
          rst    : in  std_logic;
          led    : out std_logic);
end entity pll_blinky;
architecture rtl of pll_blinky is
    component altpll
        generic (
            inclk0_input_frequency : natural := 50;
            intended_device_family : string  := "Cyclone IV E";
            clk0_multiply_by       : natural := 1;
            clk0_divide_by         : natural := 1
        );
        port (
            inclk0 : in  std_logic;
            c0     : out std_logic;
            locked : out std_logic
        );
    end component altpll;
    signal clk_pll : std_logic;
    signal locked  : std_logic;
    signal c : unsigned(25 downto 0) := (others => '0');
    signal l : std_logic := '0';
begin
    u_pll : altpll
        generic map (inclk0_input_frequency => 50, intended_device_family => "Cyclone IV E",
                     clk0_multiply_by => 1, clk0_divide_by => 1)
        port map (inclk0 => inclk0, c0 => clk_pll, locked => locked);

    process (clk_pll)
    begin
        if rising_edge(clk_pll) then
            if rst = '1' or locked = '0' then
                c <= (others => '0');
                l <= '0';
            elsif c = 25_000_000 - 1 then
                c <= (others => '0');
                l <= not l;
            else
                c <= c + 1;
            end if;
        end if;
    end process;
    led <= l;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity sw_led is
    port (sw  : in  std_logic_vector(7 downto 0);
          led : out std_logic_vector(7 downto 0));
end entity sw_led;
architecture rtl of sw_led is
begin
    led <= sw;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity hex_counter is
    port (clk : in  std_logic;
          rst : in  std_logic;
          value : out std_logic_vector(15 downto 0);
          dig   : out std_logic_vector(1 downto 0);
          seg   : out std_logic_vector(6 downto 0));
end entity hex_counter;
architecture rtl of hex_counter is
    signal v : unsigned(15 downto 0) := (others => '0');
    signal d : unsigned(1 downto 0) := (others => '0');
    function hexval(x : std_logic_vector(3 downto 0)) return std_logic_vector is
    begin
        case x is
            when "0000" => return "1000000";
            when "0001" => return "1111001";
            when "0010" => return "0100100";
            when "0011" => return "0110000";
            when "0100" => return "0011001";
            when "0101" => return "0010010";
            when "0110" => return "0000010";
            when "0111" => return "1111000";
            when "1000" => return "0000000";
            when "1001" => return "0010000";
            when "1010" => return "0001000";
            when "1011" => return "0000011";
            when "1100" => return "1000110";
            when "1101" => return "0100001";
            when "1110" => return "0000110";
            when others => return "0001110";
        end case;
    end function hexval;
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                v <= (others => '0');
                d <= (others => '0');
            else
                v <= v + 1;
                d <= d + 1;
            end if;
        end if;
    end process;
    value <= std_logic_vector(v);
    dig   <= std_logic_vector(d);
    with d select seg <=
        hexval(std_logic_vector(v(3 downto 0)))  when "00",
        hexval(std_logic_vector(v(7 downto 4)))  when "01",
        hexval(std_logic_vector(v(11 downto 8))) when "10",
        hexval(std_logic_vector(v(15 downto 12))) when others;
end architecture rtl;
