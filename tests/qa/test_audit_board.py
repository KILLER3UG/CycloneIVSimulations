"""Section 9: board.json is the single source of truth for pins and polarity.

Every case checks that the machine-readable profile agrees with the vendor
pin file, that facts carry tags, and that no runtime code hard-codes a pin.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from harness import case, check, frontend_dir, snippet

ROOT = Path(__file__).resolve().parent.parent.parent
BOARD_JSON = ROOT / "board" / "board.json"
VENDOR_PINS = ROOT / "board" / "vendor" / "Pinos_RZEasyFPGA.txt"
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"


def _vendor() -> dict:
    pins = {}
    for line in VENDOR_PINS.read_text(encoding="utf-8").splitlines():
        match = re.match(r"\s*set_location_assignment\s+PIN_(\d+)\s+-to\s+(\S+)", line)
        if match:
            pins[match.group(2).upper()] = f"PIN_{match.group(1)}"
    return pins


@case("BJ-01", "9", "board.json pinMap matches every vendor pin assignment", "infra",
      "all 86 vendor pins present with the same PIN numbers")
def bj_01() -> str:
    data = json.loads(BOARD_JSON.read_text(encoding="utf-8"))
    pin_map = {key.upper(): value for key, value in data["pinMap"].items()}
    vendor = _vendor()
    missing = [name for name in vendor if name not in pin_map]
    check(not missing, f"missing: {missing}")
    wrong = {name: (pin, pin_map[name]) for name, pin in vendor.items() if pin_map[name] != [pin]}
    check(not wrong, f"mismatches: {wrong}")
    return f"{len(vendor)} vendor pins match board.json"


@case("BJ-02", "9", "Every fact in board.json carries VERIFIED/INFERRED/UNVERIFIED", "infra",
      "34 facts, all tagged, no empty sources")
def bj_02() -> str:
    data = json.loads(BOARD_JSON.read_text(encoding="utf-8"))
    facts = data["facts"]
    valid = {"VERIFIED", "INFERRED", "UNVERIFIED"}
    bad = [f for f in facts if f["tag"] not in valid or not f["sources"]]
    check(not bad, f"untagged facts: {bad}")
    counts = {tag: sum(1 for f in facts if f["tag"] == tag) for tag in valid}
    check(counts["VERIFIED"] >= 20 and counts["UNVERIFIED"] >= 5, f"tag counts {counts}")
    return f"{len(facts)} facts tagged: {counts}"


def _code_only(text: str) -> str:
    """Strip comments and docstrings so documentation examples are not flagged."""
    text = re.sub(r'""".*?"""', "", text, flags=re.S)
    text = re.sub(r"'''.*?'''", "", text, flags=re.S)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r"#[^\n]*", "", text)
    return text


@case("BJ-03", "9", "No hard-coded pin numbers in backend or frontend runtime code", "infra",
      "zero PIN_<number> literals outside board.json, specs and tests")
def bj_03() -> str:
    offenders = []
    pattern = re.compile(r"PIN_[0-9]")
    targets = list(BACKEND.glob("*.py")) + [frontend_dir() / "app.js", frontend_dir() / "board3d.js"]
    for path in targets:
        if not path.exists():
            continue
        code = _code_only(path.read_text(encoding="utf-8", errors="replace"))
        for line_no, line in enumerate(code.splitlines(), 1):
            if pattern.search(line):
                offenders.append(f"{path.name}:{line_no}: {line.strip()[:80]}")
    check(not offenders, f"hard-coded pins: {offenders}")
    return f"scanned {len(targets)} runtime files, no PIN_<n> literals"


@case("BJ-04", "9", "Backend profile is loaded from board.json (not duplicated)", "infra",
      "BOARD pins, SEG map, I2C addresses and SDRAM DQ equal board.json")
def bj_04() -> str:
    from backend.device import BOARD, DEVICE, SEG_BIT_MAP
    data = json.loads(BOARD_JSON.read_text(encoding="utf-8"))
    check(BOARD["leds"]["pins"] == data["board"]["leds"]["pins"], "LED pins differ")
    check(BOARD["displays"]["segBitMap"] == data["board"]["displays"]["segBitMap"], "SEG map differs")
    check(BOARD["sdram"]["DQ"] == data["board"]["sdram"]["DQ"], "SDRAM DQ differs")
    check(BOARD["i2c"]["eeprom"]["address"] == data["board"]["i2c"]["buses"][0]["device"]["address"],
          "EEPROM address differs")
    check(SEG_BIT_MAP == data["board"]["displays"]["segBitMap"], "SEG_BIT_MAP differs")
    check(DEVICE()["userIo"] == data["devices"]["ep4ce6"]["userIo"], "user I/O differs")
    return "backend BOARD/DEVICE mirror board.json"


@case("BJ-05", "9", "All board.json pins are valid EQFP-144 and uniquely owned", "infra",
      "every pin in 1..144; only KEY/DIP share pins 88-91 by design")
def bj_05() -> str:
    data = json.loads(BOARD_JSON.read_text(encoding="utf-8"))
    owners: dict = {}
    for name, pins in data["pinMap"].items():
        if name in ("FPGA_CLK", "CLK"):
            continue
        for pin in pins:
            number = int(pin.split("_")[1])
            check(1 <= number <= 144, f"{name} -> {pin} outside the package")
            owners.setdefault(pin, []).append(name)
    conflicts = {pin: names for pin, names in owners.items() if len(names) > 1}
    allowed = {"PIN_88", "PIN_89", "PIN_90", "PIN_91"}
    unexpected = {pin: names for pin, names in conflicts.items() if pin not in allowed}
    check(not unexpected, f"unexpected sharing: {unexpected}")
    return f"{len(data['pinMap'])} pin entries; only KEY/DIP share nets"


@case("BJ-06", "9", "GET /api/board serves the canonical profile to the frontend", "infra",
      "endpoint returns the board.json content plus the selected device")
def bj_06() -> str:
    from fastapi.testclient import TestClient
    from backend.server import app
    data = json.loads(BOARD_JSON.read_text(encoding="utf-8"))
    with TestClient(app) as client:
        response = client.get("/api/board")
        check(response.status_code == 200, f"status {response.status_code}")
        body = response.json()
        check(body.get("ok") is True, f"body {body}")
        check(body["board"]["name"] == data["board"]["name"], "board name differs")
        check(body["board"]["pinMap"] == data["pinMap"], "pinMap differs")
        check(body["device"]["part"] == "EP4CE6E22C8N", "device differs")
    return "/api/board returns board.json + device"
