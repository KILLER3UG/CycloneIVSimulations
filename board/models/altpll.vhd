-- Behavioral ALTPLL model for simulation (BLK-02).
--
-- The vendor schematic has no PLL; this model exists only so a design that
-- instantiates Altera's `altpll` megafunction elaborates and produces a c0
-- clock with the requested clk0_multiply_by / clk0_divide_by RATIO, plus a
-- locked flag that asserts after a short acquisition window.
--
-- It is NOT a cycle-accurate PLL model: no jitter, no phase shift, no
-- dynamic reconfiguration, no input-jitter tolerance, and c0 is a
-- free-running oscillator whose frequency is measured from the incoming
-- clock rather than phase-locked to it.  The resource limit is checked
-- separately (BLK-03).
--
-- Driver discipline: c0_int / run / half_period / locked_int each have
-- EXACTLY ONE driver (osc / measure / measure / lock).  A second, partially
-- executed driver would resolve against the first and corrupt c0 to 'X'.
--
-- Port/generic names match the Altera `altpll` component declaration.
library ieee;
use ieee.std_logic_1164.all;

entity altpll is
    generic (
        inclk0_input_frequency : natural := 50;
        intended_device_family : string  := "Cyclone IV E";
        operation_mode         : string  := "normal";
        pll_type               : string  := "auto";
        compensate_clock       : string  := "clk0";
        feedback_source        : string  := "fpll_feedback";
        clk0_multiply_by       : natural := 1;
        clk0_divide_by         : natural := 1;
        clk0_phase_shift       : string  := "0"
    );
    port (
        inclk0 : in  std_logic;
        areset : in  std_logic := '0';
        c0     : out std_logic;
        locked : out std_logic
    );
end entity altpll;

architecture rtl of altpll is
    -- Lock acquisition, modelled as a fixed number of input rising edges.
    -- The real device takes microseconds and depends on the configuration.
    constant LOCK_EDGES : natural := 8;
    signal c0_int      : std_logic := '0';
    signal run         : boolean   := false;
    signal half_period : time      := 10 ns;
    signal locked_int  : std_logic := '0';
begin

    -- Measure one input period from the first two rising edges, then derive
    -- the output half period:  T_out = T_in * divide / multiply.
    -- (inclk0_input_frequency is informational here; the ratio comes from the
    -- multiply/divide generics, which is what determines c0's frequency.)
    -- Drives `run` and `half_period` ONLY (never c0_int — see above).
    measure : process (inclk0)
        variable edges : natural := 0;
        variable first : time    := 0 ns;
    begin
        if rising_edge(inclk0) then
            if areset = '1' then
                edges := 0;
                run   <= false;
            elsif not run then
                if edges = 0 then
                    first := now;
                    edges := 1;
                else
                    half_period <= (now - first) * real(clk0_divide_by)
                                   / (2.0 * real(clk0_multiply_by));
                    run <= true;
                end if;
            end if;
        end if;
    end process;

    -- Free-running output oscillator at the modelled frequency.  Sole driver
    -- of c0_int; areset gates the toggling and forces the reset level.
    osc : process
    begin
        wait until run;
        while run loop
            if areset = '1' then
                c0_int <= '0';
            else
                c0_int <= not c0_int;
            end if;
            wait for half_period;
        end loop;
        c0_int <= '0';
    end process;

    -- locked asserts after LOCK_EDGES clean input rising edges.  Sole driver
    -- of locked_int.
    lock : process (inclk0)
        variable edges : natural := 0;
    begin
        if rising_edge(inclk0) then
            if areset = '1' then
                edges      := 0;
                locked_int <= '0';
            elsif edges < LOCK_EDGES then
                edges := edges + 1;
                if edges = LOCK_EDGES then
                    locked_int <= '1';
                end if;
            end if;
        end if;
    end process;

    c0     <= c0_int;
    locked <= locked_int;

end architecture rtl;
