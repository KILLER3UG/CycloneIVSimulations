"""Unit-level audit of the board profile, QSF parser, VCD parser and the
peripheral decoders.

These tests run without GHDL and are the ones used for mutation testing: each
asserts a specific board fact or decoder behaviour so that a flipped polarity,
a swapped pin, a shifted bit index or a changed timing constant is caught.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from backend.device import BOARD, DEVICE, board_pin_map, load_board_json
from backend.peripherals import decode_buzzer, decode_uart, decode_vga
from backend.qsf_parser import parse_qsf
from backend.vcd_parser import parse_vcd_text

ROOT = Path(__file__).resolve().parent.parent
BOARD_JSON = ROOT / "board" / "board.json"
VENDOR_PINS = ROOT / "board" / "vendor" / "Pinos_RZEasyFPGA.txt"
VENDOR_QSF = sorted((ROOT / "board" / "vendor" / "examples").glob("*/*.qsf"))


# ---------------------------------------------------------------------------
# board.json structure and tags
# ---------------------------------------------------------------------------


def test_board_json_exists_and_parses():
    data = json.loads(BOARD_JSON.read_text(encoding="utf-8"))
    assert data["schema"] == "rz-easyfpga-board/1"
    assert data["board"]["name"] == "RZ-EasyFPGA A2.2"


def test_every_fact_has_a_valid_tag_and_sources():
    data = load_board_json()
    facts = data["facts"]
    assert len(facts) >= 30
    valid = {"VERIFIED", "INFERRED", "UNVERIFIED"}
    for fact in facts:
        assert fact["tag"] in valid, f"bad tag: {fact}"
        assert fact["id"] and fact["statement"]
        assert isinstance(fact["sources"], list) and fact["sources"], fact


def test_tag_counts_are_reported():
    data = load_board_json()
    counts = {}
    for fact in data["facts"]:
        counts[fact["tag"]] = counts.get(fact["tag"], 0) + 1
    assert counts.get("VERIFIED", 0) > 20
    assert counts.get("UNVERIFIED", 0) >= 5


# ---------------------------------------------------------------------------
# Pin map fidelity
# ---------------------------------------------------------------------------


def _vendor_pins() -> dict:
    pins = {}
    for line in VENDOR_PINS.read_text(encoding="utf-8").splitlines():
        match = re.match(r"\s*set_location_assignment\s+PIN_(\d+)\s+-to\s+(\S+)", line)
        if match:
            pins[match.group(2).upper()] = f"PIN_{match.group(1)}"
    return pins


def test_every_vendor_pin_is_in_board_json():
    data = load_board_json()
    pin_map = {key.upper(): value for key, value in data["pinMap"].items()}
    vendor = _vendor_pins()
    assert len(vendor) >= 80
    missing = [name for name in vendor if name not in pin_map]
    assert not missing, f"vendor pins missing from board.json: {missing}"
    wrong = {name: (pin, pin_map[name]) for name, pin in vendor.items() if pin_map[name] != [pin]}
    assert not wrong, f"board.json pin mismatches: {wrong}"


def test_structured_pins_match_pin_map():
    """The structured board data and the flat pinMap must not drift apart."""
    data = load_board_json()
    pin_map = {key.upper(): value for key, value in data["pinMap"].items()}
    board = data["board"]
    for i, pin in enumerate(board["leds"]["pins"]):
        assert pin_map[f"LED[{i}]"] == [pin], f"LED[{i}]: {pin} vs {pin_map[f'LED[{i}]']}"
    for i, pin in enumerate(board["buttons"]["pins"]):
        assert pin_map[f"KEY[{i}]"] == [pin], f"KEY[{i}]"
    for i, pin in enumerate(board["displays"]["pins"]["SEG"]):
        assert pin_map[f"SEG[{i}]"] == [pin], f"SEG[{i}]"
    for i, pin in enumerate(board["displays"]["pins"]["DIG"]):
        assert pin_map[f"DIG[{i}]"] == [pin], f"DIG[{i}]"
    for i, pin in enumerate(board["sdram"]["DQ"]):
        assert pin_map[f"SDRAM_DQ[{i}]"] == [pin], f"SDRAM_DQ[{i}]"
    for i, pin in enumerate(board["sdram"]["A"]):
        assert pin_map[f"SDRAM_A[{i}]"] == [pin], f"SDRAM_A[{i}]"
    for i in range(8):
        assert pin_map[f"LCD_D[{i}]"] == [board["lcd"]["pins"][f"LCD_D{i}"]], f"LCD_D{i}"


def test_all_pins_are_within_the_144_pin_package():
    data = load_board_json()
    for name, pins in data["pinMap"].items():
        for pin in pins:
            number = int(pin.split("_")[1])
            assert 1 <= number <= 144, f"{name} -> {pin} outside EQFP-144"


def test_no_pin_is_assigned_to_two_different_peripherals():
    data = load_board_json()
    owners: dict[str, list[str]] = {}
    for name, pins in data["pinMap"].items():
        # CLOCK_50 / FPGA_CLK / CLK are aliases of one clock function.
        if name in ("FPGA_CLK", "CLK"):
            continue
        for pin in pins:
            owners.setdefault(pin, []).append(name)
    conflicts = {pin: names for pin, names in owners.items() if len(names) > 1}
    # The only by-design shared nets are KEY[n]/ckey[n] on 88-91, and ckey is
    # not present in pinMap (the vendor file lists it commented out).
    allowed = {"PIN_88", "PIN_89", "PIN_90", "PIN_91"}
    unexpected = {pin: names for pin, names in conflicts.items() if pin not in allowed}
    assert not unexpected, f"unexpected pin sharing: {unexpected}"


def test_board_profile_polarity_matches_spec():
    data = load_board_json()
    board = data["board"]
    assert board["leds"]["activeLow"] is True
    assert board["buttons"]["activeLow"] is True
    assert board["switches"]["activeLow"] is True
    assert board["switches"]["sharedWithButtons"] is True
    assert board["displays"]["segmentActiveLow"] is True
    assert board["displays"]["digitActiveLow"] is True
    assert board["buzzer"]["activeLow"] is True
    assert board["resetActiveLow"] is True
    assert board["infrared"]["activeLow"] is True


def test_seg_bit_map_matches_schematic():
    data = load_board_json()
    assert data["board"]["displays"]["segBitMap"] == {
        "a": 0, "b": 1, "c": 2, "d": 3, "e": 4, "f": 5, "g": 6, "dp": 7,
    }


def test_i2c_buses_are_separate():
    data = load_board_json()
    buses = {bus["name"]: bus for bus in data["board"]["i2c"]["buses"]}
    assert buses["EEPROM"]["scl"] == "PIN_99" and buses["EEPROM"]["sda"] == "PIN_98"
    assert buses["LM75"]["scl"] == "PIN_112" and buses["LM75"]["sda"] == "PIN_113"
    assert buses["EEPROM"]["scl"] != buses["LM75"]["scl"]


def test_eeprom_write_protect_is_modelled():
    data = load_board_json()
    eeprom = data["board"]["i2c"]["buses"][0]["device"]
    assert eeprom["part"] == "AT24C08"
    assert eeprom["writeProtected"] is True
    assert eeprom["address"] == 0x50
    assert eeprom["pageSize"] == 16


# ---------------------------------------------------------------------------
# Backend loads the profile from board.json
# ---------------------------------------------------------------------------


def test_device_profile_comes_from_board_json():
    data = load_board_json()
    assert BOARD["leds"]["pins"] == data["board"]["leds"]["pins"]
    assert BOARD["displays"]["segBitMap"] == data["board"]["displays"]["segBitMap"]
    assert BOARD["i2c"]["eeprom"]["address"] == data["board"]["i2c"]["buses"][0]["device"]["address"]
    assert BOARD["sdram"]["DQ"] == data["board"]["sdram"]["DQ"]
    assert DEVICE()["userIo"] == data["devices"]["ep4ce6"]["userIo"] == 91


def test_board_pin_map_covers_all_peripherals():
    index = board_pin_map()
    for name in ("CLOCK_50", "FPGA_RST", "LED", "KEY", "SEG", "DIG",
                 "FPGA_BUZZER", "VGA_R", "PS_CLOCK", "UART_TXD", "IR",
                 "I2C_SCL", "FPGA_SCL", "LCD_D0", "SDRAM_DQ", "SDRAM_A"):
        assert name in index, f"{name} missing from board_pin_map"


# ---------------------------------------------------------------------------
# QSF parser
# ---------------------------------------------------------------------------


def test_all_vendor_qsf_files_parse_without_errors():
    assert len(VENDOR_QSF) == 4
    for path in VENDOR_QSF:
        result = parse_qsf(path.read_text(encoding="utf-8"))
        assert result.ok, f"{path.name}: {result.errors}"
        assert result.pins, path.name


def test_qsf_top_entity_device_io_standard_and_files():
    text = """
-- a comment
set_global_assignment -name TOP_LEVEL_ENTITY "my_top"
set_global_assignment -name DEVICE EP4CE6E22C8
set_global_assignment -name FAMILY "Cyclone IV E"
set_global_assignment -name VHDL_FILE src/a.vhd
set_global_assignment -name VERILOG_FILE src/b.v
set_instance_assignment -name IO_STANDARD "3.3-V LVTTL" -to LED[0]
set_location_assignment PIN_87 -to LED[0]
"""
    result = parse_qsf(text)
    assert result.ok, result.errors
    assert result.top == "my_top"
    assert result.device == "EP4CE6E22C8"
    assert result.family == "Cyclone IV E"
    assert result.io_standards == {"LED[0]": "3.3-V LVTTL"}
    assert ("vhdl", "src/a.vhd") in result.files
    assert ("verilog", "src/b.v") in result.files
    assert result.pins["LED"] == ["PIN_87"]


def test_qsf_comments_and_whitespace_are_tolerated():
    text = """
# hash comment
   -- dash comment
   set_location_assignment   PIN_88   -to   KEY[0]
\tset_location_assignment PIN_89 -to KEY[1]
"""
    result = parse_qsf(text)
    assert result.ok, result.errors
    assert result.pins["KEY"] == ["PIN_88", "PIN_89"]


def test_qsf_duplicate_pin_is_an_error():
    text = "set_location_assignment PIN_88 -to LED[0]\nset_location_assignment PIN_88 -to KEY[0]\n"
    result = parse_qsf(text)
    assert not result.ok
    assert any("duplicate" in error["message"].lower() for error in result.errors)


def test_qsf_invalid_pins_are_errors():
    for pin in ("PIN_0", "PIN_145", "PIN_999", "PIN_AB"):
        result = parse_qsf(f"set_location_assignment {pin} -to LED[0]\n")
        assert not result.ok, f"{pin} accepted"
        assert result.errors


def test_qsf_wrong_device_is_an_error():
    result = parse_qsf("set_global_assignment -name DEVICE EP4CE10F17C6\n")
    assert not result.ok
    assert any("device" in error["message"].lower() for error in result.errors)


def test_qsf_wrong_family_is_an_error():
    result = parse_qsf('set_global_assignment -name FAMILY "Cyclone V"\n')
    assert not result.ok


# ---------------------------------------------------------------------------
# VCD parser
# ---------------------------------------------------------------------------


def test_vcd_timescale_vectors_and_unknown_values():
    vcd = """
$timescale 10 ns $end
$scope module tb $end
$var wire 1 ! clk $end
$var wire 8 " data $end
$upscope $end
$enddefinitions $end
#0
0!
b00000000 "
#10
1!
#20
b10101010 "
#30
x!
bZZZZ0000 "
"""
    data = parse_vcd_text(vcd)
    assert data.timescale_ns == 10
    assert data.duration_ns == 300  # #30 at 10 ns per tick
    by_name = {signal.name: signal for signal in data.signals}
    assert by_name["clk"].transitions[0] == (0.0, "0")
    assert by_name["data"].transitions[1] == (200.0, 170)
    assert by_name["clk"].transitions[-1][1] == "x"


# ---------------------------------------------------------------------------
# Peripheral decoders
# ---------------------------------------------------------------------------


def _uart_frame(byte: int, bit_time: float, idle_high: bool = True) -> list[tuple[float, int]]:
    """Independent reference UART encoder: start, 8 bits LSB first, stop."""
    levels = [(0.0, 1 if idle_high else 0)]
    t = bit_time
    levels.append((t, 0))  # start bit
    for k in range(8):
        t += bit_time
        levels.append((t, (byte >> k) & 1))
    t += bit_time
    levels.append((t, 1))  # stop
    return levels


def test_decode_uart_lsb_first_and_baud():
    for byte in (0x01, 0x55, 0x80, 0xFF):
        decoded = decode_uart(_uart_frame(byte, 1000.0))
        assert decoded["bytes"] == [byte], f"{byte:#x} -> {decoded}"
        assert decoded["baud"] == 1_000_000, decoded


def test_decode_uart_missing_stop_bit_is_a_framing_error():
    levels = [(0.0, 1), (1000.0, 0)]
    t = 1000.0
    for k in range(8):
        t += 1000.0
        levels.append((t, (0x55 >> k) & 1))
    # no stop bit: the line stays low
    decoded = decode_uart(levels)
    assert decoded["bytes"] == [], decoded
    assert decoded["frames"] == 0


def test_decode_uart_idle_line_is_silent():
    assert decode_uart([(0.0, 1)])["frames"] == 0


def test_decode_buzzer_frequency_and_silence():
    # 10 kHz square wave: 50 us half period
    transitions = [(0.0, 1), (50_000.0, 0), (100_000.0, 1), (150_000.0, 0), (200_000.0, 1)]
    decoded = decode_buzzer(transitions)
    assert decoded["tone"] is True
    assert decoded["frequency"] == 10_000, decoded
    assert decode_buzzer([(0.0, 1)])["tone"] is False
    assert decode_buzzer([(0.0, 0)])["tone"] is False


def test_decode_vga_reconstructs_525_lines_per_frame():
    hs = []
    for k in range(525):
        start = 1000.0 + k * 31_780.0
        hs.append((start, 0))
        hs.append((start + 3_770.0, 1))
    vs = [(0.0, 1), (1000.0, 0), (16_700_000.0, 1), (16_800_000.0, 0), (33_400_000.0, 1)]
    decoded = decode_vga(hs, vs, [(0.0, 0)], [(0.0, 0)], [(0.0, 0)])
    assert decoded["frame"] is True, decoded
    assert decoded["lines"] == 525, decoded


def test_decode_vga_no_frame_when_sync_is_missing():
    decoded = decode_vga([(0.0, 0), (1000.0, 1)], [(0.0, 1)],
                         [(0.0, 0)], [(0.0, 0)], [(0.0, 0)])
    assert decoded["frame"] is False


def test_testbench_does_not_double_drive_model_ports():
    """A board-model pin must not also get a default '0' stimulus driver.

    Regression: the auto testbench used to emit `PS_CLOCK_bus <= '0'` for
    every un-driven input, fighting the PS/2 model's pull-up and holding the
    bus low (PR-03/PR-06 failed).
    """
    from backend.board_detect import board_models
    from backend.testbench_gen import TestbenchConfig, generate_testbench
    from backend.vhdl_parser import parse

    vhdl = """
library ieee;
use ieee.std_logic_1164.all;
entity ps2_probe is
    port (
        CLOCK_50 : in std_logic;
        PS_CLOCK : in std_logic;
        PS_DATA  : in std_logic
    );
end entity;
"""
    entity = parse(vhdl).primary
    assert entity is not None
    models = board_models(entity)
    assert models, "no board model matched PS_CLOCK/PS_DATA"
    tb = generate_testbench(entity, TestbenchConfig(models=models, duration_ns=1000))
    assert "PS_CLOCK_bus <= 'H'" in tb, "PS/2 pull-up missing"
    assert "PS_CLOCK_bus <= '0'" not in tb, "testbench double-drives the PS/2 clock"
    assert "PS_DATA_bus <= '0'" not in tb, "testbench double-drives the PS/2 data"


# ---------------------------------------------------------------------------
# Clock / reset detection (audit N8: these had no tests at all)
# ---------------------------------------------------------------------------


def test_detect_clock_ignores_clk_en_and_enable_suffixed_ports():
    from backend.testbench_gen import detect_clock
    from backend.vhdl_parser import parse

    vhdl = """
entity clk_probe is
    port (
        clk_en   : in std_logic;
        clk_out  : out std_logic;
        clk_div  : in std_logic;
        CLOCK_50 : in std_logic
    );
end entity;
"""
    clock = detect_clock(parse(vhdl).primary)
    assert clock is not None, "CLOCK_50 not detected"
    assert clock.name == "CLOCK_50", f"picked {clock.name} instead of CLOCK_50"


def test_detect_clock_returns_none_for_enable_only_design():
    from backend.testbench_gen import detect_clock
    from backend.vhdl_parser import parse

    vhdl = """
entity en_only is
    port (clk_en : in std_logic; clk_gate : in std_logic);
end entity;
"""
    assert detect_clock(parse(vhdl).primary) is None, "clk_en/clk_gate must not be the clock"


def test_detect_clock_picks_the_board_clock_port_name():
    from backend.device import BOARD
    from backend.testbench_gen import detect_clock
    from backend.vhdl_parser import parse

    vhdl = """
entity board_clk is
    port (CLOCK_50 : in std_logic; led : out std_logic_vector(3 downto 0));
end entity;
"""
    clock = detect_clock(parse(vhdl).primary)
    assert clock is not None
    assert clock.name == BOARD["clockPort"] == "CLOCK_50"


def test_detect_reset_matches_board_port_name_and_active_low_polarity():
    from backend.device import BOARD
    from backend.testbench_gen import detect_reset
    from backend.vhdl_parser import parse

    assert BOARD["resetPort"] == "FPGA_RST" and BOARD["resetActiveLow"] is True
    vhdl = """
entity rst_probe is
    port (CLOCK_50 : in std_logic; FPGA_RST : in std_logic; led : out std_logic);
end entity;
"""
    detected = detect_reset(parse(vhdl).primary)
    assert detected is not None, "FPGA_RST not detected as the reset"
    port, active_high = detected
    assert port.name == "FPGA_RST"
    assert active_high is False, "the board reset is active-low, not active-high"


def test_detect_reset_exact_names_and_no_false_matches():
    from backend.testbench_gen import detect_reset
    from backend.vhdl_parser import parse

    # an exact _RESET_NAMES port is matched; a bare "rst" defaults to
    # active-high by name convention (the bare-API heuristic). The board's
    # active-low RESET key is applied by the UI via explicit resetActiveHigh.
    vhdl_rst = """
entity rst_exact is
    port (rst : in std_logic; busy : out std_logic);
end entity;
"""
    detected = detect_reset(parse(vhdl_rst).primary)
    assert detected is not None and detected[0].name == "rst"
    assert detected[1] is True, "rst (no _n suffix) is active-high by name convention"

    # reset-like names that are NOT resets must not be hijacked
    for port_name in ("reset_req", "reset_done", "soft_rst_ctrl", "rst_status"):
        vhdl = f"""
entity no_reset is
    port ({port_name} : in std_logic; q : out std_logic);
end entity;
"""
        assert detect_reset(parse(vhdl).primary) is None, f"{port_name} was hijacked as reset"


# ---------------------------------------------------------------------------
# Waveform model: value_at bisect + serialized transition cap (audit N2)
# ---------------------------------------------------------------------------


def _signal_with_transitions(transitions):
    from backend.waveform import WaveformSignal

    return WaveformSignal(
        name="s", path="s", scope="tb", width=1, kind="wire", direction="out",
        type_name="std_logic", transitions=list(transitions),
        is_port=True, is_internal=False,
    )


def test_waveform_value_at_at_exact_between_and_outside_transitions():
    signal = _signal_with_transitions([
        (0.0, "0"), (10.0, "1"), (20.0, "0"), (35.0, "1"),
    ])
    # exact transition times take the transition's value
    assert signal.value_at(0.0) == "0"
    assert signal.value_at(10.0) == "1"
    assert signal.value_at(20.0) == "0"
    assert signal.value_at(35.0) == "1"
    # between transitions the earlier value holds
    assert signal.value_at(5.0) == "0"
    assert signal.value_at(12.5) == "1"
    assert signal.value_at(34.999) == "0"
    # before the first transition: the first (initial dump) value
    assert signal.value_at(-7.0) == "0"
    # after the last transition: the last value
    assert signal.value_at(1e9) == "1"
    # no transitions at all
    assert _signal_with_transitions([]).value_at(100.0) == 0


def test_waveform_value_at_matches_linear_reference_on_random_times():
    """The bisect implementation must equal the old linear scan exactly."""
    import random

    from backend.waveform import WaveformSignal

    rng = random.Random(7)
    transitions = []
    time = 0.0
    for _ in range(500):
        time += rng.uniform(1.0, 50.0)
        transitions.append((round(time, 3), rng.randrange(256)))
    signal = WaveformSignal(
        name="s", path="s", scope="tb", width=8, kind="wire", direction="out",
        type_name="std_logic_vector", transitions=transitions,
        is_port=True, is_internal=False,
    )

    def reference(t):
        value = transitions[0][1]
        for timestamp, item in transitions:
            if timestamp <= t:
                value = item
            else:
                break
        return value

    probes = [0.0] + [rng.uniform(0.0, time + 100.0) for _ in range(300)]
    for probe in probes:
        assert signal.value_at(probe) == reference(probe), f"mismatch at {probe}"


def test_waveform_to_dict_respects_the_transition_cap_and_is_deterministic():
    from backend.waveform import MAX_SERIALIZED_TRANSITIONS, WaveformSignal

    many = [(float(i), i % 4) for i in range(10_000)]
    signal = _signal_with_transitions(many)
    payload = signal.to_dict()
    assert len(payload["transitions"]) == MAX_SERIALIZED_TRANSITIONS
    assert payload["transitions"][0] == [0.0, 0], "first transition must be kept"
    assert payload["transitions"][-1] == [9999.0, 3], "last transition must be kept"
    # deterministic: identical input -> identical output
    assert payload == signal.to_dict()
    assert signal.to_dict()["transitions"] == _signal_with_transitions(many).to_dict()["transitions"]

    # under the cap the full list is serialized unchanged
    few = [(float(i), i % 2) for i in range(50)]
    small = _signal_with_transitions(few)
    assert len(small.to_dict()["transitions"]) == 50

    # every kept row comes from the source list (no invented values)
    lookup = {t: v for t, v in many}
    for time, value in payload["transitions"]:
        assert lookup[time] == value


# ---------------------------------------------------------------------------
# textio path pre-scan (audit N7 / ENG-07 mitigation)
# ---------------------------------------------------------------------------


def _textio_scan(vhdl: str):
    from backend.simulator import _textio_escape_errors

    return _textio_escape_errors([("design.vhd", vhdl)])


def test_textio_scan_rejects_escape_path_classes():
    body = """
library ieee;
use std.textio.all;
entity t is
port (q : out std_logic);
end entity;
architecture a of t is
begin
    process
        file f : text;
    begin
        %s
        wait;
    end process;
end architecture;
"""
    cases = {
        "drive letter": 'file_open(f, "C:/Users/x/out.txt", write_mode);',
        "drive letter (backslash)": 'file_open(f, "C:\\temp\\out.txt", write_mode);',
        "UNC path": 'file_open(f, "\\\\server\\share\\f.txt", write_mode);',
        "absolute POSIX": 'file_open(f, "/etc/passwd", read_mode);',
        "parent segment": 'file_open(f, "../secrets.txt", read_mode);',
        "env token": 'file_open(f, "%TEMP%\\out.txt", write_mode);',
        "file-decl literal": None,  # handled separately below
    }
    for label, statement in cases.items():
        if statement is None:
            continue
        errors = _textio_scan(body % statement)
        assert errors, f"{label}: no rejection"
        message = errors[0]["message"]
        assert errors[0]["severity"] == "error"
        assert errors[0]["line"] > 1, f"{label}: no line number in {errors[0]}"
        assert "work directory" in message, f"{label}: unclear message {message!r}"

    decl_src = """
architecture a of t is
    file log : text open write_mode is "C:/log.txt";
begin
end architecture;
"""
    errors = _textio_scan(decl_src)
    assert errors, "file declaration literal not rejected"
    assert "drive-letter" in errors[0]["message"], errors[0]["message"]


def test_textio_scan_allows_relative_paths_and_identifiers():
    body = """
library ieee;
use std.textio.all;
entity t is
port (q : out std_logic);
end entity;
architecture a of t is
begin
    process
        file f : text;
    begin
        %s
        wait;
    end process;
end architecture;
"""
    allowed = [
        'file_open(f, "out.txt", write_mode);',
        'file_open(f, "logs/out.txt", write_mode);',
        'file_open(f, "rom.mif", read_mode);',
        'file_open(f, PATH_C, write_mode);',  # runtime-computed: documented residual
    ]
    for statement in allowed:
        assert not _textio_scan(body % statement), f"false positive on: {statement}"

    decl_src = """
architecture a of t is
    file log : text open write_mode is "log.txt";
begin
end architecture;
"""
    assert not _textio_scan(decl_src), "relative file declaration rejected"


def test_textio_scan_ignores_comments_and_unrelated_strings():
    src = """
library ieee;
use std.textio.all;
entity t is
port (q : out std_logic);
end entity;
architecture a of t is
begin
    -- file_open(f, "C:/in-a-comment.txt", write_mode);
    process
        file f : text;
    begin
        file_open(f, "out.txt", write_mode);
        report "C:/not-a-file-path";
        wait;
    end process;
end architecture;
"""
    assert not _textio_scan(src), "comment or unrelated string triggered a rejection"
