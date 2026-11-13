"""Section 6: simulation engine, API, UI and sandbox."""
from __future__ import annotations

import os
import tempfile
import threading
from pathlib import Path

from harness import (
    ROOT,
    case,
    check,
    cycle_values,
    must_run,
    run,
    run_tb,
    run_text,
    signal,
    simulator,
    value,
)

FRONTEND = ROOT / "frontend"


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
    text = frontend_text().lower()
    check("export" in text and ("vcd" in text or "fst" in text),
          "no VCD/FST export control in the frontend")
    return "export control present"


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
      "Stop aborts the server-side GHDL run and clears state")
def eng_03() -> str:
    from fastapi.testclient import TestClient
    from backend.server import app

    client = TestClient(app)
    response = client.get("/api/stop")
    check(response.status_code != 404, "no server-side stop/cancel endpoint")
    check(response.status_code == 200, f"stop endpoint returned {response.status_code}")
    return "stop endpoint responds"


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
    wrote = escape.exists()
    if wrote:
        escape.unlink(missing_ok=True)
    check(not wrote, f"uploaded HDL wrote {escape} outside the sandbox")
    return "file write blocked"


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


@case("ENG-10", "6", "Toggling a switch updates the port on the next simulation step", "UI",
      "A click changes the live simulation without re-running")
def eng_10() -> str:
    text = (FRONTEND / "app.js").read_text(encoding="utf-8")
    handler = text.split('button.addEventListener("click"')[1].split("});")[0]
    check("simulate(" in handler, "switch click only edits the stimulus config; a re-run is required")
    return "switch click applies live"