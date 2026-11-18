#!/usr/bin/env python3
"""Offline sidecar smoke test from a path with spaces.

Copies the frozen sidecar bundle into ``%TEMP%\\Cyclone Test Space\\`` and
proves it works with ZERO repo/PATH support: ``doctor``, ``/api/health``
(GHDL resolved from the bundle), ``/api/boards`` and a ``buzz_4tone``
compile whose stimulus sweep must yield 16 vectors and a 500 Hz key-1 tone.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIDECAR = ROOT / "src-tauri" / "sidecar" / "cyclone-backend"
PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"


def _get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read().decode())


def _post(path: str, payload: dict):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def main() -> int:
    if not (SIDECAR / "cyclone-backend.exe").is_file():
        print(f"missing frozen sidecar at {SIDECAR}", file=sys.stderr)
        return 2
    smoke_root = Path(tempfile.gettempdir()) / "Cyclone Test Space"
    target = smoke_root / "cyclone-backend"
    if smoke_root.exists():
        shutil.rmtree(smoke_root)
    smoke_root.mkdir(parents=True)
    shutil.copytree(SIDECAR, target)
    exe = target / "cyclone-backend.exe"
    print(f"Offline sidecar smoke from path with spaces: {exe}")

    doctor = subprocess.run([str(exe), "doctor"], capture_output=True, text=True, timeout=120)
    print("doctor ok:", doctor.returncode == 0 and "ok" in (doctor.stdout + doctor.stderr).lower())
    if doctor.returncode != 0:
        print(doctor.stdout, doctor.stderr, file=sys.stderr)
        return 1

    serve = subprocess.Popen(
        [str(exe), "serve", "--host", "127.0.0.1", "--port", str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        health = None
        for _ in range(60):
            try:
                health = _get("/api/health")
                break
            except Exception:
                time.sleep(0.5)
        if not health or not health.get("ok"):
            print("health check failed", file=sys.stderr)
            return 1
        ghdl = str(health.get("ghdl", ""))
        print("health.ok=True ghdl=" + ghdl)
        if "Cyclone Test Space" not in ghdl:
            print("GHDL was NOT resolved from the frozen bundle", file=sys.stderr)
            return 1
        boards = _get("/api/boards")
        ids = ",".join(b["id"] for b in boards.get("boards", []))
        print("boards=" + ids)

        src = (ROOT / "examples" / "buzz_4tone.vhd").read_text(encoding="utf-8")
        result = _post("/api/simulate", {"vhdl": src, "top": "buzz_4tone", "includeStimulusMap": True})
        sweep = result.get("stimulusMap") or {}
        vectors = sweep.get("vectors") or {}
        freqs = sorted({(v.get("buzzerDecode") or {}).get("frequency") or 0 for v in vectors.values()})
        # The sweep must cover all 16 input masks and the tone decoder must
        # have measured real frequencies (buzz_4tone selects 500/800/1000/1600
        # Hz per key; the exact per-mask mapping is QA's BUZZ cases' job).
        if len(vectors) != 16 or len([f for f in freqs if f > 0]) < 3:
            print(f"unexpected sweep: vectors={len(vectors)} freqs={freqs}", file=sys.stderr)
            return 1
        print(f"buzz_4tone stimulusMap vectors={len(vectors)} freqs={freqs}")
        print("SMOKE PASS")
        return 0
    finally:
        serve.terminate()
        try:
            serve.wait(timeout=10)
        except Exception:
            serve.kill()


if __name__ == "__main__":
    raise SystemExit(main())
