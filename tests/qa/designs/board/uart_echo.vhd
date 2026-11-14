-- UART echo for the RZ-EasyFPGA A2.2 RS232 port (MAX3232E U4):
-- receives 8N1 frames on UART_RXD (pin 115, R1OUT) and re-transmits the same
-- byte on UART_TXD (pin 114, T1IN) at 115200 baud (50 MHz / 434 clocks per
-- bit, the same divider as uart_tx.vhd).
-- The receiver double-synchronises the pin, samples every bit at mid-bit and
-- requires a high stop bit; a frame whose stop bit is low is counted in
-- FRM_ERR and is NOT echoed.  Accepted bytes are shown on the four board LEDs
-- (low nibble, active-low) and counted in ECHO_COUNT.  If the receiver
-- completes a byte while the transmitter is still busy, that byte replaces
-- any older pending one (at 115200 an echo takes 10 bit times and frames can
-- only arrive every 11, so the pending window always drains first).
-- Single clock domain (CLOCK_50), fully synchronous, synthesis-plausible.
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity uart_echo_board is
    generic (
        BAUD_DIV : natural := 434            -- 50e6 / 115200
    );
    port (
        CLOCK_50   : in    std_logic;
        UART_RXD   : in    std_logic;
        UART_TXD   : out   std_logic;
        LED        : out   std_logic_vector(3 downto 0);
        ECHO_COUNT : out   std_logic_vector(7 downto 0);
        FRM_ERR    : out   std_logic_vector(7 downto 0)
    );
end entity uart_echo_board;

architecture rtl of uart_echo_board is
    constant HALF_DIV : natural := BAUD_DIV / 2;

    signal rx_ff1  : std_logic := '1';
    signal rx_ff2  : std_logic := '1';
    signal rx_prev : std_logic := '1';

    type uart_state_t is (IDLE, START, DATA, STOP);
    signal rx_state : uart_state_t := IDLE;
    signal tx_state : uart_state_t := IDLE;

    signal rx_cnt   : natural range 0 to BAUD_DIV - 1 := 0;
    signal tx_cnt   : natural range 0 to BAUD_DIV - 1 := 0;
    signal rx_bit   : natural range 0 to 7 := 0;
    signal tx_bit   : natural range 0 to 7 := 0;
    signal rx_shift : std_logic_vector(7 downto 0) := (others => '0');
    signal tx_shift : std_logic_vector(7 downto 0) := (others => '1');
    signal rx_byte  : std_logic_vector(7 downto 0) := (others => '0');
    signal rx_valid : std_logic := '0';
    signal tx_out   : std_logic := '1';
    signal echoed   : unsigned(7 downto 0) := (others => '0');
    signal bad_cnt  : unsigned(7 downto 0) := (others => '0');
begin
    UART_TXD   <= tx_out;
    LED        <= not rx_byte(3 downto 0);
    ECHO_COUNT <= std_logic_vector(echoed);
    FRM_ERR    <= std_logic_vector(bad_cnt);

    echo_proc : process (CLOCK_50)
    begin
        if rising_edge(CLOCK_50) then
            -- double-synchronise the asynchronous RX pin
            rx_ff1  <= to_x01(UART_RXD);
            rx_ff2  <= rx_ff1;
            rx_prev <= rx_ff2;

            -- transmitter: 10-bit frame 0, d0..d7 (LSB first), 1
            case tx_state is
                when IDLE =>
                    tx_out <= '1';
                    if rx_valid = '1' then
                        tx_shift <= rx_byte;
                        rx_valid <= '0';      -- consumed
                        tx_out   <= '0';      -- start bit begins now
                        tx_cnt   <= 0;
                        tx_state <= START;
                    end if;
                when START =>
                    if tx_cnt = BAUD_DIV - 1 then
                        tx_cnt   <= 0;
                        tx_out   <= tx_shift(0);
                        tx_shift <= '1' & tx_shift(7 downto 1);
                        tx_bit   <= 0;
                        tx_state <= DATA;
                    else
                        tx_cnt <= tx_cnt + 1;
                    end if;
                when DATA =>
                    if tx_cnt = BAUD_DIV - 1 then
                        tx_cnt <= 0;
                        if tx_bit = 7 then
                            tx_out   <= '1';  -- stop bit
                            tx_state <= STOP;
                        else
                            tx_out   <= tx_shift(0);
                            tx_shift <= '1' & tx_shift(7 downto 1);
                            tx_bit   <= tx_bit + 1;
                        end if;
                    else
                        tx_cnt <= tx_cnt + 1;
                    end if;
                when STOP =>
                    if tx_cnt = BAUD_DIV - 1 then
                        tx_cnt   <= 0;
                        tx_state <= IDLE;
                    else
                        tx_cnt <= tx_cnt + 1;
                    end if;
            end case;

            -- receiver: mid-bit sampling with a stop-bit framing check.
            -- Written after the transmitter block so a byte accepted in the
            -- same cycle a pending one is consumed is not lost.
            case rx_state is
                when IDLE =>
                    if rx_prev = '1' and rx_ff2 = '0' then
                        rx_state <= START;
                        rx_cnt   <= 0;
                    end if;
                when START =>
                    if rx_cnt = HALF_DIV - 1 then
                        rx_cnt <= 0;
                        if rx_ff2 = '0' then
                            rx_state <= DATA;
                            rx_bit   <= 0;
                        else
                            rx_state <= IDLE;  -- start vanished: re-sync
                        end if;
                    else
                        rx_cnt <= rx_cnt + 1;
                    end if;
                when DATA =>
                    if rx_cnt = BAUD_DIV - 1 then
                        rx_cnt   <= 0;
                        rx_shift <= rx_ff2 & rx_shift(7 downto 1);
                        if rx_bit = 7 then
                            rx_state <= STOP;
                        else
                            rx_bit <= rx_bit + 1;
                        end if;
                    else
                        rx_cnt <= rx_cnt + 1;
                    end if;
                when STOP =>
                    if rx_cnt = BAUD_DIV - 1 then
                        rx_cnt <= 0;
                        if rx_ff2 = '1' then
                            rx_byte  <= rx_shift;
                            rx_valid <= '1';
                            echoed   <= echoed + 1;
                        else
                            bad_cnt  <= bad_cnt + 1;
                        end if;
                        rx_state <= IDLE;
                    else
                        rx_cnt <= rx_cnt + 1;
                    end if;
            end case;
        end if;
    end process;
end architecture rtl;
