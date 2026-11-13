-- Clock and reset variants used by the QA suite.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter8 is
    port (clk, rst : in  std_logic;
          q        : out unsigned(7 downto 0));
end entity counter8;
architecture rtl of counter8 is
    signal c : unsigned(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                c <= (others => '0');
            else
                c <= c + 1;
            end if;
        end if;
    end process;
    q <= c;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity rst_async_low is
    port (clk, rst_n : in  std_logic;
          q          : out unsigned(7 downto 0));
end entity rst_async_low;
architecture rtl of rst_async_low is
    signal c : unsigned(7 downto 0) := (others => '0');
begin
    process (clk, rst_n)
    begin
        if rst_n = '0' then
            c <= (others => '0');
        elsif rising_edge(clk) then
            c <= c + 1;
        end if;
    end process;
    q <= c;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity rst_async_high is
    port (clk, rst : in  std_logic;
          q        : out unsigned(7 downto 0));
end entity rst_async_high;
architecture rtl of rst_async_high is
    signal c : unsigned(7 downto 0) := (others => '0');
begin
    process (clk, rst)
    begin
        if rst = '1' then
            c <= (others => '0');
        elsif rising_edge(clk) then
            c <= c + 1;
        end if;
    end process;
    q <= c;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity rst_sync_low is
    port (clk, rst_n : in  std_logic;
          q          : out unsigned(7 downto 0));
end entity rst_sync_low;
architecture rtl of rst_sync_low is
    signal c : unsigned(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst_n = '0' then
                c <= (others => '0');
            else
                c <= c + 1;
            end if;
        end if;
    end process;
    q <= c;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity pwr_init is
    port (clk : in  std_logic;
          q   : out unsigned(3 downto 0));
end entity pwr_init;
architecture rtl of pwr_init is
    signal c : unsigned(3 downto 0) := "0101";
begin
    process (clk)
    begin
        if rising_edge(clk) then
            c <= c + 1;
        end if;
    end process;
    q <= c;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity pwr_noinit is
    port (clk : in  std_logic;
          q   : out unsigned(3 downto 0));
end entity pwr_noinit;
architecture rtl of pwr_noinit is
    signal c : unsigned(3 downto 0);
begin
    process (clk)
    begin
        if rising_edge(clk) then
            c <= c + 1;
        end if;
    end process;
    q <= c;
end architecture rtl;