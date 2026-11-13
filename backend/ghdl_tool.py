"""Thin wrapper around the GHDL command line simulator.

GHDL does the real work: it analyzes (compiles) the VHDL, elaborates the top
level and runs the simulation, producing a VCD file.  This module only knows
how to locate the executable, invoke it and translate its diagnostics into
structured Python errors.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence

# GHDL's default timescale is femtoseconds in the VCD it writes; the backend
# converts everything to nanoseconds for the UI.


@dataclass
class Diagnostic:
    file: str
    line: int
    column: int
    severity: str
    message: str

    def as_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "column": self.column,
            "severity": self.severity,
            "message": self.message,
        }


@dataclass
class CommandResult:
    ok: bool
    stdout: str = ""
    stderr: str = ""
    returncode: int = 0
    diagnostics: List[Diagnostic] = field(default_factory=list)
    command: List[str] = field(default_factory=list)

    @property
    def output(self) -> str:
        return "\n".join(part for part in (self.stdout, self.stderr) if part).strip()

    def error_lines(self) -> List[str]:
        return [
            line
            for line in (self.stdout + "\n" + self.stderr).splitlines()
            if "error:" in line.lower() or "warning:" in line.lower()
        ]


_ERROR_RE = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?P<column>\d+):\s*"
    r"(?P<severity>error|warning|note):\s*(?P<message>.*)$",
    re.IGNORECASE,
)

# GHDL reports assertion failures during *simulation* in a different format:
#   design.vhd:3:79:@5ns:(assertion failure): boom
_ASSERT_RE = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):(?P<column>\d+):@[^:]+:"
    r"\((?P<severity>assertion failure|assertion error|report note|report warning)\):"
    r"\s*(?P<message>.*)$",
    re.IGNORECASE,
)


class GhdlNotFoundError(RuntimeError):
    """Raised when the GHDL executable cannot be located."""


def _candidate_paths() -> List[Path]:
    candidates: List[Path] = []
    home = Path.home()
    local = home / "AppData" / "Local"

    # winget package layout (the usual install on Windows)
    packages = local / "Microsoft" / "WinGet" / "Packages"
    if packages.is_dir():
        for entry in packages.glob("ghdl*"):
            candidates.append(entry / "bin" / "ghdl.exe")
            candidates.append(entry / "bin" / "ghdl")

    candidates.extend(
        [
            local / "Programs" / "GHDL" / "bin" / "ghdl.exe",
            local / "GHDL" / "bin" / "ghdl.exe",
            Path("C:/Program Files/GHDL/bin/ghdl.exe"),
            Path("C:/Program Files (x86)/GHDL/bin/ghdl.exe"),
            Path("C:/msys64/ucrt64/bin/ghdl.exe"),
            Path("C:/msys64/mingw64/bin/ghdl.exe"),
        ]
    )
    return candidates


def find_ghdl() -> str:
    """Locate the GHDL executable.

    Search order: ``GHDL_BIN`` environment variable, PATH, then the usual
    Windows install locations.  Raises :class:`GhdlNotFoundError` otherwise.
    """
    override = os.environ.get("GHDL_BIN") or os.environ.get("GHDL")
    if override:
        path = Path(override)
        if path.is_dir():
            path = path / "bin" / "ghdl.exe"
        if path.exists():
            return str(path)
        raise GhdlNotFoundError(f"GHDL_BIN points to a non-existent file: {override}")

    which = shutil.which("ghdl")
    if which:
        return which

    for candidate in _candidate_paths():
        if candidate.exists():
            return str(candidate)

    raise GhdlNotFoundError(
        "GHDL was not found. Install it with 'winget install ghdl.ghdl.ucrt64.mcode' "
        "or set the GHDL_BIN environment variable to ghdl.exe."
    )


class GhdlTool:
    """Command builder/runner for GHDL."""

    def __init__(self, executable: Optional[str] = None, std: str = "08") -> None:
        self.executable = executable or find_ghdl()
        self.std = std

    # -- introspection ----------------------------------------------------
    def version(self) -> str:
        result = self._run([self.executable, "--version"], cwd=None)
        first = result.stdout.splitlines()[0] if result.stdout else "unknown"
        return first.strip()

    # -- commands ---------------------------------------------------------
    def analyze(
        self, files: Sequence[str | Path], workdir: Path, work: str = "work"
    ) -> CommandResult:
        args = [
            self.executable,
            "-a",
            f"--std={self.std}",
            f"--workdir={workdir}",
            f"--work={work}",
            "-Werror=binding",
        ]
        args.extend(str(f) for f in files)
        return self._run(args, cwd=workdir.parent if workdir.parent.exists() else None)

    def elaborate(
        self, top: str, workdir: Path, work: str = "work"
    ) -> CommandResult:
        args = [
            self.executable,
            "-e",
            f"--std={self.std}",
            f"--workdir={workdir}",
            f"--work={work}",
            "-Werror=binding",
            top,
        ]
        return self._run(args, cwd=workdir.parent if workdir.parent.exists() else None)

    def synthesize(
        self, files: Sequence[str | Path], workdir: Path, top: str, work: str = "work"
    ) -> CommandResult:
        """Run GHDL's synthesis front-end.

        Used only as a lint pass: latch inference and multiple drivers are real
        problems on an FPGA, and GHDL's synthesis checker reports them even
        though the simulator itself will happily run the code.
        """
        args = [
            self.executable,
            "--synth",
            f"--std={self.std}",
            f"--workdir={workdir}",
            f"--work={work}",
        ]
        args.extend(str(f) for f in files)
        args.extend(["-e", top])
        return self._run(args, cwd=workdir.parent if workdir.parent.exists() else None)

    def run(
        self,
        top: str,
        workdir: Path,
        vcd_path: Path,
        stop_time_ns: float,
        work: str = "work",
        extra: Optional[Iterable[str]] = None,
    ) -> CommandResult:
        stop = max(1, int(round(stop_time_ns)))
        args = [
            self.executable,
            "-r",
            f"--std={self.std}",
            f"--workdir={workdir}",
            f"--work={work}",
            top,
            f"--vcd={vcd_path}",
            f"--stop-time={stop}ns",
        ]
        if extra:
            args.extend(extra)
        return self._run(args, cwd=workdir.parent if workdir.parent.exists() else None)

    # -- internals --------------------------------------------------------
    def _run(self, args: Sequence[str], cwd: Optional[Path]) -> CommandResult:
        try:
            completed = subprocess.run(
                list(args),
                cwd=str(cwd) if cwd else None,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            return CommandResult(
                ok=False,
                stderr="GHDL timed out after 60 seconds",
                returncode=-1,
                command=list(args),
            )
        except OSError as exc:
            return CommandResult(
                ok=False,
                stderr=str(exc),
                returncode=-1,
                command=list(args),
            )

        diagnostics = parse_diagnostics(completed.stdout + "\n" + completed.stderr)
        errors = [d for d in diagnostics if d.severity.lower() == "error"]
        ok = completed.returncode == 0 and not errors

        return CommandResult(
            ok=ok,
            stdout=completed.stdout or "",
            stderr=completed.stderr or "",
            returncode=completed.returncode,
            diagnostics=diagnostics,
            command=list(args),
        )


def parse_diagnostics(text: str) -> List[Diagnostic]:
    diagnostics: List[Diagnostic] = []
    for line in text.splitlines():
        match = _ERROR_RE.match(line.strip())
        if match:
            severity = match.group("severity").lower()
            message = match.group("message").strip()
        else:
            match = _ASSERT_RE.match(line.strip())
            if not match:
                continue
            severity = match.group("severity").lower()
            if severity in ("assertion failure", "assertion error"):
                severity = "error"
            message = f"assertion: {match.group('message').strip()}"
        try:
            diagnostics.append(
                Diagnostic(
                    file=match.group("file").strip(),
                    line=int(match.group("line")),
                    column=int(match.group("column")),
                    severity=severity,
                    message=message,
                )
            )
        except ValueError:  # pragma: no cover - malformed line
            continue
    return diagnostics


__all__ = [
    "CommandResult",
    "Diagnostic",
    "GhdlNotFoundError",
    "GhdlTool",
    "find_ghdl",
    "parse_diagnostics",
]