"""Slice 3.1: declarative multi-board registry and dynamic board selection."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import board_registry
from backend.device import (
    BOARD,
    DEVICES,
    get_active_board_id,
    select_board,
)
from backend.server import app

DEFAULT = "rz-easyfpga-a2.2"
SECOND = "de0-nano-ep4ce22"


@pytest.fixture(autouse=True)
def _restore_default_board():
    """Every test starts and ends on the canonical default board."""
    select_board(DEFAULT)
    yield
    select_board(DEFAULT)
    for imported in ("sdk-test-board", "raw-import-board", "unselected-board"):
        board_registry.unregister_board(imported)


@pytest.fixture()
def client():
    return TestClient(app)


def _sdk_manifest() -> dict:
    return {
        "id": "sdk-test-board",
        "name": "SDK Test Board",
        "vendor": "Test Vendor",
        "fpga_part": "EP4CE10E22C8N",
        "clock_hz": 50000000,
        "clock_pin": "PIN_23",
        "reset_pin": "PIN_25",
        "reset_active_low": True,
        "pins": [
            {"number": "PIN_23", "name": "CLOCK_50", "role": "clock",
             "input_only": True, "pull": "none", "shared_group": ""},
            {"number": "PIN_25", "name": "RESET_N", "role": "reset",
             "input_only": True, "pull": "up", "shared_group": ""},
            {"number": "PIN_87", "name": "LED[0]", "role": "led",
             "input_only": False, "pull": "none", "shared_group": ""},
            {"number": "PIN_86", "name": "LED[1]", "role": "led",
             "input_only": False, "pull": "none", "shared_group": ""},
            {"number": "PIN_88", "name": "KEY[0]", "role": "button",
             "input_only": True, "pull": "up", "shared_group": ""},
        ],
        "peripherals": {
            "leds": {"port": "LED", "count": 2,
                     "pins": ["PIN_87", "PIN_86"], "activeLow": True},
            "buttons": {"port": "KEY", "count": 1,
                        "pins": ["PIN_88"], "activeLow": True},
            "switches": {"port": "SW", "count": 0, "pins": [],
                         "sharedWithButtons": False, "activeLow": False},
            "seven_segment": {
                "count": 1, "segmentActiveLow": True, "digitActiveLow": True,
                "pins": {"SEG": [], "DIG": []},
            },
            "buzzer": {"port": "BUZZER", "pin": "PIN_110",
                       "type": "passive", "activeLow": True},
            "i2c_devices": [],
        },
        "layout3d": {
            "pcb": {"w": 50, "d": 30, "thickness": 1.6, "cornerRadius": 2},
            "pcbColor": "#123456",
        },
    }


def test_registry_discovers_both_builtin_boards():
    ids = [item["id"] for item in board_registry.list_boards()]
    assert DEFAULT in ids
    assert SECOND in ids

    rz = board_registry.get_board(DEFAULT)
    assert rz is not None
    assert rz["board"]["name"] == "RZ-EasyFPGA A2.2"
    assert rz["board"]["layout3d"]["pcbColor"] == "#111315"

    de0 = board_registry.get_board(SECOND)
    assert de0 is not None
    assert de0["board"]["name"] == "Terasic DE0-Nano (EP4CE22)"
    assert de0["board"]["layout3d"]["pcbColor"] == "#0d3b26"


def test_get_boards_lists_both_profiles(client):
    response = client.get("/api/boards")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["activeBoard"] == DEFAULT
    ids = [item["id"] for item in body["boards"]]
    assert DEFAULT in ids
    assert SECOND in ids


def test_select_board_switches_every_layer_in_place(client):
    response = client.post("/api/boards/select", json={"board": SECOND})
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["activeBoard"] == SECOND
    assert body["board"]["name"] == "Terasic DE0-Nano (EP4CE22)"
    assert body["device"]["part"] == "EP4CE22F17C6N"
    assert body["device"]["userIo"] == 153

    # Imported-by-reference globals used by simulator/frontend all see it.
    assert get_active_board_id() == SECOND
    assert BOARD["name"] == "Terasic DE0-Nano (EP4CE22)"
    assert len(BOARD["leds"]["pins"]) == 8
    assert len(BOARD["buttons"]["pins"]) == 2
    assert len(BOARD["switches"]["pins"]) == 4
    assert BOARD["switches"]["sharedWithButtons"] is False
    assert DEVICES["ep4ce22"]["part"] == "EP4CE22F17C6N"

    profile = client.get("/api/board").json()
    assert profile["ok"] is True
    assert profile["device"]["part"] == "EP4CE22F17C6N"
    board = profile["board"]
    assert board["id"] == SECOND
    assert board["name"] == "Terasic DE0-Nano (EP4CE22)"
    assert board["layout3d"]["pcbColor"] == "#0d3b26"
    assert board["pinMap"]["LED[7]"] == ["PIN_76"]
    assert board["pinMap"]["SW[0]"] == ["PIN_90"]
    assert board["pinMap"]["FPGA_BUZZER"] == ["PIN_110"]
    assert board["facts"]

    # Select accepts the "id" alias too and restores the default cleanly.
    back = client.post("/api/boards/select", json={"id": DEFAULT})
    assert back.status_code == 200
    assert back.json()["activeBoard"] == DEFAULT
    assert len(BOARD["leds"]["pins"]) == 4
    assert DEVICES["ep4ce6"]["part"] == "EP4CE6E22C8N"
    assert client.get("/api/board").json()["board"]["name"] == "RZ-EasyFPGA A2.2"


def test_select_unknown_board_returns_400(client):
    response = client.post("/api/boards/select", json={"board": "no-such-board"})
    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert get_active_board_id() == DEFAULT


def test_import_simplified_sdk_manifest(client):
    response = client.post(
        "/api/boards/import",
        json={"manifest": _sdk_manifest(), "select": True},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["activeBoard"] == "sdk-test-board"
    assert "sdk-test-board" in [b["id"] for b in body["boards"]]

    profile = client.get("/api/board").json()["board"]
    assert profile["id"] == "sdk-test-board"
    assert profile["name"] == "SDK Test Board"
    assert len(profile["leds"]["pins"]) == 2
    assert profile["pinMap"]["LED[0]"] == ["PIN_87"]
    assert profile["layout3d"]["pcbColor"] == "#123456"
    assert profile["buzzer"]["activeLow"] is True


def test_import_rejects_invalid_manifests(client):
    invalid = [
        {},                                             # no id / no name
        {"id": "x", "name": "X"},                        # no pins
        {"id": "x", "name": "X", "pins": []},            # empty pins
        {"name": "X", "pins": [{"number": "PIN_23"}]},   # no id
        {"id": "x", "name": "X", "pins": [{"number": "PIN_23"}]},  # pin has no name / no clock
    ]
    for manifest in invalid:
        response = client.post("/api/boards/import", json={"manifest": manifest})
        assert response.status_code == 400, manifest
        assert response.json()["ok"] is False
    assert get_active_board_id() == DEFAULT


def test_normalize_manifest_rejects_bad_input():
    from backend.board_registry import BoardManifestError, normalize_manifest

    with pytest.raises(BoardManifestError):
        normalize_manifest("not a dict")
    with pytest.raises(ValueError):
        normalize_manifest({"id": "bad", "name": "Bad", "pins": []})


def test_import_raw_board_dict_and_select_false(client):
    raw_manifest = _sdk_manifest()
    raw_manifest["id"] = "raw-import-board"
    raw_manifest["name"] = "Raw Import Board"

    # A bare dict (no {"manifest": ...} wrapper) is accepted and selected.
    response = client.post("/api/boards/import", json=raw_manifest)
    assert response.status_code == 200
    assert response.json()["activeBoard"] == "raw-import-board"

    # Wrapped form honours a string "false" without coercing it to True.
    other = _sdk_manifest()
    other["id"] = "unselected-board"
    other["name"] = "Unselected Board"
    response = client.post(
        "/api/boards/import", json={"manifest": other, "select": "false"}
    )
    assert response.status_code == 200
    assert response.json()["activeBoard"] == "raw-import-board"
    assert client.get("/api/board").json()["board"]["id"] == "raw-import-board"


def test_build_sidecar_packages_boards_and_winpty():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    source = (root / "packaging" / "build_sidecar.py").read_text(encoding="utf-8")
    assert '"boards"' in source
    assert '"--collect-all"' in source
    assert '"winpty"' in source
