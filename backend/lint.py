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
    return (lint_combinational_loops(sources)
            + lint_incomplete_sensitivity(sources)
            + lint_non_ascii(sources))


# ---------------------------------------------------------------------------
# Incomplete sensitivity lists (sim-vs-synthesis trap)
# ---------------------------------------------------------------------------
#
# A combinational VHDL process that reads a signal which is missing from its
# sensitivity list simulates with a *stale* output (IEEE 1076: the process
# only resumes on events of the listed signals), while Quartus synthesis
# treats every combinational process as complete-sensitive.  GHDL simulates
# the stale behaviour silently, so the lint flags the divergence the same way
# Quartus synthesis would.

_PROC_HEAD = re.compile(r"\bprocess\b", re.IGNORECASE)
_PROC_END = re.compile(r"^\s*end\s+process\b", re.IGNORECASE)
_SEQUENTIAL_BODY = re.compile(r"rising_edge|falling_edge|'event|\bwait\b", re.IGNORECASE)
_ASSIGN_TARGET = re.compile(
    r"^\s*[A-Za-z_]\w*(?:\s*\([^)]*\))?\s*(?:<=|:=)", re.IGNORECASE
)
_MAX_SENSITIVITY_WARNINGS = 8


def _process_spans(source: str) -> List[Tuple[List[str], List[str]]]:
    """Yield (sensitivity-list tokens, body lines) for every process.

    Only explicit, parenthesised sensitivity lists are returned; processes
    without one (``process`` + ``wait``) and ``process(all)`` are skipped by
    the caller.
    """
    lines = source.splitlines()
    spans: List[Tuple[List[str], List[str]]] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i].split("--", 1)[0]
        if not _PROC_HEAD.search(line):
            i += 1
            continue
        # Accumulate the process header until its parentheses balance so
        # multi-line sensitivity lists are handled.
        header = line
        start = i
        depth = header.count("(") - header.count(")")
        while depth > 0 and i + 1 < n:
            i += 1
            header += " " + lines[i].split("--", 1)[0]
            depth += lines[i].count("(") - lines[i].count(")")
        match = re.search(r"process\s*\(([^)]*)\)", header, re.IGNORECASE)
        if not match:
            i += 1
            continue
        sens_tokens = [t.strip() for t in match.group(1).split(",") if t.strip()]
        # Collect the body up to the matching `end process`.
        body: List[str] = []
        j = i + 1
        while j < n and not _PROC_END.match(lines[j]):
            body.append(lines[j])
            j += 1
        spans.append((sens_tokens, body))
        i = j + 1
    return spans


def lint_incomplete_sensitivity(sources: List[Tuple[str, str]]) -> List[dict]:
    """Warn when a combinational process reads a signal outside its list."""
    out: List[dict] = []
    for name, content in sources:
        if not name.lower().endswith((".vhd", ".vhdl")):
            continue
        try:
            from .vhdl_parser import VHDLParser

            port_names = [
                p.name for e in VHDLParser().parse(content).entities for p in e.ports
            ]
        except Exception:
            port_names = []
        if not port_names:
            continue
        for sens_tokens, body in _process_spans(content):
            if not sens_tokens:
                continue  # no list: the process uses wait statements
            lowered = {t.lower() for t in sens_tokens}
            if "all" in lowered:
                continue  # VHDL-2008 complete sensitivity
            body_text = "\n".join(body)
            if _SEQUENTIAL_BODY.search(body_text):
                continue  # clocked/sequential process: different rule
            # Blank out assignment targets so only *reads* remain, and strip
            # comments so a mentioned port name in a comment cannot warn.
            read_text = "\n".join(
                _ASSIGN_TARGET.sub(" ", raw.split("--", 1)[0]) for raw in body
            )
            for port in port_names:
                if port.lower() in lowered:
                    continue
                if not re.search(rf"\b{re.escape(port)}\b", read_text, re.IGNORECASE):
                    continue
                out.append({
                    "file": name,
                    "line": 1,
                    "column": 1,
                    "severity": "warning",
                    "message": (
                        f"incomplete sensitivity list: the process reads '{port}' "
                        f"but only lists ({', '.join(sens_tokens)}). RTL simulation "
                        "holds the previous output when only '" + port + "' changes, "
                        "while Quartus synthesis treats the process as "
                        "complete-sensitive — add '" + port + "' to the sensitivity "
                        "list or use process(all)"
                    ),
                })
                break  # one warning per process
            if len(out) >= _MAX_SENSITIVITY_WARNINGS:
                return out
    return out
