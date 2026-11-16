"""Command line interface for the Cyclone IV simulator backend.

Examples
--------
    python -m backend doctor
    python -m backend examples
    python -m backend run examples/counter.vhd --duration 200 --cycles 16
    python -m backend serve --port 8080
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

from .ghdl_tool import GhdlNotFoundError
from .simulator import SimulationRequest, Simulator


def _cmd_doctor(args: argparse.Namespace) -> int:
    try:
        simulator = Simulator()
    except GhdlNotFoundError as exc:
        print(f"GHDL not found: {exc}", file=sys.stderr)
        return 2
    health = simulator.health()
    print(f"GHDL      : {health['ghdl']}")
    print(f"Version   : {health['version']}")
    print("Status    : OK")
    return 0


def _cmd_examples(args: argparse.Namespace) -> int:
    from .server import _list_examples

    examples = _list_examples()
    if not examples:
        print("No examples found")
        return 1
    for item in examples:
        print(f"{item['id']:<16} entity={item['entity'] or '-':<14} {item['description']}")
    return 0


def _cmd_run(args: argparse.Namespace) -> int:
    path = Path(args.file)
    if not path.exists():
        print(f"File not found: {path}", file=sys.stderr)
        return 2
    source = path.read_text(encoding="utf-8", errors="replace")

    try:
        simulator = Simulator()
    except GhdlNotFoundError as exc:
        print(f"GHDL not found: {exc}", file=sys.stderr)
        return 2

    request = SimulationRequest(
        vhdl=source,
        top=args.top,
        duration=args.duration,
        clock_period=args.clock,
        reset_cycles=args.reset_cycles,
        max_cycles=args.cycles,
    )
    if args.out:
        os.environ["CYCLESIM_KEEP_DIR"] = "1"
    result = simulator.simulate(request)

    if args.json:
        print(json.dumps(result, indent=2))
        return 0 if result.get("ok") else 1

    if not result.get("ok"):
        print("Simulation failed:", file=sys.stderr)
        for error in result.get("errors", []):
            location = ""
            if error.get("line"):
                location = f" (line {error['line']}, column {error.get('column', 0)})"
            print(f"  {error.get('message')}{location}", file=sys.stderr)
        if result.get("logs"):
            print(result["logs"][-2000:], file=sys.stderr)
        return 1

    waveform = result["waveforms"]
    entity = result["entity"]
    signals = [signal["name"] for signal in waveform["signals"]]
    print(f"Entity   : {entity['name']}")
    print(f"Top      : {result['top']}")
    print(f"Duration : {waveform['duration']:.3f} ns")
    print(f"Signals  : {', '.join(signals)}")
    print()

    cycles = waveform.get("cycles", [])
    if cycles:
        width = max(len(name) for name in signals) if signals else 4
        header = "cycle".ljust(6) + "time".ljust(12) + "".join(name.ljust(width + 2) for name in signals)
        print(header)
        print("-" * len(header))
        for cycle in cycles[: args.cycles]:
            row = str(cycle["cycle"]).ljust(6) + f"{cycle['time']:g}".ljust(12)
            for name in signals:
                row += str(cycle["values"].get(name, "")).ljust(width + 2)
            print(row)
        if len(cycles) > args.cycles:
            print(f"... {len(cycles) - args.cycles} more cycles")
    else:
        print("No clocked cycles (pure combinational design).")
        print("Final state:")
        for name, value in waveform.get("final", {}).items():
            print(f"  {name:<{max(len(n) for n in waveform.get('final', {}))}} = {value}")

    if args.out:
        source_vcd = result.get("vcd")
        if source_vcd and Path(source_vcd).exists():
            shutil.copyfile(source_vcd, args.out)
            print(f"VCD written to {args.out}")
        else:
            print("VCD was not produced", file=sys.stderr)
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    print(f"Starting Cyclone IV simulator on http://{args.host}:{args.port}")
    uvicorn.run(
        "backend.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level=args.log_level,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m backend", description="Cyclone IV VHDL simulation backend")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("doctor", help="check the GHDL installation").set_defaults(func=_cmd_doctor)
    sub.add_parser("examples", help="list bundled example designs").set_defaults(func=_cmd_examples)

    run = sub.add_parser("run", help="run a VHDL file through GHDL and print waveforms")
    run.add_argument("file", help="path to a .vhd file")
    run.add_argument("--top", help="top-level entity name (default: first non-testbench entity)")
    run.add_argument("--duration", type=float, default=1000.0, help="simulation duration in ns")
    run.add_argument("--clock", type=float, default=10.0, help="clock period in ns")
    run.add_argument("--reset-cycles", type=int, default=2, help="reset asserted for N clock cycles")
    run.add_argument("--cycles", type=int, default=32, help="number of cycle rows to print")
    run.add_argument("--out", help="write the raw VCD to this path (requires CYCLESIM_KEEP_DIR=1)")
    run.add_argument("--json", action="store_true", help="print the full JSON result")
    run.set_defaults(func=_cmd_run)

    serve = sub.add_parser("serve", help="start the HTTP/WebSocket server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8080)
    serve.add_argument("--reload", action="store_true")
    serve.add_argument("--log-level", default="info")
    serve.set_defaults(func=_cmd_serve)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())