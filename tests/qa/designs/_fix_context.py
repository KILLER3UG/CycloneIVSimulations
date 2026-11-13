"""Insert the required VHDL context clause before every top-level design unit.

GHDL analyses each design unit independently, so a single context clause at the
top of a multi-entity file only applies to the first unit.
"""
from pathlib import Path

CONTEXT = [
    "library ieee;",
    "use ieee.std_logic_1164.all;",
    "use ieee.numeric_std.all;",
]


def fix(path: Path) -> bool:
    lines = path.read_text(encoding="utf-8").splitlines()
    out = []
    changed = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(("entity ", "package ")) and not line.startswith(" "):
            prev = ""
            for candidate in reversed(out):
                if candidate.strip() and not candidate.strip().startswith("--"):
                    prev = candidate.strip()
                    break
            if not (prev.startswith("library ") or prev.startswith("use ")):
                out.extend(CONTEXT)
                out.append("")
                changed = True
        out.append(line)
    if changed:
        path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return changed


if __name__ == "__main__":
    for design in sorted((Path(__file__).parent).glob("*.vhd")):
        if design.name.startswith("tb_"):
            continue
        print(("fixed " if fix(design) else "ok    ") + design.name)