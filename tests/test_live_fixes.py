"""Step 0 lock-in: regression tests for the four live-simulation fixes.

These tests are PERMANENT: they pin the exact behaviours that the live-sim
repair introduced so no later refactor can silently regress them.

1. Frame wiring: ``build_live_controller``/``LiveController`` accept
   ``on_frame``/``on_exit`` and fan every decoded frame out to the caller;
   the WebSocket pump normalizes telemetry frames to ``type: "live_frame"``.
2. 32-bit VHDL timestamp overflow: the wrapper emits timestamps as
   ``(seconds, ns-within-second)`` and the Python reader reassembles them, so
   live sessions step cleanly past 2^31 ns (~2.15 s) where
   ``integer(now / 1 ns)`` used to abort GHDL.
3. Pace-loop backpressure: the pace loop only queues the next ``T`` step once
   the previous frame has been produced (``live.frame_seq >= steps``), so the
   GHDL stdin pipe never fills and the asyncio event loop never stalls.
4. Empty Pin Planner ``strictPins`` gating: with no assignments the backend
   keeps its name-based auto alias mapping (buzzerb->PIN_110, btn1->PIN_88...);
   ``strictPins=True`` applies ONLY explicit assignments.
"""
from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from backend import live_session as live_session_mod
from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.live_session import LiveController, build_live_controller
from backend.live_wrapper import build_live_wrapper
from backend.server import app
from backend.vhdl_parser import VHDLParser
from backend.waveform import map_board

# The real user design from the adversarial matrix: scalar ports btn1..btn4
# and buzzerb — the exact names the empty-Pin-Planner fix must keep mapped.
BUZZB_VHDL = """
library IEEE;
use IEEE.STD_LOGIC_1164.ALL;
use IEEE.NUMERIC_STD.ALL;
entity buzzb is
    Port ( clk     : in  STD_LOGIC;
           btn1    : in  STD_LOGIC;
           btn2    : in  STD_LOGIC;
           btn3    : in  STD_LOGIC;
           btn4    : in  STD_LOGIC;
           buzzerb : out STD_LOGIC );
end buzzb;
architecture tingog of buzzb is
begin
  buzzerb <= not btn1;
end architecture;
"""

COUNTER_VHDL = """
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity fix_counter is
  port (clk : in std_logic; reset : in std_logic; led : out std_logic_vector(7 downto 0));
end entity;
architecture rtl of fix_counter is
  signal cnt : unsigned(7 downto 0) := (others => '0');
begin
  process (clk, reset)
  begin
    if reset = '1' then
      cnt <= (others => '0');
    elsif rising_edge(clk) then
      cnt <= cnt + 1;
    end if;
  end process;
  led <= std_logic_vector(cnt);
end architecture;
"""


@pytest.fixture(scope="module")
def ghdl_exe():
    try:
        return GhdlTool().executable
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")


@pytest.fixture(scope="module")
def client():
    try:
        GhdlTool()
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")
    with TestClient(app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# Fix 2: overflow-free timestamps
# ---------------------------------------------------------------------------

def test_parse_time_ns_split_form():
    parse = live_session_mod._parse_time_ns
    assert parse("2 500000000") == 2.5e9
    assert parse("0 0") == 0.0
    assert parse("4 1") == 4e9 + 1.0


def test_parse_time_ns_legacy_single_number():
    parse = live_session_mod._parse_time_ns
    assert parse("12345") == 12345.0
    assert parse("") == 0.0
    assert parse("not-a-number") == 0.0


def test_wrapper_emits_overflow_safe_timestamps(ghdl_exe):
    entity = VHDLParser().parse(COUNTER_VHDL).entities[0]
    wrapper = build_live_wrapper(entity, "clk", 10.0)
    vhdl = wrapper["vhdl"]
    assert "constant ONE_S" in vhdl and "constant ONE_NS" in vhdl
    # The F line must write the SPLIT timestamp, never a bare integer(now/1ns).
    assert "integer(now / ONE_S)" in vhdl
    assert "integer((now mod ONE_S) / ONE_NS)" in vhdl
    assert "integer(now / 1 ns)" not in vhdl


def test_live_steps_past_2pow31_ns_without_abort(ghdl_exe):
    """The killer scenario: simulated time crosses 2^31 ns (~2.147 s) and the
    session must keep stepping with exact nanosecond timestamps, no GHDL
    overflow abort."""
    entity = VHDLParser().parse(COUNTER_VHDL).entities[0]
    # 1 µs clock period: 3.3M cycles = 3.3e9 ns, safely past 2^31 ns.
    controller, _ = build_live_controller(
        ghdl_exe, entity, [("fix_counter.vhd", COUNTER_VHDL)], map_board(entity),
        {"resetPin": "PIN_25", "resetActiveLow": True},
        "clk", 1000.0, "reset", 2, True)
    try:
        assert controller.session.start(), controller.session.start_error
        controller.assert_reset()
        deadline = time.time() + 15.0
        while controller.frame_seq < 1 and time.time() < deadline:
            time.sleep(0.01)
        assert controller.frame_seq >= 1, "no frame after reset"

        # resetCycles=2 steps 2 clocks of 1000 ns before the design runs.
        sim_ns = 2 * 1000.0
        total = 0
        for _ in range(3):
            seq = controller.frame_seq
            assert controller.session.step(1_100_000)
            deadline = time.time() + 20.0
            while controller.frame_seq < seq + 1 and time.time() < deadline:
                time.sleep(0.01)
            assert controller.frame_seq >= seq + 1, "frame missing after 1.1M-cycle step"
            total += 1_100_000
            sim_ns += 1_100_000 * 1000.0
            frame = controller.last_frame
            # Exact reassembly: 3.3M cycles at 1000 ns == 3.3e9 ns.
            assert frame["timeNs"] == pytest.approx(sim_ns, rel=1e-9), frame["timeNs"]

        assert controller.session.alive, "session died crossing 2^31 ns"
        assert controller.session.reader_error is None, controller.session.reader_error
        assert controller.session.sim_time_ns > 2.5e9
        log_text = json.dumps(controller.last_frame.get("log", []))
        assert "overflow" not in log_text.lower()
    finally:
        controller.session.close()


# ---------------------------------------------------------------------------
# Fix 1: on_frame / on_exit wiring
# ---------------------------------------------------------------------------

def test_controller_forwards_frames_to_on_frame(ghdl_exe):
    entity = VHDLParser().parse(COUNTER_VHDL).entities[0]
    seen: list = []
    exits: list = []
    controller, _ = build_live_controller(
        ghdl_exe, entity, [("fix_counter.vhd", COUNTER_VHDL)], map_board(entity),
        {"resetPin": "PIN_25", "resetActiveLow": True},
        "clk", 10.0, "reset", 2, True,
        on_frame=seen.append, on_exit=lambda reason: exits.append(reason))
    try:
        assert controller.session.start(), controller.session.start_error
        controller.assert_reset()
        # Two explicit steps after the reset frame: every completed step must
        # reach the outer on_frame callback.
        for _ in range(2):
            seq_target = len(seen) + 1
            assert controller.session.step(10)
            deadline = time.time() + 10.0
            while len(seen) < seq_target and time.time() < deadline:
                time.sleep(0.01)
        assert len(seen) >= 3, "on_frame callback did not fire for every step"
        for frame in seen:
            assert frame.get("type") == "frame"  # internal telemetry marker
            assert "timeNs" in frame and "values" in frame
        # The controller's own bookkeeping still sees the same frames.
        assert controller.frame_seq >= 3
        assert controller.last_frame is seen[-1]
        assert exits == [], exits  # still running
    finally:
        controller.session.close()
    # After close, the reader loop ends and on_exit must have fired.
    deadline = time.time() + 5.0
    while not exits and time.time() < deadline:
        time.sleep(0.01)
    assert exits, "on_exit callback never fired after close"


def test_ws_live_frames_normalized_and_pace_responsive(client):
    """End-to-end over the WebSocket: live_start streams frames typed
    ``live_frame`` and the pace loop keeps the control channel responsive
    (backpressure never stalls the event loop)."""
    with client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"

        ws.send_text(json.dumps({
            "type": "live_start",
            "vhdl": COUNTER_VHDL,
            "top": "fix_counter",
            "clockPeriod": 10.0,
            "resetCycles": 2,
        }))
        while True:
            msg = ws.receive_json()
            if msg["type"] == "live_ready":
                break
            assert msg["type"] == "live_error", msg  # fail loudly, never hang

        ws.send_text(json.dumps({"type": "live_pace", "pace": "max"}))
        frames = []
        while len(frames) < 8:
            msg = ws.receive_json()
            if msg["type"] == "live_frame":
                frames.append(msg)
        # Every streamed telemetry frame carries the public type.
        assert all(f.get("type") == "live_frame" for f in frames)
        times = [f["timeNs"] for f in frames]
        assert times == sorted(times), times  # sim time advances monotonically
        assert len(set(times)) == len(times), times  # no duplicate frames

        # Responsiveness probe: while (or after) streaming, a control message
        # still gets its reply promptly — proof the event loop is not blocked
        # on GHDL's stdin pipe.
        ws.send_text(json.dumps({"type": "live_pace", "pace": "single"}))
        while True:
            msg = ws.receive_json()
            if msg["type"] == "live_pace":
                assert msg["pace"] == "single"
                break

        ws.send_text(json.dumps({"type": "live_stop"}))
        while True:
            msg = ws.receive_json()
            if msg["type"] == "live_stopped":
                break


def test_ws_notifies_client_when_ghdl_exits(client):
    """If GHDL dies on its own, the server must push live_stopped (with the
    reader error detail) instead of going silent."""
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_text(json.dumps({
            "type": "live_start",
            "vhdl": COUNTER_VHDL,
            "top": "fix_counter",
            "clockPeriod": 10.0,
            "resetCycles": 2,
        }))
        while True:
            msg = ws.receive_json()
            if msg["type"] == "live_ready":
                break
            assert msg["type"] == "live_error", msg

        # The registry holds every live session; the newest one is ours.
        session = live_session_mod._SESSIONS[-1]
        assert session.alive
        session.proc.kill()  # simulate a GHDL crash mid-session

        while True:
            msg = ws.receive_json()
            if msg["type"] == "live_stopped":
                break


# ---------------------------------------------------------------------------
# Fix 4: strictPins gating semantics (empty vs. populated Pin Planner)
# ---------------------------------------------------------------------------

def test_empty_pin_planner_keeps_auto_alias_pins():
    """strictPins=False (empty Pin Planner) must keep the name-based alias
    resolver active: buzzerb -> PIN_110, btn1..4 -> KEY1..4 pins."""
    entity = VHDLParser().parse(BUZZB_VHDL).entities[0]
    board_map = map_board(entity, qsf_pins=None, strict_pins=False)
    assert board_map.pins.get("buzzerb") == ["PIN_110"], board_map.pins
    assert board_map.pins.get("btn1") == ["PIN_88"], board_map.pins
    assert board_map.pins.get("btn2") == ["PIN_89"], board_map.pins
    assert board_map.pins.get("btn3") == ["PIN_90"], board_map.pins
    assert board_map.pins.get("btn4") == ["PIN_91"], board_map.pins
    assert board_map.pins.get("clk"), board_map.pins  # clock auto-detected


def test_strict_pins_applies_only_explicit_assignments():
    """strictPins=True with NO assignments maps nothing (this is exactly why
    the frontend must not send it for an empty planner), and with explicit
    QSF assignments it applies them without name-based leakage."""
    entity = VHDLParser().parse(BUZZB_VHDL).entities[0]
    empty = map_board(entity, qsf_pins=None, strict_pins=True)
    assert "buzzerb" not in empty.pins
    assert "btn1" not in empty.pins

    explicit = map_board(entity, qsf_pins={"buzzerb": ["PIN_110"]}, strict_pins=True)
    assert explicit.pins.get("buzzerb") == ["PIN_110"]
    assert "btn1" not in explicit.pins  # unassigned ports stay unmapped


def test_simulate_rest_honours_strict_pins_flag(client):
    """The REST path parses strictPins and keeps the auto alias map when it
    is false (the payload the frontend sends for an empty Pin Planner)."""
    auto = client.post("/api/simulate", json={
        "vhdl": BUZZB_VHDL, "duration": 100, "strictPins": False})
    assert auto.status_code == 200, auto.text
    pins = auto.json()["board"]["pins"]
    assert pins.get("buzzerb") == ["PIN_110"], pins
    assert pins.get("btn1") == ["PIN_88"], pins

    strict = client.post("/api/simulate", json={
        "vhdl": BUZZB_VHDL, "duration": 100, "strictPins": True})
    assert strict.status_code == 200, strict.text
    strict_pins = strict.json()["board"]["pins"]
    assert "buzzerb" not in strict_pins, strict_pins


def test_simulate_header_only_qsf_keeps_auto_alias(client):
    """A fresh Pin Planner still sends a header-only QSF body; with
    strictPins=false the auto alias map must survive it untouched."""
    header_qsf = (
        "# Generated by Cyclone IV Studio Pin Planner\n"
        'set_global_assignment -name FAMILY "Cyclone IV E"\n'
        "set_global_assignment -name DEVICE EP4CE6E22C8\n"
        "set_global_assignment -name TOP_LEVEL_ENTITY buzzb\n"
        "\n"
    )
    response = client.post("/api/simulate", json={
        "vhdl": BUZZB_VHDL, "duration": 100, "qsf": header_qsf, "strictPins": False})
    assert response.status_code == 200, response.text
    pins = response.json()["board"]["pins"]
    assert pins.get("buzzerb") == ["PIN_110"], pins
    assert pins.get("btn4") == ["PIN_91"], pins
