-- Combinational coverage: gates, mux, adder, comparator, decoder, priority encoder.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity gates is
    port (a, b : in  std_logic;
          y_and, y_or, y_xor, y_nand : out std_logic);
end entity gates;
architecture rtl of gates is
begin
    y_and  <= a and b;
    y_or   <= a or b;
    y_xor  <= a xor b;
    y_nand <= a nand b;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity mux4 is
    port (d   : in  std_logic_vector(3 downto 0);
          sel : in  std_logic_vector(1 downto 0);
          y   : out std_logic);
end entity mux4;
architecture rtl of mux4 is
begin
    with sel select y <=
        d(0) when "00",
        d(1) when "01",
        d(2) when "10",
        d(3) when others;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity adder4 is
    port (a, b : in  unsigned(3 downto 0);
          sum  : out unsigned(3 downto 0);
          cout : out std_logic);
end entity adder4;
architecture rtl of adder4 is
    signal total : unsigned(4 downto 0);
begin
    total <= ("0" & a) + ("0" & b);
    sum   <= total(3 downto 0);
    cout  <= total(4);
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity cmp4 is
    port (a, b : in  unsigned(3 downto 0);
          gt, lt, eq : out std_logic);
end entity cmp4;
architecture rtl of cmp4 is
begin
    gt <= '1' when a > b else '0';
    lt <= '1' when a < b else '0';
    eq <= '1' when a = b else '0';
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity decoder2to4 is
    port (sel : in  std_logic_vector(1 downto 0);
          y   : out std_logic_vector(3 downto 0));
end entity decoder2to4;
architecture rtl of decoder2to4 is
begin
    with sel select y <=
        "0001" when "00",
        "0010" when "01",
        "0100" when "10",
        "1000" when others;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity prio_encoder is
    port (req   : in  std_logic_vector(3 downto 0);
          grant : out std_logic_vector(1 downto 0);
          valid : out std_logic);
end entity prio_encoder;
architecture rtl of prio_encoder is
begin
    process (req)
    begin
        if req(3) = '1' then
            grant <= "11";
        elsif req(2) = '1' then
            grant <= "10";
        elsif req(1) = '1' then
            grant <= "01";
        else
            grant <= "00";
        end if;
        if req = "0000" then
            valid <= '0';
        else
            valid <= '1';
        end if;
    end process;
end architecture rtl;