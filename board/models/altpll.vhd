-- Behavioral ALTPLL model for simulation (BLK-02).
--
-- The vendor schematic has no PLL; this model exists only so a design that
-- instantiates Altera's `altpll` megafunction elaborates and produces a
-- divided c0 clock and a locked flag. It is NOT a cycle-accurate PLL model
-- (no jitter, lock time or dynamic reconfiguration); the resource limit is
-- checked separately (BLK-03).
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
    signal divided : std_logic := '0';
begin

    -- Divide the input clock by 2 (clk0_divide_by=1 in the default config;
    -- the exact ratio is not modelled, but c0 is a real toggling clock).
    process (inclk0)
    begin
        if rising_edge(inclk0) then
            if areset = '1' then
                divided <= '0';
            else
                divided <= not divided;
            end if;
        end if;
    end process;

    c0     <= divided;
    locked <= not areset;

end architecture rtl;