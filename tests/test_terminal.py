"""Slice 4.1/4.2: interactive PTY terminal bridge and process cleanup."""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time

import pytest
from fastapi.testclient import TestClient

from backend import terminal as terminal_mod
from backend.paths import bundle_root
from backend.server import app

#: Hard bound per WebSocket read: a stalled shell bridge must FAIL the test
#: with a clear message instead of hanging the whole suite (this exact hang
#: burned >2 h of CI when the PTY spawn stalled on a hosted runner).
RECV_TIMEOUT = 60.0


def _receive_json(ws, timeout: float = RECV_TIMEOUT) -> dict:
    """``ws.receive_json()`` with a hard bound (the SDK call blocks forever)."""
    result: dict = {}
    done = threading.Event()

    def _run() -> None:
        try:
            result["value"] = ws.receive_json()
        except BaseException as exc:  # noqa: BLE001 - re-raised in the tester
            result["error"] = exc
        finally:
            done.set()

    reader = threading.Thread(target=_run, daemon=True, name="ws-receive")
    reader.start()
    if not done.wait(timeout):
        raise AssertionError(
            f"terminal sent no message within {timeout:g}s — the shell bridge "
            "is stalled (see backend/terminal.py)"
        )
    if "error" in result:
        raise result["error"]
    return result["value"]


def _recv_until(ws, kind: str, limit: int = 120) -> dict:
    """Read messages until one of ``kind`` arrives (output may interleave)."""
    for _ in range(limit):
        message = _receive_json(ws)
        if message.get("type") == kind:
            return message
    raise AssertionError(f"no {kind!r} message in {limit} reads")


def _collect_output(ws, needle: str, limit: int = 120) -> str:
    chunks: list[str] = []
    for _ in range(limit):
        message = _receive_json(ws)
        kind = message.get("type")
        if kind == "output":
            chunks.append(str(message.get("data", "")))
            if needle in "".join(chunks):
                return "".join(chunks)
        elif kind == "error":
            raise AssertionError(f"terminal error: {message}")
        elif kind == "exit":
            raise AssertionError(f"terminal exited before {needle!r}: {message}")
    raise AssertionError(f"{needle!r} not seen; output was: {''.join(chunks)!r}")


@pytest.fixture()
def client():
    return TestClient(app)


def _pid_alive(pid: int) -> bool:
    if not pid:
        return False
    if os.name == "nt":
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}"],
            capture_output=True, text=True, check=False,
        )
        return str(pid) in (result.stdout or "")
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def test_terminal_websocket_runs_ghdl_and_echo_then_kills_shell_tree():
    if not terminal_mod.ghdl_on_path():
        pytest.skip("GHDL not available for terminal PATH test")

    with TestClient(app) as client:
        with client.websocket_connect("/ws/terminal") as ws:
            ready = _recv_until(ws, "ready")
            assert ready["type"] == "ready", ready
            assert ready["ghdlOnPath"] is True
            assert ready["cwd"] == str(bundle_root())
            pid = int(ready["pid"])

            ws.send_text(json.dumps({"type": "input", "data": "ghdl --version\r\n"}))
            ghdl_output = _collect_output(ws, "GHDL")
            assert "GHDL" in ghdl_output

            ws.send_text(json.dumps({"type": "input", "data": "echo SIM_TERMINAL_OK\r\n"}))
            echo_output = _collect_output(ws, "SIM_TERMINAL_OK")
            assert "SIM_TERMINAL_OK" in echo_output

            ws.send_text(json.dumps({"type": "resize", "cols": 100, "rows": 30}))

    # WebSocket disconnect must terminate the shell; poll briefly for the
    # endpoint's finally block to run in the server thread.
    for _ in range(60):
        if not terminal_mod.active_terminals():
            break
        time.sleep(0.05)
    assert terminal_mod.active_terminals() == []
    assert not _pid_alive(pid), f"orphan shell process {pid} still running"


def test_terminal_ws_restart_returns_a_new_ready_shell():
    if not terminal_mod.ghdl_on_path():
        pytest.skip("GHDL not available for terminal PATH test")

    with TestClient(app) as client:
        with client.websocket_connect("/ws/terminal") as ws:
            first = _recv_until(ws, "ready")
            assert first["type"] == "ready"
            first_pid = int(first["pid"])

            ws.send_text(json.dumps({"type": "restart"}))
            second = _recv_until(ws, "ready")
            assert second["type"] == "ready", f"restart produced {second}"
            second_pid = int(second["pid"])
            assert second_pid != first_pid

            ws.send_text(json.dumps({"type": "input", "data": "echo RESTART_OK\r\n"}))
            assert "RESTART_OK" in _collect_output(ws, "RESTART_OK")

    for _ in range(60):
        if not terminal_mod.active_terminals():
            break
        time.sleep(0.05)
    assert terminal_mod.active_terminals() == []
    assert not _pid_alive(second_pid)


def test_terminal_exec_runs_ghdl_on_path(client):
    response = client.post("/api/terminal/exec", json={"command": "ghdl --version"})
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert "GHDL" in body["output"]

    echo = client.post("/api/terminal/exec", json={"command": "echo EXEC_TERMINAL_OK"})
    assert echo.status_code == 200
    assert echo.json()["ok"] is True
    assert "EXEC_TERMINAL_OK" in echo.json()["output"]


def test_terminal_exec_empty_command_is_rejected(client):
    response = client.post("/api/terminal/exec", json={"command": "   "})
    assert response.status_code == 200
    assert response.json()["ok"] is False


# ---------------------------------------------------------------------------
# Shell + working-directory detection: nothing machine-specific is hardcoded.
# ---------------------------------------------------------------------------

def test_default_shell_comes_from_the_environment(monkeypatch):
    if os.name == "nt":
        monkeypatch.setenv("COMSPEC", r"C:\Windows\System32\cmd.exe")
        monkeypatch.delenv("SHELL", raising=False)
        assert terminal_mod.default_shell() == r"C:\Windows\System32\cmd.exe"
    else:
        monkeypatch.setenv("SHELL", "/bin/zsh")
        monkeypatch.delenv("COMSPEC", raising=False)
        assert terminal_mod.default_shell() == "/bin/zsh"


def test_default_shell_falls_back_to_platform_default(monkeypatch):
    monkeypatch.delenv("COMSPEC", raising=False)
    monkeypatch.delenv("SHELL", raising=False)
    expected = "cmd.exe" if os.name == "nt" else "/bin/sh"
    assert terminal_mod.default_shell() == expected


def test_resolve_cwd_prefers_an_existing_explicit_directory(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    assert terminal_mod.resolve_cwd(str(workspace)) == str(workspace)


def test_resolve_cwd_skips_missing_explicit_and_uses_workspace_root(tmp_path):
    missing = tmp_path / "does-not-exist"
    assert terminal_mod.resolve_cwd(str(missing)) == str(terminal_mod.bundle_root())


def test_resolve_cwd_installed_app_uses_the_projects_workspace(monkeypatch, tmp_path):
    monkeypatch.setattr(terminal_mod.sys, "frozen", True, raising=False)
    monkeypatch.setenv("CYCLONE_USER_DATA_DIR", str(tmp_path))
    expected = terminal_mod.projects_dir(create=True)
    assert terminal_mod.resolve_cwd(None) == str(expected)


def test_resolve_cwd_final_fallback_is_the_home_directory(monkeypatch):
    monkeypatch.setattr(terminal_mod.sys, "frozen", True, raising=False)
    monkeypatch.setenv("CYCLONE_USER_DATA_DIR", str(__import__("pathlib").Path.home() / "no-such-dir-xyz"))
    assert terminal_mod.resolve_cwd(None) == str(terminal_mod.Path.home())
