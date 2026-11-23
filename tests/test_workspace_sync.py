"""Tests for two-way disk workspace synchronization and WebSocket watcher."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.server import app
from backend.workspace import delete_workspace_file, scan_workspace, write_workspace_files


def test_workspace_write_scan_delete_and_traversal_guard(tmp_path):
    ws = tmp_path / "proj"
    snap1 = write_workspace_files(ws, [
        {"name": "top.vhd", "content": "entity top is end top;\n"},
        {"name": "sub/helper.v", "content": "module helper; endmodule\n"},
    ])
    assert snap1["ok"] is True
    assert len(snap1["files"]) == 2
    assert {f["name"] for f in snap1["files"]} == {"top.vhd", "sub/helper.v"}
    assert (ws / "top.vhd").read_text(encoding="utf-8") == "entity top is end top;\n"

    # Re-writing identical bytes preserves exact content version
    snap2 = write_workspace_files(ws, [
        {"name": "top.vhd", "content": "entity top is end top;\n"},
        {"name": "sub/helper.v", "content": "module helper; endmodule\n"},
    ])
    assert snap2["version"] == snap1["version"]

    # Deleting one file updates the workspace snapshot and version
    snap3 = delete_workspace_file(ws, "sub/helper.v")
    assert len(snap3["files"]) == 1
    assert snap3["version"] != snap1["version"]

    # Path traversal must be rejected
    with pytest.raises(ValueError):
        write_workspace_files(ws, [{"name": "../escape.vhd", "content": "bad"}])


def test_workspace_rest_and_websocket_push_on_external_edit(tmp_path):
    ws = tmp_path / "cli_agent_ws"
    with TestClient(app) as client:
        r_write = client.post("/api/workspace/write", json={
            "dir": str(ws),
            "files": [{"name": "buzzb.vhd", "content": "-- initial\n"}],
        })
        assert r_write.status_code == 200
        v0 = r_write.json()["version"]

        r_open = client.post("/api/workspace/open", json={"dir": str(ws)})
        assert r_open.status_code == 200
        assert r_open.json()["files"][0]["name"] == "buzzb.vhd"

        with client.websocket_connect("/ws") as ws_conn:
            hello = ws_conn.receive_json()
            assert hello["type"] == "hello"

            ws_conn.send_json({"type": "workspace_watch", "dir": str(ws), "lastVersion": v0})

            # Simulate an external CLI agent (Claude Code / Codex) modifying the file on disk
            time.sleep(0.15)
            (ws / "buzzb.vhd").write_text("-- initial\n-- edited_by_cli\n", encoding="utf-8")

            pushed = None
            for _ in range(15):
                msg = ws_conn.receive_json()
                if msg.get("type") == "workspace_changed":
                    pushed = msg
                    break
            assert pushed is not None
            assert pushed["version"] != v0
            assert any(
                f["name"] == "buzzb.vhd" and "-- edited_by_cli" in f["content"]
                for f in pushed["files"]
            )
