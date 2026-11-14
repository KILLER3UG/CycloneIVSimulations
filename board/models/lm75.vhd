-- LM75 / LM75A digital temperature sensor behavioural model (A2.2, U9).
-- I2C address 1001 + A2 + A1 + A0 = 0x48 with A2/A1/A0 tied to GND.
-- Registers: 0x00 temperature (bits 15..7, 0.5 C LSB for the classic LM75),
-- 0x01 configuration, 0x02 Thyst, 0x03 Tos.  The UI supplies the temperature
-- through the TEMPERATURE generic.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.textio.all;

entity lm75 is
    generic (
        A2          : std_logic := '0';
        A1          : std_logic := '0';
        A0          : std_logic := '0';
        TEMPERATURE : real      := 25.0   -- degrees C, set from the UI
    );
    port (
        scl : in    std_logic;
        sda : inout std_logic
    );
end entity lm75;

architecture behavioural of lm75 is
    constant TREG  : natural := 16#00#;
    constant CREG  : natural := 16#01#;
    constant THREG : natural := 16#02#;
    constant TSREG : natural := 16#03#;

    signal temp_reg : std_logic_vector(15 downto 0);
    signal conf_reg : std_logic_vector(7 downto 0)  := (others => '0');
    signal sda_out  : std_logic := 'Z';
begin
    -- LM75 temperature register: value = round(TEMPERATURE * 2) in bits 15..7
    temp_reg <= std_logic_vector(to_signed(integer(TEMPERATURE * 2.0) * 256, 16));

    sda <= '0' when sda_out = '0' else 'Z';

    main : process (scl, sda)
        type state_t is (IDLE, ADDR, ACK_ADDR, POINTER, ACK_PTR, DATA_R, DATA_W, ACK_DATA);
        variable state    : state_t  := IDLE;
        variable bits     : natural  := 0;
        variable shifter  : natural  := 0;
        variable rw       : std_logic := '0';
        variable regsel   : natural  := 0;
        variable last_sda : std_logic := '1';
        variable last_scl : std_logic := '1';
        variable scl_x    : std_logic := '1';   -- to_x01(scl): the bus idles 'H'
        variable ack_pending : boolean := false; -- master ACK slot armed
        variable master_acked : boolean := false;-- master ACK level sampled
        variable byte_out : std_logic_vector(15 downto 0);

        -- Load the selected register into byte_out (16 bits, MSB first).
        procedure load_byte is
        begin
            if regsel = TREG then
                byte_out := temp_reg;
            elsif regsel = CREG then
                byte_out(15 downto 8) := (others => '0');
                byte_out(7 downto 0)  := conf_reg;
            elsif regsel = THREG then
                byte_out := x"4B00";    -- Thyst power-up default: 75 C
            elsif regsel = TSREG then
                byte_out := x"5000";    -- Tos power-up default: 80 C
            else
                byte_out := (others => '0');
            end if;
        end procedure;

        -- Drive the loaded byte's MSB (open drain: a 0 bit pulls SDA low,
        -- a 1 bit releases the line to the pull-up).
        procedure drive_msb is
        begin
            sda_out <= '0' when byte_out(15) = '0' else 'Z';
            bits    := 1;
        end procedure;
    begin
        scl_x := to_x01(scl);
        if last_sda = '1' and to_x01(sda) = '0' and last_scl = '1' and scl_x = '1' then
            state   := ADDR;
            bits    := 0;
            shifter := 0;
            sda_out <= 'Z';
        elsif last_sda = '0' and to_x01(sda) = '1' and last_scl = '1' and scl_x = '1' then
            state   := IDLE;
            sda_out <= 'Z';
        elsif last_scl = '1' and scl_x = '0' then
            -- SCL falling edge (to_x01: the released bus idles at 'H')
            case state is
                when ADDR | POINTER | DATA_W =>
                    if bits = 8 then
                        if state = ADDR then
                            -- wire byte = 1001 A2 A1 A0 R/W (LM75 base 0x48)
                            if to_unsigned(shifter mod 256, 8)(7 downto 4) /= "1001"
                               or to_unsigned(shifter mod 256, 8)(3) /= A2
                               or to_unsigned(shifter mod 256, 8)(2) /= A1
                               or to_unsigned(shifter mod 256, 8)(1) /= A0 then
                                sda_out <= 'Z';          -- not our address
                                state   := IDLE;
                            else
                                sda_out <= '0';          -- ACK
                                rw      := '1' when (shifter mod 2) = 1 else '0';
                                state   := ACK_ADDR;
                            end if;
                        elsif state = POINTER then
                            sda_out <= '0';              -- ACK
                            state   := ACK_PTR;
                        else
                            sda_out <= '0';              -- ACK (data accepted)
                            state   := ACK_DATA;
                        end if;
                    end if;
                when ACK_ADDR =>
                    sda_out <= 'Z';
                    bits    := 0;
                    if rw = '0' then
                        state := POINTER;
                    else
                        -- read: load the register and drive bit 15 now so the
                        -- master samples it on the next SCL high phase.
                        load_byte;
                        drive_msb;
                        state := DATA_R;
                    end if;
                when ACK_PTR =>
                    sda_out <= 'Z';
                    bits    := 0;
                    if rw = '0' then
                        state := DATA_W;
                    else
                        load_byte;
                        drive_msb;
                        state := DATA_R;
                    end if;
                when ACK_DATA =>
                    sda_out <= 'Z';
                    state   := POINTER;
                    bits    := 0;
                when DATA_R =>
                    if bits >= 8 then
                        -- master ACK slot after each byte: release SDA; the
                        -- master's ACK level is sampled on the next rising edge
                        sda_out <= 'Z';
                        ack_pending := true;
                    else
                        -- open drain: a 0 bit pulls SDA low, a 1 bit releases
                        sda_out <= '0' when byte_out(15 - bits) = '0' else 'Z';
                        bits := bits + 1;
                    end if;
                when others =>
                    sda_out <= 'Z';
            end case;
        elsif last_scl = '0' and scl_x = '1' then
            -- SCL rising edge
            case state is
                when ADDR | POINTER | DATA_W =>
                    if bits < 8 then
                        if to_x01(sda) = '0' then
                            shifter := shifter * 2;
                        else
                            shifter := shifter * 2 + 1;
                        end if;
                        bits := bits + 1;
                        if bits = 8 then
                            shifter := shifter mod 256;
                            if state = POINTER then
                                regsel := shifter;
                            elsif state = DATA_W then
                                if regsel = CREG then
                                    conf_reg <= std_logic_vector(to_unsigned(shifter, 8));
                                end if;
                                -- the ACK slot is handled on the next falling edge
                            end if;
                        end if;
                    end if;
                when DATA_R =>
                    if ack_pending then
                        ack_pending := false;
                        master_acked := to_x01(sda) = '0';
                        if master_acked then
                            if bits >= 16 then
                                load_byte;    -- rollover: restart from bit 15
                            else
                                -- continue with the low byte of the register
                                byte_out := byte_out(7 downto 0) & "00000000";
                            end if;
                            bits := 0;
                        else
                            state := IDLE;    -- NACK: the transfer is over
                        end if;
                    end if;
                when others =>
                    null;
            end case;
        end if;

        last_sda := to_x01(sda);
        last_scl := scl_x;
    end process;
end architecture behavioural;