"""Diagnostic-hint tests: cryptic GHDL syntax errors get plain-language hints."""
from backend.simulator import SimulationRequest, Simulator, _augment_syntax_hints

BROKEN_SEMI = """library ieee;
use ieee.std_logic_1164.all;
entity broken_semi is
    port (y : out std_logic);
end entity broken_semi;
architecture rtl of broken_semi is
begin
    y <= '1'
end architecture rtl;
"""


def test_augment_adds_hint_to_missing_semi():
    for msg in ('missing ";" at end of architecture', "';' expected at end of signal assignment"):
        out = _augment_syntax_hints([{"message": msg, "line": 9, "column": 1, "severity": "error"}])
        assert "';' is missing at the end of the previous statement" in out[0]["message"]
        assert out[0]["line"] == 9


def test_augment_leaves_other_errors_alone():
    errors = [{"message": "some other error", "line": 1, "column": 1, "severity": "error"}]
    assert _augment_syntax_hints(errors) == errors


def test_missing_semi_compile_reports_hint():
    result = Simulator().simulate(SimulationRequest.from_dict({"vhdl": BROKEN_SEMI, "duration": 10}))
    assert not result["ok"]
    msgs = " | ".join(e.get("message", "") for e in result.get("errors", []))
    assert "';' expected at end of" in msgs or 'missing ";"' in msgs, msgs
    assert "';' is missing at the end of the previous statement" in msgs, msgs
    assert "check the line above" in msgs