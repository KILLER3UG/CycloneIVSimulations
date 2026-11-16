"""Bundle and per-user data path helpers for development and packaged runs."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _clean_path(p: Path) -> Path:
    s = str(p)
    if s.startswith("\\\\?\\") and not s.startswith("\\\\?\\UNC\\"):
        return Path(s[4:])
    return p


def bundle_root() -> Path:
    """Return the root directory containing ``board/``, ``examples/``, and ``frontend/``."""
    env_dir = os.environ.get("CYCLONE_BUNDLE_DIR", "").strip()
    if env_dir:
        candidate = _clean_path(Path(env_dir).expanduser().resolve())
        if candidate.is_dir():
            return candidate

    if getattr(sys, "frozen", False):
        exe_dir = _clean_path(Path(sys.executable).resolve().parent)
        for cand in (exe_dir, exe_dir / "_internal"):
            if (cand / "board" / "board.json").is_file():
                return cand
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            cand = _clean_path(Path(meipass).resolve())
            if (cand / "board" / "board.json").is_file():
                return cand
        return exe_dir

    return _clean_path(Path(__file__).resolve().parent.parent)


def bundled_ghdl_candidates() -> list[Path]:
    """Candidate paths for a GHDL binary bundled inside the app package."""
    roots: list[Path] = [bundle_root()]
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        roots.extend([exe_dir, exe_dir / "_internal"])
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            roots.append(Path(meipass).resolve())

    seen: set[Path] = set()
    candidates: list[Path] = []
    for root in roots:
        for rel in (
            Path("ghdl") / "bin" / "ghdl.exe",
            Path("ghdl") / "bin" / "ghdl",
            Path("bin") / "ghdl.exe",
        ):
            p = root / rel
            if p not in seen:
                seen.add(p)
                candidates.append(p)
    return candidates


def user_data_dir(*, create: bool = True) -> Path:
    """Return writable per-user data directory (``%APPDATA%\\CycloneIVStudio`` on Windows)."""
    override = os.environ.get("CYCLONE_USER_DATA_DIR", "").strip()
    if override:
        base = Path(override).expanduser().resolve()
    elif os.name == "nt":
        appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        base = Path(appdata) / "CycloneIVStudio"
    else:
        xdg = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        base = Path(xdg) / "CycloneIVStudio"

    if create:
        base.mkdir(parents=True, exist_ok=True)
    return base


def log_file_path(*, create: bool = True) -> Path:
    """Path to the persistent backend log file inside the user data directory."""
    logs = user_data_dir(create=create) / "logs"
    if create:
        logs.mkdir(parents=True, exist_ok=True)
    return logs / "backend.log"


def projects_dir(*, create: bool = True) -> Path:
    """Path to saved user projects directory inside the user data directory."""
    proj = user_data_dir(create=create) / "projects"
    if create:
        proj.mkdir(parents=True, exist_ok=True)
    return proj
