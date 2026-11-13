-- Language features: generics, generate, functions/procedures, records,
-- signed arithmetic, tri-state, multiple clocks, derived clock, delta order.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity generic_counter is
    generic (WIDTH : integer := 8);
    port (clk, rst : in  std_logic;
          q        : out unsigned(WIDTH - 1 downto 0));
end entity generic_counter;
architecture rtl of generic_counter is
    signal c : unsigned(WIDTH - 1 downto 0) := (others => '0');
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

entity gen_parity is
    port (data   : in  std_logic_vector(3 downto 0);
          parity : out std_logic_vector(3 downto 0));
end entity gen_parity;
architecture rtl of gen_parity is
begin
    g_parity : for i in 0 to 3 generate
        parity(i) <= data(0) xor data(1) xor data(2) xor data(3);
    end generate g_parity;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

package func_pkg is
    type rec is record
        x : signed(3 downto 0);
        y : unsigned(3 downto 0);
    end record;
    function add2(a, b : integer) return integer;
    procedure bump(signal v : inout integer);
end package func_pkg;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

package body func_pkg is
    function add2(a, b : integer) return integer is
    begin
        return a + b;
    end function add2;

    procedure bump(signal v : inout integer) is
    begin
        v <= v + 1;
    end procedure bump;
end package body func_pkg;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.func_pkg.all;

entity func_user is
    port (a, b : in  integer range 0 to 15;
          y    : out integer range 0 to 31);
end entity func_user;
architecture rtl of func_user is
begin
    y <= add2(a, b);
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity signed_math is
    port (a, b : in  signed(3 downto 0);
          sum  : out signed(3 downto 0);
          diff : out signed(3 downto 0);
          ovf  : out std_logic);
end entity signed_math;
architecture rtl of signed_math is
begin
    sum  <= a + b;
    diff <= a - b;
    ovf  <= '1' when (a(3) = b(3)) and (sum(3) /= a(3)) else '0';
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity tri_state is
    port (oe      : in    std_logic;
          in_val  : in    std_logic_vector(3 downto 0);
          bus_io  : inout std_logic_vector(3 downto 0);
          out_val : out   std_logic_vector(3 downto 0));
end entity tri_state;
architecture rtl of tri_state is
begin
    bus_io  <= in_val when oe = '1' else (others => 'Z');
    out_val <= bus_io;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity multi_clock is
    port (clk_a, clk_b, rst : in  std_logic;
          qa, qb              : out unsigned(3 downto 0));
end entity multi_clock;
architecture rtl of multi_clock is
    signal a, b : unsigned(3 downto 0) := (others => '0');
begin
    process (clk_a, rst)
    begin
        if rst = '1' then
            a <= (others => '0');
        elsif rising_edge(clk_a) then
            a <= a + 1;
        end if;
    end process;

    process (clk_b, rst)
    begin
        if rst = '1' then
            b <= (others => '0');
        elsif rising_edge(clk_b) then
            b <= b + 2;
        end if;
    end process;

    qa <= a;
    qb <= b;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity clk_divider is
    port (clk     : in  std_logic;
          rst     : in  std_logic;
          clk_div : out std_logic;
          q       : out unsigned(3 downto 0));
end entity clk_divider;
architecture rtl of clk_divider is
    signal div : std_logic := '0';
    signal c   : unsigned(3 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            if rst = '1' then
                div <= '0';
            else
                div <= not div;
            end if;
        end if;
    end process;

    -- A register output used as a clock.  Simulates in GHDL; not directly
    -- synthesizable without a clock buffer in Quartus.
    process (div)
    begin
        if rising_edge(div) then
            c <= c + 1;
        end if;
    end process;

    clk_div <= div;
    q       <= c;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity delta_order is
    port (b : in  std_logic;
          a : out std_logic;
          c : out std_logic);
end entity delta_order;
architecture rtl of delta_order is
    signal sa : std_logic := '0';
begin
    sa <= b;
    a  <= sa;
    c  <= sa;
end architecture rtl;


library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.func_pkg.all;

entity record_user is
    port (clk : in  std_logic;
          a   : in  signed(3 downto 0);
          y   : out signed(3 downto 0));
end entity record_user;
architecture rtl of record_user is
    signal r : rec := (x => "0000", y => "0000");
begin
    process (clk)
    begin
        if rising_edge(clk) then
            r.x <= a;
        end if;
    end process;
    y <= r.x;
end architecture rtl;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity procedure_user is
    port (clk : in  std_logic;
          a   : in  integer range 0 to 63;
          y   : out integer range 0 to 127);
end entity procedure_user;
architecture rtl of procedure_user is
    procedure double_it(variable v : inout integer) is
    begin
        v := v * 2;
    end procedure double_it;
begin
    process (clk)
        variable t : integer range 0 to 127 := 0;
    begin
        if rising_edge(clk) then
            t := a;
            double_it(t);
            y <= t;
        end if;
    end process;
end architecture rtl;
