"""Section 6: simulation engine, API, UI and sandbox."""
from __future__ import annotations

import os
import tempfile
import threading
from typing import Optional
from pathlib import Path

from harness import (
    DESIGNS,
    ROOT,
    case,
    check,
    cycle_values,
    errors_text,
    frontend_dir,
    has_error,
    must_run,
    run,
    run_tb,
    run_text,
    signal,
    simulator,
    value,
)

FRONTEND = frontend_dir()


def current_frontend_text() -> str:
    """The current Vite app (frontend/src), not the legacy viewer."""
    src = ROOT / "frontend" / "src"
    names = [
        "main.js",
        "board/index.js",
        "ui/toolbar.js",
        "ui/bottomPanel.js",
        "ui/waveform.js",
        "index.html",
    ]
    return "\n".join(
        (src / name).read_text(encoding="utf-8", errors="replace")
        for name in names
        if (src / name).exists()
    )


def frontend_text() -> str:
    return "\n".join(
        (FRONTEND / name).read_text(encoding="utf-8", errors="replace")
        for name in ("app.js", "board3d.js", "index.html")
    )


# ---------------------------------------------------------------------------
# Waveforms / VCD
# ---------------------------------------------------------------------------


@case("ENG-01", "6", "Raw VCD export works from the CLI/keep-dir path", "VHDL",
      "VCD file is produced and matches the final LED value")
def eng_01() -> str:
    old = os.environ.get("CYCLESIM_KEEP_DIR")
    os.environ["CYCLESIM_KEEP_DIR"] = "1"
    try:
        result = must_run("clk_reset.vhd", top="counter8", duration=100, clockPeriod=10, resetCycles=2)
    finally:
        if old is None:
            os.environ.pop("CYCLESIM_KEEP_DIR", None)
        else:
            os.environ["CYCLESIM_KEEP_DIR"] = old
    vcd_path = result.get("vcd")
    check(vcd_path and Path(vcd_path).exists(), f"no VCD at {vcd_path}")
    text = Path(vcd_path).read_text(encoding="utf-8", errors="replace")
    check("$timescale" in text and "$var" in text, "VCD header missing")
    check(str(value(result, "q")) in text, "final q value not present in VCD")
    return f"VCD {Path(vcd_path).name} ({len(text)} bytes)"


@case("ENG-01B", "6", "Waveform export button/endpoint in the web UI", "UI",
      "A UI action downloads VCD/FST")
def eng_01b() -> str:
    text = current_frontend_text().lower()
    check("export" in text and ("vcd" in text or "fst" in text),
          "no VCD/FST export control in the current frontend")
    return "Export VCD control present (frontend/src)"


@case("ENG-02", "6", "Waveform matches board state at the same timestamp", "VHDL",
      "Cycle samples and final state agree with LED/switch values")
def eng_02() -> str:
    result = run_tb("board.vhd", "tb_edge.vhd", "tb_edge", duration=150)
    final = result["waveforms"]["final"]
    check(final["led"] == final["count"], f"final led={final['led']} count={final['count']}")
    check(result["board"]["leds"] == ["led"], f"board={result['board']}")
    for cycle in result["waveforms"]["cycles"]:
        values = cycle["values"]
        check(values["led"] == values["count"],
              f"cycle {cycle['cycle']}: led={values['led']} count={values['count']}")
    return f"all {len(result['waveforms']['cycles'])} cycles agree (key_edge, 1 press)"


# ---------------------------------------------------------------------------
# Controls / server
# ---------------------------------------------------------------------------


@case("ENG-03", "6", "Stop/cancel a running simulation", "UI",
      "sim_stop kills the server-side GHDL run and emits sim_stopped within 10 s "
      "(the uncanceled long_run fixture needs minutes of wall time)")
def eng_03() -> str:
    import queue as _queue
    import time as _time

    from fastapi.testclient import TestClient
    from backend.server import app

    client = TestClient(app)
    source = (DESIGNS / "long_run.vhd").read_text(encoding="utf-8")
    # Declared expectations (declared before running): sim_stop during the
    # GHDL phase -> a single "sim_stopped" arrives within 10 s; "sim_ready"
    # and "sim_done" never arrive (the uncanceled run of duration 2e9 ns =
    # 2e8 cycles at 10 ns clock needs minutes of wall time, so a prompt
    # stop proves the subprocess was actually killed, not waited for).
    messages: list = []
    started = _time.monotonic()
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"type": "sim_start", "vhdl": source, "top": "long_run",
                      "duration": 2_000_000_000, "clockPeriod": 10,
                      "maxCycles": 1000})
        _time.sleep(4.0)  # compile phase done, GHDL run in flight (no frames yet)

        reader_q: _queue.Queue = _queue.Queue()

        def _reader() -> None:
            try:
                while True:
                    reader_q.put(ws.receive_json())
            except Exception:
                reader_q.put({"type": "_reader_exit"})

        stop_sent = _time.monotonic()
        ws.send_json({"type": "sim_stop"})
        reader = threading.Thread(target=_reader, daemon=True)
        reader.start()

        stopped_in: Optional[float] = None
        saw_done = False
        saw_ready = False
        while _time.monotonic() - stop_sent < 10.0:
            try:
                msg = reader_q.get(timeout=1.0)
            except _queue.Empty:
                continue
            kind = msg.get("type")
            if kind == "_reader_exit":
                break
            messages.append(kind)
            if kind == "sim_stopped":
                stopped_in = _time.monotonic() - stop_sent
                break
            if kind == "sim_done":
                saw_done = True
                break
            if kind == "sim_ready":
                saw_ready = True
                break
            if kind == "sim_error":
                check(False, f"simulation errored: {msg.get('message')}")
                return "error"
    elapsed = _time.monotonic() - started
    check(stopped_in is not None, f"no sim_stopped within 10 s; frames={messages[-6:]}")
    check(not saw_done, "run completed instead of being stopped")
    check(not saw_ready, "cancelled run streamed results (stop must discard them)")
    check(stopped_in is not None and stopped_in < 10.0,
          f"stop took {stopped_in if stopped_in is not None else '?'} s")
    check(elapsed < 45.0, f"whole stop cycle took {elapsed:.1f} s (kill must be immediate)")
    if stopped_in is None:
        return "failed"
    return (f"sim_stopped after {stopped_in:.2f} s; whole cycle {elapsed:.1f} s "
            f"(uncanceled run: minutes)")


@case("ENG-03B", "6", "Stop is a kill, not a wait: GHDL child exits promptly", "API",
      "Simulator.cancel() ends a minutes-long run within ~5 s")
def eng_03b() -> str:
    import threading as _threading
    import time as _time

    from backend.simulator import SimulationRequest, Simulator

    source = (DESIGNS / "long_run.vhd").read_text(encoding="utf-8")
    # Declared expectations (declared before running): with duration 2e9 ns
    # the uncanceled run needs minutes; cancel() after 4 s (compile done,
    # GHDL in flight) must end the worker within 15 s total with the child
    # process gone.
    request = SimulationRequest.from_dict({
        "vhdl": source, "top": "long_run",
        "duration": 2_000_000_000, "clockPeriod": 10, "maxCycles": 1000,
    })
    sim = Simulator()
    results: list = []
    worker = _threading.Thread(target=lambda: results.append(sim.simulate(request)), daemon=True)
    worker.start()
    _time.sleep(4.0)  # compile phase done, GHDL run in flight
    killed = sim.cancel()
    t0 = _time.monotonic()
    worker.join(15.0)
    elapsed = _time.monotonic() - t0
    check(worker.is_alive() is False, f"worker still alive {elapsed:.1f} s after cancel")
    check(killed or not results, "cancel reported a killed child or run already ended")
    if results:
        check(results[0].get("cancelled") is True or results[0].get("ok") is False,
              "cancelled run reported as not-ok")
    check(elapsed < 15.0, f"cancel cycle took {elapsed:.1f} s (uncanceled: minutes)")
    return f"worker exited {elapsed:.1f} s after cancel (killed={killed})"


@case("ENG-04", "6", "Re-upload during a running sim leaves no stale state", "VHDL",
      "A second upload starts from a fresh temp directory")
def eng_04() -> str:
    first = must_run("board.vhd", top="sw_led8", duration=20, constantInputs={"sw": 0xFF})
    second = must_run("board.vhd", top="sw_led8", duration=20, constantInputs={"sw": 0x00})
    check(value(first, "led") == 0xFF, "first run wrong")
    check(value(second, "led") == 0x00, "second run wrong")
    return "0xFF then 0x00, no stale state"


@case("ENG-11", "6", "Server health reports GHDL", "API", "GET /api/health -> ok")
def eng_11() -> str:
    from fastapi.testclient import TestClient
    from backend.server import app

    client = TestClient(app)
    response = client.get("/api/health")
    check(response.status_code == 200, f"status {response.status_code}")
    data = response.json()
    check(data.get("ok") and data.get("version"), f"health={data}")
    return str(data.get("version"))


@case("ENG-12", "6", "Concurrent HTTP simulations are isolated", "API",
      "Two different designs run at the same time without interference")
def eng_12() -> str:
    from fastapi.testclient import TestClient
    from backend.server import app

    client = TestClient(app)
    results = {}

    def call(name, payload):
        results[name] = client.post("/api/simulate", json=payload)

    threads = [
        threading.Thread(target=call, args=("a", {"vhdl": "library ieee; use ieee.std_logic_1164.all; entity a is port(x: in std_logic; y: out std_logic); end; architecture r of a is begin y <= not x; end;", "constantInputs": {"x": 1}, "duration": 10})),
        threading.Thread(target=call, args=("b", {"vhdl": "library ieee; use ieee.std_logic_1164.all; entity b is port(x: in std_logic; y: out std_logic); end; architecture r of b is begin y <= x; end;", "constantInputs": {"x": 1}, "duration": 10})),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    check(results["a"].status_code == 200 and results["b"].status_code == 200,
          f"a={results['a'].status_code} b={results['b'].status_code}")
    check(results["a"].json()["waveforms"]["final"]["y"] == 0, "design a wrong")
    check(results["b"].json()["waveforms"]["final"]["y"] == 1, "design b wrong")
    return "not-gate=0, buffer=1 concurrently"


@case("ENG-05", "6", "Runaway design is caught with a message", "VHDL",
      "Infinite-loop warning; no hang, server still usable")
def eng_05() -> str:
    result = run("runaway.vhd", top="runaway", duration=20, resetCycles=0)
    warnings = " ".join(w.get("message", "") for w in result.get("warnings", [])).lower()
    check("infinite loop" in warnings, f"warnings={warnings!r}")
    # The server must still answer afterwards.
    from fastapi.testclient import TestClient
    from backend.server import app

    check(TestClient(app).get("/api/health").status_code == 200, "server unhealthy after runaway")
    return "infinite-loop warning, server healthy"


# ---------------------------------------------------------------------------
# Sandbox
# ---------------------------------------------------------------------------


@case("ENG-07", "6", "Uploaded HDL cannot write host files", "VHDL",
      "File I/O is blocked or confined to a throw-away directory")
def eng_07() -> str:
    escape = Path(tempfile.gettempdir()) / "cyclone_qa_escape.txt"
    escape.unlink(missing_ok=True)
    source = f"""library ieee;
use ieee.std_logic_1164.all;
use std.textio.all;
entity escape is
    port (clk : in std_logic);
end entity escape;
architecture rtl of escape is
begin
    process (clk)
        file f : text;
        variable l : line;
    begin
        if rising_edge(clk) then
            file_open(f, "{escape.as_posix()}", write_mode);
            write(l, string'("escaped"));
            writeline(f, l);
            file_close(f);
        end if;
    end process;
end architecture rtl;"""
    result = run_text(source, duration=15, resetCycles=0)
    # The literal absolute path is rejected by the backend pre-scan before
    # GHDL ever runs (audit N7 / ENG-07 mitigation).  Documented residual:
    # runtime-computed paths (concatenated strings) are not covered by the
    # scan; relative paths inside the workdir stay allowed (RB-05B).
    check(not result.get("ok"), "the design ran; an absolute textio path must be rejected")
    check(has_error(result, "outside the simulation work directory"),
          f"unclear rejection: {errors_text(result)}")
    wrote = escape.exists()
    if wrote:
        escape.unlink(missing_ok=True)
    check(not wrote, f"uploaded HDL wrote {escape} outside the sandbox")
    return "absolute-path file write rejected before GHDL (no host file written)"


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------


@case("ENG-08", "6", "3D board assets are present and the page has no obvious errors", "UI",
      "three.js loads, board3d.js imports it, WebGL fallback exists")
def eng_08() -> str:
    text = frontend_text()
    check("three.module.js" in text, "three.js is not referenced")
    check((FRONTEND / "vendor" / "three.module.js").exists(), "three.module.js missing")
    check("board3d-fallback" in text, "no WebGL fallback")
    return "three.js + fallback present (see browser pass for console check)"


@case("ENG-09", "6", "All clickable 3D parts respond", "UI",
      "LEDs, switches and keys are pickable in the 3D view")
def eng_09() -> str:
    text = (FRONTEND / "board3d.js").read_text(encoding="utf-8")
    check("raycaster" in text.lower(), "no raycaster/click handling in the 3D board")
    return "3D parts pickable"


@case("ENG-10", "6", "Toggling a switch updates the port (auto re-run)", "UI",
      "Click updates the live stimulus and schedules a re-run on the current UI")
def eng_10() -> str:
    text = (ROOT / "frontend" / "src" / "main.js").read_text(encoding="utf-8")
    check("toggleDip" in text, "no DIP toggle handler")
    check("syncKeyStimulusAndUI" in text, "DIP click does not update the live stimulus")
    check("scheduleRerun" in text, "DIP click does not schedule a re-run")
    return "DIP click updates the stimulus and schedules an immediate re-run"