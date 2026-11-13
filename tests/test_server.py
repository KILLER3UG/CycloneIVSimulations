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