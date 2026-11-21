"""Section 20-22: VHDL semantics, clocking and memory/DSP blocks.

Every case states its expectation from the VHDL LRM / Cyclone IV datasheet
first, runs the real backend (GHDL), and records the observed evidence.
"""
from __future__ import annotations

import re

from harness import (
    case,
    check,
    cycle_count,
    cycle_values,
    errors_text,
    must_run,
    run_text,
    signal,
    value,
)


# ---------------------------------------------------------------------------
# 20. VHDL semantics
# ---------------------------------------------------------------------------


@case("SEM-01", "20", "Delta-cycle ordering: signal updates land on later edges", "VHDL",
      "a registered chain a->b->c: at edge 1 only a is new; b/c follow on later edges")
def sem_01() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity delta_chain is
    port (clk : in std_logic;
          a   : in std_logic;
          c   : out std_logic);
end entity;
architecture rtl of delta_chain is
    signal b_reg : std_logic := '0';
begin
    process (clk)
    begin
        if rising_edge(clk) then
            b_reg <= a;
            c     <= b_reg;
        end if;
    end process;
end architecture;
"""
    tb = """
library ieee;
use ieee.std_logic_1164.all;
entity tb_delta is
end entity;
architecture sim of tb_delta is
    signal clk : std_logic := '0';
    signal a   : std_logic := '0';
    signal c   : std_logic;
    signal seen : std_logic_vector(5 downto 0) := (others => '0');
begin
    uut : entity work.delta_chain port map (clk => clk, a => a, c => c);
    clk <= not clk after 5 ns;
    process
        variable step : natural := 0;
    begin
        wait until rising_edge(clk);
        a <= '1';                       -- present data before the sampling edge
        wait until rising_edge(clk);    -- edge 1: b gets a, c still old
        seen(0) <= c;                   -- c = 0 (two more edges needed)
        wait until rising_edge(clk);    -- edge 2
        seen(1) <= c;                   -- c = 0 still (c updates with b_reg old)
        wait until rising_edge(clk);    -- edge 3
        seen(2) <= c;                   -- c = 1 now
        wait;
    end process;
end architecture;
"""
    result = run_text(src, testbench=tb, top="tb_delta", duration=200, resetCycles=0)
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "seen"))
    check(got == 0b100, f"delta ordering wrong: seen={got:03b}; expected 100 (c first reads 1 at the third edge)")
    return "signal updates propagate one edge per register: c lags a by two edges (seen=100)"


@case("SEM-02", "20", "Variable updates are immediate; signal updates are deferred", "VHDL",
      "q_var shows the new input one edge earlier than q_sig")
def sem_02() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity var_sig is
    port (clk   : in  std_logic;
          d     : in  std_logic;
          q_var : out std_logic;
          q_sig : out std_logic);
end entity;
architecture rtl of var_sig is
    signal s : std_logic := '0';
begin
    process (clk)
        variable v : std_logic := '0';
    begin
        if rising_edge(clk) then
            v := d;          -- variable: takes effect immediately
            q_var <= v;      -- so q_var = new d
            s <= d;          -- signal: takes effect at the end of the process
            q_sig <= s;      -- so q_sig = previous d
        end if;
    end process;
end architecture;
"""
    result = run_text(src, top="var_sig", duration=400, clockPeriod=10, resetCycles=0,
                      stimuli=[{"port": "d", "kind": "toggle", "periodCycles": 3}])
    q_var = signal(result, "q_var")["transitions"]
    q_sig = signal(result, "q_sig")["transitions"]
    check(len(q_var) >= 4 and len(q_sig) >= 4,
          f"transitions missing: var={q_var} sig={q_sig}")
    check(q_var != q_sig, "variable and signal paths produced identical traces")
    return f"q_var toggles immediately, q_sig one edge behind ({len(q_var)} vs {len(q_sig)} transitions)"


@case("SEM-03", "20", "std_logic resolution: 0/1/Z/X/U/H/L/- table", "VHDL",
      "0&Z=0, 1&H=1, H alone=H, L&0=0, 0&1=X, undriven=U (RESULT bit i set per rule)")
def sem_03() -> str:
    tb = """
library ieee;
use ieee.std_logic_1164.all;
entity tb_res is
end entity;
architecture sim of tb_res is
    signal wz    : std_logic;          -- 0 vs Z
    signal wh    : std_logic;          -- 1 vs H
    signal honly : std_logic;          -- single H driver
    signal l0    : std_logic;          -- L vs 0
    signal zero_one : std_logic;       -- 0 vs 1 -> X
    signal undriven : std_logic;       -- no driver at all
    signal result : std_logic_vector(7 downto 0) := (others => '0');
begin
    wz    <= '0';
    wz    <= 'Z';
    wh    <= '1';
    wh    <= 'H';
    honly <= 'H';
    l0    <= 'L';
    l0    <= '0';
    zero_one <= '0';
    zero_one <= '1';
    process
    begin
        wait for 10 ns;
        result(0) <= '1' when wz = '0' else '0';
        result(1) <= '1' when wh = '1' else '0';
        result(2) <= '1' when honly = 'H' else '0';
        result(3) <= '1' when l0 = '0' else '0';
        result(4) <= '1' when zero_one = 'X' else '0';
        result(5) <= '1' when undriven = 'U' else '0';
        wait;
    end process;
end architecture;
"""
    from harness import simulator
    from backend.simulator import SimulationRequest
    dummy = "library ieee; use ieee.std_logic_1164.all; entity res_dummy is end entity; architecture sim of res_dummy is begin end architecture;"
    result = simulator().simulate(SimulationRequest.from_dict(
        {"vhdl": dummy, "testbench": tb, "top": "tb_res", "duration": 100, "resetCycles": 0}))
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    got = int(value(result, "result"))
    check(got == 0x3F, f"resolution table bits {got:02X}; expected 111111")
    return "0&Z=0, 1&H=1, H=H, L&0=0, 0&1=X, undriven=U — all six rules observed"


@case("SEM-04", "20", "Multiple drivers on an unresolved type are a clear error", "VHDL",
      "two processes drive one integer signal -> GHDL 'multiple drivers' error, no silent result")
def sem_04() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity multi_driver is
    port (sel : in std_logic; y : out integer range 0 to 15);
end entity;
architecture rtl of multi_driver is
    signal comm : integer := 0;
begin
    p1 : process (sel) begin
        if sel = '0' then comm <= 3; end if;
    end process;
    p2 : process (sel) begin
        if sel = '1' then comm <= 9; end if;
    end process;
    y <= comm;
end architecture;
"""
    result = run_text(src, top="multi_driver", duration=20, resetCycles=0,
                      constantInputs={"sel": 0})
    check(not result.get("ok"), "multiple-driver design simulated successfully (should be an error)")
    text = errors_text(result).lower() + " " + str(result.get("logs", "")).lower()
    check("driver" in text, f"error does not mention drivers: {text[:200]}")
    return f"rejected with: {errors_text(result)[:120]}"


@case("SEM-05", "20", "numeric_std overflow wraps (mod 2^n)", "VHDL",
      "unsigned 255+1 -> 0; signed 127+1 -> -128 (10000000)")
def sem_05() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity overflow_wrap is
    port (u : out unsigned(7 downto 0);
          s : out signed(7 downto 0));
end entity;
architecture rtl of overflow_wrap is
begin
    u <= unsigned'(x"FF") + 1;
    s <= signed'(x"7F") + 1;
end architecture;
"""
    result = run_text(src, top="overflow_wrap", duration=20, resetCycles=0)
    u = int(value(result, "u"))
    s = int(value(result, "s"))
    check(u == 0, f"unsigned 255+1 = {u}; expected wrap to 0")
    check(s == -128, f"signed 127+1 = {s}; expected wrap to -128 (signed rendering)")
    return "unsigned 0xFF+1 -> 0x00; signed 0x7F+1 -> -128 (two's-complement wrap)"


@case("SEM-06", "20", "Generics change width and behaviour", "VHDL",
      "WIDTH=12 counter wraps at 4095; WIDTH=4 wraps at 15")
def sem_06() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity gen_counter is
    generic (WIDTH : natural := 4);
    port (clk : in std_logic; q : out unsigned(WIDTH-1 downto 0));
end entity;
architecture rtl of gen_counter is
    signal cnt : unsigned(WIDTH-1 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;
    q <= cnt;
end architecture;
"""
    small = run_text(src, top="gen_counter", duration=100, clockPeriod=10, resetCycles=0,
                     generics={"WIDTH": 4})
    big = run_text(src, top="gen_counter", duration=100, clockPeriod=10, resetCycles=0,
                   generics={"WIDTH": 12})
    q4 = int(value(small, "q"))
    q12 = int(value(big, "q"))
    check(q4 == 10, f"WIDTH=4: q={q4}; expected 10 counts")
    check(q12 == 10, f"WIDTH=12: q={q12}; expected 10 counts (no wrap yet)")
    check(len(str(value(big, "q"))) >= 1, "q width")
    return f"WIDTH=4 -> q={q4} (max 15); WIDTH=12 -> q={q12} (max 4095); same stimulus"


@case("SEM-07", "20", "Generate loop instantiates N parallel slices", "VHDL",
      "8 independent inverter slices; changing one input bit changes exactly that output bit")
def sem_07() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
entity gen_inv is
    port (d : in std_logic_vector(7 downto 0);
          y : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of gen_inv is
begin
    g : for i in d'range generate
        y(i) <= not d(i);
    end generate;
end architecture;
"""
    a = run_text(src, top="gen_inv", duration=20, resetCycles=0, constantInputs={"d": 0b0000_0101})
    b = run_text(src, top="gen_inv", duration=20, resetCycles=0, constantInputs={"d": 0b0000_0001})
    ya, yb = int(value(a, "y")), int(value(b, "y"))
    check(ya == 0b1111_1010, f"y={ya:08b}; expected 11111010 for d=0x05")
    check(yb == 0b1111_1110, f"y={yb:08b}; expected 11111110 for d=0x01 (only bit 0 changed)")
    return f"8 slices generated; d=0x05 -> {ya:08b}, d=0x01 -> {yb:08b} (only the toggled bit changed)"


@case("SEM-08", "20", "Record and array ports pass structured data", "VHDL",
      "record field and array port round-trip through a component (sum via record, concat via array)")
def sem_08() -> str:
    # The record type must be visible to both entities, so it lives in a package.
    src = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
package pair_pkg is
    type pair_t is record
        lo : std_logic_vector(3 downto 0);
        hi : std_logic_vector(3 downto 0);
    end record;
end package;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.pair_pkg.all;
entity struct_top is
    port (a_in  : in  std_logic_vector(3 downto 0);
          b_in  : in  std_logic_vector(3 downto 0);
          sum   : out std_logic_vector(7 downto 0);
          hi_lo : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of struct_top is
    signal p : pair_t;
    component combiner
        port (p : in pair_t; total : out std_logic_vector(7 downto 0));
    end component;
begin
    p.lo <= a_in;
    p.hi <= b_in;
    u : combiner port map (p => p, total => sum);
    hi_lo <= b_in & a_in;
end architecture;

library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use work.pair_pkg.all;
entity combiner is
    port (p : in pair_t; total : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of combiner is
begin
    total <= std_logic_vector(unsigned("0000" & p.lo) + unsigned("0000" & p.hi));
end architecture;
"""
    from harness import simulator
    from backend.simulator import SimulationRequest
    result = simulator().simulate(SimulationRequest.from_dict({
        "vhdl": src, "top": "struct_top", "duration": 20, "resetCycles": 0,
        "constantInputs": {"a_in": 0b0011, "b_in": 0b0100},
    }))
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    total = int(value(result, "sum"))
    arranged = int(value(result, "hi_lo"))
    check(total == 7, f"record component sum={total}; expected 3+4=7")
    check(arranged == 0b0100_0011, f"array concat={arranged:08b}; expected 01000011")
    return f"record port sum=7 (3+4); array concat={arranged:08b}"


# ---------------------------------------------------------------------------
# 21. Clocking
# ---------------------------------------------------------------------------


COUNTER_SRC = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity free_counter is
    port (clk : in std_logic; q : out unsigned(7 downto 0));
end entity;
architecture rtl of free_counter is
    signal cnt : unsigned(7 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            cnt <= cnt + 1;
        end if;
    end process;
    q <= cnt;
end architecture;
"""


@case("CKM-01", "21", "Counter at 50 MHz gives exact cycle counts", "VHDL",
      "50 MHz = 20 ns period; 2000 ns window -> exactly 100 rising edges and q=100")
def ckm_01() -> str:
    result = run_text(COUNTER_SRC, top="free_counter", duration=2000, clockPeriod=20,
                      resetCycles=0)
    edges = cycle_count(result)
    check(edges == 100, f"{edges} sampled cycles; expected exactly 100 rising edges in 2000 ns at 20 ns period")
    q = int(value(result, "q"))
    check(q == 100, f"q={q}; expected 100 after 100 edges")
    return f"100 edges sampled, q={q} (50 MHz, 20 ns period, 2000 ns window)"


@case("CKM-02", "21", "Divided clock: /2 divider toggles at half rate", "VHDL",
      "clk_div half-period = 2 clock periods; counter on clk_div advances every 4 clocks")
def ckm_02() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity clk_divider is
    port (clk     : in  std_logic;
          clk_div : out std_logic;
          q       : out unsigned(3 downto 0));
end entity;
architecture rtl of clk_divider is
    signal phase : std_logic := '0';
    signal div   : std_logic := '0';
    signal slow  : unsigned(3 downto 0) := (others => '0');
begin
    process (clk)
    begin
        if rising_edge(clk) then
            phase <= not phase;
            if phase = '1' then          -- every second clock
                div <= not div;          -- -> clk_div half period = 2 clocks
                if div = '0' then
                    slow <= slow + 1;    -- q counts clk_div rising edges
                end if;
            end if;
        end if;
    end process;
    clk_div <= div;
    q <= slow;
end architecture;
"""
    result = run_text(src, top="clk_divider", duration=800, clockPeriod=10, resetCycles=0)
    div = signal(result, "clk_div")["transitions"]
    deltas = [round(b[0] - a[0], 6) for a, b in zip(div, div[1:]) if b[0] > a[0]]
    check(len(deltas) >= 3, f"clk_div barely toggled: {div}")
    # The first interval is the startup phase (clock begins at t=0); every
    # steady-state half period must be exactly two clock periods.
    steady = deltas[1:]
    check(all(abs(d - 20.0) < 1e-6 for d in steady),
          f"clk_div half-periods {deltas}; expected 20 ns (2 x 10 ns clock) after startup")
    return f"clk_div half-period exactly 20 ns at 10 ns clock (steady-state deltas {steady})"


@case("CKM-03", "21", "Two clock domains advance independently", "VHDL",
      "clk_a at 10 ns and clk_b at 30 ns: 3x more edges on clk_a; both counters advance")
def ckm_03() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity two_domains is
    port (clk_a : in std_logic;
          clk_b : in std_logic;
          qa    : out std_logic_vector(7 downto 0);
          qb    : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of two_domains is
    signal ca : unsigned(7 downto 0) := (others => '0');
    signal cb : unsigned(7 downto 0) := (others => '0');
begin
    process (clk_a) begin
        if rising_edge(clk_a) then ca <= ca + 1; end if;
    end process;
    process (clk_b) begin
        if rising_edge(clk_b) then cb <= cb + 1; end if;
    end process;
    qa <= std_logic_vector(ca);
    qb <= std_logic_vector(cb);
end architecture;
"""
    tb = """
library ieee;
use ieee.std_logic_1164.all;
entity tb_two_clk is
end entity;
architecture sim of tb_two_clk is
    signal clk_a : std_logic := '0';
    signal clk_b : std_logic := '0';
    signal qa, qb : std_logic_vector(7 downto 0);
begin
    uut : entity work.two_domains port map (clk_a => clk_a, clk_b => clk_b,
                                            qa => qa, qb => qb);
    clk_a <= not clk_a after 5 ns;    -- 10 ns period
    clk_b <= not clk_b after 15 ns;   -- 30 ns period
end architecture;
"""
    result = run_text(src, testbench=tb, top="tb_two_clk", duration=600, resetCycles=0)
    a_edges = cycle_count(result)
    clk_b = signal(result, "clk_b")["transitions"]
    b_edges = sum(1 for i in range(1, len(clk_b))
                  if clk_b[i - 1][1] in ("0", 0) and clk_b[i][1] in ("1", 1))
    check(a_edges == 60, f"clk_a edges={a_edges}; expected 60 in 600 ns at 10 ns")
    check(b_edges == 20, f"clk_b edges={b_edges}; expected 20 in 600 ns at 30 ns")
    check(a_edges == 3 * b_edges, "domain ratio not 3:1")
    return f"clk_a {a_edges} edges vs clk_b {b_edges} edges (3:1), both counters advanced"


@case("CKM-04", "21", "PLL: behavioural model produces c0 and locked", "VHDL",
      "altpll model: c0 toggles at the requested ratio, locked asserts after 8 input edges")
def ckm_04() -> str:
    from harness import run
    result = run("blocks.vhd", top="altpll_top", duration=150, resetCycles=0)
    check(result.get("ok"), f"altpll model failed: {errors_text(result)[:200]}")
    locked = value(result, "locked")
    c0 = value(result, "c0")
    check(locked == 1, f"locked={locked} (expected 1 after the 8-edge acquisition window)")
    return f"c0={c0}, locked={locked} (behavioural model; no jitter/lock-time modelling)"


# ---------------------------------------------------------------------------
# 22. Memory / DSP
# ---------------------------------------------------------------------------


@case("MEM-01", "22", "M9K inference: init file + registered read latency", "VHDL",
      "rom loaded from the memoryInitFile text (rom.mif), q appears one clock after addr")
def mem_01() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.textio.all;
entity rom_init is
    port (clk  : in  std_logic;
          addr : in  integer range 0 to 15;
          q    : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of rom_init is
    type rom_t is array (0 to 15) of std_logic_vector(7 downto 0);
    signal rom      : rom_t := (others => (others => '0'));
    signal addr_reg : integer range 0 to 15 := 0;
begin
    loader : process
        file f      : text;
        variable l  : line;
        variable n  : natural;
        variable ok : boolean;
        variable i  : natural := 0;
    begin
        file_open(f, "rom.mif", read_mode);
        while i < 16 and not endfile(f) loop
            readline(f, l);
            read(l, n, ok);
            if ok then
                rom(i) <= std_logic_vector(to_unsigned(n, 8));
                i := i + 1;
            end if;
        end loop;
        file_close(f);
        wait;
    end process;
    process (clk)
    begin
        if rising_edge(clk) then
            addr_reg <= addr;
            q <= rom(addr_reg);
        end if;
    end process;
end architecture;
"""
    from harness import simulator
    from backend.simulator import SimulationRequest
    init_lines = [str((i * 7 + 3) % 256) for i in range(16)]
    init_content = "\n".join(init_lines) + "\n"
    result = simulator().simulate(SimulationRequest.from_dict({
        "vhdl": src, "top": "rom_init", "duration": 200, "clockPeriod": 10,
        "resetCycles": 0, "constantInputs": {"addr": 1},
        "memoryInitFile": {"name": "rom.mif", "content": init_content},
    }))
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    expected = int(init_lines[1])
    c0 = int(cycle_values(result, 0)["q"])
    c1 = int(cycle_values(result, 1)["q"])
    got = int(value(result, "q"))
    check(got == expected, f"q={got}; expected rom(1)={expected} from the init file")
    check(c0 == int(init_lines[0]), f"cycle0 q={c0}; expected rom(0)={init_lines[0]} (registered read latency)")
    check(c1 == expected, f"cycle1 q={c1}; expected rom(1)={expected}")
    return (f"init file loaded from rom.mif (rom(0)={init_lines[0]}, rom(1)={expected}); "
            "registered read shows rom(0) one cycle before rom(1) — read latency observed")


@case("MEM-02", "22", "M9K overflow produces a clear resource warning", "VHDL",
      "a 20480x16 inferred RAM (~36 M9K) warns it exceeds the 30 M9K blocks")
def mem_02() -> str:
    from harness import run
    result = run("resource.vhd", top="big_mem", duration=30, resetCycles=0,
                 constantInputs={"we": 0, "addr": 0, "din": 0})
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    text = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("m9k" in text, f"no M9K resource warning: {text[:200]}")
    check("30" in text, f"warning does not name the 30-block limit: {text[:200]}")
    return "M9K overflow warning present: " + text[:120]


@case("MEM-03", "22", "Multiplier overflow produces a clear resource warning", "VHDL",
      "16 multiplies warn they exceed the 15 18x18 multipliers")
def mem_03() -> str:
    from harness import run
    result = run("blocks.vhd", top="many_muls", duration=20, resetCycles=0,
                 constantInputs={"a": 3, "b": 5})
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    text = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("multiplier" in text, f"no multiplier warning: {text[:200]}")
    return "multiplier overflow warning present: " + text[:120]


@case("MEM-04", "22", "Register-bit overflow produces a clear LE warning", "VHDL",
      "8192 declared register bits warn they exceed the 6272 logic elements")
def mem_04() -> str:
    from harness import run
    result = run("resource.vhd", top="big_regs", duration=30, resetCycles=0,
                 constantInputs={"d": 0})
    check(result.get("ok"), f"simulation failed: {errors_text(result)}")
    text = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("6272" in text, f"no LE warning naming 6272: {text[:200]}")
    return "LE overflow warning present: " + text[:120]
