"""Tests for the WebSocket simulation playback protocol.

Exercises ``backend/session.py`` through the real ``/ws`` endpoint of
``backend/server.py``: sim_start streaming, pause/resume, single-stepping,
stop, reset, session replacement, error handling, and the resilient frontend
serving (dist > legacy > flat layout).
"""

from __future__ import annotations

import concurrent.futures
import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.server import app

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
COUNTER = (EXAMPLES / "counter.vhd").read_text(encoding="utf-8")
BAD_VHDL = "entity broken is end entity"

#: Board real time is 50 MHz; 50e6 * 4e-5 = 2000 cycles/s, i.e. one 32-cycle
#: batch every ~16 ms.  Slow enough that pause/stop/reset messages reliably
#: arrive while the stream is still running.
SLOW_SPEED = 0.00004

# Receiving is done from helper threads so a stuck stream fails with a
# timeout instead of hanging the suite.
_RECV_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4)


@pytest.fixture(scope="module")
def client():
    try:
        GhdlTool()
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def counter_cycles(client):
    """Reference cycles from the unchanged REST path, for value comparison."""
    response = client.post(
        "/api/simulate", json={"vhdl": COUNTER, "duration": 10000, "maxCycles": 500}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    return body["waveforms"]["cycles"]


class WsHelper:
    """Small driver for the /ws protocol with timeouts on every receive."""

    def __init__(self, ws):
        self.ws = ws
        hello = self.recv()
        assert hello["type"] == "hello", hello

    def send(self, payload: dict) -> None:
        self.ws.send_text(json.dumps(payload))

    def send_raw(self, text: str) -> None:
        self.ws.send_text(text)

    def recv(self, timeout: float = 60.0) -> dict:
        future = _RECV_POOL.submit(self.ws.receive_json)
        try:
            return future.result(timeout=timeout)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise AssertionError(f"no websocket message within {timeout}s")

    def expect(self, mtype: str, timeout: float = 60.0) -> dict:
        message = self.recv(timeout)
        assert message["type"] == mtype, f"expected {mtype!r}, got {message!r}"
        return message

    def until_pong(self, timeout: float = 60.0) -> list:
        """Send ping and return every message that arrives before the pong.

        The server processes client messages in order, so this snapshots
        exactly what was emitted while the surrounding control message was
        being handled (plus anything already buffered on the socket).
        """
        self.send({"type": "ping"})
        seen = []
        while True:
            message = self.recv(timeout)
            if message["type"] == "pong":
                return seen
            seen.append(message)

    def quiesce(self, allowed=("cycle_batch",), max_rounds: int = 8) -> list:
        """Ping-barrier until the socket goes quiet; returns drained frames."""
        drained: list = []
        for _ in range(max_rounds):
            trailing = self.until_pong()
            for message in trailing:
                assert message["type"] in allowed, message
            drained.extend(trailing)
            if not trailing:
                return drained
        pytest.fail("socket did not go quiet")

    def collect_stream(self, timeout: float = 120.0):
        """Collect cycle batches until sim_done; returns (batches, done)."""
        batches = []
        while True:
            message = self.recv(timeout)
            if message["type"] == "cycle_batch":
                batches.append(message)
            elif message["type"] == "sim_done":
                return batches, message
            elif message["type"] in ("sim_paused", "sim_resumed", "sim_reset", "sim_stopped"):
                continue
            else:
                pytest.fail(f"unexpected message during stream: {message!r}")


def start_counter(ws: WsHelper, *, speed=SLOW_SPEED, max_cycles=500, duration=10000):
    payload = {
        "type": "sim_start",
        "vhdl": COUNTER,
        "duration": duration,
        "maxCycles": max_cycles,
    }
    if speed is not None:
        payload["speed"] = speed
    ws.send(payload)
    ready = ws.expect("sim_ready")
    first = ws.expect("cycle_batch")
    return ready, first


def batch_cycles(batches):
    return [cycle for batch in batches for cycle in batch["cycles"]]


# ---------------------------------------------------------------------------
# sim_start streaming
# ---------------------------------------------------------------------------


def test_sim_start_streams_ready_batches_done(client):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ws.send({"type": "sim_start", "vhdl": COUNTER, "duration": 200, "maxCycles": 64})
        ready = ws.expect("sim_ready")
        assert ready["totalCycles"] > 0
        assert ready["clockNs"] == 10.0
        assert ready["entity"]["name"] == "counter"
        assert isinstance(ready["board"], dict) and ready["board"]

        by_name = {signal["name"]: signal for signal in ready["signals"]}
        assert by_name["clk"]["direction"] == "in"
        assert by_name["led"]["direction"] == "out"
        assert by_name["led"]["width"] == 8
        for signal in ready["signals"]:
            assert {"name", "width", "direction"} <= set(signal)

        batches, done = ws.collect_stream()
        assert done["totalCycles"] == ready["totalCycles"]
        assert done["final"]["led"] == done["final"]["count"]

        cycles = batch_cycles(batches)
        assert len(cycles) == ready["totalCycles"]
        assert [cycle["cycle"] for cycle in cycles] == list(range(ready["totalCycles"]))
        assert batches[-1]["cursor"] == ready["totalCycles"]
        assert all(batch["playing"] is True for batch in batches)

        for batch in batches:
            assert 1 <= len(batch["cycles"]) <= 32
            stats = batch["stats"]
            assert stats["targetSpeed"] == 50_000_000
            assert stats["cyclesPerSecond"] >= 0
            assert isinstance(stats["realSpeed"], (int, float))
            assert stats["engineLoad"] is None
        for cycle in cycles:
            assert set(cycle) == {"cycle", "time", "values"}
            assert "led" in cycle["values"]


def test_ws_simulate_batch_mode_still_works(client):
    """The pre-existing "simulate" WS message keeps its behaviour."""
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ws.send({"type": "simulate", "vhdl": COUNTER, "duration": 100})
        while True:
            message = ws.recv()
            if message["type"] == "simulation_complete":
                break
        assert message["ok"] is True
        assert message["waveforms"]["final"]["led"] == message["waveforms"]["final"]["count"]


# ---------------------------------------------------------------------------
# pause / resume / step
# ---------------------------------------------------------------------------


def test_pause_resume_and_step(client, counter_cycles):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        # stepping while still compiling is rejected before anything streams
        ws.send(
            {
                "type": "sim_start",
                "vhdl": COUNTER,
                "duration": 10000,
                "maxCycles": 500,
                "speed": SLOW_SPEED,
            }
        )
        ws.send({"type": "sim_step", "cycles": 1})
        assert "paused" in ws.expect("sim_error")["message"]

        ready = ws.expect("sim_ready")
        first = ws.expect("cycle_batch")
        total = ready["totalCycles"]

        # pause right after the first batch: whatever the server streamed in
        # between arrives before the acknowledgement (FIFO per connection).
        ws.send({"type": "sim_pause"})
        pre = []
        while True:
            message = ws.recv()
            if message["type"] == "sim_paused":
                break
            assert message["type"] == "cycle_batch", message
            pre.append(message)
        drained = ws.quiesce()
        batches = [first] + pre + drained
        assert all(batch["playing"] is True for batch in batches)
        cursor = batches[-1]["cursor"]
        assert cursor == sum(len(batch["cycles"]) for batch in batches)
        assert 0 < cursor < total  # paused mid-stream, not at the end

        # invalid step sizes
        ws.send({"type": "sim_step", "cycles": 0})
        assert ">= 1" in ws.expect("sim_error")["message"]
        ws.send({"type": "sim_step", "cycles": "lots"})
        assert "integer" in ws.expect("sim_error")["message"]

        # a paused step advances by exactly N cycles, immediately
        ws.send({"type": "sim_step", "cycles": 3})
        stepped = ws.expect("cycle_batch")
        assert stepped["playing"] is False
        assert [cycle["cycle"] for cycle in stepped["cycles"]] == [
            cursor,
            cursor + 1,
            cursor + 2,
        ]
        assert stepped["cursor"] == cursor + 3
        for offset, cycle in enumerate(stepped["cycles"]):
            assert cycle == counter_cycles[cursor + offset]

        # resume continues the stream from the stepped position
        ws.send({"type": "sim_resume"})
        resumed = ws.expect("sim_resumed")
        assert resumed["playing"] is True
        assert resumed["cursor"] == cursor + 3

        tail, done = ws.collect_stream()
        assert done["totalCycles"] == total
        stream = batch_cycles(batches) + batch_cycles(tail)
        indices = [cycle["cycle"] for cycle in stream]
        # every cycle except the three delivered by the step arrives once
        assert indices == [i for i in range(total) if i not in (cursor, cursor + 1, cursor + 2)]


# ---------------------------------------------------------------------------
# stop
# ---------------------------------------------------------------------------


def test_stop_ends_session_and_allows_restart(client):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ready, first = start_counter(ws)
        total = ready["totalCycles"]

        ws.send({"type": "sim_stop"})
        pre = []
        while True:
            message = ws.recv()
            if message["type"] == "sim_stopped":
                stopped = message
                break
            assert message["type"] == "cycle_batch", message
            pre.append(message)
        batches = [first] + pre
        assert stopped["totalCycles"] == total
        cursor = batches[-1]["cursor"]
        assert stopped["cursor"] == cursor
        assert cursor < total  # stopped mid-stream

        # the stream goes quiet: each barrier round drains at most the
        # in-flight batch, then a round comes back empty.
        drained = ws.quiesce()
        assert all(message["type"] == "cycle_batch" for message in drained)

        # a brand-new session on the same connection starts from scratch
        ws.send({"type": "sim_start", "vhdl": COUNTER, "duration": 200, "maxCycles": 64})
        ready2 = ws.expect("sim_ready")
        assert ready2["totalCycles"] != total
        batches, done = ws.collect_stream()
        assert done["totalCycles"] == ready2["totalCycles"]
        assert [cycle["cycle"] for cycle in batch_cycles(batches)] == list(
            range(ready2["totalCycles"])
        )
        assert batches[0]["cycles"][0]["cycle"] == 0


# ---------------------------------------------------------------------------
# reset
# ---------------------------------------------------------------------------


def test_reset_while_paused_returns_to_cycle_zero(client, counter_cycles):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ready, first = start_counter(ws)
        total = ready["totalCycles"]

        ws.send({"type": "sim_pause"})
        pre = []
        while True:
            message = ws.recv()
            if message["type"] == "sim_paused":
                break
            assert message["type"] == "cycle_batch", message
            pre.append(message)
        ws.quiesce()
        batches = [first] + pre
        paused_cursor = batches[-1]["cursor"]
        assert 0 < paused_cursor < total

        ws.send({"type": "sim_step", "cycles": 2})
        stepped = ws.expect("cycle_batch")
        assert stepped["cursor"] == paused_cursor + 2

        ws.send({"type": "sim_reset"})
        reset = ws.expect("sim_reset")
        assert reset["cursor"] == 0
        assert reset["playing"] is False
        # paused reset emits nothing else: the next step restarts at cycle 0
        ws.send({"type": "sim_step", "cycles": 1})
        batch = ws.expect("cycle_batch")
        assert [cycle["cycle"] for cycle in batch["cycles"]] == [0]
        assert batch["cursor"] == 1
        assert batch["cycles"][0] == counter_cycles[0]

        # and stepping on continues from the reset position
        ws.send({"type": "sim_step", "cycles": 1})
        batch = ws.expect("cycle_batch")
        assert [cycle["cycle"] for cycle in batch["cycles"]] == [1]
        assert batch["cycles"][0] == counter_cycles[1]


def test_reset_while_running_replays_from_start(client):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ready, _ = start_counter(ws, max_cycles=200, duration=4000)
        total = ready["totalCycles"]

        ws.send({"type": "sim_reset"})
        pre = []
        while True:
            message = ws.recv()
            if message["type"] == "sim_reset":
                reset = message
                break
            assert message["type"] == "cycle_batch", message
            pre.append(message)
        assert reset["cursor"] == 0
        assert reset["playing"] is True

        batches, done = ws.collect_stream()
        assert done["totalCycles"] == total
        # Post-reset traffic is the fresh replay from cycle 0, plus at most
        # one in-flight batch ([0..31]) from the pre-reset generation.
        indices = [cycle["cycle"] for cycle in batch_cycles(batches)]
        assert set(indices) == set(range(total))
        assert indices.count(0) in (1, 2)
        assert len(indices) in (total, total + 32)
        assert indices[-1] == total - 1


# ---------------------------------------------------------------------------
# session lifecycle / isolation
# ---------------------------------------------------------------------------


def test_sequential_sessions_do_not_share_state(client):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ws.send({"type": "sim_start", "vhdl": COUNTER, "duration": 200, "maxCycles": 64})
        ready1 = ws.expect("sim_ready")
        batches1, done1 = ws.collect_stream()
        assert done1["totalCycles"] == ready1["totalCycles"]
        assert batches1[-1]["cursor"] == ready1["totalCycles"]

        ws.send({"type": "sim_start", "vhdl": COUNTER, "duration": 1000, "maxCycles": 128})
        # the finished first session announces its replacement
        while True:
            message = ws.recv()
            if message["type"] == "sim_ready":
                ready2 = message
                break
            assert message["type"] == "sim_stopped", message
        batches2, done2 = ws.collect_stream()

        assert ready2["totalCycles"] != ready1["totalCycles"]
        assert done2["totalCycles"] == ready2["totalCycles"]
        # the second session replays its own waveform from cycle 0
        assert batches2[0]["cycles"][0]["cycle"] == 0
        assert [cycle["cycle"] for cycle in batch_cycles(batches2)] == list(
            range(ready2["totalCycles"])
        )
        # identical designs replay identical values at the same cycle
        assert batch_cycles(batches2)[0]["values"] == batch_cycles(batches1)[0]["values"]


def test_new_session_replaces_paused_session(client):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ready_a, first = start_counter(ws)
        ws.send({"type": "sim_pause"})
        pre = []
        while True:
            message = ws.recv()
            if message["type"] == "sim_paused":
                break
            assert message["type"] == "cycle_batch", message
            pre.append(message)
        ws.quiesce()
        paused_cursor = ([first] + pre)[-1]["cursor"]

        ws.send({"type": "sim_start", "vhdl": COUNTER, "duration": 200, "maxCycles": 64})
        stopped = ws.expect("sim_stopped")  # session A was stopped by the replacement
        assert stopped["cursor"] == paused_cursor
        ready_b = ws.expect("sim_ready")
        assert ready_b["totalCycles"] != ready_a["totalCycles"]

        batches, done = ws.collect_stream()
        assert done["totalCycles"] == ready_b["totalCycles"]
        assert [cycle["cycle"] for cycle in batch_cycles(batches)] == list(
            range(ready_b["totalCycles"])
        )


# ---------------------------------------------------------------------------
# same-object replacement: stale runs must never stream (audit N1)
# ---------------------------------------------------------------------------


def test_replaced_run_never_streams_stale_results():
    """A replaced run whose worker outlives stop()'s join timeout must emit
    nothing: no stale sim_ready, batches or sim_done (audit N1).

    The first simulate() blocks on a threading.Event (deterministic — no
    sleeps), the same session object is started again while it is still
    "simulating", then the first worker is released.  Before the per-run
    generation guards, the stale worker posted its result, the never-cancelled
    pump applied it (the only guard was state == "stopped") and the client saw
    a second sim_ready/batch/sim_done sequence for the dead run.
    """
    import asyncio

    from backend.session import SimSession

    entered = threading.Event()   # worker 1 entered simulate()
    release = threading.Event()   # test lets worker 1 finish
    left = threading.Event()      # worker 1 returned from simulate()

    class BlockingSimulator:
        def simulate(self, request):
            if request.vhdl == "slow":
                entered.set()
                release.wait(10.0)
                left.set()
                return {
                    "ok": True,
                    "entity": {"name": "slow"},
                    "board": {},
                    "waveforms": {
                        "cycles": [{"cycle": 0, "time": 0.0, "values": {"q": 99}}],
                        "signals": [{"name": "q", "width": 8, "direction": "out"}],
                        "final": {"q": 99},
                    },
                }
            return {
                "ok": True,
                "entity": {"name": "fast"},
                "board": {},
                "waveforms": {
                    "cycles": [
                        {"cycle": 0, "time": 0.0, "values": {"q": 1}},
                        {"cycle": 1, "time": 10.0, "values": {"q": 2}},
                    ],
                    "signals": [{"name": "q", "width": 8, "direction": "out"}],
                    "final": {"q": 2},
                },
            }

    messages: list = []

    async def scenario():
        session = SimSession(BlockingSimulator(), join_timeout=0.5)
        done = asyncio.Event()

        async def emit(message):
            messages.append(message)
            if message.get("type") == "sim_done":
                done.set()

        assert await session.start({"vhdl": "slow", "clockPeriod": 10}, emit)
        stale_worker = session._thread
        # Worker 1 is now blocked inside simulate(): replace the run.
        assert await asyncio.to_thread(entered.wait, 10.0)
        assert await session.start({"vhdl": "fast", "clockPeriod": 10}, emit)

        # Run 2 streams to completion through run 2's own pump task.
        await asyncio.wait_for(done.wait(), 10.0)

        # Release the stale worker and prove it delivers nothing.  The loop
        # barrier (call_soon_threadsafe sentinel + yields) guarantees every
        # callback the stale worker could have scheduled has run — this is an
        # ordering guarantee, not a timing guess.
        release.set()
        await asyncio.to_thread(left.wait, 10.0)
        await asyncio.to_thread(stale_worker.join, 10.0)
        loop = asyncio.get_running_loop()
        for _ in range(3):
            barrier = asyncio.Event()
            loop.call_soon_threadsafe(barrier.set)
            await barrier.wait()
            await asyncio.sleep(0)
            await asyncio.sleep(0)

        await session.stop()

        # Exactly the replacement's stream, prefixed by the replacement's
        # sim_stopped acknowledgement — never the dead run's results.
        assert [m["type"] for m in messages] == [
            "sim_stopped", "sim_ready", "cycle_batch", "sim_done"
        ], messages
        ready = messages[1]
        assert ready["entity"]["name"] == "fast"
        assert ready["totalCycles"] == 2
        assert [c["cycle"] for c in messages[2]["cycles"]] == [0, 1]

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# errors
# ---------------------------------------------------------------------------


def test_sim_error_on_bad_vhdl_then_recovery(client):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ws.send({"type": "sim_start", "vhdl": BAD_VHDL})
        error = ws.expect("sim_error")
        assert error["message"]
        assert isinstance(error["errors"], list) and error["errors"]

        # the connection recovers: a valid session still runs afterwards
        ws.send(
            {
                "type": "sim_start",
                "vhdl": COUNTER,
                "duration": 10000,
                "maxCycles": 500,
                "speed": SLOW_SPEED,
            }
        )
        ready = ws.expect("sim_ready")
        assert ready["totalCycles"] > 0
        ws.expect("cycle_batch")
        ws.send({"type": "sim_stop"})
        ws.expect("sim_stopped")


def test_invalid_speed_is_rejected_without_starting(client):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ws.send({"type": "sim_start", "vhdl": COUNTER, "speed": -1})
        assert "speed" in ws.expect("sim_error")["message"]
        ws.send({"type": "sim_start", "vhdl": COUNTER, "speed": "fast"})
        assert "speed" in ws.expect("sim_error")["message"]
        # still idle: control messages report that no session is active
        ws.send({"type": "sim_pause"})
        assert "sim_start" in ws.expect("sim_error")["message"]


def test_malformed_and_unknown_messages(client):
    with client.websocket_connect("/ws") as raw:
        ws = WsHelper(raw)
        ws.send_raw("this is not json")
        assert ws.expect("error")["message"] == "Invalid JSON"

        ws.send_raw("[1, 2, 3]")
        assert "JSON object" in ws.expect("error")["message"]

        ws.send({"type": "bogus"})
        assert "Unknown message type" in ws.expect("error")["message"]

        ws.send({"type": "sim_step", "cycles": 2})
        assert "sim_start" in ws.expect("sim_error")["message"]

        ws.send({"type": "ping"})
        ws.expect("pong")


# ---------------------------------------------------------------------------
# static frontend serving resilience
# ---------------------------------------------------------------------------


def test_index_and_static_serving(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "<html" in response.text.lower()

    # assets resolve in whatever layout is present (here: the flat one)
    assert client.get("/static/styles.css").status_code == 200

    # missing assets 404 instead of crashing
    assert client.get("/static/definitely-missing.js").status_code == 404
    assert client.get("/definitely-missing.js").status_code == 404

    # path traversal is rejected
    assert client.get("/static/../backend/server.py").status_code == 404
    assert client.get("/..%2f..%2fbackend%2fserver.py").status_code in (404, 400)


def test_frontend_layout_priority(tmp_path, monkeypatch):
    """GET / and /static resolve dist > legacy > flat, whichever exists."""
    import backend.server as server_mod

    # state 3: flat layout only
    (tmp_path / "index.html").write_text("<html>flat</html>", encoding="utf-8")
    (tmp_path / "app.js").write_text("// flat js", encoding="utf-8")
    monkeypatch.setattr(server_mod, "FRONTEND_DIR", tmp_path)
    test_client = TestClient(server_mod.app)

    assert "flat" in test_client.get("/").text
    assert "flat js" in test_client.get("/static/app.js").text

    # state 2: old files moved to legacy/
    (tmp_path / "legacy").mkdir()
    (tmp_path / "legacy" / "index.html").write_text("<html>legacy</html>", encoding="utf-8")
    (tmp_path / "legacy" / "app.js").write_text("// legacy js", encoding="utf-8")
    assert "legacy" in test_client.get("/").text
    assert "legacy js" in test_client.get("/static/app.js").text
    assert "legacy js" in test_client.get("/app.js").text

    # state 1: built Vite app
    (tmp_path / "dist").mkdir()
    (tmp_path / "dist" / "index.html").write_text("<html>dist</html>", encoding="utf-8")
    (tmp_path / "dist" / "assets").mkdir()
    (tmp_path / "dist" / "assets" / "main.js").write_text("// dist js", encoding="utf-8")
    assert "dist" in test_client.get("/").text
    assert "dist js" in test_client.get("/assets/main.js").text
    # legacy assets remain reachable through /static
    assert "legacy js" in test_client.get("/static/app.js").text


def test_rest_endpoints_unchanged(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["ok"] is True

    examples = client.get("/api/examples")
    assert examples.status_code == 200
    assert any(item["id"] == "counter" for item in examples.json()["examples"])

    unknown = client.get("/api/examples/does-not-exist")
    assert unknown.status_code == 404
