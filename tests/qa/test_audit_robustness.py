"""Section 15: robustness — fuzzing, malformed input, concurrency, sandbox.

The simulator must never crash, hang, or grow without bound on bad input.
Literal absolute textio paths are rejected by a backend pre-scan before GHDL
runs (RB-05); relative textio inside the throw-away workdir keeps working
(RB-05B).  Documented residual: runtime-computed paths are not covered by the
scan, so uploaded HDL still runs with process privileges.
"""
from __future__ import annotations

import json
import random
import threading
import time
from pathlib import Path

from harness import case, check, errors_text, has_error, run_text, simulator, value

ROOT = Path(__file__).resolve().parent.parent.parent
SCRATCH = Path(__file__).resolve().parent.parent.parent / "tests" / ".audit-scratch"


@case("RB-01", "15", "VHDL parser survives random binary garbage", "fuzz",
      "200 random inputs: no exception, no hang")
def rb_01() -> str:
    from backend.vhdl_parser import VHDLParser
    rng = random.Random(1234)
    for _ in range(200):
        data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 400)))
        text = data.decode("latin-1", errors="replace")
        try:
            VHDLParser().parse(text)
        except Exception as exc:  # noqa: BLE001 - the point is "never crash"
            check(False, f"parser raised {type(exc).__name__}: {exc}")
    return "200 random inputs parsed without an exception"


@case("RB-02", "15", "QSF parser survives garbage and a 1 MB file", "fuzz",
      "random garbage + 1 MB input: no exception, bounded time")
def rb_02() -> str:
    from backend.qsf_parser import parse_qsf
    rng = random.Random(99)
    for _ in range(200):
        data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 2000)))
        try:
            parse_qsf(data.decode("latin-1", errors="replace"))
        except Exception as exc:  # noqa: BLE001
            check(False, f"qsf parser raised {type(exc).__name__}: {exc}")
    big = ("set_location_assignment PIN_87 -to LED[0]\n" + "# filler\n" * 60_000)
    started = time.time()
    result = parse_qsf(big)
    elapsed = time.time() - started
    check(result.ok, f"1 MB qsf parse errors: {result.errors[:2]}")
    check(elapsed < 10, f"1 MB qsf parse took {elapsed:.1f}s")
    return f"garbage + 1 MB qsf parsed without an exception ({elapsed:.2f}s)"


@case("RB-03", "15", "WebSocket survives malformed and unknown messages", "WS",
      "invalid JSON -> error; unknown type -> error; ping -> pong; connection stays open")
def rb_03() -> str:
    from fastapi.testclient import TestClient
    from backend.server import app
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            hello = ws.receive_json()
            check(hello["type"] == "hello", f"hello: {hello}")
            ws.send_text("this is not json")
            msg = ws.receive_json()
            check(msg.get("type") == "error", f"invalid JSON: {msg}")
            ws.send_text(json.dumps({"type": "bogus_type"}))
            msg = ws.receive_json()
            check(msg.get("type") == "error", f"unknown type: {msg}")
            ws.send_text(json.dumps({"type": "ping"}))
            msg = ws.receive_json()
            check(msg.get("type") == "pong", f"ping: {msg}")
    return "malformed/unknown WS messages rejected; connection stayed open"


@case("RB-04", "15", "A huge VHDL file (5k lines) compiles without unbounded memory", "VHDL",
      "compile succeeds in bounded time")
def rb_04() -> str:
    from backend.simulator import SimulationRequest
    lines = ["-- filler line %d" % i for i in range(5000)]
    lines.append("library ieee; use ieee.std_logic_1164.all;")
    lines.append("entity big_file is port (a : in std_logic; b : out std_logic); end entity;")
    lines.append("architecture rtl of big_file is begin b <= a; end architecture;")
    src = "\n".join(lines)
    started = time.time()
    result = simulator().compile_source(src)
    elapsed = time.time() - started
    check(result.get("ok"), f"compile failed: {errors_text(result)}")
    check(elapsed < 30, f"compile took {elapsed:.1f}s")
    return f"5k-line VHDL compiled in {elapsed:.2f}s"


@case("RB-05", "15", "HDL textio with literal absolute host paths is rejected", "VHDL",
      "the pre-scan rejects the design with a clear error; no host file is written")
def rb_05() -> str:
    SCRATCH.mkdir(parents=True, exist_ok=True)
    in_path = SCRATCH / "escape_in.txt"
    out_path = SCRATCH / "escape_out.txt"
    in_path.write_text("XYZ\n", encoding="utf-8")
    if out_path.exists():
        out_path.unlink()
    src = f"""
library ieee;
use ieee.std_logic_1164.all;
use std.textio.all;
entity escape is
    port (RESULT : out std_logic_vector(7 downto 0));
end entity;
architecture sim of escape is
begin
    process
        file in_f  : text;
        file out_f : text;
        variable l : line;
        variable c : character;
    begin
        file_open(in_f, "{in_path.as_posix()}", read_mode);
        readline(in_f, l);
        c := l(1);
        file_open(out_f, "{out_path.as_posix()}", write_mode);
        writeline(out_f, l);
        file_close(in_f);
        file_close(out_f);
        if c = 'X' then
            RESULT <= x"5A";
        else
            RESULT <= x"00";
        end if;
        wait;
    end process;
end architecture;
"""
    result = run_text(src, top="escape", duration=1000, resetCycles=0)
    # Audit N7 / ENG-07 mitigation: the literal absolute paths are rejected
    # before GHDL runs.  Documented residual: runtime-computed paths
    # (concatenated strings) can still reach the host FS - the pre-scan covers
    # the demonstrated literal-path class only.
    check(not result.get("ok"), "the design ran; absolute textio paths must be rejected")
    check(has_error(result, "outside the simulation work directory"),
          f"unclear rejection: {errors_text(result)}")
    check(not out_path.exists(), f"the design still wrote the host file {out_path}")
    check(not result.get("waveforms"), "a rejected design must not produce waveforms")
    in_path.unlink(missing_ok=True)
    return "absolute textio read+write rejected before GHDL (clear error, no host file written)"


@case("RB-05B", "15", "Relative textio stays confined to the workdir and works", "VHDL",
      "a design that writes out.txt (relative) and reads it back passes end-to-end")
def rb_05b() -> str:
    src = """
library ieee;
use ieee.std_logic_1164.all;
use std.textio.all;
entity rel_textio is
    port (RESULT : out std_logic_vector(7 downto 0));
end entity;
architecture sim of rel_textio is
begin
    process
        file out_f : text;
        file in_f  : text;
        variable l : line;
        variable c : character;
    begin
        file_open(out_f, "out.txt", write_mode);
        write(l, string'("ROUNDTRIP"));
        writeline(out_f, l);
        file_close(out_f);
        file_open(in_f, "out.txt", read_mode);
        readline(in_f, l);
        c := l(1);
        file_close(in_f);
        if c = 'R' then
            RESULT <= x"5A";
        else
            RESULT <= x"00";
        end if;
        wait;
    end process;
end architecture;
"""
    result = run_text(src, top="rel_textio", duration=1000, resetCycles=0)
    check(result.get("ok"), f"relative textio must keep working: {errors_text(result)}")
    check(int(value(result, "RESULT")) == 0x5A, "the design did not read back out.txt")
    return "relative textio write+read round-trips inside the throw-away workdir"


@case("RB-06", "15", "Concurrent simulations are isolated", "VHDL",
      "two designs run at once; each result matches its own design")
def rb_06() -> str:
    from backend.simulator import SimulationRequest
    not_gate = ("library ieee; use ieee.std_logic_1164.all; "
                "entity conc_not is port (a : in std_logic; b : out std_logic); end entity; "
                "architecture rtl of conc_not is begin b <= not a; end architecture;")
    buffer = ("library ieee; use ieee.std_logic_1164.all; "
              "entity conc_buf is port (a : in std_logic; b : out std_logic); end entity; "
              "architecture rtl of conc_buf is begin b <= a; end architecture;")
    results: dict = {}

    def run_one(name: str, src: str, top: str) -> None:
        results[name] = simulator().simulate(SimulationRequest.from_dict({
            "vhdl": src, "top": top, "duration": 20, "resetCycles": 0,
            "constantInputs": {"a": 1},
        }))

    threads = [threading.Thread(target=run_one, args=("not", not_gate, "conc_not")),
               threading.Thread(target=run_one, args=("buf", buffer, "conc_buf"))]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    check(results["not"].get("ok"), f"not sim failed: {errors_text(results['not'])}")
    check(results["buf"].get("ok"), f"buf sim failed: {errors_text(results['buf'])}")
    check(int(value(results["not"], "b")) == 0, "not-gate result wrong")
    check(int(value(results["buf"], "b")) == 1, "buffer result wrong")
    return "two concurrent simulations isolated (not=0, buffer=1)"
