"""Section 28: robustness — malformed input, oversized payloads, WS abuse,
the scaled runaway timeout, and the honest sandbox statement.
"""
from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

from harness import ROOT, case, check, errors_text, has_error, run_text, simulator, value

GOOD_DESIGN = """
library ieee;
use ieee.std_logic_1164.all;
entity rf_ok is
    port (a : in std_logic; y : out std_logic);
end entity;
architecture rtl of rf_ok is
begin
    y <= not a;
end architecture;
"""


@case("RF-01", "28", "Malformed VHDL is rejected with a clear error, never a crash", "VHDL",
      "truncated/garbled VHDL -> ok=False with a diagnostic; the server stays usable")
def rf_01() -> str:
    for bad in ("entity broken is port (", "architecture of ;", "library ieee; use;",
                "entity e is end entity e architecture", "process begin end;"):
        result = run_text(bad, duration=10)
        check(result.get("ok") is False, f"garbage accepted: {bad!r}")
        check(result.get("errors"), f"no error reported for {bad!r}")
    # the backend still works afterwards
    ok = run_text(GOOD_DESIGN, top="rf_ok", duration=10, resetCycles=0, constantInputs={"a": 0})
    check(ok.get("ok"), f"backend unhealthy after malformed input: {errors_text(ok)}")
    return "5 malformed sources rejected with diagnostics; backend still healthy"


@case("RF-02", "28", "Random binary garbage is handled without a crash", "fuzz",
      "300 random byte strings through simulate/compile: no exception, no hang")
def rf_02() -> str:
    import random
    rng = random.Random(2026)
    for _ in range(300):
        size = rng.randrange(0, 600)
        blob = bytes(rng.randrange(256) for _ in range(size))
        text = blob.decode("latin-1", errors="replace")
        try:
            result = simulator().compile_source(text)
            check(isinstance(result, dict) and "ok" in result, "compile_source returned junk")
        except Exception as exc:  # noqa: BLE001 - the point is "never crash"
            check(False, f"compile_source raised {type(exc).__name__}: {exc}")
    return "300 random garbage inputs handled without an exception"


@case("RF-03", "28", "An oversized upload is handled in bounded time and memory", "VHDL",
      "a 2 MB design (valid but huge) compiles without unbounded memory or a hang")
def rf_03() -> str:
    filler = "\n".join(f"-- padding line {i} to inflate the upload size" for i in range(40_000))
    big = filler + "\n" + GOOD_DESIGN
    check(len(big) > 1_500_000, f"payload only {len(big)} bytes")
    started = time.time()
    result = simulator().compile_source(big)
    elapsed = time.time() - started
    check(result.get("ok"), f"oversized compile failed: {errors_text(result)}")
    check(elapsed < 60, f"oversized compile took {elapsed:.1f}s")
    return f"{len(big) // 1024} KiB upload compiled in {elapsed:.1f}s"


@case("RF-04", "28", "Empty and whitespace-only inputs give a clear error", "VHDL",
      "empty source -> 'no entity' style error, not a crash or a silent pass")
def rf_04() -> str:
    for empty in ("", "   \n\t  ", "-- only a comment\n"):
        result = run_text(empty, duration=10)
        check(result.get("ok") is False, f"empty input accepted: {empty!r}")
        text = errors_text(result).lower()
        check("entity" in text, f"unclear error for empty input: {text[:120]}")
    return "empty inputs rejected with a clear no-entity error"


@case("RF-05", "28", "WebSocket survives hostile message shapes", "WS",
      "arrays, strings, numbers, deep nesting and huge payloads all get error replies; the socket stays open")
def rf_05() -> str:
    from fastapi.testclient import TestClient
    from backend.server import app
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            check(hello["type"] == "hello", f"hello: {hello}")
            hostile = [
                "[1, 2, 3]",
                '"just a string"',
                "42",
                "null",
                "true",
                json.dumps({"type": ["compile"]}),
                json.dumps({"type": "compile", "vhdl": {"deep": {"nested": [1, 2, {"x": "y"}]}}}),
                json.dumps({"type": "simulate", "duration": "not-a-number", "vhdl": ""}),
                json.dumps({"type": "sim_step", "cycles": "many"}),
                json.dumps({"type": "ping", "extra": "x" * 100_000}),
            ]
            for raw in hostile:
                ws.send_text(raw)
                reply = ws.receive_json()
                check(reply.get("type") in ("error", "pong", "sim_error"),
                      f"hostile message {raw[:40]!r} -> {reply}")
            # the connection is still usable
            ws.send_text(json.dumps({"type": "ping"}))
            check(ws.receive_json().get("type") == "pong", "socket unusable after hostile messages")
    return "10 hostile WS messages answered with errors; connection stayed open"


@case("RF-06", "28", "A runaway design hits the scaled GHDL timeout with a clear message", "VHDL",
      "with GHDL_TIMEOUT=3 the infinite-loop design fails with 'timed out after 3 s' and a runaway hint")
def rf_06() -> str:
    from backend.ghdl_tool import GhdlTool
    from backend.simulator import SimulationRequest, Simulator
    runaway = (ROOT / "tests" / "qa" / "designs" / "runaway.vhd").read_text(encoding="utf-8")
    tool = GhdlTool(timeout=3)
    sim = Simulator(ghdl=tool)
    started = time.time()
    result = sim.simulate(SimulationRequest.from_dict({
        "vhdl": runaway, "top": "runaway", "duration": 20, "resetCycles": 0}))
    elapsed = time.time() - started
    check(result.get("ok") is False, "runaway design reported success")
    text = errors_text(result).lower() + " " + str(result.get("logs", "")).lower()
    check("timed out after 3 s" in text, f"no explicit 3 s timeout message: {text[:200]}")
    check("runaway" in text, f"no runaway hint: {text[:200]}")
    check(elapsed < 30, f"timeout took {elapsed:.1f}s to trigger")
    return f"runaway design stopped by the scaled timeout in {elapsed:.1f}s: {errors_text(result)[:120]}"


@case("RF-07", "28", "Sandbox reality: literal absolute textio paths are rejected; runs stay isolated", "VHDL",
      "the pre-scan rejects the design with a clear error, the host file is never read and no temp dir is left behind")
def rf_07() -> str:
    scratch = Path(tempfile.mkdtemp(prefix="cyclone_qa_rf07_"))
    host_file = scratch / "host_secret.txt"
    host_file.write_text("TOPSECRET\n", encoding="utf-8")
    src = f"""
library ieee;
use ieee.std_logic_1164.all;
use std.textio.all;
entity rf_escape is
    port (RESULT : out std_logic_vector(7 downto 0));
end entity;
architecture sim of rf_escape is
begin
    process
        file f     : text;
        variable l : line;
        variable c : character;
    begin
        file_open(f, "{host_file.as_posix()}", read_mode);
        readline(f, l);
        c := l(1);
        file_close(f);
        if c = 'T' then
            RESULT <= x"AA";   -- the first character proves a real read
        else
            RESULT <= x"00";
        end if;
        wait;
    end process;
end architecture;
"""
    import tempfile as tf
    tmp = Path(tf.gettempdir())

    def sim_dirs() -> set:
        return {p.name for p in tmp.iterdir()
                if p.is_dir() and p.name.startswith("cyclone_sim_")}

    before = sim_dirs()
    result = run_text(src, top="rf_escape", duration=1000, resetCycles=0)
    # Audit N7 / ENG-07 mitigation: the literal absolute path is rejected by
    # the pre-scan before GHDL runs, so the host file is never read.
    # Documented residual: runtime-computed paths are not covered by the
    # scan; per-run isolation still comes from throw-away tempdirs.
    check(not result.get("ok"), "the design ran; an absolute textio path must be rejected")
    check(has_error(result, "outside the simulation work directory"),
          f"unclear rejection: {errors_text(result)}")
    check(not result.get("waveforms"), "a rejected design must not produce waveforms")
    import shutil
    shutil.rmtree(scratch, ignore_errors=True)
    # isolation: this run left no NEW temp workdir behind.  Other concurrent
    # workers may legitimately own live directories created during this run,
    # so poll until they clear (every run removes its workdir in a finally);
    # a truly stale directory never clears and fails the check.
    deadline = time.time() + 120
    while time.time() < deadline:
        if not (sim_dirs() - before):
            break
        time.sleep(2)
    new_dirs = sim_dirs() - before
    check(not new_dirs, f"this run left stale simulation workdirs: {sorted(new_dirs)[:3]}")
    return ("Honest statement: the absolute-path design is rejected before GHDL runs (no host "
            "read); per-run isolation comes from throw-away tempdirs, and this run left none "
            "behind")
