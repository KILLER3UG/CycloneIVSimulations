"""Interactive terminal bridge for the simulator sidecar.

The terminal is a real OS shell started in a sensible working directory with
the bundled (or discovered) GHDL executable directory prepended to ``PATH``,
so a student can type ``ghdl ...`` immediately after opening the terminal.

Nothing about the machine is hardcoded:

* the shell is the user's default — ``$SHELL`` on POSIX/WSL, ``%COMSPEC%`` on
  Windows (``cmd.exe``/``/bin/sh`` only as last-resort fallbacks);
* the environment (including the system ``PATH``) is inherited as-is;
* the working directory resolves dynamically: an explicit request wins, then
  the workspace root (development checkout) or the user's projects directory
  (installed app), then the user's home directory.

On Windows a ConPTY is used when ``winpty`` is available; if it is not, the
module falls back to a plain pipe-backed shell.  On POSIX a standard
``pty.openpty()`` pair is used.  Every shell is tracked so a WebSocket
disconnect or server shutdown can kill the whole child process tree (no
orphan shells).
"""

from __future__ import annotations

import atexit
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .ghdl_tool import GhdlNotFoundError, find_ghdl
from .paths import bundle_root, projects_dir, user_data_dir

_ACTIVE_TERMINALS: set["TerminalSession"] = set()
_LOCK = threading.Lock()


def _ghdl_binary() -> Optional[str]:
    try:
        return find_ghdl()
    except GhdlNotFoundError:
        return None


def ghdl_on_path() -> bool:
    """Whether the shell environment includes a usable GHDL binary."""
    binary = _ghdl_binary()
    if not binary:
        return False
    augmented = str(Path(binary).resolve().parent) + os.pathsep + os.environ.get("PATH", "")
    return shutil.which("ghdl", path=augmented) is not None


def default_shell() -> str:
    """The user's default shell, detected from the environment.

    POSIX (and WSL) honour ``$SHELL``; Windows honours ``%COMSPEC%``.  The
    platform's standard shell (``/bin/sh`` / ``cmd.exe``) is only a last
    resort when the variable is unset — never a hardcoded assumption.
    """
    if os.name == "nt":
        return os.environ.get("COMSPEC") or os.environ.get("SHELL") or "cmd.exe"
    return os.environ.get("SHELL") or os.environ.get("COMSPEC") or "/bin/sh"


def resolve_cwd(explicit: Optional[str] = None) -> str:
    """Working directory for a new shell, resolved dynamically.

    Order: an explicit request from the caller, then the workspace root (the
    development checkout, or the user's saved-projects directory for the
    installed app), then the user's home directory — the first one that
    exists wins.
    """
    candidates: list[Path] = []
    if explicit and str(explicit).strip():
        candidates.append(Path(str(explicit).strip()).expanduser())
    if getattr(sys, "frozen", False):
        candidates.append(projects_dir(create=False))
    else:
        candidates.append(bundle_root())
    candidates.append(user_data_dir(create=False))
    candidates.append(Path.home())
    for candidate in candidates:
        try:
            if candidate.is_dir():
                return str(candidate)
        except OSError:
            continue
    return str(Path.home())


def _shell_env() -> dict:
    env = os.environ.copy()
    binary = _ghdl_binary()
    if binary:
        ghdl_dir = str(Path(binary).resolve().parent)
        env["PATH"] = ghdl_dir + os.pathsep + env.get("PATH", "")
    return env


def _decode(data) -> str:
    if isinstance(data, bytes):
        return data.decode("utf-8", errors="replace")
    return str(data)


class TerminalSession:
    """One interactive shell attached to an optional output callback."""

    #: Seconds to wait for the winpty ConPTY spawn before falling back to a
    #: pipe-backed shell (a stalled spawn must never hang the caller).
    SPAWN_TIMEOUT = 15.0

    def __init__(
        self,
        rows: int = 24,
        cols: int = 80,
        cwd: Optional[str] = None,
        on_output: Optional[Callable[[str], None]] = None,
        on_exit: Optional[Callable[[int], None]] = None,
    ) -> None:
        self.rows = max(1, int(rows))
        self.cols = max(1, int(cols))
        self.cwd = resolve_cwd(cwd)
        self.on_output = on_output
        self.on_exit = on_exit
        self.ghdl_on_path = ghdl_on_path()

        self._proc: Any = None
        self._master_fd: Optional[int] = None
        self._slave_fd: Optional[int] = None
        self._reader: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._emit_lock = threading.Lock()
        self._output_queue: "queue.Queue[str]" = queue.Queue()
        self._using_winpty = False
        self._exit_code: Optional[int] = None

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> "TerminalSession":
        self._stop.clear()
        env = _shell_env()
        if os.name == "nt":
            self._start_windows(env)
        else:
            self._start_posix(env)

        self._reader = threading.Thread(target=self._read_loop, daemon=True,
                                        name="terminal-reader")
        self._reader.start()
        with _LOCK:
            _ACTIVE_TERMINALS.add(self)
        return self

    def _start_windows(self, env: dict) -> None:
        shell = default_shell()
        # winpty's ConPTY spawn can stall indefinitely in environments without
        # a usable window station (observed on hosted CI runners).  Run the
        # spawn under a bounded wait and fall back to a pipe-backed shell
        # instead of hanging the caller; a late-completing spawn is discarded.
        outcome: dict = {"proc": None, "error": None, "done": False}

        def _spawn() -> None:
            try:
                import winpty  # type: ignore
                outcome["proc"] = winpty.PtyProcess.spawn(
                    shell, cwd=self.cwd, env=env,
                    dimensions=(self.rows, self.cols),
                )
            except Exception as exc:  # noqa: BLE001 - any winpty failure => fallback
                outcome["error"] = exc
            finally:
                outcome["done"] = True

        spawner = threading.Thread(target=_spawn, daemon=True, name="winpty-spawn")
        spawner.start()
        spawner.join(timeout=self.SPAWN_TIMEOUT)
        if outcome["done"] and outcome["proc"] is not None:
            self._proc = outcome["proc"]
            self._using_winpty = True
            return
        if not outcome["done"]:
            # The spawn may still complete after the timeout; make sure that
            # late shell never leaks.
            def _discard_late() -> None:
                while not outcome["done"]:
                    time.sleep(0.2)
                late = outcome["proc"]
                if late is not None:
                    try:
                        late.terminate(force=True)
                    except Exception:
                        pass

            threading.Thread(target=_discard_late, daemon=True,
                             name="winpty-discard").start()

        # winpty is optional; a pipe-backed shell is still usable.
        self._using_winpty = False

        creationflags = 0
        if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP
        self._proc = subprocess.Popen(
            [shell], cwd=self.cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, creationflags=creationflags,
        )

    def _start_posix(self, env: dict) -> None:
        import fcntl  # POSIX only; imported lazily for Windows compatibility.
        import pty
        import termios
        import struct

        shell = default_shell()
        self._master_fd, self._slave_fd = pty.openpty()
        fcntl.ioctl(
            self._slave_fd, termios.TIOCSWINSZ,
            struct.pack("HHHH", self.rows, self.cols, 0, 0),
        )
        self._proc = subprocess.Popen(
            [shell], cwd=self.cwd, env=env,
            stdin=self._slave_fd, stdout=self._slave_fd, stderr=self._slave_fd,
            start_new_session=True, close_fds=True,
        )

    # -- I/O ---------------------------------------------------------------
    def _read_once(self) -> Optional[str]:
        if self._proc is None:
            return None
        if self._using_winpty:
            data = self._proc.read(4096)  # pywinpty returns str
            return data or None
        if os.name == "nt":
            assert self._proc.stdout is not None
            # read1() returns whatever the pipe has now; BufferedReader.read()
            # would block until the FULL 4096 bytes arrive (or EOF), which
            # stalls the interactive prompt/output flow (CI hang root cause).
            chunk = self._proc.stdout.read1(4096)
            return _decode(chunk) if chunk else None
        assert self._master_fd is not None
        try:
            chunk = os.read(self._master_fd, 4096)
        except OSError:
            return None
        return _decode(chunk) if chunk else None

    def _read_loop(self) -> None:
        while not self._stop.is_set():
            try:
                data = self._read_once()
            except Exception:
                data = None
            if data:
                if self.on_output:
                    try:
                        self.on_output(data)
                    except Exception:
                        pass
                self._output_queue.put(data)
                continue
            break
        code = self._current_exit_code()
        self._exit_code = code
        # An intentional close()/restart() must not emit an exit event: a
        # restart would otherwise satisfy the WebSocket's exit watcher and
        # tear down the connection instead of returning to the new shell.
        if self.on_exit and not self._stop.is_set():
            try:
                self.on_exit(code)
            except Exception:
                pass

    def _current_exit_code(self) -> int:
        if self._proc is None:
            return -1
        if self._using_winpty:
            try:
                status = self._proc.exitstatus
                if status is not None:
                    return int(status)
            except Exception:
                pass
            return -1
        code = self._proc.poll()
        return int(code) if code is not None else -1

    def read_output(self, timeout: float = 0.1) -> Optional[str]:
        """Pop one queued output chunk (used by non-callback consumers)."""
        try:
            return self._output_queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def write(self, data: str) -> None:
        if self._proc is None or self._stop.is_set():
            return
        if self._using_winpty:
            self._proc.write(str(data))
        elif os.name == "nt":
            assert self._proc.stdin is not None
            self._proc.stdin.write(str(data).encode("utf-8", errors="replace"))
            self._proc.stdin.flush()
        elif self._master_fd is not None:
            os.write(self._master_fd, str(data).encode("utf-8", errors="replace"))

    def interrupt(self) -> None:
        """Send an interrupt (Ctrl-C) to the foreground shell process."""
        if self._proc is None:
            return
        if self._using_winpty:
            try:
                self._proc.sendintr()
                return
            except Exception:
                self.write("\x03")
            return
        if os.name == "nt":
            if hasattr(self._proc, "send_signal") and hasattr(signal, "CTRL_C_EVENT"):
                try:
                    self._proc.send_signal(signal.CTRL_C_EVENT)
                    return
                except Exception:
                    pass
            self.write("\x03")
            return
        try:
            os.killpg(os.getpgid(self._proc.pid), signal.SIGINT)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def resize(self, cols: int, rows: int) -> None:
        self.cols = max(1, int(cols))
        self.rows = max(1, int(rows))
        if self._proc is None:
            return
        if self._using_winpty:
            try:
                self._proc.setwinsize(self.rows, self.cols)
            except Exception:
                pass
            return
        if os.name != "nt" and self._master_fd is not None:
            import fcntl
            import struct
            try:
                fcntl.ioctl(self._master_fd, 0x5418,
                            struct.pack("HHHH", self.rows, self.cols, 0, 0))
            except (OSError, ImportError):
                pass

    def restart(self) -> "TerminalSession":
        self.close()
        return self.start()

    def close(self) -> None:
        """Terminate the shell and all of its children; safe to call twice."""
        self._stop.set()
        with _LOCK:
            _ACTIVE_TERMINALS.discard(self)

        proc = self._proc
        if proc is not None and os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=10, check=False,
                )
            except Exception:
                pass
        if proc is not None:
            try:
                if self._using_winpty:
                    try:
                        proc.close(force=True)
                    except Exception:
                        proc.terminate(force=True)
                else:
                    if os.name != "nt":
                        try:
                            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                        except (ProcessLookupError, PermissionError, OSError):
                            pass
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
            except Exception:
                pass

        for fd_attr in ("_master_fd", "_slave_fd"):
            fd = getattr(self, fd_attr)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(self, fd_attr, None)

        reader = self._reader
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=2)
        self._reader = None
        self._proc = None


def cleanup_all_terminals() -> None:
    """Close every tracked terminal (FastAPI shutdown / atexit hook)."""
    with _LOCK:
        sessions = list(_ACTIVE_TERMINALS)
    for session in sessions:
        try:
            session.close()
        except Exception:
            pass


atexit.register(cleanup_all_terminals)


def active_terminals() -> list["TerminalSession"]:
    with _LOCK:
        return list(_ACTIVE_TERMINALS)


def exec_terminal_command(
    command: str,
    cwd: Optional[str] = None,
    timeout: float = 15.0,
) -> dict:
    """Run one command synchronously with GHDL on PATH."""
    env = _shell_env()
    target_cwd = resolve_cwd(cwd)
    shell = default_shell()
    argv = [shell, "/C", command] if os.name == "nt" else [shell, "-c", command]
    try:
        # A fresh session lets us kill the entire tree on timeout; a plain
        # subprocess.run(timeout=...) only kills the direct child.
        proc = subprocess.Popen(
            argv, cwd=target_cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=(os.name != "nt"),
        )
        try:
            out_b, err_b = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                try:
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        timeout=10, check=False,
                    )
                except Exception:
                    pass
            else:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    proc.kill()
            out_b, err_b = proc.communicate()
            return {
                "ok": False, "code": -1, "output": "Command timed out",
                "timedOut": True, "cwd": target_cwd,
            }
        stdout = _decode(out_b)
        stderr = _decode(err_b)
        output = stdout + stderr
        return {
            "ok": proc.returncode == 0,
            "code": proc.returncode,
            "output": output,
            "stdout": stdout,
            "stderr": stderr,
            "cwd": target_cwd,
            "ghdlOnPath": ghdl_on_path(),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "code": -1, "output": "Command timed out",
                "timedOut": True, "cwd": target_cwd}
    except Exception as exc:
        return {"ok": False, "code": -1, "output": str(exc), "cwd": target_cwd}


__all__ = [
    "TerminalSession",
    "cleanup_all_terminals",
    "active_terminals",
    "exec_terminal_command",
    "ghdl_on_path",
    "default_shell",
    "resolve_cwd",
]
