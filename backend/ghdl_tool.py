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
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .paths import bundled_ghdl_candidates
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
    #: True when the run was aborted by ``cancel_current()`` (stop path) —
    #: reported as not-ok but NOT as a compile/simulation error.
    cancelled: bool = False

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
    candidates: List[Path] = list(bundled_ghdl_candidates())
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

    if getattr(sys, "frozen", False):
        for candidate in bundled_ghdl_candidates():
            if candidate.exists():
                return str(candidate)

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
    """Command builder/runner for GHDL.

    The subprocess timeout scales with the requested simulation duration
    (minimum 60 s, hard cap 900 s) so a long but legitimate run is not killed
    by a fixed ceiling.  Set the ``GHDL_TIMEOUT`` environment variable (or
    pass ``timeout=``) to force a specific budget in seconds — useful to
    prove that a runaway design is reported instead of hanging.
    """

    #: Wall-clock seconds per simulated millisecond used to size the run budget.
    WALL_SECONDS_PER_SIM_MS = 2.0
    #: Floor/ceiling for the auto-scaled run timeout.
    MIN_RUN_TIMEOUT = 60.0
    MAX_RUN_TIMEOUT = 900.0

    def __init__(self, executable: Optional[str] = None, std: str = "08",
                 timeout: Optional[float] = None) -> None:
        self.executable = executable or find_ghdl()
        self.std = std
        self._version_cache: Optional[str] = None
        env_timeout = os.environ.get("GHDL_TIMEOUT", "").strip()
        if timeout is None and env_timeout:
            try:
                timeout = float(env_timeout)
            except ValueError:
                timeout = None
        self.timeout = float(timeout) if timeout and timeout > 0 else None
        # Stop/cancel support (ENG-03): every run registers its GHDL child
        # under a per-run cancel TOKEN (a small dict owned by the caller —
        # usually one per simulation session). Killing a token kills exactly
        # that run; no shared flag can poison an unrelated run's compile.
        self._children_lock = threading.Lock()
        self._active_children: Dict[int, subprocess.Popen] = {}

    def _run_timeout(self, stop_time_ns: float) -> float:
        """Timeout for a simulation run: explicit override, else scaled."""
        if self.timeout is not None:
            return self.timeout
        simulated_ms = max(0.0, float(stop_time_ns)) / 1e6
        scaled = simulated_ms * self.WALL_SECONDS_PER_SIM_MS + 30.0
        return min(self.MAX_RUN_TIMEOUT, max(self.MIN_RUN_TIMEOUT, scaled))

    # -- introspection ----------------------------------------------------
    def version(self) -> str:
        # The GHDL version never changes for a given executable, so cache it:
        # every WebSocket connect calls health() -> version(), and spawning
        # `ghdl --version` each time added ~200 ms to every live refresh.
        if self._version_cache is None:
            result = self._run([self.executable, "--version"], cwd=None)
            first = result.stdout.splitlines()[0] if result.stdout else "unknown"
            self._version_cache = first.strip()
        return self._version_cache

    # -- commands ---------------------------------------------------------
    @staticmethod
    def _resolve_cwd(cwd: Optional[Path], workdir: Path) -> Optional[Path]:
        """Explicit cwd wins; otherwise run next to the work library as before."""
        if cwd is not None:
            return cwd
        return workdir.parent if workdir.parent.exists() else None

    def analyze(
        self,
        files: Sequence[str | Path],
        workdir: Path,
        work: str = "work",
        cwd: Optional[Path] = None,
        extra_flags: Optional[Iterable[str]] = None,
        token: Optional[dict] = None,
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
        if extra_flags:
            args.extend(str(f) for f in extra_flags)
        return self._run(args, cwd=self._resolve_cwd(cwd, workdir), token=token)

    def elaborate(
        self, top: str, workdir: Path, work: str = "work", cwd: Optional[Path] = None,
        token: Optional[dict] = None,
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
        return self._run(args, cwd=self._resolve_cwd(cwd, workdir), token=token)

    def synthesize(
        self,
        files: Sequence[str | Path],
        workdir: Path,
        top: str,
        work: str = "work",
        cwd: Optional[Path] = None,
        token: Optional[dict] = None,
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
        return self._run(args, cwd=self._resolve_cwd(cwd, workdir), token=token)

    def run(
        self,
        top: str,
        workdir: Path,
        vcd_path: Path,
        stop_time_ns: float,
        work: str = "work",
        extra: Optional[Iterable[str]] = None,
        cwd: Optional[Path] = None,
        token: Optional[dict] = None,
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
        return self._run(args, cwd=self._resolve_cwd(cwd, workdir),
                         timeout=self._run_timeout(stop_time_ns), token=token)

    # -- stop/cancel (ENG-03) ---------------------------------------------
    def cancel_token(self, token: dict) -> bool:
        """Kill the GHDL child registered under ``token`` (stop path).

        The token's ``cancelled`` flag makes that run's result come back as
        not-ok; the calling session discards it (sim_stopped was already
        emitted). Returns True when a live child was killed.
        """
        proc = token.get("proc") if isinstance(token, dict) else None
        if not isinstance(token, dict):
            # No GHDL child has been registered yet (still analyzing/elaborating,
            # or the run already finished). Nothing to kill — report False
            # instead of raising (ENG-03B).
            return False
        if proc is not None and proc.poll() is None:
            token["cancelled"] = True
            try:
                proc.kill()
                return True
            except OSError:
                return False
        token["cancelled"] = True
        return False

    # -- internals --------------------------------------------------------
    def _cancelled_result(self, args: Sequence[str]) -> CommandResult:
        """A clean not-ok result for a run aborted by its cancel token.

        Marked ``cancelled=True`` so callers can tell a user-requested stop
        from a compile/simulation error: the stop path discards the run, and
        the REST/CLI path reports "Simulation cancelled" instead of treating
        the killed GHDL child as a failure.
        """
        message = "simulation cancelled: the GHDL run was stopped by a cancel request"
        return CommandResult(
            ok=False,
            stderr=message,
            returncode=-1,
            cancelled=True,
            command=list(args),
            diagnostics=[
                Diagnostic(file="ghdl", line=0, column=0, severity="error", message=message)
            ],
        )

    def _run(self, args: Sequence[str], cwd: Optional[Path],
             timeout: Optional[float] = None,
             token: Optional[dict] = None) -> CommandResult:
        effective = float(timeout) if timeout is not None else (self.timeout or 60.0)
        if isinstance(token, dict) and token.get("cancelled"):
            return self._cancelled_result(args)
        proc = subprocess.Popen(
            list(args),
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        child_id = id(proc)
        with self._children_lock:
            self._active_children[child_id] = proc
        if isinstance(token, dict):
            token["proc"] = proc
        timed_out = False
        try:
            completed_stdout, completed_stderr = proc.communicate(timeout=effective)
        except subprocess.TimeoutExpired:
            timed_out = True
            proc.kill()
            completed_stdout, completed_stderr = proc.communicate()
        except OSError as exc:
            return CommandResult(
                ok=False,
                stderr=str(exc),
                returncode=-1,
                command=list(args),
            )
        finally:
            with self._children_lock:
                self._active_children.pop(child_id, None)
            cancel_hit = bool(isinstance(token, dict) and token.get("cancelled")
                              and proc.returncode not in (0, None))

        if timed_out:
            is_run = "-r" in args
            message = (
                f"GHDL timed out after {effective:g} s of wall time"
                + (
                    " — possible runaway design (an infinite loop without a wait "
                    "statement?) or a simulation budget that is too small; raise the "
                    "requested duration cap or set GHDL_TIMEOUT to change the limit"
                    if is_run else ""
                )
            )
            return CommandResult(
                ok=False,
                stderr=message,
                returncode=-1,
                command=list(args),
                diagnostics=[Diagnostic(
                    file="ghdl", line=0, column=0, severity="error", message=message,
                )],
            )
        if cancel_hit and proc.returncode != 0:
            # killed by cancel_current(): report as cancelled, not as a
            # compile/simulation error (the stop path discards the run)
            return self._cancelled_result(args)

        completed = subprocess.CompletedProcess(args, proc.returncode, completed_stdout, completed_stderr)

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