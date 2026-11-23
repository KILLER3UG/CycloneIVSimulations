"""User settings persistence and Quartus/ModelSim toolchain validation."""

from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from .paths import projects_dir, user_data_dir

_SETTINGS_LOCK = threading.Lock()
_VERSION_CACHE: Dict[str, str] = {}

_QUARTUS_BINARIES = (
    "quartus_sh",
    "quartus_map",
    "quartus_fit",
    "quartus_asm",
    "quartus_sta",
    "quartus_eda",
    "quartus_pgm",
    "quartus_pgmw",
    "quartus",
)

_MODELSIM_BINARIES = ("vsim", "vcom", "vlog", "vlib")


def settings_file_path(*, create: bool = True) -> Path:
    return user_data_dir(create=create) / "settings.json"


def _exe_name(stem: str) -> str:
    return f"{stem}.exe" if os.name == "nt" else stem


def _no_window_flags() -> int:
    if os.name == "nt":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return 0


def _discover_quartus_candidates() -> List[str]:
    candidates: List[str] = []
    seen: set[str] = set()

    def _add(p: Path) -> None:
        try:
            resolved = str(p.resolve())
        except OSError:
            resolved = str(p)
        key = os.path.normcase(resolved)
        if key not in seen and p.is_dir():
            seen.add(key)
            candidates.append(resolved)

    rootdir = os.environ.get("QUARTUS_ROOTDIR", "").strip()
    if rootdir:
        for sub in ("bin64", "bin"):
            _add(Path(rootdir) / sub)

    which_sh = shutil.which("quartus_sh")
    if which_sh:
        _add(Path(which_sh).resolve().parent)

    if os.name == "nt":
        for drive in ("C:", "D:", "E:", "F:"):
            if not Path(f"{drive}\\").exists():
                continue
            for vendor in ("intelFPGA", "intelFPGA_lite", "intelFPGA_pro", "altera", "altera_lite"):
                for sub in ("bin64", "bin"):
                    for match in sorted(glob.glob(f"{drive}\\{vendor}\\*\\quartus\\{sub}"), reverse=True):
                        _add(Path(match))
    else:
        for pattern in (
            "/opt/intelFPGA/*/quartus/bin",
            "/opt/intelFPGA_lite/*/quartus/bin",
            "/opt/altera/*/quartus/bin",
        ):
            for match in sorted(glob.glob(pattern), reverse=True):
                _add(Path(match))

    return candidates


def _probe_quartus_version(quartus_sh: Path) -> str:
    key = os.path.normcase(str(quartus_sh))
    if key in _VERSION_CACHE:
        return _VERSION_CACHE[key]
    try:
        proc = subprocess.run(
            [str(quartus_sh), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=_no_window_flags(),
            check=False,
        )
        text = (proc.stdout or "") + "\n" + (proc.stderr or "")
        lines = [ln.strip() for ln in text.splitlines() if ln.strip() and "copyright" not in ln.lower()]
        ver = " ".join(lines[:2]) if lines else "Quartus Prime"
        _VERSION_CACHE[key] = ver
        return ver
    except Exception:
        return "Quartus Prime"


def validate_quartus_path(path: Optional[str]) -> Dict[str, Any]:
    """Validate a Quartus bin64 directory and return binary paths + version."""
    candidates = _discover_quartus_candidates()
    raw = str(path or "").strip()
    if not raw:
        return {
            "valid": False,
            "path": "",
            "version": "",
            "binaries": {},
            "candidates": candidates,
            "error": "Quartus path is not configured. Set the path to your Quartus bin64 directory (e.g. C:\\intelFPGA\\18.1\\quartus\\bin64).",
        }

    p = Path(raw).expanduser()
    # Accept a user accidentally picking the parent quartus/ folder
    if p.is_dir() and not (p / _exe_name("quartus_sh")).is_file():
        for sub in ("bin64", "bin", os.path.join("quartus", "bin64"), os.path.join("quartus", "bin")):
            cand = p / sub
            if (cand / _exe_name("quartus_sh")).is_file():
                p = cand
                break

    if not p.is_dir():
        return {
            "valid": False,
            "path": raw,
            "version": "",
            "binaries": {},
            "candidates": candidates,
            "error": f"Quartus directory does not exist: {raw}",
        }

    binaries: Dict[str, str] = {}
    for stem in _QUARTUS_BINARIES:
        exe = p / _exe_name(stem)
        if exe.is_file():
            binaries[stem] = str(exe)

    if "quartus_sh" not in binaries or "quartus_map" not in binaries:
        return {
            "valid": False,
            "path": str(p),
            "version": "",
            "binaries": binaries,
            "candidates": candidates,
            "error": f"Required Quartus tools (quartus_sh, quartus_map) were not found in {p}",
        }

    version = _probe_quartus_version(Path(binaries["quartus_sh"]))
    return {
        "valid": True,
        "path": str(p),
        "version": version,
        "binaries": binaries,
        "candidates": candidates,
        "error": "",
    }


def detect_quartus_bin() -> Dict[str, Any]:
    """Return validation info for the first detected Quartus bin directory."""
    for cand in _discover_quartus_candidates():
        info = validate_quartus_path(cand)
        if info["valid"]:
            return info
    return validate_quartus_path("")


def _discover_modelsim_candidates(quartus_bin: Optional[str] = None) -> List[str]:
    candidates: List[str] = []
    seen: set[str] = set()

    def _add(p: Path) -> None:
        try:
            resolved = str(p.resolve())
        except OSError:
            resolved = str(p)
        key = os.path.normcase(resolved)
        if key not in seen and p.is_dir():
            seen.add(key)
            candidates.append(resolved)

    if quartus_bin:
        q_path = Path(quartus_bin)
        # e.g. C:\intelFPGA\18.1\quartus\bin64 -> C:\intelFPGA\18.1
        suite_root = q_path.parent.parent if q_path.parent.name.lower() == "quartus" else q_path.parent
        for rel in (
            os.path.join("modelsim_ase", "win32aloem"),
            os.path.join("modelsim_ae", "win32aloem"),
            os.path.join("questa_fse", "win64"),
            os.path.join("modelsim_ase", "linuxaloem"),
            os.path.join("modelsim_ase", "bin"),
        ):
            _add(suite_root / rel)

    which_vsim = shutil.which("vsim")
    if which_vsim:
        _add(Path(which_vsim).resolve().parent)

    if os.name == "nt":
        for drive in ("C:", "D:", "E:", "F:"):
            if not Path(f"{drive}\\").exists():
                continue
            for vendor in ("intelFPGA", "intelFPGA_lite", "altera"):
                for rel in (r"modelsim_ase\win32aloem", r"modelsim_ae\win32aloem", r"questa_fse\win64"):
                    for match in sorted(glob.glob(f"{drive}\\{vendor}\\*\\{rel}"), reverse=True):
                        _add(Path(match))

    return candidates


def validate_modelsim_path(path: Optional[str], quartus_bin: Optional[str] = None) -> Dict[str, Any]:
    candidates = _discover_modelsim_candidates(quartus_bin)
    raw = str(path or "").strip()
    if not raw:
        return {
            "valid": False,
            "path": "",
            "binaries": {},
            "candidates": candidates,
            "error": "ModelSim path is not configured.",
        }

    p = Path(raw).expanduser()
    if p.is_dir() and not (p / _exe_name("vsim")).is_file():
        for sub in ("win32aloem", "win64", "bin", os.path.join("modelsim_ase", "win32aloem")):
            cand = p / sub
            if (cand / _exe_name("vsim")).is_file():
                p = cand
                break

    if not p.is_dir():
        return {
            "valid": False,
            "path": raw,
            "binaries": {},
            "candidates": candidates,
            "error": f"ModelSim directory does not exist: {raw}",
        }

    binaries: Dict[str, str] = {}
    for stem in _MODELSIM_BINARIES:
        exe = p / _exe_name(stem)
        if exe.is_file():
            binaries[stem] = str(exe)

    if "vsim" not in binaries or "vcom" not in binaries:
        return {
            "valid": False,
            "path": str(p),
            "binaries": binaries,
            "candidates": candidates,
            "error": f"Required ModelSim tools (vsim, vcom) were not found in {p}",
        }

    return {
        "valid": True,
        "path": str(p),
        "binaries": binaries,
        "candidates": candidates,
        "error": "",
    }


def detect_modelsim_bin(quartus_bin: Optional[str] = None) -> Dict[str, Any]:
    for cand in _discover_modelsim_candidates(quartus_bin):
        info = validate_modelsim_path(cand, quartus_bin=quartus_bin)
        if info["valid"]:
            return info
    return validate_modelsim_path("", quartus_bin=quartus_bin)


def default_settings() -> Dict[str, Any]:
    q_info = detect_quartus_bin()
    q_path = q_info["path"] if q_info["valid"] else ""
    m_info = detect_modelsim_bin(q_path or None)
    m_path = m_info["path"] if m_info["valid"] else ""
    return {
        "quartusPath": q_path,
        "modelsimPath": m_path,
        "defaultShell": "powershell",
        "projectDir": str(projects_dir(create=True)),
    }


def load_settings() -> Dict[str, Any]:
    with _SETTINGS_LOCK:
        path = settings_file_path(create=False)
        data: Dict[str, Any] = {}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except Exception:
                data = {}

        defaults = default_settings()
        merged = {
            "quartusPath": str(data["quartusPath"]) if "quartusPath" in data else defaults["quartusPath"],
            "modelsimPath": str(data["modelsimPath"]) if "modelsimPath" in data else defaults["modelsimPath"],
            "defaultShell": str(data.get("defaultShell") or defaults["defaultShell"]),
            "projectDir": str(data.get("projectDir") or defaults["projectDir"]),
        }
        return merged


def save_settings(updates: Dict[str, Any]) -> Dict[str, Any]:
    with _SETTINGS_LOCK:
        path = settings_file_path(create=True)
        existing: Dict[str, Any] = {}
        if path.is_file():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    existing = loaded
            except Exception:
                existing = {}

        defaults = default_settings()
        merged = {
            "quartusPath": str(existing["quartusPath"]) if "quartusPath" in existing else defaults["quartusPath"],
            "modelsimPath": str(existing["modelsimPath"]) if "modelsimPath" in existing else defaults["modelsimPath"],
            "defaultShell": str(existing.get("defaultShell") or defaults["defaultShell"]),
            "projectDir": str(existing.get("projectDir") or defaults["projectDir"]),
        }
        for key in ("quartusPath", "modelsimPath", "defaultShell", "projectDir"):
            if key in updates and updates[key] is not None:
                merged[key] = str(updates[key]).strip()

        if not merged["modelsimPath"] and merged["quartusPath"]:
            auto_m = detect_modelsim_bin(merged["quartusPath"])
            if auto_m["valid"]:
                merged["modelsimPath"] = auto_m["path"]

        path.write_text(json.dumps(merged, indent=2), encoding="utf-8")
        return merged


def get_settings_with_status() -> Dict[str, Any]:
    settings = load_settings()
    quartus_info = validate_quartus_path(settings.get("quartusPath"))
    modelsim_info = validate_modelsim_path(
        settings.get("modelsimPath"),
        quartus_bin=quartus_info.get("path") or settings.get("quartusPath"),
    )
    return {
        "settings": settings,
        "quartus": quartus_info,
        "modelsim": modelsim_info,
    }
