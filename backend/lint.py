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

# Invisible / “smart” characters that copy-paste from web pages and PDFs
# introduces. They look identical to ASCII but break the VHDL/Verilog parser
# with cryptic errors such as `missing ";" at end of architecture`.
_CONFUSABLE = {
    0x00A0: "non-breaking space (use a normal space)",
    0x2018: "left single quotation mark (use ')",
    0x2019: "right single quotation mark (use ')",
    0x201C: "left double quotation mark (use \")",
    0x201D: "right double quotation mark (use \")",
    0x2013: "en dash (use '-')",
    0x2014: "em dash (use '-')",
    0x2026: "ellipsis (use '...')",
    0x00B5: "micro sign (use 'u')",
    0x2212: "minus sign (use '-')",
}
_MAX_CHAR_WARNINGS = 25


def _code_part(line: str, prefixes: Tuple[str, ...]) -> str:
    idx = None
    for p in prefixes:
        j = line.find(p)
        if j != -1 and (idx is None or j < idx):
            idx = j
    return line if idx is None else line[:idx]


def lint_non_ascii(sources: List[Tuple[str, str]]) -> List[dict]:
    """Flag invisible/smart characters outside comments (they break the parser)."""
    out: List[dict] = []
    for name, content in sources:
        lower = name.lower()
        if lower.endswith((".vhd", ".vhdl")):
            prefixes: Tuple[str, ...] = ("--",)
        elif lower.endswith((".v", ".sv")):
            prefixes = ("//",)
        else:
            continue
        for lineno, raw in enumerate(content.splitlines(), 1):
            code = _code_part(raw, prefixes)
            for col, ch in enumerate(code, 1):
                codepoint = ord(ch)
                if codepoint <= 127:
                    continue
                desc = _CONFUSABLE.get(codepoint, "non-ASCII character")
                out.append({
                    "file": name,
                    "line": lineno,
                    "column": col,
                    "severity": "warning",
                    "message": (
                        f"Non-ASCII character U+{codepoint:04X} — {desc} at line "
                        f"{lineno}, column {col}. VHDL/Verilog sources must be plain "
                        "ASCII here; retype this character."
                    ),
                })
                if len(out) >= _MAX_CHAR_WARNINGS:
                    return out
    return out


def lint_sources(sources: List[Tuple[str, str]]) -> List[dict]:
    """All static lint passes for a set of sources."""
    return lint_combinational_loops(sources) + lint_non_ascii(sources)
