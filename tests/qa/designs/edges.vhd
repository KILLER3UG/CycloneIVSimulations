-- Edge cases that should be diagnosed rather than silently accepted.
library ieee;
use ieee.std_logic_1164.all;

entity latch is
    port (e, d : in  std_logic;
          q    : out std_logic);
end entity latch;
architecture rtl of latch is
begin
    process (e)
    begin
        if e = '1' then
            q <= d;
        end if;
    end process;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity comb_loop is
    port (y : out std_logic);
end entity comb_loop;
architecture rtl of comb_loop is
    signal a : std_logic := '0';
begin
    a <= not a;
    y <= a;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity multi_driver is
    port (y : out std_logic);
end entity multi_driver;
architecture rtl of multi_driver is
begin
    y <= '0';
    y <= '1';
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity unassigned is
    port (q : out std_logic);
end entity unassigned;
architecture rtl of unassigned is
begin
    -- q is deliberately left unassigned.
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity after_arch is
    port (y : out std_logic);
end entity after_arch;
architecture rtl of after_arch is
    signal s : std_logic := '0';
begin
    s <= '1' after 5 ns;
    y <= s;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity assert_report is
    port (clk : in std_logic);
end entity assert_report;
architecture rtl of assert_report is
begin
    process (clk)
    begin
        if rising_edge(clk) then
            assert false report "QA assertion failure" severity failure;
        end if;
    end process;
end architecture rtl;


library ieee;
use ieee.std_logic_1164.all;

entity wait_arch is
    port (y : out std_logic);
end entity wait_arch;
architecture rtl of wait_arch is
begin
    process
    begin
        wait for 10 ns;
        y <= '1';
        wait;
    end process;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;

entity report_note is
    port (clk : in std_logic);
end entity report_note;
architecture rtl of report_note is
begin
    process (clk)
    begin
        if rising_edge(clk) then
            report "QA note from user design" severity note;
        end if;
    end process;
end architecture rtl;
