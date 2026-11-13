-- Memory and arithmetic blocks: single-port RAM, dual-port RAM, ROM, 18x18 multiplier.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ram_sp is
    port (clk  : in  std_logic;
          we   : in  std_logic;
          addr : in  integer range 0 to 7;
          din  : in  std_logic_vector(7 downto 0);
          q    : out std_logic_vector(7 downto 0));
end entity ram_sp;
architecture rtl of ram_sp is
    type mem_t is array (0 to 7) of std_logic_vector(7 downto 0);
    signal mem : mem_t := (others => (others => '0'));
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if we = '1' then
                mem(addr) <= din;
            end if;
            q <= mem(addr);
        end if;
    end process;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity ram_dp is
    port (clk   : in  std_logic;
          we_a  : in  std_logic;
          addr_a: in  integer range 0 to 7;
          din_a : in  std_logic_vector(7 downto 0);
          q_a   : out std_logic_vector(7 downto 0);
          addr_b: in  integer range 0 to 7;
          q_b   : out std_logic_vector(7 downto 0));
end entity ram_dp;
architecture rtl of ram_dp is
    type mem_t is array (0 to 7) of std_logic_vector(7 downto 0);
    signal mem : mem_t := (others => (others => '0'));
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if we_a = '1' then
                mem(addr_a) <= din_a;
            end if;
            q_a <= mem(addr_a);
            q_b <= mem(addr_b);
        end if;
    end process;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity rom16 is
    port (addr : in  integer range 0 to 15;
          q    : out std_logic_vector(7 downto 0));
end entity rom16;
architecture rtl of rom16 is
    type rom_t is array (0 to 15) of std_logic_vector(7 downto 0);
    constant rom : rom_t := (
        0 => "00000000", 1 => "00000001", 2 => "00000010", 3 => "00000011",
        4 => "00000100", 5 => "00000101", 6 => "00000110", 7 => "00000111",
        8 => "00001000", 9 => "00001001", 10 => "00001010", 11 => "00001011",
        12 => "00001100", 13 => "00001101", 14 => "00001110", 15 => "00001111"
    );
begin
    q <= rom(addr);
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity mult18 is
    port (a : in  unsigned(17 downto 0);
          b : in  unsigned(17 downto 0);
          p : out unsigned(35 downto 0));
end entity mult18;
architecture rtl of mult18 is
begin
    p <= a * b;
end architecture rtl;
