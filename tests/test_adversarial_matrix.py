"""Phase 2 adversarial verification matrix — real user designs, full pipeline.

Every design here is a real, non-trivial HDL file pushed through the same
pipeline the studio UI uses (compile -> simulate -> decode -> live co-sim),
asserting exact electrical behaviour — never example-specific shortcuts.

Design 1  buzzb.vhd          4-tone latched buzzer, scalar btn1..4/buzzerb
Design 2  polarity pair      VHDL vs Verilog combinational LED truth table
Design 3  key_counter.vhd    stateful edge-triggered button counter (live)
Design 4  divider blinker    50 MHz clock divider toggling an LED (live)
Design 5  sevseg_4tube.vhd   multiplexed 4-digit 7-segment (stimulusMap)
Design 6  uart_tx_board      115200 8N1 TX decoded from the VCD
Design 7  DE0-Nano           board switch, ball-name pins, active-high LEDs
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.live_session import LiveController, build_live_controller
from backend.server import app
from backend.vhdl_parser import VHDLParser
from backend.waveform import map_board

ROOT = Path(__file__).resolve().parent.parent
BOARD_JSON = json.loads((ROOT / "board" / "board.json").read_text(encoding="utf-8"))
SEG_BIT_MAP = dict(BOARD_JSON["board"]["displays"]["segBitMap"])

BUZZB = (ROOT / "examples" / "buzzb.vhd").read_text(encoding="utf-8")
BUZZB_1S = BUZZB.replace("250000000", "50000000")
# Mechanism variant: same structure, a hold of 200k cycles instead of 250M so
# the expiry can be simulated in seconds. The REAL 250M/50M constants are
# proven exactly by the stimulus-map release-cycle detection (slope analysis),
# which reads the loaded terminal value without simulating the countdown.
BUZZB_FAST_HOLD = BUZZB.replace("250000000", "200000")

SEVSEG = (ROOT / "examples" / "sevseg_4tube.vhd").read_text(encoding="utf-8")
UART_TX = (ROOT / "tests" / "qa" / "designs" / "board" / "uart_tx.vhd").read_text(encoding="utf-8")

POLARITY_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
entity pol_vhdl is
  port (sw : in std_logic_vector(3 downto 0); led : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of pol_vhdl is
begin
  led <= not sw;   -- RZ-EasyFPGA LEDs are active-low
end architecture;
"""

POLARITY_VERILOG = """
module pol_verilog(input [3:0] sw, output reg [3:0] led);
always @(*) led = ~sw;   // same active-low board, Verilog front-end
endmodule
"""

KEY_COUNTER = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity key_counter is
  port (clk  : in  std_logic;
        key1 : in  std_logic;   -- K1: count on release edge
        key2 : in  std_logic;   -- K2: clear
        led  : out std_logic_vector(3 downto 0));
end entity;
architecture rtl of key_counter is
  signal cnt     : unsigned(3 downto 0) := (others => '0');
  signal k1_sync : std_logic := '1';
  signal k1_prev : std_logic := '1';
begin
  process (clk)
  begin
    if rising_edge(clk) then
      k1_sync <= key1;
      k1_prev <= k1_sync;
      if key2 = '0' then
        cnt <= (others => '0');
      elsif k1_prev = '0' and k1_sync = '1' then
        cnt <= cnt + 1;
      end if;
    end if;
  end process;
  led <= std_logic_vector(cnt);
end architecture;
"""

BLINKER = """
library ieee;
use ieee.std_logic_1164.all;
entity blink_div is
  port (clk : in std_logic; led : out std_logic);
end entity;
architecture rtl of blink_div is
  constant HALF_SEC : integer := 250000;  -- 50 MHz divider structure
  signal cnt   : integer range 0 to HALF_SEC - 1 := 0;
  signal state : std_logic := '0';
begin
  process (clk)
  begin
    if rising_edge(clk) then
      if cnt = HALF_SEC - 1 then
        cnt   <= 0;
        state <= not state;
      else
        cnt <= cnt + 1;
      end if;
    end if;
  end process;
  led <= state;
end architecture;
"""

NANO_TOP = """
library ieee;
use ieee.std_logic_1164.all;
entity nano_top is
  port (clk : in  std_logic;
        key : in  std_logic_vector(1 downto 0);
        sw  : in  std_logic_vector(3 downto 0);
        led : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of nano_top is
begin
  led <= sw & key & "00";   -- DE0-Nano LEDs are active-HIGH
end architecture;
"""

# Glyph segment sets (seven_seg bit0=a .. bit6=g, active-low drive).
GLYPH_SEGMENTS = {
    1: {"b", "c"},
    2: {"a", "b", "d", "e", "g"},
    3: {"a", "b", "c", "d", "g"},
    4: {"b", "c", "f", "g"},
}


@pytest.fixture(scope="module")
def client():
    try:
        GhdlTool()
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def ghdl_exe():
    try:
        return GhdlTool().executable
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")


# ---------------------------------------------------------------------------
# Live-session harness
# ---------------------------------------------------------------------------

RZ_PROFILE = {
    "buttons": {"pins": ["PIN_88", "PIN_89", "PIN_90", "PIN_91"], "activeLow": True},
    "switches": {"pins": ["PIN_88", "PIN_89", "PIN_90", "PIN_91"], "activeLow": True,
                 "sharedWithButtons": True},
    "buzzer": {"pin": "PIN_110", "activeLow": True},
    "resetPin": "PIN_25", "resetActiveLow": True,
}


def _make_live(ghdl_exe: str, vhdl: str, profile: dict = RZ_PROFILE,
               clock: str = "clk", period_ns: float = 20.0) -> LiveController:
    entity = VHDLParser().parse(vhdl).entities[0]
    controller, _ = build_live_controller(
        ghdl_exe, entity, [(entity.name + ".vhd", vhdl)], map_board(entity),
        profile, clock, period_ns, None, 0, True)
    assert controller.session.start(), controller.session.start_error
    return controller


def _step_frame(controller: LiveController, cycles: int, timeout: float = 30.0) -> dict:
    seq = controller.frame_seq
    assert controller.session.step(cycles)
    deadline = time.time() + timeout
    while controller.frame_seq < seq + 1 and time.time() < deadline:
        time.sleep(0.01)
    assert controller.frame_seq >= seq + 1, f"no frame after {cycles}-cycle step"
    return controller.last_frame


def _frame_freq(frame: dict, cycles: int, clock_ns: float = 20.0) -> float:
    """Frequency implied by the frame's buzzer toggle count (exact math)."""
    toggles = (frame.get("buzzer") or {}).get("toggles", 0)
    return toggles / (2.0 * cycles * clock_ns * 1e-9)


# ---------------------------------------------------------------------------
# Design 1 — buzzb.vhd
# ---------------------------------------------------------------------------

def test_buzzb_auto_pin_map_and_compile(client):
    compiled = client.post("/api/compile", json={"vhdl": BUZZB})
    assert compiled.status_code == 200, compiled.text
    body = compiled.json()
    assert body["ok"] is True
    assert body["entity"]["name"] == "buzzb"
    pins = body["board"]["pins"]
    assert pins["clk"] == ["PIN_23"]
    assert pins["btn1"] == ["PIN_88"]
    assert pins["btn2"] == ["PIN_89"]
    assert pins["btn3"] == ["PIN_90"]
    assert pins["btn4"] == ["PIN_91"]
    assert pins["buzzerb"] == ["PIN_110"]


def test_buzzb_idle_is_silent(ghdl_exe):
    controller = _make_live(ghdl_exe, BUZZB)
    try:
        controller.apply_channel_state([False] * 4, [False] * 4, False)
        _step_frame(controller, 1_000_000)   # settle
        frame = _step_frame(controller, 1_000_000)
        assert frame["buzzer"]["toggles"] == 0, frame["buzzer"]
        assert frame["values"]["buzzerb"] == 1  # released net, active-low idle
    finally:
        controller.session.close()


@pytest.mark.parametrize("channel,expected_hz", [(0, 500), (1, 800), (2, 1000), (3, 1600)])
def test_buzzb_four_tones_via_keys(ghdl_exe, channel, expected_hz):
    """Pressing K1..K4 (HUD or 3D — same net) produces the exact four tones."""
    controller = _make_live(ghdl_exe, BUZZB)
    try:
        keys = [False] * 4
        keys[channel] = True
        controller.apply_channel_state(keys, [False] * 4, False)
        _step_frame(controller, 1_000_000)   # settle into the new tone
        frame = _step_frame(controller, 1_000_000)
        freq = _frame_freq(frame, 1_000_000)
        assert abs(freq - expected_hz) <= expected_hz * 0.02, (freq, expected_hz)
        assert frame["buzzer"]["toggles"] >= 2
    finally:
        controller.session.close()


@pytest.mark.parametrize("channel,expected_hz", [(0, 500), (1, 800), (2, 1000), (3, 1600)])
def test_buzzb_four_tones_via_dip(ghdl_exe, channel, expected_hz):
    """The shared DIP bank drives the SAME KEY nets: S1..S4 give the same tones."""
    controller = _make_live(ghdl_exe, BUZZB)
    try:
        dip = [False] * 4
        dip[channel] = True
        controller.apply_channel_state([False] * 4, dip, False)
        _step_frame(controller, 1_000_000)
        frame = _step_frame(controller, 1_000_000)
        freq = _frame_freq(frame, 1_000_000)
        assert abs(freq - expected_hz) <= expected_hz * 0.02, (freq, expected_hz)
    finally:
        controller.session.close()


def test_buzzb_release_holds_tone_then_expires(ghdl_exe):
    """Release-hold mechanism: the tone keeps sounding after release and
    silences exactly when the (scaled) hold timer expires."""
    controller = _make_live(ghdl_exe, BUZZB_FAST_HOLD)
    try:
        controller.apply_channel_state([True, False, False, False], [False] * 4, False)
        _step_frame(controller, 1_000_000)          # settle at 500 Hz
        controller.apply_channel_state([False] * 4, [False] * 4, False)  # release
        frame = _step_frame(controller, 100_000)    # inside the 200k-cycle hold
        assert frame["buzzer"]["toggles"] >= 1, "tone did not survive release"
        _step_frame(controller, 200_000)            # straddles the 200k expiry
        frame = _step_frame(controller, 100_000)    # fully past the hold
        assert frame["buzzer"]["toggles"] == 0, "hold timer did not expire"
    finally:
        controller.session.close()


def test_buzzb_mid_hold_tone_switch(ghdl_exe):
    """Pressing another key mid-hold switches the frequency immediately."""
    controller = _make_live(ghdl_exe, BUZZB)
    try:
        controller.apply_channel_state([True, False, False, False], [False] * 4, False)
        _step_frame(controller, 1_000_000)
        controller.apply_channel_state([False] * 4, [False] * 4, False)  # release -> hold
        _step_frame(controller, 1_000_000)          # still 500 Hz in the hold
        controller.apply_channel_state([False, True, False, False], [False] * 4, False)
        _step_frame(controller, 1_000_000)          # settle at the new tone
        frame = _step_frame(controller, 1_000_000)
        freq = _frame_freq(frame, 1_000_000)
        assert abs(freq - 800) <= 16, freq
    finally:
        controller.session.close()


@pytest.mark.parametrize("mask,channel_pressed,expected_hz", [
    ("15", None, None),
    ("14", 0, 500),
    ("13", 1, 800),
    ("11", 2, 1000),
    ("7", 3, 1600),
])
def test_buzzb_stimulus_map_vectors(client, mask, channel_pressed, expected_hz):
    """The pre-computed stimulusMap carries the exact tone per key vector
    (mask bit = released for this active-low board) and the release entries
    carry the exact hold length read from the design's own counter constant."""
    response = client.post("/api/simulate", json={
        "vhdl": BUZZB, "duration": 4_000_000, "clockPeriod": 20,
        "resetCycles": 2, "includeStimulusMap": True,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    sweep = body.get("stimulusMap")
    assert sweep and sweep["meta"]["channelCount"] == 4
    assert sorted(sweep["meta"]["boundChannels"]) == [0, 1, 2, 3]
    vectors = sweep["vectors"]
    entry = vectors[mask]
    decode = entry["buzzerDecode"]
    if expected_hz is None:
        assert decode["tone"] is False and decode["frequency"] == 0, decode
    else:
        assert decode["tone"] is True, decode
        assert abs(decode["frequency"] - expected_hz) <= expected_hz * 0.02, decode
    releases = sweep["releases"]
    assert releases, "buzzer designs must produce release entries"
    assert releases["0"]["releaseCycles"] == 250_000_000


def test_buzzb_stimulus_map_one_second_hold_variant(client):
    response = client.post("/api/simulate", json={
        "vhdl": BUZZB_1S, "duration": 4_000_000, "clockPeriod": 20,
        "resetCycles": 2, "includeStimulusMap": True,
    })
    assert response.status_code == 200, response.text
    sweep = response.json().get("stimulusMap")
    assert sweep and sweep["releases"], response.text
    assert sweep["releases"]["0"]["releaseCycles"] == 50_000_000


# ---------------------------------------------------------------------------
# Design 2 — combinational polarity, VHDL vs Verilog
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("files,label", [
    ([{"name": "pol_vhdl.vhd", "content": POLARITY_VHDL}], "vhdl"),
    ([{"name": "pol_verilog.v", "content": POLARITY_VERILOG}], "verilog"),
])
def test_combinational_polarity_truth_table(client, files, label):
    """sw=0101 -> led=1010 -> LEDs 0 and 2 lit on the active-low board;
    identical electrical result through both language front-ends."""
    response = client.post("/api/simulate", json={
        "files": files, "duration": 2_000, "clockPeriod": 20,
        "constantInputs": {"sw": 0b0101},
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True, body.get("errors")
    image = body["waveforms"]["boardImage"]
    assert image["leds"] == [1, 0, 1, 0], (label, image["leds"])
    assert body["waveforms"]["final"]["led"] == 0b1010, (label, body["waveforms"]["final"])


# ---------------------------------------------------------------------------
# Design 3 — stateful edge-triggered button counter (live co-sim)
# ---------------------------------------------------------------------------

def test_stateful_key_counter_persists(ghdl_exe):
    """Sequential design: the count advances on key RELEASE edges and persists
    across frames — live co-sim keeps history instead of snapping to a
    stateless per-vector image."""
    controller = _make_live(ghdl_exe, KEY_COUNTER)
    try:
        def press(i):
            keys = [False] * 4
            keys[i] = True
            controller.apply_channel_state(keys, [False] * 4, False)
            _step_frame(controller, 4)

        def release(i):
            controller.apply_channel_state([False] * 4, [False] * 4, False)
            return _step_frame(controller, 8)

        press(0)
        assert int(_step_frame(controller, 4)["values"]["led"]) == 0  # held, no edge yet
        assert int(release(0)["values"]["led"]) == 1
        press(0)
        release(0)
        assert int(controller.last_frame["values"]["led"]) == 2
        press(0)
        release(0)
        assert int(controller.last_frame["values"]["led"]) == 3
        # State persists with no further input.
        assert int(_step_frame(controller, 50_000)["values"]["led"]) == 3
        # K2 clears.
        press(1)
        assert int(_step_frame(controller, 8)["values"]["led"]) == 0
    finally:
        controller.session.close()


# ---------------------------------------------------------------------------
# Design 4 — 50 MHz clock-divider blinker (live)
# ---------------------------------------------------------------------------

def test_divider_blinker_led_toggles(ghdl_exe):
    """The LED must visibly toggle — never stuck dark or solid."""
    controller = _make_live(ghdl_exe, BLINKER)
    try:
        first = _step_frame(controller, 300_000)["values"]["led"]
        second = _step_frame(controller, 300_000)["values"]["led"]
        third = _step_frame(controller, 300_000)["values"]["led"]
        assert first != second, "LED never toggled (stuck dark or solid?)"
        assert second != third, "LED never toggled back (stuck solid?)"
    finally:
        controller.session.close()


# ---------------------------------------------------------------------------
# Design 5 — sevseg_4tube multiplexed display (stimulusMap)
# ---------------------------------------------------------------------------

def _decode_tube_digits(pov_bits):
    """Decode each tube's ever-lit segment set back to a glyph 1..4."""
    bit_to_name = {bit: name for name, bit in SEG_BIT_MAP.items()}
    decoded = []
    for tube in range(4):
        lit = {bit_to_name[bit] for bit in range(8) if pov_bits[tube * 8 + bit]}
        match = [g for g, segs in GLYPH_SEGMENTS.items() if segs == lit]
        decoded.append(match[0] if len(match) == 1 else None)
    return decoded


def test_sevseg_4tube_idle_and_key_digits(client):
    response = client.post("/api/simulate", json={
        "vhdl": SEVSEG, "duration": 10_000_000, "clockPeriod": 20,
        "resetCycles": 2, "includeStimulusMap": True,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True, body.get("errors")
    sweep = body["stimulusMap"]
    assert sweep and sweep["meta"]["channelCount"] == 4

    idle = _decode_tube_digits(sweep["vectors"]["15"]["povBits"])
    assert sorted(idle) == [1, 2, 3, 4], idle  # four distinct crisp digits

    for mask, glyph in (("14", 1), ("13", 2), ("11", 3), ("7", 4)):
        pressed = _decode_tube_digits(sweep["vectors"][mask]["povBits"])
        assert pressed == [glyph, glyph, glyph, glyph], (mask, pressed)

    # Multiplex scan must be in the hundreds of Hz (65536-cycle rotation).
    scan = sweep["vectors"]["15"]["scanHz"]
    assert 600 <= scan <= 950, scan
    # Ghost bleed must be imperceptible at this scan rate.
    ghosts = body["waveforms"]["boardImage"].get("ghosts") or []
    assert all(g[3] < 0.01 for g in ghosts), ghosts[:4]


# ---------------------------------------------------------------------------
# Design 6 — UART TX decoded from the VCD
# ---------------------------------------------------------------------------

def test_uart_tx_decodes_0x55_frames(client):
    response = client.post("/api/simulate", json={
        "vhdl": UART_TX, "duration": 800_000, "clockPeriod": 20,
        "resetCycles": 2,
    })
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True, body.get("errors")
    uart = body["peripherals"].get("uart") or {}
    assert uart.get("frames", 0) >= 3, uart
    assert len(uart.get("bytes", [])) >= 3, uart
    assert all(byte == 0x55 for byte in uart["bytes"]), uart
    # 50 MHz / 434 = 115207 baud — the decoded value must sit at 115200 ±0.3%.
    assert abs(uart["baud"] - 115200) <= 350, uart


# ---------------------------------------------------------------------------
# Design 7 — DE0-Nano board switch + ball-name pins
# ---------------------------------------------------------------------------

def test_de0_nano_board_switch_and_mapping(client):
    selected = client.post("/api/boards/select", json={"board": "de0-nano-ep4ce22"})
    assert selected.status_code == 200, selected.text
    try:
        assert selected.json()["activeBoard"] == "de0-nano-ep4ce22"
        response = client.post("/api/simulate", json={
            "vhdl": NANO_TOP, "duration": 2_000, "clockPeriod": 20,
            "constantInputs": {"key": 0b10, "sw": 0b0011},
        })
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["ok"] is True, body.get("errors")
        pins = body["board"]["pins"]
        assert pins["clk"] == ["PIN_R8"]
        assert pins["key"] == ["PIN_J15", "PIN_E1"]
        assert pins["sw"] == ["PIN_M1", "PIN_T8", "PIN_B9", "PIN_M15"]
        assert pins["led"] == ["PIN_A15", "PIN_A13", "PIN_B13", "PIN_A11",
                               "PIN_D1", "PIN_F3", "PIN_B1", "PIN_L3"]
        # Zero RZ-EasyFPGA leakage.
        flat = {p for plist in pins.values() for p in plist}
        assert "PIN_87" not in flat and "PIN_110" not in flat and "PIN_23" not in flat
        # Active-high LEDs: led = sw & key & "00" = 0011_10_00 -> LEDs 3..5 lit.
        image = body["waveforms"]["boardImage"]
        assert image["leds"] == [0, 0, 0, 1, 1, 1, 0, 0], image["leds"]
    finally:
        back = client.post("/api/boards/select", json={"board": "rz-easyfpga-a2.2"})
        assert back.status_code == 200
        assert back.json()["activeBoard"] == "rz-easyfpga-a2.2"
