"""Lightweight synthesizable Verilog-2001 front-end and VHDL-2008 translator.

Parses Verilog ``module`` declarations into :class:`backend.vhdl_parser.Entity`
interfaces and lowers synthesizable RTL (``assign``, ``always @(posedge ...)``,
``always @(*)``, ``wire``/``reg``, ``parameter``/``localparam``, ``if/else``,
``case``, module instantiations, concatenations, and bitwise/arithmetic/ternary
expressions) into self-contained VHDL-2008 units for GHDL compilation and
simulation while mapping diagnostics back to the original ``.v`` file and line.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .vhdl_parser import Design, Entity, Generic, Port

_VERILOG_KEYWORDS = {
    "always", "and", "assign", "begin", "buf", "bufif0", "bufif1", "case",
    "casex", "casez", "cmos", "deassign", "default", "defparam", "disable",
    "edge", "else", "end", "endcase", "endfunction", "endmodule", "endprimitive",
    "endspecify", "endtable", "endtask", "event", "for", "force", "forever",
    "fork", "function", "generate", "genvar", "highz0", "highz1", "if",
    "ifnone", "initial", "inout", "input", "integer", "join", "large",
    "localparam", "macromodule", "medium", "module", "nand", "negedge", "nmos",
    "nor", "not", "notif0", "notif1", "or", "output", "parameter", "pmos",
    "posedge", "primitive", "pull0", "pull1", "pulldown", "pullup", "rcmos",
    "real", "realtime", "reg", "release", "repeat", "rnmos", "rpmos", "rtran",
    "rtranif0", "rtranif1", "scalared", "signed", "small", "specify", "specparam",
    "strong0", "strong1", "supply0", "supply1", "table", "task", "time", "tran",
    "tranif0", "tranif1", "tri", "tri0", "tri1", "triand", "trior", "trireg",
    "unsigned", "vectored", "wait", "wand", "weak0", "weak1", "while", "wire",
    "wor", "xnor", "xor", "logic",
}

_VHDL_RESERVED = {
    "abs", "access", "after", "alias", "all", "and", "architecture", "array",
    "assert", "attribute", "begin", "block", "body", "buffer", "bus", "case",
    "component", "configuration", "constant", "disconnect", "downto", "else",
    "elsif", "end", "entity", "exit", "file", "for", "function", "generate",
    "generic", "group", "guarded", "if", "impure", "in", "inertial", "inout",
    "is", "label", "library", "linkage", "literal", "loop", "map", "mod",
    "nand", "new", "next", "nor", "not", "null", "of", "on", "open", "or",
    "others", "out", "package", "port", "postponed", "procedure", "process",
    "pure", "range", "record", "register", "reject", "rem", "report", "return",
    "rol", "ror", "select", "severity", "shared", "signal", "sla", "sll", "sra",
    "srl", "subtype", "then", "to", "transport", "type", "unaffected", "units",
    "until", "use", "variable", "wait", "when", "while", "with", "xnor", "xor",
}

_VERILOG_SYNTAX_RE = re.compile(
    r"^\s*(?:endmodule\b|always(?:_ff|_comb|_latch)?\s*(?:@|\b)|module\s+[A-Za-z_]\w*\s*(?:\(|#|;))",
    re.IGNORECASE | re.MULTILINE,
)

_COMMENT_RE = re.compile(r"/\*.*?\*/|//[^\n]*", re.DOTALL)


def is_verilog_source(name: str, code: str) -> bool:
    """Return True if this source should be handled as Verilog."""
    lower = (name or "").lower()
    if lower.endswith((".v", ".sv")):
        return True
    cleaned = strip_verilog_comments(code)
    has_vhdl = bool(re.search(r"\bentity\s+[A-Za-z_]\w*\s+is\b", cleaned, re.IGNORECASE))
    return bool(_VERILOG_SYNTAX_RE.search(cleaned)) and not has_vhdl


def strip_verilog_comments(code: str) -> str:
    """Replace comments with spaces/newlines so line numbers stay unchanged."""
    def _repl(m: re.Match) -> str:
        text = m.group(0)
        if text.startswith("/*"):
            return "\n" * text.count("\n")
        return ""

    return _COMMENT_RE.sub(_repl, code)


@dataclass
class _VTok:
    kind: str
    value: str
    line: int
    column: int


_VTOK_RE = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<sized>(?:\d+)?\s*'[sS]?[bBdDhHoO][0-9a-fA-F_xXzZ\?]+)
  | (?P<number>\d[\d_]*)
  | (?P<ident>[A-Za-z_`\$][A-Za-z0-9_\$]*)
  | (?P<op>===|!==|==|!=|<=|>=|<<|>>|&&|\|\||~&|~\||~\^|\^~|[\+\-\*/%&\|\^~!<>=\?:;\.,\(\)\[\]\{\}@#])
  | (?P<other>.)
    """,
    re.VERBOSE,
)


def _tokenize_verilog(code: str) -> List[_VTok]:
    clean = strip_verilog_comments(code)
    out: List[_VTok] = []
    line = 1
    col = 1
    pos = 0
    n = len(clean)
    while pos < n:
        m = _VTOK_RE.match(clean, pos)
        if not m:  # pragma: no cover
            pos += 1
            col += 1
            continue
        kind = m.lastgroup or "other"
        val = m.group()
        if kind == "ws":
            nl = val.count("\n")
            if nl:
                line += nl
                col = len(val.rsplit("\n", 1)[-1]) + 1
            else:
                col += len(val)
        else:
            out.append(_VTok(kind, val, line, col))
            col += len(val)
        pos = m.end()
    return out


def _err(filename: str, line: int, col: int, message: str) -> dict:
    return {
        "file": filename,
        "line": max(1, int(line)),
        "column": max(1, int(col)),
        "severity": "error",
        "message": message,
    }


def _eval_int(expr_tokens: List[_VTok], params: Dict[str, int]) -> Optional[int]:
    """Evaluate a small constant integer expression used in bounds/parameters."""
    if not expr_tokens:
        return None
    parts: List[str] = []
    for tok in expr_tokens:
        if tok.kind == "number":
            parts.append(tok.value.replace("_", ""))
        elif tok.kind == "sized":
            lit = _parse_sized_literal(tok.value)
            if lit is None or lit[2]:
                return None
            parts.append(str(lit[1]))
        elif tok.kind == "ident":
            if tok.value in params:
                parts.append(str(params[tok.value]))
            else:
                return None
        elif tok.value in ("+", "-", "*", "/", "%", "(", ")"):
            parts.append("//" if tok.value == "/" else tok.value)
        else:
            return None
    try:
        return int(eval(" ".join(parts), {"__builtins__": {}}, {}))  # noqa: S307
    except Exception:
        return None


def _parse_sized_literal(text: str) -> Optional[Tuple[Optional[int], int, bool, str]]:
    """Return ``(width_or_None, int_val, has_xz, bits_msb_to_lsb)``."""
    m = re.match(r"^(?:(\d+)\s*)?'[sS]?([bBdDhHoO])([0-9a-fA-F_xXzZ\?]+)$", text.strip())
    if not m:
        return None
    w_str, base_ch, digits = m.groups()
    width = int(w_str) if w_str else None
    digits = digits.replace("_", "").lower()
    base = base_ch.lower()
    has_xz = any(c in "xz?" for c in digits)
    if base == "b":
        bits = "".join("0" if c == "?" else c for c in digits)
        int_val = int(bits, 2) if not has_xz else 0
        w = width or len(bits)
        bits = bits.rjust(w, bits[0] if bits and bits[0] in "xz" else "0")[-w:]
        return width, int_val, has_xz, bits
    if base == "d":
        if has_xz:
            w = width or 32
            return width, 0, True, (digits[0] * w)[:w]
        int_val = int(digits, 10)
        w = width or max(1, int_val.bit_length())
        return width, int_val, False, format(int_val, f"0{w}b")[-w:]
    if base == "h":
        bits = "".join(
            (c * 4) if c in "xz" else ("0000" if c == "?" else format(int(c, 16), "04b"))
            for c in digits
        )
        int_val = int(bits, 2) if not has_xz else 0
        w = width or len(bits)
        bits = bits.rjust(w, bits[0] if bits and bits[0] in "xz" else "0")[-w:]
        return width, int_val, has_xz, bits
    if base == "o":
        bits = "".join(
            (c * 3) if c in "xz" else ("000" if c == "?" else format(int(c, 8), "03b"))
            for c in digits
        )
        int_val = int(bits, 2) if not has_xz else 0
        w = width or len(bits)
        bits = bits.rjust(w, bits[0] if bits and bits[0] in "xz" else "0")[-w:]
        return width, int_val, has_xz, bits
    return None


@dataclass
class _DeclInfo:
    name: str
    direction: Optional[str]  # in / out / inout / None
    is_reg: bool = False
    is_vector: bool = False
    left: int = 0
    right: int = 0
    width: int = 1
    init_tokens: Optional[List[_VTok]] = None
    line: int = 1
    col: int = 1
    vhdl_name: str = ""


def _safe_vhdl_name(name: str, used_lower: Dict[str, str], prefer_exact: bool = False) -> str:
    low = name.lower()
    if prefer_exact and low not in _VHDL_RESERVED:
        if low not in used_lower or used_lower[low] == name:
            used_lower[low] = name
            return name
    if low in _VHDL_RESERVED:
        cand = f"v_{name}"
    elif low in used_lower and used_lower[low] != name:
        cand = f"{name}_cs"
    else:
        cand = name
    idx = 2
    base = cand
    while cand.lower() in used_lower and used_lower[cand.lower()] != cand:
        cand = f"{base}_{idx}"
        idx += 1
    used_lower[cand.lower()] = cand
    return cand


def _range_props(msb: int, lsb: int) -> Tuple[bool, int, int, int]:
    width = abs(msb - lsb) + 1
    return True, msb, lsb, width


def _parse_range(toks: List[_VTok], i: int, params: Dict[str, int]) -> Tuple[Optional[Tuple[int, int]], int]:
    if i >= len(toks) or toks[i].value != "[":
        return None, i
    depth = 0
    colon_idx = -1
    end_idx = i
    while end_idx < len(toks):
        v = toks[end_idx].value
        if v == "[":
            depth += 1
        elif v == "]":
            depth -= 1
            if depth == 0:
                break
        elif v == ":" and depth == 1 and colon_idx < 0:
            colon_idx = end_idx
        end_idx += 1
    if depth != 0 or colon_idx < 0:
        return None, i
    msb = _eval_int(toks[i + 1 : colon_idx], params)
    lsb = _eval_int(toks[colon_idx + 1 : end_idx], params)
    if msb is None or lsb is None:
        msb, lsb = 0, 0
    return (msb, lsb), end_idx + 1


def _find_matching(toks: List[_VTok], i: int, open_ch: str, close_ch: str) -> int:
    depth = 0
    n = len(toks)
    while i < n:
        if toks[i].value == open_ch:
            depth += 1
        elif toks[i].value == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


@dataclass
class _ExprResult:
    vhdl: str
    is_scalar: bool
    width: int


class _VerilogTranslator:
    """Translate a single parsed Verilog module into VHDL-2008."""

    def __init__(self, filename: str, toks: List[_VTok], known_modules: Dict[str, List[Port]]) -> None:
        self.filename = filename
        self.toks = toks
        self.known_modules = known_modules
        self.errors: List[dict] = []
        self.params: Dict[str, int] = {}
        self.param_decls: List[Tuple[str, int, int]] = []
        self.ports: List[_DeclInfo] = []
        self.sigs: Dict[str, _DeclInfo] = {}
        self.used_lower: Dict[str, str] = {}
        self.blocking_vars: Dict[str, _DeclInfo] = {}
        self.out_shadows: Dict[str, str] = {}
        self.in_comb_process = False
        self.comb_blocking_targets: set[str] = set()
        self.lines: List[Tuple[str, int]] = []  # (line_text, orig_verilog_line)
        self.assoc_counter = 0
        self.extra_concurrent: List[Tuple[str, int]] = []
        self.extra_signals: List[Tuple[str, int]] = []

    def _emit(self, text: str, line: int) -> None:
        self.lines.append((text, max(1, line)))

    def _vhdl_ref(self, name: str) -> str:
        if self.in_comb_process and name in self.comb_blocking_targets:
            return f"bv_{self.sigs[name].vhdl_name}"
        if name in self.out_shadows:
            return self.out_shadows[name]
        if name in self.sigs:
            return self.sigs[name].vhdl_name
        return name

    def _decl_width(self, name: str) -> Tuple[bool, int]:
        if name in self.sigs:
            d = self.sigs[name]
            return (not d.is_vector), d.width
        return True, 1

    def parse_and_translate(self) -> Optional[Tuple[Entity, str, List[Tuple[str, int]]]]:
        toks = self.toks
        n = len(toks)
        i = 0
        while i < n and toks[i].value.startswith("`"):
            # Skip compiler directives like `timescale ...
            ln = toks[i].line
            while i < n and toks[i].line == ln:
                i += 1
        if i >= n or toks[i].value != "module":
            return None
        mod_tok = toks[i]
        i += 1
        if i >= n or toks[i].kind != "ident":
            self.errors.append(_err(self.filename, mod_tok.line, mod_tok.column, "Expected module name after 'module'"))
            return None
        mod_name = toks[i].value
        mod_line, mod_col = toks[i].line, toks[i].column
        i += 1

        # Optional #( parameter ... )
        if i < n and toks[i].value == "#":
            i += 1
            if i < n and toks[i].value == "(":
                end_p = _find_matching(toks, i, "(", ")")
                if end_p < 0:
                    self.errors.append(_err(self.filename, toks[i].line, toks[i].column, "Unclosed '#(' parameter list"))
                    return None
                self._parse_param_list(toks[i + 1 : end_p])
                i = end_p + 1

        # Port list (...)
        port_order: List[str] = []
        ansi_ports = False
        if i < n and toks[i].value == "(":
            end_ports = _find_matching(toks, i, "(", ")")
            if end_ports < 0:
                self.errors.append(_err(self.filename, toks[i].line, toks[i].column, "Unclosed module port list '('"))
                return None
            port_toks = toks[i + 1 : end_ports]
            ansi_ports = any(t.value in ("input", "output", "inout") for t in port_toks)
            if ansi_ports:
                self._parse_ansi_ports(port_toks)
            else:
                port_order = [t.value for t in port_toks if t.kind == "ident"]
            i = end_ports + 1
        if i >= n or toks[i].value != ";":
            tok = toks[min(i, n - 1)]
            self.errors.append(_err(self.filename, tok.line, tok.column, f"Missing ';' after module header '{mod_name}'"))
            return None
        i += 1

        # Find endmodule
        end_mod = -1
        for k in range(i, n):
            if toks[k].value == "endmodule":
                end_mod = k
                break
        if end_mod < 0:
            self.errors.append(_err(self.filename, mod_line, mod_col, f"Missing 'endmodule' for module '{mod_name}'"))
            return None
        body = toks[i:end_mod]

        # Collect declarations first, then behavioral/continuous items
        items: List[Tuple[str, List[_VTok]]] = []
        self._split_body(body, items, port_order, ansi_ports)
        if self.errors:
            return None

        # Order ports per module header if non-ANSI
        if not ansi_ports and port_order:
            ordered: List[_DeclInfo] = []
            for pname in port_order:
                if pname not in self.sigs or self.sigs[pname].direction is None:
                    self.errors.append(_err(self.filename, mod_line, mod_col, f"Port '{pname}' in module header has no input/output/inout declaration"))
                    return None
                ordered.append(self.sigs[pname])
            self.ports = ordered

        # Build Entity model for Simulator
        entity_ports: List[Port] = []
        for p in self.ports:
            dir_map = {"input": "in", "output": "out", "inout": "inout"}
            vhdl_dir = dir_map.get(p.direction or "input", "in")
            tname = "std_logic_vector" if p.is_vector else "std_logic"
            ttext = (
                f"std_logic_vector({p.left} {'downto' if p.left >= p.right else 'to'} {p.right})"
                if p.is_vector
                else "std_logic"
            )
            p.vhdl_name = _safe_vhdl_name(p.name, self.used_lower, prefer_exact=True)
            if vhdl_dir == "out":
                sh = _safe_vhdl_name(f"v_out_{p.name}", self.used_lower)
                self.out_shadows[p.name] = sh
            entity_ports.append(
                Port(
                    name=p.name,
                    direction=vhdl_dir,
                    type_name=tname,
                    type_text=ttext,
                    width=p.width,
                    left=p.left if p.is_vector else None,
                    right=p.right if p.is_vector else None,
                    downto=p.left >= p.right,
                    line=p.line,
                    column=p.col,
                )
            )
        entity_generics = [
            Generic(name=gn, type_name="integer", type_text="integer", default=str(val), line=ln, column=1)
            for gn, val, ln in self.param_decls
        ]
        entity = Entity(name=mod_name, ports=entity_ports, generics=entity_generics, line=mod_line, column=mod_col)

        for sig in self.sigs.values():
            if not sig.vhdl_name:
                sig.vhdl_name = _safe_vhdl_name(sig.name, self.used_lower)

        # Emit VHDL header & architecture helper functions
        self._emit("library IEEE;", mod_line)
        self._emit("use IEEE.STD_LOGIC_1164.ALL;", mod_line)
        self._emit("use IEEE.NUMERIC_STD.ALL;", mod_line)
        self._emit("", mod_line)
        self._emit(f"entity {mod_name} is", mod_line)
        if entity_generics:
            self._emit("    generic (", mod_line)
            for idx, (gn, val, ln) in enumerate(self.param_decls):
                sep = ";" if idx + 1 < len(self.param_decls) else ""
                self._emit(f"        {gn} : integer := {val}{sep}", ln)
            self._emit("    );", mod_line)
        if entity_ports:
            self._emit("    port (", mod_line)
            for idx, (p, ep) in enumerate(zip(self.ports, entity_ports)):
                sep = ";" if idx + 1 < len(entity_ports) else ""
                self._emit(f"        {p.vhdl_name} : {ep.direction} {ep.type_text}{sep}", p.line)
            self._emit("    );", mod_line)
        self._emit(f"end {mod_name};", mod_line)
        self._emit("", mod_line)
        self._emit(f"architecture verilog_rtl of {mod_name} is", mod_line)
        self._emit_vhdl_helpers(mod_line)

        # Declare signals & shadow outputs
        for p in self.ports:
            if p.name in self.out_shadows:
                ep = next(x for x in entity_ports if x.name == p.name)
                init_expr = "'0'" if not p.is_vector else "(others => '0')"
                if p.init_tokens:
                    init_expr = self._target_rhs_expr(p.init_tokens, not p.is_vector, p.width)
                self._emit(f"    signal {self.out_shadows[p.name]} : {ep.type_text} := {init_expr};", p.line)

        for sig in self.sigs.values():
            if sig.direction is not None:
                continue
            ttext = (
                f"std_logic_vector({sig.left} {'downto' if sig.left >= sig.right else 'to'} {sig.right})"
                if sig.is_vector
                else "std_logic"
            )
            init_expr = "'0'" if not sig.is_vector else "(others => '0')"
            if sig.init_tokens:
                init_expr = self._target_rhs_expr(sig.init_tokens, not sig.is_vector, sig.width)
            self._emit(f"    signal {sig.vhdl_name} : {ttext} := {init_expr};", sig.line)

        body_lines_start = len(self.lines)
        # Emit body items into temporary buffer so extra assoc signals can be declared first
        saved_lines = self.lines
        self.lines = []
        self._emit("begin", mod_line)
        for p in self.ports:
            if p.name in self.out_shadows:
                self._emit(f"    {p.vhdl_name} <= {self.out_shadows[p.name]};", p.line)

        for kind, stoks in items:
            if kind == "assign":
                self._emit_assign(stoks)
            elif kind == "always":
                self._emit_always(stoks)
            elif kind == "inst":
                self._emit_instantiation(stoks)

        for stmt, ln in self.extra_concurrent:
            self._emit(stmt, ln)
        self._emit("end verilog_rtl;", mod_line)
        arch_body = self.lines
        self.lines = saved_lines
        for decl, ln in self.extra_signals:
            self._emit(decl, ln)
        self.lines.extend(arch_body)

        if self.errors:
            return None
        vhdl_text = "\n".join(text for text, _ in self.lines) + "\n"
        return entity, vhdl_text, self.lines

    def _emit_vhdl_helpers(self, line: int) -> None:
        helpers = [
            "    function v_sl(b : boolean) return std_logic is begin if b then return '1'; else return '0'; end if; end function;",
            "    function v_bool(s : std_logic) return boolean is begin return s = '1'; end function;",
            "    function v_bool(v : std_logic_vector) return boolean is begin return unsigned(v) /= 0; end function;",
            "    function v_bool(n : integer) return boolean is begin return n /= 0; end function;",
            "    function v_u(v : std_logic_vector) return unsigned is begin return resize(unsigned(v), 64); end function;",
            "    function v_u(s : std_logic) return unsigned is variable r : unsigned(63 downto 0) := (others => '0'); begin r(0) := s; return r; end function;",
            "    function v_u(n : integer) return unsigned is begin return to_unsigned(n, 64); end function;",
            "    function v_bit(v : std_logic_vector) return std_logic is begin return v(v'right); end function;",
            "    function v_bit(s : std_logic) return std_logic is begin return s; end function;",
            "    function v_bit(n : integer) return std_logic is begin if (n mod 2) /= 0 then return '1'; else return '0'; end if; end function;",
            "    function v_eq(a : std_logic_vector; b : std_logic_vector) return std_logic is begin return v_sl(v_u(a) = v_u(b)); end function;",
            "    function v_eq(a : std_logic_vector; b : std_logic) return std_logic is begin return v_sl(v_u(a) = v_u(b)); end function;",
            "    function v_eq(a : std_logic; b : std_logic_vector) return std_logic is begin return v_sl(v_u(a) = v_u(b)); end function;",
            "    function v_eq(a : std_logic; b : std_logic) return std_logic is begin return v_sl(a = b); end function;",
            "    function v_eq(a : std_logic_vector; b : integer) return std_logic is begin return v_sl(v_u(a) = to_unsigned(b, 64)); end function;",
            "    function v_eq(a : std_logic; b : integer) return std_logic is begin return v_sl(a = v_bit(b)); end function;",
            "    function v_mux(c : boolean; t : std_logic_vector; f : std_logic_vector) return std_logic_vector is",
            "    begin if c then return t; else return f; end if; end function;",
            "    function v_mux(c : boolean; t : std_logic; f : std_logic) return std_logic is",
            "    begin if c then return t; else return f; end if; end function;",
        ]
        for h in helpers:
            self._emit(h, line)

    def _parse_param_list(self, toks: List[_VTok]) -> None:
        i = 0
        n = len(toks)
        while i < n:
            if toks[i].value in ("parameter", "localparam", ","):
                i += 1
                continue
            if toks[i].kind == "ident" and i + 2 < n and toks[i + 1].value == "=":
                name = toks[i].value
                j = i + 2
                depth = 0
                while j < n:
                    if toks[j].value in ("(", "["):
                        depth += 1
                    elif toks[j].value in (")", "]"):
                        depth -= 1
                    elif toks[j].value == "," and depth == 0:
                        break
                    j += 1
                val = _eval_int(toks[i + 2 : j], self.params)
                if val is not None:
                    self.params[name] = val
                    self.param_decls.append((name, val, toks[i].line))
                i = j + 1
            else:
                i += 1

    def _parse_ansi_ports(self, toks: List[_VTok]) -> None:
        i = 0
        n = len(toks)
        cur_dir = "input"
        cur_reg = False
        cur_vec = False
        cur_left = 0
        cur_right = 0
        cur_width = 1
        while i < n:
            t = toks[i]
            if t.value == ",":
                i += 1
                continue
            if t.value in ("input", "output", "inout"):
                cur_dir = t.value
                cur_reg = False
                cur_vec = False
                cur_left = 0
                cur_right = 0
                cur_width = 1
                i += 1
                while i < n and toks[i].value in ("wire", "reg", "logic", "signed", "unsigned"):
                    if toks[i].value in ("reg", "logic"):
                        cur_reg = True
                    i += 1
                if i < n and toks[i].value == "[":
                    rng, ni = _parse_range(toks, i, self.params)
                    if rng:
                        cur_vec, cur_left, cur_right, cur_width = _range_props(rng[0], rng[1])
                        i = ni
                continue
            if t.value in ("wire", "reg", "logic", "signed", "unsigned"):
                if t.value in ("reg", "logic"):
                    cur_reg = True
                i += 1
                if i < n and toks[i].value == "[":
                    rng, ni = _parse_range(toks, i, self.params)
                    if rng:
                        cur_vec, cur_left, cur_right, cur_width = _range_props(rng[0], rng[1])
                        i = ni
                continue
            if t.kind == "ident":
                init_toks = None
                if i + 1 < n and toks[i + 1].value == "=":
                    j = i + 2
                    while j < n and toks[j].value != ",":
                        j += 1
                    init_toks = toks[i + 2 : j]
                    i = j
                else:
                    i += 1
                info = _DeclInfo(
                    name=t.value,
                    direction=cur_dir,
                    is_reg=cur_reg,
                    is_vector=cur_vec,
                    left=cur_left,
                    right=cur_right,
                    width=cur_width,
                    init_tokens=init_toks,
                    line=t.line,
                    col=t.column,
                )
                self.ports.append(info)
                self.sigs[t.value] = info
                continue
            i += 1

    def _split_body(
        self,
        body: List[_VTok],
        items: List[Tuple[str, List[_VTok]]],
        port_order: List[str],
        ansi_ports: bool,
    ) -> None:
        i = 0
        n = len(body)
        while i < n:
            tok = body[i]
            v = tok.value
            if v in ("parameter", "localparam"):
                j = self._find_semi(body, i)
                if j < 0:
                    self.errors.append(_err(self.filename, tok.line, tok.column, f"Missing ';' after '{v}' declaration"))
                    return
                self._parse_param_list(body[i + 1 : j])
                i = j + 1
                continue
            if v in ("input", "output", "inout", "wire", "reg", "logic", "integer"):
                j = self._find_semi(body, i)
                if j < 0:
                    self.errors.append(_err(self.filename, tok.line, tok.column, f"Missing ';' after '{v}' declaration"))
                    return
                self._parse_body_decl(body[i:j])
                i = j + 1
                continue
            if v == "assign":
                j = self._find_semi(body, i)
                if j < 0:
                    self.errors.append(_err(self.filename, tok.line, tok.column, "Missing ';' in 'assign' statement"))
                    return
                items.append(("assign", body[i + 1 : j]))
                i = j + 1
                continue
            if v == "always":
                end_a = self._scan_statement_end(body, i + 1)
                if end_a < 0:
                    self.errors.append(_err(self.filename, tok.line, tok.column, "Unterminated 'always' block"))
                    return
                items.append(("always", body[i:end_a]))
                i = end_a
                continue
            if v == "initial":
                end_init = self._scan_statement_end(body, i + 1)
                i = end_init if end_init > i else i + 1
                continue
            if tok.kind == "ident" and v not in _VERILOG_KEYWORDS:
                j = self._find_semi(body, i)
                if j < 0:
                    self.errors.append(_err(self.filename, tok.line, tok.column, f"Unexpected syntax or missing ';' near '{v}'"))
                    return
                items.append(("inst", body[i:j]))
                i = j + 1
                continue
            if v == ";":
                i += 1
                continue
            self.errors.append(_err(self.filename, tok.line, tok.column, f"Unsupported or unexpected token '{v}' in module body"))
            return

    @staticmethod
    def _find_semi(toks: List[_VTok], start: int) -> int:
        depth = 0
        for k in range(start, len(toks)):
            if toks[k].value in ("(", "[", "{"):
                depth += 1
            elif toks[k].value in (")", "]", "}"):
                depth = max(0, depth - 1)
            elif toks[k].value == ";" and depth == 0:
                return k
        return -1

    def _scan_statement_end(self, toks: List[_VTok], i: int) -> int:
        n = len(toks)
        # skip optional @( ... ) or @*
        if i < n and toks[i].value == "@":
            i += 1
            if i < n and toks[i].value == "(":
                end_p = _find_matching(toks, i, "(", ")")
                if end_p < 0:
                    return -1
                i = end_p + 1
            elif i < n and toks[i].value in ("*", "(*"):
                i += 1
        if i >= n:
            return -1
        return self._scan_single_stmt(toks, i)

    def _scan_single_stmt(self, toks: List[_VTok], i: int) -> int:
        n = len(toks)
        if i >= n:
            return -1
        v = toks[i].value
        if v == "begin":
            i += 1
            while i < n and toks[i].value != "end":
                nxt = self._scan_single_stmt(toks, i)
                if nxt < 0:
                    return -1
                i = nxt
            return i + 1 if i < n and toks[i].value == "end" else -1
        if v == "if":
            i += 1
            if i >= n or toks[i].value != "(":
                return -1
            end_c = _find_matching(toks, i, "(", ")")
            if end_c < 0:
                return -1
            i = self._scan_single_stmt(toks, end_c + 1)
            if i < 0:
                return -1
            if i < n and toks[i].value == "else":
                return self._scan_single_stmt(toks, i + 1)
            return i
        if v in ("case", "casex", "casez"):
            i += 1
            if i < n and toks[i].value == "(":
                end_c = _find_matching(toks, i, "(", ")")
                if end_c < 0:
                    return -1
                i = end_c + 1
            while i < n and toks[i].value != "endcase":
                if toks[i].value == "default":
                    i += 1
                    if i < n and toks[i].value == ":":
                        i += 1
                else:
                    # skip label exprs until ':'
                    depth = 0
                    while i < n:
                        if toks[i].value in ("(", "["):
                            depth += 1
                        elif toks[i].value in (")", "]"):
                            depth = max(0, depth - 1)
                        elif toks[i].value == ":" and depth == 0:
                            i += 1
                            break
                        elif toks[i].value == "endcase":
                            break
                        i += 1
                if i < n and toks[i].value == "endcase":
                    break
                nxt = self._scan_single_stmt(toks, i)
                if nxt < 0:
                    return -1
                i = nxt
            return i + 1 if i < n and toks[i].value == "endcase" else -1
        # Simple statement ending in ';'
        semi = self._find_semi(toks, i)
        return semi + 1 if semi >= 0 else -1

    def _parse_body_decl(self, toks: List[_VTok]) -> None:
        i = 0
        n = len(toks)
        direction: Optional[str] = None
        is_reg = False
        is_vec = False
        left, right, width = 0, 0, 1
        if toks[i].value in ("input", "output", "inout"):
            direction = toks[i].value
            i += 1
        while i < n and toks[i].value in ("wire", "reg", "logic", "signed", "unsigned", "integer"):
            if toks[i].value == "integer":
                is_reg = True
                is_vec = True
                left, right, width = 31, 0, 32
            elif toks[i].value in ("reg", "logic"):
                is_reg = True
            i += 1
        if i < n and toks[i].value == "[":
            rng, ni = _parse_range(toks, i, self.params)
            if rng:
                is_vec, left, right, width = _range_props(rng[0], rng[1])
                i = ni
        while i < n:
            if toks[i].value == ",":
                i += 1
                continue
            if toks[i].kind != "ident":
                i += 1
                continue
            name = toks[i].value
            ln, col = toks[i].line, toks[i].column
            i += 1
            init_toks = None
            if i < n and toks[i].value == "=":
                j = i + 1
                depth = 0
                while j < n:
                    if toks[j].value in ("(", "[", "{"):
                        depth += 1
                    elif toks[j].value in (")", "]", "}"):
                        depth = max(0, depth - 1)
                    elif toks[j].value == "," and depth == 0:
                        break
                    j += 1
                init_toks = toks[i + 1 : j]
                i = j
            existing = self.sigs.get(name)
            if existing:
                if direction:
                    existing.direction = direction
                if is_reg:
                    existing.is_reg = True
                if is_vec:
                    existing.is_vector = True
                    existing.left, existing.right, existing.width = left, right, width
                if init_toks and not existing.init_tokens:
                    existing.init_tokens = init_toks
            else:
                self.sigs[name] = _DeclInfo(
                    name=name,
                    direction=direction,
                    is_reg=is_reg,
                    is_vector=is_vec,
                    left=left,
                    right=right,
                    width=width,
                    init_tokens=init_toks,
                    line=ln,
                    col=col,
                )

    def _emit_assign(self, toks: List[_VTok]) -> None:
        eq = next((k for k, t in enumerate(toks) if t.value == "="), -1)
        if eq <= 0:
            t0 = toks[0] if toks else _VTok("other", "assign", 1, 1)
            self.errors.append(_err(self.filename, t0.line, t0.column, "Invalid 'assign' statement"))
            return
        lhs_toks = toks[:eq]
        rhs_toks = toks[eq + 1 :]
        lhs_str, is_scalar, width = self._target_lhs(lhs_toks)
        rhs_str = self._target_rhs_expr(rhs_toks, is_scalar, width)
        self._emit(f"    {lhs_str} <= {rhs_str};", lhs_toks[0].line)

    def _emit_instantiation(self, toks: List[_VTok]) -> None:
        mod = toks[0]
        i = 1
        generics: List[Tuple[Optional[str], List[_VTok]]] = []
        if i < len(toks) and toks[i].value == "#":
            i += 1
            if i < len(toks) and toks[i].value == "(":
                end_p = _find_matching(toks, i, "(", ")")
                if end_p > i:
                    generics = self._parse_port_conns(toks[i + 1 : end_p])
                    i = end_p + 1
        if i >= len(toks) or toks[i].kind != "ident":
            self.errors.append(_err(self.filename, mod.line, mod.column, f"Expected instance name for '{mod.value}'"))
            return
        inst = toks[i].value
        i += 1
        if i >= len(toks) or toks[i].value != "(":
            self.errors.append(_err(self.filename, mod.line, mod.column, f"Expected '(' in instantiation '{inst}'"))
            return
        end_c = _find_matching(toks, i, "(", ")")
        if end_c < 0:
            self.errors.append(_err(self.filename, mod.line, mod.column, f"Unclosed '(' in instantiation '{inst}'"))
            return
        conns = self._parse_port_conns(toks[i + 1 : end_c])
        mod_ports = self.known_modules.get(mod.value.lower(), [])
        gmap_parts = []
        for gname, gexpr in generics:
            v = _eval_int(gexpr, self.params)
            val_str = str(v) if v is not None else self._expr_tokens(gexpr).vhdl
            if gname:
                gmap_parts.append(f"{gname} => {val_str}")
            else:
                gmap_parts.append(val_str)
        pmap_parts = []
        for idx, (pname, pexpr) in enumerate(conns):
            target_port = (
                next((mp for mp in mod_ports if mp.name.lower() == pname.lower()), None)
                if pname
                else (mod_ports[idx] if idx < len(mod_ports) else None)
            )
            lhs_label = target_port.name if target_port else (pname or f"p{idx}")
            if not pexpr:
                pmap_parts.append(f"{lhs_label} => open")
                continue
            # If expr is a plain identifier/slice without needing coercion or output matches:
            if len(pexpr) == 1 and pexpr[0].kind == "ident" and pexpr[0].value in self.sigs:
                ref = self._vhdl_ref(pexpr[0].value)
                pmap_parts.append(f"{lhs_label} => {ref}")
            elif target_port is not None and not target_port.is_input:
                lhs_str, _, _ = self._target_lhs(pexpr)
                pmap_parts.append(f"{lhs_label} => {lhs_str}")
            else:
                # Create helper signal for complex input expression so VHDL-2008 binding works everywhere
                w = target_port.width or 1 if target_port else 1
                is_sc = not (target_port.is_vector if target_port else False)
                rhs = self._target_rhs_expr(pexpr, is_sc, w)
                sig_n = f"v_pmap_{self.assoc_counter}"
                self.assoc_counter += 1
                ttype = "std_logic" if is_sc else f"std_logic_vector({target_port.left} {'downto' if target_port.downto else 'to'} {target_port.right})"
                self.extra_signals.append((f"    signal {sig_n} : {ttype};", mod.line))
                self.extra_concurrent.append((f"    {sig_n} <= {rhs};", mod.line))
                pmap_parts.append(f"{lhs_label} => {sig_n}")

        g_clause = f" generic map ({', '.join(gmap_parts)})" if gmap_parts else ""
        p_clause = f" port map ({', '.join(pmap_parts)})" if pmap_parts else ""
        self._emit(f"    {inst} : entity work.{mod.value}{g_clause}{p_clause};", mod.line)

    @staticmethod
    def _parse_port_conns(toks: List[_VTok]) -> List[Tuple[Optional[str], List[_VTok]]]:
        conns: List[Tuple[Optional[str], List[_VTok]]] = []
        i = 0
        n = len(toks)
        while i < n:
            depth = 0
            start = i
            while i < n:
                if toks[i].value in ("(", "[", "{"):
                    depth += 1
                elif toks[i].value in (")", "]", "}"):
                    depth = max(0, depth - 1)
                elif toks[i].value == "," and depth == 0:
                    break
                i += 1
            chunk = toks[start:i]
            if chunk:
                if len(chunk) >= 4 and chunk[0].value == "." and chunk[1].kind == "ident" and chunk[2].value == "(":
                    end_p = _find_matching(chunk, 2, "(", ")")
                    conns.append((chunk[1].value, chunk[3:end_p] if end_p > 3 else []))
                else:
                    conns.append((None, chunk))
            i += 1
        return conns

    def _emit_always(self, toks: List[_VTok]) -> None:
        line = toks[0].line
        i = 1
        edges: List[Tuple[str, str]] = []  # (posedge|negedge, sig_name)
        is_comb = False
        if i < len(toks) and toks[i].value == "@":
            i += 1
            if i < len(toks) and toks[i].value == "*":
                is_comb = True
                i += 1
            elif i < len(toks) and toks[i].value == "(":
                end_p = _find_matching(toks, i, "(", ")")
                sens = toks[i + 1 : end_p]
                i = end_p + 1
                if len(sens) == 1 and sens[0].value == "*":
                    is_comb = True
                else:
                    k = 0
                    while k < len(sens):
                        if sens[k].value in ("posedge", "negedge") and k + 1 < len(sens):
                            edges.append((sens[k].value, sens[k + 1].value))
                            k += 2
                        else:
                            k += 1
                    if not edges:
                        is_comb = True
        else:
            is_comb = True

        stmt_toks = toks[i:]
        if is_comb or not edges:
            self.in_comb_process = True
            self.comb_blocking_targets = self._collect_blocking_targets(stmt_toks)
            self._emit("    process(all)", line)
            for name in sorted(self.comb_blocking_targets):
                d = self.sigs[name]
                ttext = (
                    f"std_logic_vector({d.left} {'downto' if d.left >= d.right else 'to'} {d.right})"
                    if d.is_vector
                    else "std_logic"
                )
                init_v = "'0'" if not d.is_vector else "(others => '0')"
                self._emit(f"        variable bv_{d.vhdl_name} : {ttext} := {init_v};", line)
            self._emit("    begin", line)
            self._emit_stmt(stmt_toks, 8, blocking_as_var=True)
            for name in sorted(self.comb_blocking_targets):
                d = self.sigs[name]
                target = self.out_shadows.get(name, d.vhdl_name)
                self._emit(f"        {target} <= bv_{d.vhdl_name};", line)
            self._emit("    end process;", line)
            self.comb_blocking_targets = set()
            self.in_comb_process = False
        else:
            self.in_comb_process = False
            sens_list = ", ".join(self._vhdl_ref(sig) for _, sig in edges)
            self._emit(f"    process({sens_list})", line)
            self._emit("    begin", line)
            clk_edge, clk_sig = edges[0]
            clk_fn = "rising_edge" if clk_edge == "posedge" else "falling_edge"
            if len(edges) >= 2:
                rst_edge, rst_sig = edges[1]
                rst_lvl = "'1'" if rst_edge == "posedge" else "'0'"
                self._emit(f"        if {self._vhdl_ref(rst_sig)} = {rst_lvl} then", line)
                # Extract reset/clock branches cleanly if top-level is `if (rst...) ... else ...`
                inner_if = self._extract_async_if(stmt_toks)
                if inner_if:
                    _, rst_branch, clk_branch = inner_if
                    self._emit_stmt(rst_branch, 12, blocking_as_var=False)
                    self._emit(f"        elsif {clk_fn}({self._vhdl_ref(clk_sig)}) then", line)
                    if clk_branch:
                        self._emit_stmt(clk_branch, 12, blocking_as_var=False)
                    self._emit("        end if;", line)
                else:
                    self._emit_stmt(stmt_toks, 12, blocking_as_var=False)
                    self._emit("        end if;", line)
            else:
                self._emit(f"        if {clk_fn}({self._vhdl_ref(clk_sig)}) then", line)
                self._emit_stmt(stmt_toks, 12, blocking_as_var=False)
                self._emit("        end if;", line)
            self._emit("    end process;", line)

    def _extract_async_if(self, toks: List[_VTok]) -> Optional[Tuple[List[_VTok], List[_VTok], List[_VTok]]]:
        t = list(toks)
        if len(t) >= 2 and t[0].value == "begin" and t[-1].value == "end":
            t = t[1:-1]
        if not t or t[0].value != "if" or len(t) < 3 or t[1].value != "(":
            return None
        end_c = _find_matching(t, 1, "(", ")")
        if end_c < 0:
            return None
        cond = t[2:end_c]
        rest_start = end_c + 1
        end_then = self._scan_single_stmt(t, rest_start)
        if end_then < 0:
            return None
        then_toks = t[rest_start:end_then]
        else_toks: List[_VTok] = []
        if end_then < len(t) and t[end_then].value == "else":
            else_toks = t[end_then + 1 :]
        return cond, then_toks, else_toks

    def _collect_blocking_targets(self, toks: List[_VTok]) -> set[str]:
        targets: set[str] = set()
        for k in range(1, len(toks)):
            if toks[k].value == "=" and toks[k - 1].kind == "ident" and toks[k - 1].value in self.sigs:
                if k == 1 or toks[k - 2].value not in ("=", "!", "<", ">"):
                    targets.add(toks[k - 1].value)
            elif toks[k].value == "=" and toks[k - 1].value == "]":
                # find identifier before '['
                j = k - 2
                depth = 1
                while j >= 0 and depth > 0:
                    if toks[j].value == "]":
                        depth += 1
                    elif toks[j].value == "[":
                        depth -= 1
                    j -= 1
                if j >= 0 and toks[j].kind == "ident" and toks[j].value in self.sigs:
                    targets.add(toks[j].value)
        return targets

    def _emit_stmt(self, toks: List[_VTok], indent: int, blocking_as_var: bool) -> None:
        pad = " " * indent
        i = 0
        n = len(toks)
        while i < n:
            v = toks[i].value
            ln = toks[i].line
            if v == "begin":
                i += 1
                while i < n and toks[i].value != "end":
                    nxt = self._scan_single_stmt(toks, i)
                    if nxt < 0:
                        return
                    self._emit_stmt(toks[i:nxt], indent, blocking_as_var)
                    i = nxt
                i += 1
                continue
            if v == "end":
                i += 1
                continue
            if v == ";":
                i += 1
                continue
            if v == "if":
                if i + 1 >= n or toks[i + 1].value != "(":
                    return
                end_c = _find_matching(toks, i + 1, "(", ")")
                cond_res = self._expr_tokens(toks[i + 2 : end_c])
                self._emit(f"{pad}if v_bool({cond_res.vhdl}) then", ln)
                then_end = self._scan_single_stmt(toks, end_c + 1)
                self._emit_stmt(toks[end_c + 1 : then_end], indent + 4, blocking_as_var)
                i = then_end
                while i < n and toks[i].value == "else":
                    if i + 1 < n and toks[i + 1].value == "if":
                        if i + 2 >= n or toks[i + 2].value != "(":
                            return
                        ec = _find_matching(toks, i + 2, "(", ")")
                        cres = self._expr_tokens(toks[i + 3 : ec])
                        self._emit(f"{pad}elsif v_bool({cres.vhdl}) then", toks[i].line)
                        te = self._scan_single_stmt(toks, ec + 1)
                        self._emit_stmt(toks[ec + 1 : te], indent + 4, blocking_as_var)
                        i = te
                    else:
                        self._emit(f"{pad}else", toks[i].line)
                        ee = self._scan_single_stmt(toks, i + 1)
                        self._emit_stmt(toks[i + 1 : ee], indent + 4, blocking_as_var)
                        i = ee
                        break
                self._emit(f"{pad}end if;", ln)
                continue
            if v in ("case", "casex", "casez"):
                if i + 1 >= n or toks[i + 1].value != "(":
                    return
                end_c = _find_matching(toks, i + 1, "(", ")")
                sel_res = self._expr_tokens(toks[i + 2 : end_c])
                k = end_c + 1
                first_branch = True
                while k < n and toks[k].value != "endcase":
                    if toks[k].value == "default":
                        k += 1
                        if k < n and toks[k].value == ":":
                            k += 1
                        be = self._scan_single_stmt(toks, k)
                        if not first_branch:
                            self._emit(f"{pad}else", toks[k - 1].line)
                        self._emit_stmt(toks[k:be], indent + (0 if first_branch else 4), blocking_as_var)
                        k = be
                        break
                    else:
                        # collect comma-separated case items until ':'
                        labels: List[List[_VTok]] = []
                        cur_lbl: List[_VTok] = []
                        depth = 0
                        lbl_line = toks[k].line
                        while k < n:
                            tv = toks[k].value
                            if tv in ("(", "["):
                                depth += 1
                                cur_lbl.append(toks[k])
                            elif tv in (")", "]"):
                                depth = max(0, depth - 1)
                                cur_lbl.append(toks[k])
                            elif tv == "," and depth == 0:
                                if cur_lbl:
                                    labels.append(cur_lbl)
                                    cur_lbl = []
                            elif tv == ":" and depth == 0:
                                if cur_lbl:
                                    labels.append(cur_lbl)
                                k += 1
                                break
                            else:
                                cur_lbl.append(toks[k])
                            k += 1
                        cond_parts = [f"v_bool(v_eq({sel_res.vhdl}, {self._expr_tokens(lbl).vhdl}))" for lbl in labels]
                        kw = "if" if first_branch else "elsif"
                        first_branch = False
                        self._emit(f"{pad}{kw} {' or '.join(cond_parts)} then", lbl_line)
                        be = self._scan_single_stmt(toks, k)
                        self._emit_stmt(toks[k:be], indent + 4, blocking_as_var)
                        k = be
                if not first_branch:
                    self._emit(f"{pad}end if;", ln)
                while k < n and toks[k].value != "endcase":
                    k += 1
                i = k + 1
                continue
            # Assignment statement ending in ';'
            semi = self._find_semi(toks, i)
            if semi < 0:
                return
            st = toks[i:semi]
            i = semi + 1
            assign_idx = -1
            is_blocking = False
            for idx, tk in enumerate(st):
                if tk.value in ("<=", "=") and (idx == 0 or st[idx - 1].value not in ("=", "!", "<", ">")):
                    assign_idx = idx
                    is_blocking = tk.value == "="
                    break
            if assign_idx > 0:
                lhs_t = st[:assign_idx]
                rhs_t = st[assign_idx + 1 :]
                use_var = blocking_as_var and is_blocking and lhs_t[0].kind == "ident" and lhs_t[0].value in self.comb_blocking_targets
                lhs_str, is_scalar, width = self._target_lhs(lhs_t)
                rhs_str = self._target_rhs_expr(rhs_t, is_scalar, width)
                op = ":=" if use_var else "<="
                self._emit(f"{pad}{lhs_str} {op} {rhs_str};", ln)

    def _target_lhs(self, toks: List[_VTok]) -> Tuple[str, bool, int]:
        if toks and toks[0].value == "{":
            # Keep fallback scalar if concatenation LHS (rare)
            return self._vhdl_ref(toks[1].value) if len(toks) > 1 else "open", True, 1
        name = toks[0].value
        ref = self._vhdl_ref(name)
        is_scalar, width = self._decl_width(name)
        if len(toks) == 1:
            return ref, is_scalar, width
        if toks[1].value == "[":
            end_b = _find_matching(toks, 1, "[", "]")
            inside = toks[2:end_b]
            colon = next((idx for idx, t in enumerate(inside) if t.value == ":"), -1)
            if colon < 0:
                idx_v = _eval_int(inside, self.params)
                idx_s = str(idx_v) if idx_v is not None else f"to_integer(unsigned({self._expr_tokens(inside).vhdl}))"
                return ref if is_scalar else f"{ref}({idx_s})", True, 1
            msb = _eval_int(inside[:colon], self.params) or 0
            lsb = _eval_int(inside[colon + 1 :], self.params) or 0
            w = abs(msb - lsb) + 1
            dir_kw = "downto" if msb >= lsb else "to"
            return f"{ref}({msb} {dir_kw} {lsb})", False, w
        return ref, is_scalar, width

    @staticmethod
    def _fit_vec(res: _ExprResult, w: int) -> str:
        if not res.is_scalar and res.width == w:
            return res.vhdl
        if res.is_scalar:
            if w == 1:
                return f"std_logic_vector'(0 => {res.vhdl})"
            return f"(({w - 1} downto 1 => '0') & {res.vhdl})"
        return f"std_logic_vector(resize(unsigned({res.vhdl}), {w}))"

    def _target_rhs_expr(self, toks: List[_VTok], target_scalar: bool, target_width: int) -> str:
        res = self._expr_tokens(toks, target_width_hint=target_width)
        if target_scalar:
            if res.is_scalar:
                return res.vhdl
            return f"v_bit({res.vhdl})"
        return self._fit_vec(res, target_width)

    # -- Recursive descent Verilog expression parser ----------------------
    def _expr_tokens(self, toks: List[_VTok], target_width_hint: int = 32) -> _ExprResult:
        if not toks:
            return _ExprResult("'0'", True, 1)
        pos = [0]

        def peek() -> Optional[_VTok]:
            return toks[pos[0]] if pos[0] < len(toks) else None

        def eat() -> _VTok:
            t = toks[pos[0]]
            pos[0] += 1
            return t

        def as_vec(r: _ExprResult, w: int) -> str:
            return self._fit_vec(r, w)

        def parse_ternary() -> _ExprResult:
            cond = parse_lor()
            if peek() and peek().value == "?":
                eat()
                t_val = parse_ternary()
                if peek() and peek().value == ":":
                    eat()
                f_val = parse_ternary()
                is_sc = t_val.is_scalar and f_val.is_scalar
                if is_sc:
                    return _ExprResult(f"v_mux(v_bool({cond.vhdl}), {t_val.vhdl}, {f_val.vhdl})", True, 1)
                w = max(t_val.width, f_val.width)
                return _ExprResult(f"v_mux(v_bool({cond.vhdl}), {as_vec(t_val, w)}, {as_vec(f_val, w)})", False, w)
            return cond

        def parse_lor() -> _ExprResult:
            left = parse_land()
            while peek() and peek().value == "||":
                eat()
                right = parse_land()
                left = _ExprResult(f"v_sl(v_bool({left.vhdl}) or v_bool({right.vhdl}))", True, 1)
            return left

        def parse_land() -> _ExprResult:
            left = parse_bor()
            while peek() and peek().value == "&&":
                eat()
                right = parse_bor()
                left = _ExprResult(f"v_sl(v_bool({left.vhdl}) and v_bool({right.vhdl}))", True, 1)
            return left

        def parse_bor() -> _ExprResult:
            left = parse_bxor()
            while peek() and peek().value == "|":
                eat()
                right = parse_bxor()
                if left.is_scalar and right.is_scalar:
                    left = _ExprResult(f"({left.vhdl} or {right.vhdl})", True, 1)
                else:
                    w = max(left.width, right.width)
                    left = _ExprResult(f"({as_vec(left, w)} or {as_vec(right, w)})", False, w)
            return left

        def parse_bxor() -> _ExprResult:
            left = parse_band()
            while peek() and peek().value in ("^", "^~", "~^"):
                op = eat().value
                right = parse_band()
                kw = "xor" if op == "^" else "xnor"
                if left.is_scalar and right.is_scalar:
                    left = _ExprResult(f"({left.vhdl} {kw} {right.vhdl})", True, 1)
                else:
                    w = max(left.width, right.width)
                    left = _ExprResult(f"({as_vec(left, w)} {kw} {as_vec(right, w)})", False, w)
            return left

        def parse_band() -> _ExprResult:
            left = parse_eq()
            while peek() and peek().value == "&":
                eat()
                right = parse_eq()
                if left.is_scalar and right.is_scalar:
                    left = _ExprResult(f"({left.vhdl} and {right.vhdl})", True, 1)
                else:
                    w = max(left.width, right.width)
                    left = _ExprResult(f"({as_vec(left, w)} and {as_vec(right, w)})", False, w)
            return left

        def parse_eq() -> _ExprResult:
            left = parse_rel()
            while peek() and peek().value in ("==", "!=", "===", "!=="):
                op = eat().value
                right = parse_rel()
                eq_s = f"v_eq({left.vhdl}, {right.vhdl})"
                if op in ("!=", "!=="):
                    left = _ExprResult(f"(not {eq_s})", True, 1)
                else:
                    left = _ExprResult(eq_s, True, 1)
            return left

        def parse_rel() -> _ExprResult:
            left = parse_shift()
            while peek() and peek().value in ("<", "<=", ">", ">="):
                op = eat().value
                right = parse_shift()
                w = max(left.width, right.width, 1)
                l_v = f"unsigned({as_vec(left, w)})"
                r_v = f"unsigned({as_vec(right, w)})"
                left = _ExprResult(f"v_sl({l_v} {op} {r_v})", True, 1)
            return left

        def parse_shift() -> _ExprResult:
            left = parse_add()
            while peek() and peek().value in ("<<", ">>"):
                op = eat().value
                right = parse_add()
                w = max(left.width, 1)
                fn = "shift_left" if op == "<<" else "shift_right"
                sh = f"to_integer(unsigned({as_vec(right, 8)}))"
                left = _ExprResult(f"std_logic_vector({fn}(unsigned({as_vec(left, w)}), {sh}))", False, w)
            return left

        def parse_add() -> _ExprResult:
            left = parse_mul()
            while peek() and peek().value in ("+", "-"):
                op = eat().value
                right = parse_mul()
                w = max(left.width, right.width, target_width_hint if (left.is_scalar and right.is_scalar) else 1)
                w = max(left.width, right.width)
                left = _ExprResult(
                    f"std_logic_vector(unsigned({as_vec(left, w)}) {op} unsigned({as_vec(right, w)}))",
                    False,
                    w,
                )
            return left

        def parse_mul() -> _ExprResult:
            left = parse_unary()
            while peek() and peek().value in ("*", "/"):
                op = eat().value
                right = parse_unary()
                w = max(left.width, right.width)
                if op == "*":
                    left = _ExprResult(
                        f"std_logic_vector(resize(unsigned({as_vec(left, w)}) * unsigned({as_vec(right, w)}), {w}))",
                        False,
                        w,
                    )
                else:
                    left = _ExprResult(
                        f"std_logic_vector(resize(unsigned({as_vec(left, w)}) / unsigned({as_vec(right, w)}), {w}))",
                        False,
                        w,
                    )
            return left

        def parse_unary() -> _ExprResult:
            t = peek()
            if t and t.value == "!":
                eat()
                sub = parse_unary()
                return _ExprResult(f"v_sl(not v_bool({sub.vhdl}))", True, 1)
            if t and t.value == "~":
                eat()
                sub = parse_unary()
                return _ExprResult(f"(not {sub.vhdl})", sub.is_scalar, sub.width)
            if t and t.value in ("&", "|", "^"):
                op = eat().value
                sub = parse_unary()
                if sub.is_scalar:
                    return sub
                kw = {"&": "and", "|": "or", "^": "xor"}[op]
                return _ExprResult(f"({kw} {sub.vhdl})", True, 1)
            if t and t.value in ("+", "-"):
                op = eat().value
                sub = parse_unary()
                if op == "+":
                    return sub
                return _ExprResult(f"std_logic_vector(-signed({as_vec(sub, max(1, sub.width))}))", False, sub.width)
            return parse_atom()

        def parse_atom() -> _ExprResult:
            t = peek()
            if not t:
                return _ExprResult("'0'", True, 1)
            if t.value == "(":
                eat()
                inner = parse_ternary()
                if peek() and peek().value == ")":
                    eat()
                return _ExprResult(f"({inner.vhdl})", inner.is_scalar, inner.width)
            if t.value == "{":
                eat()
                # Check replication {count{item...}}
                # Look ahead for inner '{' before matching '}'
                parts: List[_ExprResult] = []
                first = parse_ternary()
                if peek() and peek().value == "{":
                    # replication! Re-evaluate count as integer if possible
                    cnt = _eval_int([_VTok("number", first.vhdl, t.line, t.column)], self.params)
                    if cnt is None and first.vhdl.isdigit():
                        cnt = int(first.vhdl)
                    eat()
                    rep_items: List[_ExprResult] = []
                    while peek() and peek().value != "}":
                        rep_items.append(parse_ternary())
                        if peek() and peek().value == ",":
                            eat()
                    if peek() and peek().value == "}":
                        eat()
                    if peek() and peek().value == "}":
                        eat()
                    combined = rep_items[0]
                    if len(rep_items) > 1:
                        cw = sum(x.width for x in rep_items)
                        combined = _ExprResult("(" + " & ".join(as_vec(x, x.width) for x in rep_items) + ")", False, cw)
                    c_n = cnt if (cnt and cnt > 0) else 1
                    if combined.is_scalar:
                        return _ExprResult(f"({c_n - 1} downto 0 => {combined.vhdl})", False, c_n)
                    joined_rep = " & ".join([combined.vhdl] * c_n)
                    return _ExprResult(f"({joined_rep})", False, c_n * combined.width)
                parts.append(first)
                while peek() and peek().value == ",":
                    eat()
                    parts.append(parse_ternary())
                if peek() and peek().value == "}":
                    eat()
                if len(parts) == 1:
                    return parts[0]
                cw = sum(x.width for x in parts)
                joined = " & ".join(x.vhdl if not x.is_scalar else f"std_logic'({x.vhdl})" for x in parts)
                return _ExprResult(f"({joined})", False, cw)
            if t.kind == "sized":
                eat()
                parsed = _parse_sized_literal(t.value)
                if parsed is None:
                    return _ExprResult("'0'", True, 1)
                explicit_w, int_val, _, bits = parsed
                w = explicit_w or len(bits)
                if explicit_w == 1 or (explicit_w is None and w == 1):
                    return _ExprResult(f"'{bits[-1]}'", True, 1)
                return _ExprResult(f'std_logic_vector\'("{bits}")', False, w)
            if t.kind == "number":
                eat()
                val = int(t.value.replace("_", ""))
                if val in (0, 1) and target_width_hint == 1:
                    return _ExprResult(f"'{val}'", True, 1)
                w = max(1, target_width_hint) if val.bit_length() <= target_width_hint else val.bit_length()
                return _ExprResult(f'std_logic_vector\'("{format(val, f"0{w}b")[-w:]}")', False, w)
            if t.kind == "ident":
                eat()
                name = t.value
                if name in self.params:
                    val = self.params[name]
                    w = max(1, target_width_hint)
                    return _ExprResult(f'std_logic_vector\'("{format(val, f"0{w}b")[-w:]}")', False, w)
                ref = self._vhdl_ref(name)
                is_sc, w = self._decl_width(name)
                if peek() and peek().value == "[":
                    eat()
                    idx_toks: List[_VTok] = []
                    colon_pos = -1
                    depth = 1
                    while peek() and depth > 0:
                        nt = eat()
                        if nt.value == "[":
                            depth += 1
                            idx_toks.append(nt)
                        elif nt.value == "]":
                            depth -= 1
                            if depth > 0:
                                idx_toks.append(nt)
                        elif nt.value == ":" and depth == 1 and colon_pos < 0:
                            colon_pos = len(idx_toks)
                            idx_toks.append(nt)
                        else:
                            idx_toks.append(nt)
                    if colon_pos < 0:
                        iv = _eval_int(idx_toks, self.params)
                        is_str = str(iv) if iv is not None else f"to_integer(unsigned({self._expr_tokens(idx_toks).vhdl}))"
                        return _ExprResult(ref if is_sc else f"{ref}({is_str})", True, 1)
                    msb = _eval_int(idx_toks[:colon_pos], self.params) or 0
                    lsb = _eval_int(idx_toks[colon_pos + 1 :], self.params) or 0
                    sw = abs(msb - lsb) + 1
                    dir_kw = "downto" if msb >= lsb else "to"
                    return _ExprResult(f"{ref}({msb} {dir_kw} {lsb})", False, sw)
                return _ExprResult(ref, is_sc, w)
            bad = eat()
            self.errors.append(
                _err(self.filename, bad.line, bad.column, f"Unexpected token '{bad.value}' in expression")
            )
            return _ExprResult("'0'", True, 1)

        expr_res = parse_ternary()
        if peek() is not None:
            extra = peek()
            self.errors.append(
                _err(self.filename, extra.line, extra.column, f"Unexpected token '{extra.value}' in expression")
            )
        return expr_res


def _split_verilog_modules(toks: List[_VTok]) -> List[List[_VTok]]:
    modules: List[List[_VTok]] = []
    i = 0
    n = len(toks)
    while i < n:
        if toks[i].value == "module":
            start = i
            k = i + 1
            while k < n and toks[k].value != "endmodule":
                k += 1
            end = min(n, k + 1)
            modules.append(toks[start:end])
            i = end
        else:
            i += 1
    return modules


def translate_verilog_sources(
    sources: List[Tuple[str, str]],
) -> Tuple[List[Tuple[str, str]], Dict[str, Dict[int, Tuple[str, int]]], List[dict]]:
    """Parse and transpile any Verilog ``.v``/``.sv`` sources into VHDL-2008.

    Returns ``(new_sources, line_maps, errors)`` where ``line_maps`` maps
    synthetic VHDL filename -> ``{vhdl_line: (orig_file, orig_line)}``.
    """
    verilog_items = [(idx, name, content) for idx, (name, content) in enumerate(sources) if is_verilog_source(name, content)]
    if not verilog_items:
        return sources, {}, []

    known_modules: Dict[str, List[Port]] = {}
    parsed_chunks: List[Tuple[int, str, List[List[_VTok]]]] = []
    errors: List[dict] = []

    # First pass: collect module interfaces across all Verilog files so positional instantiations know port widths/names
    for idx, name, content in verilog_items:
        toks = _tokenize_verilog(content)
        chunks = _split_verilog_modules(toks)
        if not chunks:
            errors.append(_err(name, 1, 1, "No Verilog module declaration found"))
        parsed_chunks.append((idx, name, chunks))
        for ch in chunks:
            tr = _VerilogTranslator(name, ch, known_modules)
            res = tr.parse_and_translate()
            if res is not None:
                ent, _, _ = res
                known_modules[ent.name.lower()] = ent.ports

    # Second pass: transpile cleanly with all module ports populated
    out_sources = list(sources)
    line_maps: Dict[str, Dict[int, Tuple[str, int]]] = {}
    for idx, name, chunks in parsed_chunks:
        vhdl_parts: List[str] = []
        v_map: Dict[int, Tuple[str, int]] = {}
        line_offset = 0
        for ch in chunks:
            tr = _VerilogTranslator(name, ch, known_modules)
            res = tr.parse_and_translate()
            if tr.errors:
                errors.extend(tr.errors)
            if res is None:
                continue
            _, vhdl_text, tracked_lines = res
            for local_idx, (_, orig_ln) in enumerate(tracked_lines, start=1):
                v_map[line_offset + local_idx] = (name, orig_ln)
            line_offset += len(tracked_lines) + 1
            vhdl_parts.append(vhdl_text)
        synth_name = f"__v_{Path_safe(name)}.vhd"
        line_maps[synth_name] = v_map
        out_sources[idx] = (synth_name, "\n".join(vhdl_parts))

    return out_sources, line_maps, errors


def Path_safe(name: str) -> str:
    stem = re.sub(r"\.(?:v|sv)$", "", name, flags=re.IGNORECASE)
    return re.sub(r"[^A-Za-z0-9_]", "_", stem) or "verilog"


def parse_verilog_design(code: str, filename: str = "design.v") -> Design:
    """Parse Verilog module headers into a :class:`Design`."""
    toks = _tokenize_verilog(code)
    chunks = _split_verilog_modules(toks)
    known: Dict[str, List[Port]] = {}
    design = Design()
    for ch in chunks:
        tr = _VerilogTranslator(filename, ch, known)
        res = tr.parse_and_translate()
        design.errors.extend(tr.errors)
        if res is not None:
            ent, _, _ = res
            known[ent.name.lower()] = ent.ports
            design.entities.append(ent)
    return design


__all__ = [
    "is_verilog_source",
    "parse_verilog_design",
    "strip_verilog_comments",
    "translate_verilog_sources",
]
