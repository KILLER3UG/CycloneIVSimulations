"""Regression tests for the multi-board audit minor fixes.

Covers: classifier word-boundary precision, the uniform resetActiveLow
fallback, strictPins forwarding on WebSocket compile, request-cache
invalidation on /api/device/select, manifest single-source sync between
board/board.json and boards/rz-easyfpga-a2.2/board.json, and the digitLabels
vs digitOrder transistor-designator consistency.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.ghdl_tool import GhdlNotFoundError, GhdlTool
from backend.server import app
from backend.waveform import _classify_port

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = "rz-easyfpga-a2.2"


# ---------------------------------------------------------------------------
# Classifier precision: the substring fallback needs a leading boundary so
# "answer" does not match "sw" and "monkey" does not match "key".
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", ["answer", "monkey", "psw", "turkey_leg", "hockey"])
def test_classifier_does_not_false_match_embedded_tokens(name):
    assert _classify_port(name) is None


@pytest.mark.parametrize("name,kind", [
    ("LED_DONE", "led"),
    ("led_done", "led"),
    ("sw_reg", "switch"),
    ("switch_en", "switch"),
    ("dip1", "switch"),
    ("key_start", "button"),
    ("btn_x", "button"),
    ("display_en", "display"),
    ("seg_out", "display"),
])
def test_classifier_still_matches_prefixed_and_joined_names(name, kind):
    assert _classify_port(name) == kind


# ---------------------------------------------------------------------------
# resetActiveLow fallback: one default everywhere (active-low, matching the
# board shell default and both real manifests).
# ---------------------------------------------------------------------------

def test_reset_active_low_fallback_is_uniform():
    waveform_src = (ROOT / "backend" / "waveform.py").read_text(encoding="utf-8")
    testbench_src = (ROOT / "backend" / "testbench_gen.py").read_text(encoding="utf-8")
    assert 'BOARD.get("resetActiveLow", False)' not in waveform_src
    assert 'BOARD.get("resetActiveLow", False)' not in testbench_src
    assert waveform_src.count('BOARD.get("resetActiveLow", True)') == 2
    assert testbench_src.count('BOARD.get("resetActiveLow", True)') == 1


# ---------------------------------------------------------------------------
# WebSocket compile must honor strictPins exactly like the REST endpoint.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client():
    try:
        GhdlTool()
    except GhdlNotFoundError as exc:
        pytest.skip(f"GHDL not available: {exc}")
    with TestClient(app) as test_client:
        yield test_client


def test_ws_compile_forwards_strict_pins(client):
    source = (ROOT / "examples" / "counter.vhd").read_text(encoding="utf-8")
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_text(json.dumps({"type": "compile", "vhdl": source, "strictPins": True}))
        while True:
            message = ws.receive_json()
            if message["type"] == "compiled":
                break
    assert message["ok"] is True
    # strict pin mode with no QSF: nothing may be auto-mapped
    assert message["board"]["pins"] == {}


def test_device_select_clears_the_request_cache(client):
    from backend.server import get_simulator

    simulator = get_simulator()
    simulator._req_cache["stale-key"] = {"ok": True}
    response = client.post("/api/device/select", json={"device": "ep4ce10"})
    assert response.status_code == 200
    assert "stale-key" not in simulator._req_cache


# ---------------------------------------------------------------------------
# Manifest single source of truth: the canonical copy and the directory copy
# of the RZ-EasyFPGA A2.2 profile must stay in sync (id/layout3d excepted).
# ---------------------------------------------------------------------------

def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_rz_manifest_copies_stay_in_sync():
    canonical = _load(ROOT / "board" / "board.json")
    directory = _load(ROOT / "boards" / "rz-easyfpga-a2.2" / "board.json")
    assert canonical["devices"] == directory["devices"]
    assert canonical["pinMap"] == directory["pinMap"]
    assert canonical["facts"] == directory["facts"]
    for key, value in directory["board"].items():
        if key in ("id", "layout3d"):
            continue  # the directory copy may contribute identity + 3D layout
        assert canonical["board"].get(key) == value, f"board.{key} drifted"


def test_digit_labels_agree_with_digit_order():
    board = _load(ROOT / "boards" / "rz-easyfpga-a2.2" / "board.json")["board"]
    displays = board["displays"]
    order = displays["digitOrder"]
    labels = {item["dig"]: item for item in displays["digitLabels"]}
    # digitOrder: DIG[3] (DIG4) -> Q1 -> D1 leftmost; DIG[0] (DIG1) -> Q4 -> D4
    assert labels["DIG[3]"]["transistor"] == "Q1"
    assert labels["DIG[3]"]["diode"] == "D1"
    assert labels["DIG[0]"]["transistor"] == "Q4"
    assert labels["DIG[0]"]["diode"] == "D4"
    assert "Q1" in order and "D1" in order
