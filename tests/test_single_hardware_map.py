"""A1 — one hardware map, no hard-coded pin literals.

The vendor schematic, ``board/board.json`` and ``board/board_spec.md`` are the
only hardware sources of truth.  This test guards the consolidation: every
runtime layer must read pins/polarities from the profile, and no source file
may embed a ``PIN_<n>`` literal (tests and the legacy viewer excepted).

It also pins the resolved buzzer question: BEEP is PIN_110 on the
RZ-EasyFPGA A2.2; PIN_85 is LED3.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARD_JSON = ROOT / "board" / "board.json"
PIN_LITERAL = re.compile(r"""["']PIN_\d+["']""")

# Files allowed to contain pin literals: unit tests build small fixtures, and
# the legacy (not-built) viewer keeps a documented last-resort geometry map.
ALLOWED_FRONTEND = {"layout.test.js", "pinPlanner.test.js"}


def _board() -> dict:
    return json.loads(BOARD_JSON.read_text(encoding="utf-8"))


def _iter_source(roots, suffixes):
    for root in roots:
        for path in root.rglob("*"):
            if path.is_file() and path.suffix in suffixes:
                yield path


def _pin_literal_offenders(paths) -> list[str]:
    found = []
    for path in paths:
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if PIN_LITERAL.search(line):
                found.append(f"{path.relative_to(ROOT)}:{lineno}: {line.strip()}")
    return found


def test_board_json_carries_the_schematic_ground_truth():
    b = _board()["board"]
    assert b["clockPin"] == "PIN_23"
    assert b["resetPin"] == "PIN_25"
    assert b["resetActiveLow"] is True
    assert b["leds"]["pins"] == ["PIN_87", "PIN_86", "PIN_85", "PIN_84"]
    assert b["leds"]["activeLow"] is True
    assert b["buttons"]["pins"] == ["PIN_88", "PIN_89", "PIN_90", "PIN_91"]
    assert b["buttons"]["activeLow"] is True
    assert b["displays"]["pins"]["SEG"] == [
        "PIN_128", "PIN_121", "PIN_125", "PIN_129",
        "PIN_132", "PIN_126", "PIN_124", "PIN_127",
    ]
    assert b["displays"]["pins"]["DIG"] == ["PIN_133", "PIN_135", "PIN_136", "PIN_137"]
    assert b["displays"]["segBitMap"] == {
        "a": 0, "b": 1, "c": 2, "d": 3, "e": 4, "f": 5, "g": 6, "dp": 7,
    }
    # BEEP is PIN_110 (schematic, vendor pin file, board.json). PIN_85 is LED3.
    assert b["buzzer"]["pin"] == "PIN_110"
    assert b["buzzer"]["activeLow"] is True
    assert b["buzzer"]["type"] == "passive"
    assert "PIN_85" in b["leds"]["pins"]


def test_no_pin_literals_in_frontend_source():
    paths = (
        p for p in _iter_source([ROOT / "frontend" / "src"], {".js"})
        if p.name not in ALLOWED_FRONTEND
    )
    offenders = _pin_literal_offenders(paths)
    assert not offenders, (
        "hard-coded PIN literals found (read them from board.json instead):\n"
        + "\n".join(offenders)
    )


def test_no_pin_literals_in_backend_source():
    offenders = _pin_literal_offenders(_iter_source([ROOT / "backend"], {".py"}))
    assert not offenders, (
        "hard-coded PIN literals found (read them from board.json instead):\n"
        + "\n".join(offenders)
    )


def test_single_seg_bit_map_fallback():
    layout = (ROOT / "frontend" / "src" / "board" / "layout.js").read_text(encoding="utf-8")
    io = (ROOT / "frontend" / "src" / "board" / "io.js").read_text(encoding="utf-8")
    assert "export const SEG_BIT_MAP_FALLBACK" in layout
    assert "DEF_SEG_MAP" not in io
    assert "SEG_BIT_MAP_FALLBACK" in io
    # No stale swapped (b=0, a=1) map anywhere in shipped source or the legacy viewer.
    for path in _iter_source([ROOT / "frontend"], {".js"}):
        text = path.read_text(encoding="utf-8")
        assert "{ b: 0, a: 1" not in text, f"stale swapped SEG map in {path.relative_to(ROOT)}"


def test_runtime_layers_consume_the_profile():
    """The backend module and the frontend layout/planner must not define maps."""
    device = (ROOT / "backend" / "device.py").read_text(encoding="utf-8")
    assert 'load_board_json()' in device
    assert '"board.json"' in device
    layout = (ROOT / "frontend" / "src" / "board" / "layout.js").read_text(encoding="utf-8")
    assert "profile.board" in layout or "profile.board" in layout.replace("?.", ".")
    planner = (ROOT / "frontend" / "src" / "pinPlanner.js").read_text(encoding="utf-8")
    assert "buildPinCatalog(profile)" in planner