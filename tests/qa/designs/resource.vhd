-- Resource-limit probe: 92 output pins, one more than the EP4CE6E22C8's 91.
library ieee;
use ieee.std_logic_1164.all;

entity wide_io is
    port (clk : in  std_logic;
          q   : out std_logic_vector(91 downto 0));
end entity wide_io;
architecture rtl of wide_io is
begin
    q <= (others => '0');
end architecture rtl;

-- Resource-limit probes (used by the QA resource-estimator cases):
-- big_regs declares more register bits than the EP4CE6E22C8N has logic
-- elements (6272); big_mem infers more M9K blocks than the device provides.
library ieee;
use ieee.std_logic_1164.all;

entity big_regs is
    port (clk : in  std_logic;
          d   : in  std_logic;
          q   : out std_logic);
end entity big_regs;
architecture rtl of big_regs is
    signal shift : std_logic_vector(8191 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            shift <= shift(8190 downto 0) & d;
        end if;
    end process;
    q <= shift(8191);
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity big_mem is
    port (clk  : in  std_logic;
          we   : in  std_logic;
          addr : in  integer range 0 to 20479;
          din  : in  std_logic_vector(15 downto 0);
          q    : out std_logic_vector(15 downto 0));
end entity big_mem;
architecture rtl of big_mem is
    type mem_t is array (0 to 20479) of std_logic_vector(15 downto 0);
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
