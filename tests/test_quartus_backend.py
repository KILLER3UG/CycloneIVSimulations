"""Tests for Quartus settings, CLI runner, report parser, ModelSim netlist sim, and terminal isolation."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import settings as settings_mod
from backend import terminal as terminal_mod
from backend.modelsim_tool import simulate_vho_with_modelsim
from backend.quartus_tool import (
    QuartusCompileRunner,
    normalize_quartus_device,
    parse_compilation_report,
    parse_quartus_line,
    sync_quartus_project,
)
from backend.server import app


def test_parse_quartus_line_extracts_severities_ids_and_locations():
    info = parse_quartus_line("Info (293000): Quartus Prime Full Compilation was successful. 0 errors, 12 warnings")
    assert info["severity"] == "info"
    assert info["id"] == "293000"
    assert "Full Compilation was successful" in info["message"]

    warn = parse_quartus_line("Warning (18236): Number of processors has not been specified")
    assert warn["severity"] == "warning"
    assert warn["id"] == "18236"

    crit = parse_quartus_line("Critical Warning (332012): Synopsys Design Constraints File file not found: 'buzzb.sdc'")
    assert crit["severity"] == "critical_warning"
    assert crit["id"] == "332012"

    err = parse_quartus_line("Error (10500): VHDL syntax error at buzzb.vhd(14) near text \"end\"")
    assert err["severity"] == "error"
    assert err["id"] == "10500"
    assert err["file"] == "buzzb.vhd"
    assert err["line"] == 14


def test_validate_quartus_path_reports_clear_error_for_missing_path(tmp_path):
    empty = settings_mod.validate_quartus_path("")
    assert empty["valid"] is False
    assert "not configured" in empty["error"].lower()

    missing = settings_mod.validate_quartus_path(str(tmp_path / "no_quartus_here"))
    assert missing["valid"] is False
    assert "does not exist" in missing["error"].lower()


def test_settings_persistence_round_trip(monkeypatch, tmp_path):
    monkeypatch.setenv("CYCLONE_USER_DATA_DIR", str(tmp_path))
    saved = settings_mod.save_settings({"quartusPath": r"C:\custom\quartus\bin64", "defaultShell": "cmd"})
    assert saved["quartusPath"] == r"C:\custom\quartus\bin64"
    assert saved["defaultShell"] == "cmd"
    loaded = settings_mod.load_settings()
    assert loaded["quartusPath"] == r"C:\custom\quartus\bin64"
    assert loaded["defaultShell"] == "cmd"


def test_sync_quartus_project_generates_qpf_qsf_and_eda_settings(tmp_path):
    assert normalize_quartus_device("EP4CE6E22C8N") == "EP4CE6E22C8"
    qsf_pins = "set_location_assignment PIN_23 -to clk\nset_location_assignment PIN_110 -to buzzerb\n"
    info = sync_quartus_project(
        tmp_path,
        "buzzb",
        [{"name": "buzzb.vhd", "content": "-- test\n"}],
        "buzzb",
        qsf_pins,
        device="EP4CE6E22C8N",
    )
    qpf = Path(info["qpfPath"]).read_text(encoding="utf-8")
    qsf = Path(info["qsfPath"]).read_text(encoding="utf-8")
    assert 'PROJECT_REVISION = "buzzb"' in qpf
    assert "set_global_assignment -name DEVICE EP4CE6E22C8" in qsf
    assert "EDA_OUTPUT_DATA_FORMAT VHDL" in qsf
    assert "EDA_NETLIST_WRITER_OUTPUT_DIR simulation/modelsim" in qsf
    assert "set_location_assignment PIN_23 -to clk" in qsf
    assert (tmp_path / "buzzb.vhd").is_file()


def test_list_available_shells_prefers_powershell_on_windows():
    shells = terminal_mod.list_available_shells()
    assert len(shells) >= 1
    if os.name == "nt":
        ids = [s["id"] for s in shells]
        assert "powershell" in ids
        assert "cmd" in ids
        assert shells[0]["id"] == "powershell"
        assert shells[0]["default"] is True


def test_network_terminal_disabled_flag_blocks_http_and_ws(monkeypatch):
    monkeypatch.setenv("CYCLONE_DISABLE_NETWORK_TERMINAL", "1")
    with TestClient(app) as client:
        res = client.post("/api/terminal/exec", json={"command": "echo hi"})
        assert res.status_code == 403
        assert res.json()["ok"] is False


def test_real_quartus_compile_and_modelsim_simulation_on_buzzb(tmp_path):
    info = settings_mod.detect_quartus_bin()
    if not info["valid"]:
        pytest.skip("Quartus Prime CLI not installed")

    src = Path("examples/buzzb.vhd").read_text(encoding="utf-8")
    qsf_pins = "\n".join([
        "set_location_assignment PIN_23 -to clk",
        "set_location_assignment PIN_88 -to btn1",
        "set_location_assignment PIN_89 -to btn2",
        "set_location_assignment PIN_90 -to btn3",
        "set_location_assignment PIN_91 -to btn4",
        "set_location_assignment PIN_110 -to buzzerb",
    ])
    sync_quartus_project(tmp_path, "buzzb", [{"name": "buzzb.vhd", "content": src}], "buzzb", qsf_pins)
    stages_seen = []
    runner = QuartusCompileRunner(
        info["path"],
        tmp_path,
        "buzzb",
        on_stage=lambda ev: stages_seen.append((ev.get("stage"), ev.get("state"))),
    )
    res = runner.run_blocking()
    assert res["ok"] is True, res
    assert ("eda", "done") in stages_seen
    report = parse_compilation_report(tmp_path, "buzzb")
    assert Path(report["vhoPath"]).is_file()
    assert Path(report["sofPath"]).is_file()

    ms_info = settings_mod.detect_modelsim_bin(info["path"])
    if ms_info["valid"]:
        ms_res = simulate_vho_with_modelsim(
            Path(report["vhoPath"]),
            modelsim_path=ms_info["path"],
            top_entity="buzzb",
            duration_ns=400.0,
            clock_period_ns=20.0,
            qsf_text=qsf_pins,
            stimuli=[{"port": "btn1", "kind": "constant", "value": 0}],
        )
        assert ms_res["ok"] is True, ms_res
        assert ms_res["engine"] == "modelsim"
