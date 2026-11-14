-- Dummy design for the AT24C08 model testbench.  It exposes the board's I2C
-- port names so the simulator analyses the AT24C08 model; the testbench itself
-- instantiates the model and drives it directly.
library ieee;
use ieee.std_logic_1164.all;
entity eeprom_model_dummy is
    port (
        I2C_SCL : inout std_logic;
        I2C_SDA : inout std_logic
    );
end entity;
architecture sim of eeprom_model_dummy is
begin
end architecture;
