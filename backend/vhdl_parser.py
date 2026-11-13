"""VHDL source parser.

The simulator uses GHDL for real compilation and simulation.  This module is
the lightweight front-end that extracts the *interface* of a design (entities,
generics and ports) which is needed to:

* build an automatic testbench,
* map physical signals to the dev-board peripherals (LEDs, keys, switches...),
* present pin/type information to the UI.

It is intentionally a *syntax* parser, not a full VHDL compiler.  Anything it
does not understand is skipped, but the interface extraction is robust for the
VHDL subset produced by Quartus and by hand-written RTL.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<line_comment>--[^\n]*)
  | (?P<block_comment>/\*.*?\*/)
  | (?P<string>"(?:[^"]|"")*")
  | (?P<based>[0-9]+\#[0-9a-fA-F_xXzZ]+\#)
  | (?P<number>\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<char>'(?:[01xXzZwWhHuUlL\-])')
  | (?P<op>\*\*|=>|<=|>=|/=|\?=|:\=|<<|>>|[\+\-&\|=<>\(\)\[\],;:\.])
  | (?P<other>.)
    """,
    re.VERBOSE | re.DOTALL,
)


@dataclass(frozen=True)
class Token:
    kind: str
    value: str
    line: int
    column: int

    def is_kw(self, *words: str) -> bool:
        return self.kind == "ident" and self.value.lower() in words

    def is_op(self, *values: str) -> bool:
        return self.value in values

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Token({self.kind}:{self.value!r}@{self.line}:{self.column})"


def tokenize(code: str) -> List[Token]:
    tokens: List[Token] = []
    line = 1
    column = 1
    pos = 0
    length = len(code)

    while pos < length:
        match = _TOKEN_RE.match(code, pos)
        if not match:  # pragma: no cover - regex matches any char
            pos += 1
            column += 1
            continue

        kind = match.lastgroup or "other"
        value = match.group()
        start = match.start()

        if kind in ("ws", "line_comment", "block_comment"):
            newlines = value.count("\n")
            if newlines:
                line += newlines
                column = len(value.rsplit("\n", 1)[-1]) + 1
            else:
                column += len(value)
        else:
            tokens.append(Token(kind, value, line, column))
            newlines = value.count("\n")
            if newlines:
                line += newlines
                column = len(value.rsplit("\n", 1)[-1]) + 1
            else:
                column += len(value)

        pos = match.end()
        # `start` is kept for potential future use (e.g. source ranges).

    return tokens


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class Port:
    name: str
    direction: str  # in / out / inout / buffer / linkage
    type_name: str  # std_logic, std_logic_vector, unsigned, ...
    type_text: str  # full declaration, e.g. "std_logic_vector(7 downto 0)"
    width: Optional[int] = None
    left: Optional[int] = None
    right: Optional[int] = None
    downto: bool = True
    default: Optional[str] = None
    line: int = 0
    column: int = 0

    @property
    def is_vector(self) -> bool:
        return (self.width or 1) > 1

    @property
    def is_input(self) -> bool:
        return self.direction in ("in", "linkage")

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "direction": self.direction,
            "type": self.type_text,
            "typeName": self.type_name,
            "width": self.width or 1,
            "isVector": self.is_vector,
            "line": self.line,
            "column": self.column,
            "default": self.default,
        }


@dataclass
class Generic:
    name: str
    type_name: str
    type_text: str
    default: Optional[str] = None
    width: Optional[int] = None
    line: int = 0
    column: int = 0


@dataclass
class Entity:
    name: str
    ports: List[Port] = field(default_factory=list)
    generics: List[Generic] = field(default_factory=list)
    line: int = 0
    column: int = 0

    @property
    def inputs(self) -> List[Port]:
        return [p for p in self.ports if p.is_input]

    @property
    def outputs(self) -> List[Port]:
        return [p for p in self.ports if not p.is_input]

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "ports": [p.as_dict() for p in self.ports],
            "generics": [
                {
                    "name": g.name,
                    "type": g.type_text,
                    "default": g.default,
                    "width": g.width or 1,
                }
                for g in self.generics
            ],
        }


@dataclass
class Design:
    entities: List[Entity] = field(default_factory=list)
    errors: List[dict] = field(default_factory=list)

    @property
    def primary(self) -> Optional[Entity]:
        return self.entities[0] if self.entities else None

    def as_dict(self) -> dict:
        return {
            "entities": [e.as_dict() for e in self.entities],
            "primary": self.primary.as_dict() if self.primary else None,
            "errors": self.errors,
        }


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

_DIRECTIONS = {"in", "out", "inout", "buffer", "linkage"}
_VECTOR_TYPES = {"std_logic_vector", "unsigned", "signed", "bit_vector"}
_STD_TYPES = {"std_logic", "bit"}


class VHDLParser:
    """Extracts entity interfaces from VHDL source."""

    def __init__(self) -> None:
        self.tokens: List[Token] = []
        self.pos = 0
        self.errors: List[dict] = []

    # -- cursor helpers ---------------------------------------------------
    def _peek(self, offset: int = 0) -> Optional[Token]:
        idx = self.pos + offset
        if 0 <= idx < len(self.tokens):
            return self.tokens[idx]
        return None

    def _next(self) -> Optional[Token]:
        token = self._peek()
        if token is not None:
            self.pos += 1
        return token

    def _at_end(self) -> bool:
        return self.pos >= len(self.tokens)

    def _accept_op(self, *values: str) -> bool:
        token = self._peek()
        if token and token.kind == "op" and token.value in values:
            self.pos += 1
            return True
        return False

    def _accept_kw(self, *words: str) -> bool:
        token = self._peek()
        if token and token.is_kw(*words):
            self.pos += 1
            return True
        return False

    def _expect_op(self, value: str) -> bool:
        if self._accept_op(value):
            return True
        token = self._peek()
        self._error(
            f"Expected '{value}'"
            + (f" but found '{token.value}'" if token else " but reached end of file"),
            token,
        )
        return False

    def _expect_ident(self) -> Optional[str]:
        token = self._peek()
        if token and token.kind == "ident":
            self.pos += 1
            return token.value
        self._error("Expected an identifier", token)
        return None

    def _error(self, message: str, token: Optional[Token] = None) -> None:
        line = token.line if token else (self.tokens[-1].line if self.tokens else 0)
        column = token.column if token else (self.tokens[-1].column if self.tokens else 0)
        self.errors.append(
            {"message": message, "line": line, "column": column, "severity": "error"}
        )

    def _skip_balanced(self, open_value: str = "(", close_value: str = ")") -> None:
        """Skip tokens until the matching close delimiter is consumed."""
        depth = 0
        while not self._at_end():
            token = self._next()
            assert token is not None
            if token.value == open_value:
                depth += 1
            elif token.value == close_value:
                depth -= 1
                if depth <= 0:
                    return

    def _skip_to_semicolon(self) -> None:
        while not self._at_end():
            token = self._next()
            assert token is not None
            if token.value == ";":
                return

    # -- entry point ------------------------------------------------------
    def parse(self, code: str) -> Design:
        self.tokens = tokenize(code)
        self.pos = 0
        self.errors = []
        design = Design()

        while not self._at_end():
            token = self._peek()
            assert token is not None
            if token.is_kw("entity"):
                nxt = self._peek(1)
                after = self._peek(2)
                if nxt and nxt.kind == "ident" and after and after.is_kw("is"):
                    entity = self._parse_entity()
                    if entity:
                        design.entities.append(entity)
                else:
                    self.pos += 1
            elif token.is_kw("architecture", "package", "context", "library", "use"):
                # The interface extractor only needs entities; everything else is
                # skipped token by token.  `entity work.foo` inside a port map is
                # ignored because it is not followed by `is`.
                self.pos += 1
            else:
                self.pos += 1

        design.errors = self.errors
        return design

    # -- entity -----------------------------------------------------------
    def _parse_entity(self) -> Optional[Entity]:
        start = self._next()  # 'entity'
        assert start is not None
        name = self._expect_ident()
        if not name:
            return None

        self._accept_kw("is")

        entity = Entity(name=name, line=start.line, column=start.column)
        while not self._at_end():
            token = self._peek()
            assert token is not None
            if token.is_kw("end"):
                self.pos += 1
                self._accept_kw("entity")
                self._accept_ident_optional()
                self._accept_op(";")
                return entity
            if token.is_kw("generic"):
                self._parse_interface_list(entity.generics, is_generic=True)
            elif token.is_kw("port"):
                self._parse_interface_list(entity.ports, is_generic=False)
            elif token.value == ";":
                self.pos += 1
            else:
                self.pos += 1

        self._error("Unexpected end of file inside entity declaration", start)
        return entity

    def _accept_ident_optional(self) -> Optional[str]:
        token = self._peek()
        if token and token.kind == "ident":
            self.pos += 1
            return token.value
        return None

    def _parse_interface_list(self, target: list, is_generic: bool) -> None:
        self._next()  # generic / port
        if not self._accept_op("("):
            # Some sources use `port clk : in ...` without parentheses (illegal
            # but easy to recover from); bail out gracefully.
            return

        while not self._at_end():
            token = self._peek()
            assert token is not None

            if token.value == ")":
                self.pos += 1
                return
            if token.value == ";":
                self.pos += 1
                continue

            # Collect names:  a, b, c :
            names: List[Tuple[str, int, int]] = []
            while not self._at_end():
                token = self._peek()
                assert token is not None
                if token.kind == "ident":
                    names.append((token.value, token.line, token.column))
                    self.pos += 1
                    if self._accept_op(","):
                        continue
                break

            if not names:
                # Nothing recognisable - skip to the next separator.
                if not self._accept_op(";"):
                    self._next()
                continue

            if not self._accept_op(":"):
                self._error("Expected ':' in interface declaration", token)
                self._skip_to_semicolon()
                continue

            mode = "in"
            token = self._peek()
            if token and token.is_kw(*_DIRECTIONS):
                mode = token.value.lower()
                self.pos += 1

            type_name, type_text, left, right, downto, width = self._parse_type()

            default: Optional[str] = None
            if self._accept_op(":="):
                default_parts: List[str] = []
                depth = 0
                while not self._at_end():
                    token = self._peek()
                    assert token is not None
                    if token.value == "(":
                        depth += 1
                    elif token.value == ")":
                        if depth == 0:
                            break
                        depth -= 1
                    elif token.value == ";" and depth == 0:
                        break
                    default_parts.append(token.value)
                    self.pos += 1
                default = " ".join(default_parts) if default_parts else None

            for port_name, line, column in names:
                if is_generic:
                    target.append(
                        Generic(
                            name=port_name,
                            type_name=type_name,
                            type_text=type_text,
                            default=default,
                            width=width,
                            line=line,
                            column=column,
                        )
                    )
                else:
                    target.append(
                        Port(
                            name=port_name,
                            direction=mode,
                            type_name=type_name,
                            type_text=type_text,
                            width=width,
                            left=left,
                            right=right,
                            downto=downto,
                            default=default,
                            line=line,
                            column=column,
                        )
                    )

            if self._accept_op(";"):
                continue
            if self._accept_op(")"):
                return
            # Unexpected token; skip it to avoid an infinite loop.
            self._next()

    def _parse_type(self) -> Tuple[str, str, Optional[int], Optional[int], bool, Optional[int]]:
        """Parse a type mark plus optional constraint.

        Returns (type_name, full_type_text, left, right, downto, width).
        """
        token = self._peek()
        if token is None:
            return ("std_logic", "std_logic", None, None, True, 1)

        # Qualified type:  ieee.std_logic_1164.std_logic
        parts = [token.value]
        self.pos += 1
        while self._peek() and self._peek().value == "." and self._peek(1) and self._peek(1).kind == "ident":
            self.pos += 1
            parts.append(self._next().value)
            self.pos += 1
        type_name = parts[-1]
        type_text = ".".join(parts)

        left = right = None
        downto = True
        width: Optional[int] = None

        # `type range ...` / `type (...)`
        if self._accept_kw("range"):
            left, right, downto = self._parse_range()
            type_text += " range " + self._range_text(left, right, downto)
        elif self._peek() and self._peek().value == "(":
            # Array constraint: (7 downto 0)
            self.pos += 1
            raw: List[str] = []
            depth = 1
            while not self._at_end() and depth:
                token = self._next()
                assert token is not None
                if token.value == "(":
                    depth += 1
                elif token.value == ")":
                    depth -= 1
                    if depth == 0:
                        break
                raw.append(token.value)
            text = " ".join(raw)
            left, right, downto = _parse_range_text(text)
            type_text += "(" + text + ")"

        if type_name in _VECTOR_TYPES and left is not None and right is not None:
            width = abs(left - right) + 1
        elif type_name in _STD_TYPES:
            width = 1
        elif width is None:
            width = None

        return type_name, type_text, left, right, downto, width

    def _parse_range(self) -> Tuple[Optional[int], Optional[int], bool]:
        raw: List[str] = []
        depth = 0
        while not self._at_end():
            token = self._peek()
            assert token is not None
            if token.value == "(":
                depth += 1
            elif token.value == ")":
                if depth == 0:
                    break
                depth -= 1
            elif token.value == ";" and depth == 0:
                break
            raw.append(token.value)
            self.pos += 1
        return _parse_range_text(" ".join(raw))

    @staticmethod
    def _range_text(left: Optional[int], right: Optional[int], downto: bool) -> str:
        if left is None or right is None:
            return ""
        return f"{left} {'downto' if downto else 'to'} {right}"


def _parse_range_text(text: str) -> Tuple[Optional[int], Optional[int], bool]:
    """Parse '7 downto 0' / '0 to 7' into (left, right, downto)."""
    cleaned = text.replace("  ", " ").strip()
    match = re.match(
        r"^([+-]?\d+)\s+(downto|to)\s+([+-]?\d+)$", cleaned, re.IGNORECASE
    )
    if match:
        left = int(match.group(1))
        right = int(match.group(3))
        return left, right, match.group(2).lower() == "downto"

    # `natural range 0 to 7` / `integer range ...`
    match = re.search(
        r"([+-]?\d+)\s+(downto|to)\s+([+-]?\d+)", cleaned, re.IGNORECASE
    )
    if match:
        left = int(match.group(1))
        right = int(match.group(3))
        return left, right, match.group(2).lower() == "downto"

    return None, None, True


def parse(code: str) -> Design:
    """Convenience wrapper."""
    return VHDLParser().parse(code)


if __name__ == "__main__":  # pragma: no cover - manual smoke test
    import json
    import sys
    from pathlib import Path

    source = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
    print(json.dumps(parse(source).as_dict(), indent=2))