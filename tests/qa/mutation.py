"""Mutation testing: inject a bug, confirm a test catches it.

For each mutation the script copies the repository to a throw-away directory,
applies one change, runs the test that should catch it, and records whether
the test failed (mutation KILLED) or still passed (mutation SURVIVED).

A surviving mutation means a missing test; every survivor here is a real gap.

Run:  python tests/qa/mutation.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SKIP = shutil.ignore_patterns(".git", "__pycache__", ".pytest_cache", "node_modules",
                              "frontend/vendor", "*.pyc", ".audit-scratch")


def _set_json(path: Path, pointer: list, value) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    node = data
    for key in pointer[:-1]:
        node = node[key]
    node[pointer[-1]] = value
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _swap_json_pins(path: Path, pointer: list, i: int, j: int) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    node = data
    for key in pointer[:-1]:
        node = node[key]
    pins = node[pointer[-1]]
    pins[i], pins[j] = pins[j], pins[i]
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _rotate_seg_bitmap(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    bitmap = data["board"]["displays"]["segBitMap"]
    for key in bitmap:
        bitmap[key] = (bitmap[key] + 1) % 8
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


MUTATIONS = [
    {
        "id": "M01", "file": "board/board.json",
        "fn": lambda root: _set_json(root / "board/board.json", ["board", "leds", "activeLow"], False),
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_board_profile_polarity_matches_spec", "-q"],
        "why": "LED polarity flipped",
    },
    {
        "id": "M02", "file": "board/board.json",
        "fn": lambda root: _swap_json_pins(root / "board/board.json", ["board", "leds", "pins"], 0, 1),
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_structured_pins_match_pin_map", "-q"],
        "why": "LED1/LED2 pins swapped",
    },
    {
        "id": "M03", "file": "board/board.json",
        "fn": lambda root: _set_json(root / "board/board.json", ["board", "displays", "segBitMap", "a"], 3),
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_seg_bit_map_matches_schematic", "-q"],
        "why": "SEG bit map a:0 -> a:3 (collides with d)",
    },
    {
        "id": "M04", "file": "board/board.json",
        "fn": lambda root: _set_json(root / "board/board.json",
                                     ["board", "i2c", "buses", 0, "device", "address"], 81),
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_eeprom_write_protect_is_modelled", "-q"],
        "why": "EEPROM address 0x50 -> 0x51",
    },
    {
        "id": "M05", "file": "backend/qsf_parser.py",
        "old": "            if pin in seen_pin_targets and seen_pin_targets[pin] != slot:",
        "new": "            if False:",
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_qsf_duplicate_pin_is_an_error", "-q"],
        "why": "cross-port duplicate-pin check disabled",
    },
    {
        "id": "M06", "file": "backend/peripherals.py",
        "old": "                value |= (level & 1) << k",
        "new": "                value |= (level & 1) << (7 - k)",
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_decode_uart_lsb_first_and_baud", "-q"],
        "why": "UART bit order reversed (MSB first)",
    },
    {
        "id": "M07", "file": "backend/peripherals.py",
        "old": "    freq = int(round(1e9 / (2 * half))) if half > 0 else 0",
        "new": "    freq = int(round(1e9 / half)) if half > 0 else 0",
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_decode_buzzer_frequency_and_silence", "-q"],
        "why": "buzzer frequency formula halved",
    },
    {
        "id": "M08", "file": "board/models/at24c08.vhd",
        "old": "                        sda_out <= '0' when tmp(7 - bits) = '0' else 'Z';",
        "new": "                        sda_out <= '0' when tmp(bits) = '0' else 'Z';",
        "test": ["tests/run_all.py", "--filter", "OD-04"],
        "why": "AT24C08 read bit order reversed",
    },
    {
        "id": "M09", "file": "board/models/ir_nec.vhd",
        "old": "        wait for 9 ms;",
        "new": "        wait for 8 ms;",
        "test": ["tests/run_all.py", "--filter", "PR-06"],
        "why": "NEC lead burst 9 ms -> 8 ms",
    },
    {
        "id": "M10", "file": "board/models/ps2_keyboard.vhd",
        "old": "            ps_data_int <= not parity;",
        "new": "            ps_data_int <= parity;",
        "test": ["tests/run_all.py", "--filter", "PR-03"],
        "why": "PS/2 parity inverted (even instead of odd)",
    },
    {
        "id": "M11", "file": "backend/testbench_gen.py",
        "old": "        release_value = \"'0'\" if config.reset_active_high else \"'1'\"",
        "new": "        release_value = \"'1'\" if config.reset_active_high else \"'0'\"",
        "test": ["tests/run_all.py", "--filter", "SPEC-01"],
        "why": "reset never released in the auto testbench",
    },
    {
        "id": "M13", "file": "backend/testbench_gen.py",
        "old": "    if reset is not None:\n        assert_value =",
        "new": "    if False:\n        assert_value =",
        "test": ["tests/run_all.py", "--filter", "SPEC-01"],
        "why": "reset pulse generation dropped from the auto testbench",
    },
    {
        "id": "M14", "file": "backend/waveform.py",
        "old": "\"activeLow\": BOARD[\"leds\"].get(\"activeLow\", False),",
        "new": "\"activeLow\": not BOARD[\"leds\"].get(\"activeLow\", False),",
        "test": ["tests/run_all.py", "--filter", "POL-01"],
        "why": "LED polarity handling inverted in the backend board map",
    },
    {
        "id": "M15", "file": "board/board.json",
        "fn": lambda root: _rotate_seg_bitmap(root / "board/board.json"),
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_seg_bit_map_matches_schematic", "-q"],
        "why": "segBitMap shifted by one bit (every segment index +1 mod 8)",
    },
    {
        "id": "M16", "file": "backend/peripherals.py",
        "old": "    baud = int(round(1e9 / bit_time))",
        "new": "    baud = int(round(1e9 / (2 * bit_time)))",
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_decode_uart_lsb_first_and_baud", "-q"],
        "why": "UART bit time interpretation halved (baud formula wrong)",
    },
    {
        "id": "M17", "file": "backend/qsf_parser.py",
        "old": "        line = _strip_inline_comment(raw).strip()",
        "new": "        line = raw.strip()",
        "test": ["tests/run_all.py", "--filter", "QE-01"],
        "why": "inline comment stripping removed (audit M5 regression)",
    },
    {
        "id": "M12", "file": "board/board.json",
        "fn": lambda root: _set_json(root / "board/board.json", ["board", "buzzer", "activeLow"], False),
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_board_profile_polarity_matches_spec", "-q"],
        "why": "buzzer polarity flipped",
    },
    {
        # audit N7 / ENG-07 mitigation: the pre-scan must actually reject
        "id": "M18", "file": "backend/simulator.py",
        "old": "    for filename, content in sources:\n        clean = _strip_vhdl_comments_keep_lines(content)",
        "new": "    for filename, content in []:\n        clean = _strip_vhdl_comments_keep_lines(content)",
        "test": ["tests/run_all.py", "--filter", "RB-05"],
        "why": "ENG-07 textio absolute-path pre-scan disabled (scans nothing)",
    },
    {
        # audit N3 / BLK-03: the PLL-count warning must actually fire
        "id": "M19", "file": "backend/simulator.py",
        "old": "    pll_instantiations = len(\n        _ALTPLL_NAME_RE.findall(_ALTPLL_COMPONENT_DECL_RE.sub(\" \", clean))\n    )",
        "new": "    pll_instantiations = 0",
        "test": ["tests/run_all.py", "--filter", "BLK-03"],
        "why": "PLL-count warning removed (estimator reports 0 ALTPLLs)",
    },
    {
        # audit N1: every per-run generation guard removed at once (a single
        # guard would be caught by one of the others - the bug is the family)
        "id": "M20", "file": "backend/session.py",
        "edits": [
            ["if stop_event.is_set() or self._run_id_stale(run_id):", "if False:"],
            ["if self._run_id_stale(run_id) or self._state == \"stopped\":", "if False:"],
            ["if run_id != self._run_seq or self._state == \"stopped\":", "if False:"],
            ["if pump_task is not None and not pump_task.done():", "if False:"],
        ],
        "test": ["-m", "pytest", "tests/test_session.py::test_replaced_run_never_streams_stale_results", "-q"],
        "why": "session per-run generation guards removed (stale-run hijack restored)",
    },
    {
        # audit N2: value_at must really bisect over the transition times
        "id": "M21", "file": "backend/waveform.py",
        "old": "        index = bisect.bisect_right(self._time_index(), time_ns)",
        "new": "        index = 0",
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_waveform_value_at_matches_linear_reference_on_random_times", "-q"],
        "why": "waveform value_at bisect broken (always returns the initial value)",
    },
    {
        # audit N2: the serialized transition cap must really apply
        "id": "M22", "file": "backend/waveform.py",
        "old": "                for time, value in _decimate_transitions(\n                    self.transitions, MAX_SERIALIZED_TRANSITIONS\n                )",
        "new": "                for time, value in self.transitions",
        "test": ["-m", "pytest", "tests/test_audit_units.py::test_waveform_to_dict_respects_the_transition_cap_and_is_deterministic", "-q"],
        "why": "to_dict transition cap removed (every transition serialized)",
    },
]


def _apply(root: Path, mutation: dict) -> None:
    path = root / mutation["file"]
    if "fn" in mutation:
        mutation["fn"](root)
        return
    text = path.read_text(encoding="utf-8")
    if "edits" in mutation:
        # A multi-edit mutation removes a whole guard family (e.g. every
        # generation check of one defence) with one coherent change.
        for old, new in mutation["edits"]:
            if old not in text:
                raise RuntimeError(
                    f"{mutation['id']}: pattern not found in {mutation['file']}: {old[:60]!r}"
                )
            text = text.replace(old, new, 1)
        path.write_text(text, encoding="utf-8")
        return
    old = mutation["old"]
    if old not in text:
        raise RuntimeError(f"{mutation['id']}: pattern not found in {mutation['file']}")
    path.write_text(text.replace(old, mutation["new"], 1), encoding="utf-8")


def _run_test(root: Path, command: list) -> tuple[bool, str]:
    started = time.time()
    try:
        proc = subprocess.run([sys.executable] + command, cwd=str(root),
                              capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return True, "TIMEOUT (treated as killed)"
    elapsed = time.time() - started
    output = (proc.stdout or "") + (proc.stderr or "")
    if command[0] == "-m":
        killed = proc.returncode != 0
    else:
        killed = "[FAIL]" in output
    return killed, f"rc={proc.returncode} {elapsed:.1f}s {output.strip().splitlines()[-1][:100] if output.strip() else ''}"


def main() -> int:
    results = []
    for mutation in MUTATIONS:
        tmp = Path(tempfile.mkdtemp(prefix="cyclone_mutant_"))
        try:
            root = tmp / "repo"
            shutil.copytree(ROOT, root, ignore=SKIP)
            _apply(root, mutation)
            killed, detail = _run_test(root, mutation["test"])
            results.append((mutation["id"], mutation["why"], killed, detail))
            print(f"[{'KILLED' if killed else 'SURVIVED'}] {mutation['id']} {mutation['why']} -- {detail}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    survived = [r for r in results if not r[2]]
    lines = [
        "# Mutation testing results",
        "",
        f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"Mutations: {len(results)}  Killed: {len(results) - len(survived)}  Survived: {len(survived)}",
        "",
        "| ID | Injected bug | Result | Evidence |",
        "| --- | --- | --- | --- |",
    ]
    for identifier, why, killed, detail in results:
        lines.append(f"| {identifier} | {why} | {'KILLED' if killed else 'SURVIVED'} | {detail} |")
    lines.append("")
    lines.append("A KILLED mutation means at least one test fails when the bug is present,"
                 " so the behaviour is actually covered. A SURVIVED mutation is a missing test.")
    lines.append("")
    (ROOT / "tests" / "MUTATION_REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    print()
    print(f"{len(results) - len(survived)}/{len(results)} mutations killed; report: tests/MUTATION_REPORT.md")
    return 1 if survived else 0


if __name__ == "__main__":
    raise SystemExit(main())
