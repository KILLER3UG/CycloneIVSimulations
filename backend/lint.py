"""Static lint passes that GHDL does not perform.

Currently: combinational-loop detection. GHDL settles ``a <= not a`` to a
stable value and reports a normal result, so the simulator must diagnose it
itself (OUT-13). Only *concurrent* assignments are checked — a clocked
``q <= q + 1`` inside a process is a register, not a loop.
"""
from __future__ import annotations

import re
from typing import Dict, List, Tuple

_ASSIGN_RE = re.compile(r"^\s*([A-Za-z_]\w*)\s*<=\s*(.+?)\s*;?\s*$")
_PROCESS_START = re.compile(r"^\s*(?:\w+\s*:\s*)?process\b", re.IGNORECASE)
_PROCESS_END = re.compile(r"^\s*end\s+process\b", re.IGNORECASE)
_VLOG_ASSIGN = re.compile(r"^\s*assign\s+([A-Za-z_]\w*)\s*=\s*(.+?)\s*;\s*$")


def _lint_vhdl(name: str, source: str) -> List[dict]:
    out: List[dict] = []
    depth = 0
    for lineno, raw in enumerate(source.splitlines(), 1):
        line = raw.split("--", 1)[0]
        if _PROCESS_START.search(line):
            depth += 1
            continue
        if _PROCESS_END.search(line):
            depth = max(0, depth - 1)
            continue
        if depth > 0:
            continue
        match = _ASSIGN_RE.match(line)
        if not match:
            continue
        lhs, rhs = match.group(1), match.group(2)
        if re.search(rf"\b{re.escape(lhs)}\b", rhs, re.IGNORECASE):
            out.append({
                "file": name,
                "line": lineno,
                "column": 1,
                "severity": "warning",
                "message": (
                    f"Combinational loop: '{lhs}' depends on itself "
                    "(concurrent assignment with no register)"
                ),
            })
    return out


def _lint_verilog(name: str, source: str) -> List[dict]:
    out: List[dict] = []
    for lineno, raw in enumerate(source.splitlines(), 1):
        line = raw.split("//", 1)[0]
        match = _VLOG_ASSIGN.match(line)
        if not match:
            continue
        lhs, rhs = match.group(1), match.group(2)
        if re.search(rf"\b{re.escape(lhs)}\b", rhs):
            out.append({
                "file": name,
                "line": lineno,
                "column": 1,
                "severity": "warning",
                "message": f"Combinational loop: '{lhs}' depends on itself (continuous assign)",
            })
    return out


def lint_combinational_loops(sources: List[Tuple[str, str]]) -> List[dict]:
    """Return loop warnings for every VHDL/Verilog source in ``sources``."""
    out: List[dict] = []
    for name, content in sources:
        lower = name.lower()
        if lower.endswith((".vhd", ".vhdl")):
            out.extend(_lint_vhdl(name, content))
        elif lower.endswith((".v", ".sv")):
            out.extend(_lint_verilog(name, content))
    return out


__all__ = ["lint_combinational_loops"]