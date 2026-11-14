-- AT24C08 I2C EEPROM behavioural model (RZ-EasyFPGA A2.2, U8).
-- Behaviour per the AT24C08 datasheet:
--   * device address byte 1010 + A2 + A1 + P0 (P0 is the word-address MSB)
--   * 1 KiB array, 16-byte pages, page writes wrap inside their page
--   * 5 ms write cycle: the device NACKs and ignores commands meanwhile
--   * random and sequential reads, rolling over the whole array
-- Open-drain SDA: the model drives '0' or releases; the testbench supplies
-- the 'H' pull-up.  The committed array is dumped to a text file so the host
-- application can display the device contents.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
use std.textio.all;

entity at24c08 is
    generic (
        -- Only A2 is a physical address pin on the AT24C08; control-byte bits
        -- A1/A0 are the two MSBs of the 10-bit word address (block select).
        A2     : std_logic := '0';   -- tied to GND on the A2.2
        TWRITE : time      := 5 ms;
        DUMP   : string    := "eeprom_dump.txt"
    );
    port (
        scl : in    std_logic;
        sda : inout std_logic;        -- open drain: '0' or 'Z'
        wp  : in    std_logic := '0'
    );
end entity at24c08;

architecture behavioural of at24c08 is
    constant MEM_BYTES : natural := 1024;
    constant PAGE_SIZE : natural := 16;

    type mem_t is array (0 to MEM_BYTES - 1) of std_logic_vector(7 downto 0);
    signal committed : mem_t    := (others => (others => '0'));
    signal page_buf  : mem_t    := (others => (others => '0'));
    signal busy      : boolean  := false;
    signal wr_end    : time     := 0 ns;
    signal sda_out   : std_logic := 'Z';

    function dev_ok(b : natural; sa2 : std_logic) return boolean is
        variable v : std_logic_vector(7 downto 0) :=
            std_logic_vector(to_unsigned(b mod 256, 8));
    begin
        -- Control byte 1010 A2 A1 A0 R/W: A2 is the only physical address pin.
        -- A1/A0 are block-select bits (word-address bits 9 and 8), so any value
        -- of them must ACK; the device address on this board is 0x50-0x53.
        return v(7 downto 4) = "1010" and v(3) = sa2;
    end function dev_ok;
begin
    sda <= '0' when sda_out = '0' else 'Z';

    main : process (scl, sda)
        type state_t is (IDLE, ADDR, ACK_ADDR, WORD, ACK_WORD, DATA_W, ACK_DATA, DATA_R);
        variable state    : state_t  := IDLE;
        variable bits     : natural  := 0;
        variable shifter  : natural  := 0;
        variable rw       : std_logic := '0';
        variable wordaddr : natural  := 0;
        variable page_base: natural  := 0;
        variable blk      : natural  := 0;   -- {A1,A0} from the control byte
        variable last_sda : std_logic := '1';
        variable last_scl : std_logic := '1';
        variable scl_x    : std_logic := '1';   -- to_x01(scl): the bus idles 'H'
        variable ack_pending : boolean := false; -- master ACK slot armed
        variable master_acked : boolean := false;-- master ACK level sampled
        variable byte_out : natural  := 0;
        variable tmp      : std_logic_vector(7 downto 0);
    begin
        scl_x := to_x01(scl);
        if last_sda = '1' and to_x01(sda) = '0' and last_scl = '1' and scl_x = '1' then
            -- START / repeated START
            state   := ADDR;
            bits    := 0;
            shifter := 0;
            sda_out <= 'Z';
        elsif last_sda = '0' and to_x01(sda) = '1' and last_scl = '1' and scl_x = '1' then
            -- STOP: page writes commit here
            if state = DATA_W or state = ACK_DATA or state = ACK_WORD or state = WORD then
                busy   <= true;
                wr_end <= now + TWRITE;
            end if;
            state   := IDLE;
            sda_out <= 'Z';
        elsif last_scl = '1' and scl_x = '0' then
            -- SCL falling edge (to_x01: the released bus idles at 'H')
            case state is
                when ADDR | WORD | DATA_W =>
                    if bits = 8 then
                        -- 9th pulse: ACK slot
                        if state = ADDR then
                            if busy or not dev_ok(shifter, A2) then
                                sda_out <= 'Z';          -- NACK
                                state   := IDLE;         -- refuse the transfer
                            else
                                sda_out <= '0';          -- ACK
                                rw      := '1' when (shifter mod 2) = 1 else '0';
                                -- A1/A0 = control-byte bits 2/1 = word-address bits 9/8
                                blk     := 0;
                                if (shifter / 4) mod 2 = 1 then
                                    blk := blk + 2;
                                end if;
                                if (shifter / 2) mod 2 = 1 then
                                    blk := blk + 1;
                                end if;
                                state   := ACK_ADDR;
                            end if;
                        else
                            if state = WORD then
                                state := ACK_WORD;
                                -- the word-address phase of a read is a write-
                                -- direction exchange: WP only blocks writes
                                if busy then
                                    sda_out <= 'Z';      -- NACK (write cycle)
                                else
                                    sda_out <= '0';      -- ACK
                                end if;
                            else
                                state := ACK_DATA;
                                if busy or (wp = '1' and rw = '0') then
                                    sda_out <= 'Z';      -- NACK (write cycle / WP on writes)
                                else
                                    sda_out <= '0';      -- ACK
                                end if;
                            end if;
                        end if;
                    end if;
                when ACK_ADDR =>
                    sda_out <= 'Z';
                    if rw = '0' then
                        state := WORD;
                        bits  := 0;
                    else
                        -- read: load the first byte and drive bit 7 now so the
                        -- master samples it on the next SCL high phase.
                        -- open drain: a 0 bit pulls SDA low, a 1 bit releases
                        byte_out := to_integer(unsigned(committed(wordaddr mod MEM_BYTES)));
                        wordaddr := (wordaddr + 1) mod MEM_BYTES;
                        tmp := std_logic_vector(to_unsigned(byte_out, 8));
                        sda_out <= '0' when tmp(7) = '0' else 'Z';
                        bits    := 1;
                        state   := DATA_R;
                    end if;
                when ACK_WORD =>
                    sda_out <= 'Z';
                    state   := DATA_W;
                    bits    := 0;
                when ACK_DATA =>
                    sda_out <= 'Z';
                    state   := DATA_W;
                    bits    := 0;
                when DATA_R =>
                    if bits >= 8 then
                        -- master ACK slot: release SDA, preload the next byte
                        sda_out <= 'Z';
                        byte_out := to_integer(unsigned(committed(wordaddr mod MEM_BYTES)));
                        wordaddr := (wordaddr + 1) mod MEM_BYTES;
                        ack_pending := true;
                        bits := 8;
                    else
                        tmp := std_logic_vector(to_unsigned(byte_out, 8));
                        sda_out <= '0' when tmp(7 - bits) = '0' else 'Z';
                        bits := bits + 1;
                    end if;
                    -- the ACK level was sampled on the rising edge; it must not
                    -- leak into the next byte (this cleared the stale flag that
                    -- corrupted the second and later bytes of a read)
                    master_acked := false;
                when others =>
                    sda_out <= 'Z';
            end case;
        elsif last_scl = '0' and scl_x = '1' then
            -- SCL rising edge
            if busy and now >= wr_end then
                busy      <= false;                       -- write cycle finished
                committed <= page_buf;
            end if;

            case state is
                when ADDR | WORD | DATA_W =>
                    if bits < 8 then
                        if to_x01(sda) = '0' then
                            shifter := shifter * 2;
                        else
                            shifter := shifter * 2 + 1;
                        end if;
                        bits := bits + 1;
                        if bits = 8 then
                            shifter := shifter mod 256;
                            if state = WORD then
                                tmp := std_logic_vector(to_unsigned(shifter, 8));
                                -- 10-bit word address = {A1, A0, word_address_byte}
                                wordaddr  := blk * 256 + to_integer(unsigned(tmp));
                                page_base := (wordaddr / PAGE_SIZE) * PAGE_SIZE;
                            elsif state = DATA_W then
                                if wp = '0' then
                                    page_buf(wordaddr mod MEM_BYTES) <= std_logic_vector(to_unsigned(shifter, 8));
                                end if;
                                wordaddr := page_base
                                            + ((wordaddr - page_base + 1) mod PAGE_SIZE);
                            end if;
                        end if;
                    end if;
                when DATA_R =>
                    if ack_pending then
                        ack_pending := false;
                        master_acked := to_x01(sda) = '0';
                        if master_acked then
                            bits := 0;       -- continue with the next byte
                        else
                            state := IDLE;   -- NACK: the transfer is over
                        end if;
                    end if;
                when others =>
                    null;
            end case;
        end if;

        if busy and now >= wr_end then
            busy      <= false;
            committed <= page_buf;
        end if;

        last_sda := to_x01(sda);
        last_scl := scl_x;
    end process;

    commit_on_busy_fall : process (busy)
    begin
        if busy'event and busy = false then
            committed <= page_buf;
        end if;
    end process;

    -- (committed, busy): a blocked write (WP) leaves committed unchanged, so
    -- busy must also wake this process or the dump would never be written
    dump_proc : process (committed, busy)
        file f     : text;
        variable l : line;
        variable first : boolean := true;
    begin
        if not first then
            file_open(f, DUMP, write_mode);
            write(l, string'("size=") & integer'image(MEM_BYTES));
            writeline(f, l);
            for i in 0 to 255 loop
                hwrite(l, committed(i));
                if (i mod 16) = 15 then
                    writeline(f, l);
                else
                    write(l, string'(" "));
                end if;
            end loop;
            file_close(f);
        end if;
        first := false;
    end process;
end architecture behavioural;