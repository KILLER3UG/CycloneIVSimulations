import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.server import app

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


@pytest.fixture(scope="module")
def client():
    try:
        GhdlTool()
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")
    with TestClient(app) as test_client:
        yield test_client


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert "GHDL" in body["version"]


def test_examples(client):
    response = client.get("/api/examples")
    assert response.status_code == 200
    examples = response.json()["examples"]
    assert any(item["id"] == "counter" for item in examples)


def test_compile_and_simulate(client):
    source = (EXAMPLES / "counter.vhd").read_text(encoding="utf-8")
    compiled = client.post("/api/compile", json={"vhdl": source})
    assert compiled.status_code == 200
    assert compiled.json()["entity"]["name"] == "counter"

    simulated = client.post("/api/simulate", json={"vhdl": source, "duration": 100})
    assert simulated.status_code == 200
    body = simulated.json()
    assert body["ok"] is True
    assert body["waveforms"]["final"]["led"] == body["waveforms"]["final"]["count"]


def test_invalid_vhdl_returns_400(client):
    response = client.post("/api/compile", json={"vhdl": "entity broken is end entity"})
    assert response.status_code == 400
    assert response.json()["errors"]


def test_unknown_example(client):
    response = client.get("/api/examples/does-not-exist")
    assert response.status_code == 404


def test_websocket_roundtrip(client):
    source = (EXAMPLES / "counter.vhd").read_text(encoding="utf-8")
    with client.websocket_connect("/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello"

        ws.send_text(json.dumps({"type": "compile", "vhdl": source}))
        while True:
            message = ws.receive_json()
            if message["type"] == "compiled":
                assert message["ok"] is True
                break

        ws.send_text(json.dumps({"type": "simulate", "vhdl": source, "duration": 100}))
        while True:
            message = ws.receive_json()
            if message["type"] == "simulation_complete":
                assert message["ok"] is True
                break


def test_version_sync_and_endpoints(client):
    expected_version = (Path(__file__).resolve().parent.parent / "VERSION").read_text(encoding="utf-8").strip()

    from scripts.sync_version import run_sync
    ok, notes = run_sync(write=False)
    assert ok, notes

    v_resp = client.get("/api/version")
    assert v_resp.status_code == 200
    assert v_resp.json() == {"ok": True, "version": expected_version}

    h_resp = client.get("/api/health")
    assert h_resp.status_code == 200
    h_body = h_resp.json()
    assert h_body["appVersion"] == expected_version
    assert h_body["userDataDir"]


def test_serve_port_zero_prints_port_and_writes_log(tmp_path):
    import re
    import subprocess
    import sys
    import urllib.request

    root = Path(__file__).resolve().parent.parent
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "backend",
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--user-data-dir",
            str(tmp_path),
            "--log-level",
            "warning",
        ],
        cwd=str(root),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    port = None
    try:
        assert proc.stdout is not None
        for _ in range(40):
            line = proc.stdout.readline()
            if not line:
                break
            m = re.search(r"CYCLONE_PORT=(\d+)", line)
            if m:
                port = int(m.group(1))
                break
        assert port is not None and port > 0
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        assert payload["ok"] is True
        assert (tmp_path / "logs" / "backend.log").exists()
        assert (tmp_path / "projects").is_dir()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
