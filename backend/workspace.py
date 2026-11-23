"""Two-way disk workspace synchronization for external editors & CLI agents."""

from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List

WORKSPACE_EXTS = {".vhd", ".vhdl", ".v", ".sv", ".qsf", ".qpf", ".sdc", ".mif", ".hex"}
IGNORED_DIRS = {
    "db",
    "incremental_db",
    "output_files",
    "simulation",
    "greybox_tmp",
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "target",
}
_MAX_FILE_BYTES = 2 * 1024 * 1024


def _safe_rel_path(root: Path, rel: str) -> Path:
    cleaned = str(rel or "").replace("\\", "/").strip().lstrip("/")
    if not cleaned:
        raise ValueError("Empty relative file path")
    rel_path = Path(cleaned)
    if rel_path.is_absolute() or ".." in rel_path.parts:
        raise ValueError(f"Invalid relative path: {rel!r}")
    root_resolved = root.resolve()
    target = (root_resolved / rel_path).resolve()
    if not target.is_relative_to(root_resolved):
        raise ValueError(f"Path escapes workspace root: {rel!r}")
    return target


def scan_workspace(dir_path: str | Path, *, max_depth: int = 3) -> Dict[str, Any]:
    """Scan a workspace directory for HDL/Quartus source files and return a content hash version."""
    raw = str(dir_path or "").strip()
    if not raw:
        raise ValueError("Workspace directory path is required")
    root = Path(raw).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Workspace directory does not exist: {raw}")

    found: List[tuple[str, Path]] = []

    def _walk(cur: Path, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = list(cur.iterdir())
        except OSError:
            return
        for entry in entries:
            try:
                if entry.is_dir():
                    if entry.name in IGNORED_DIRS or entry.name.startswith("."):
                        continue
                    _walk(entry, depth + 1)
                elif entry.is_file():
                    if entry.suffix.lower() not in WORKSPACE_EXTS:
                        continue
                    rel = entry.relative_to(root).as_posix()
                    found.append((rel, entry))
            except OSError:
                continue

    _walk(root, 0)
    found.sort(key=lambda item: (item[0].lower(), item[0]))

    files: List[Dict[str, Any]] = []
    version_hasher = hashlib.sha256()

    for rel, path in found:
        try:
            st = path.stat()
            if st.st_size > _MAX_FILE_BYTES:
                continue
            raw_bytes = path.read_bytes()
        except OSError:
            continue

        digest = hashlib.sha256(raw_bytes).hexdigest()
        text = raw_bytes.decode("utf-8", errors="replace")
        mtime_ns = getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000))
        files.append({
            "name": rel,
            "content": text,
            "sha256": digest,
            "mtimeNs": mtime_ns,
            "size": len(raw_bytes),
        })
        version_hasher.update(rel.encode("utf-8"))
        version_hasher.update(b"\0")
        version_hasher.update(digest.encode("ascii"))
        version_hasher.update(b"\n")

    return {
        "ok": True,
        "dir": str(root),
        "version": version_hasher.hexdigest(),
        "files": files,
    }


def write_workspace_files(dir_path: str | Path, files: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Write editor files to disk atomically (skipping unchanged files), then return snapshot."""
    raw = str(dir_path or "").strip()
    if not raw:
        raise ValueError("Workspace directory path is required")
    root = Path(raw).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)

    for item in files or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        content = str(item.get("content") or "")
        target = _safe_rel_path(root, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        new_bytes = content.encode("utf-8")
        try:
            if target.is_file() and target.read_bytes() == new_bytes:
                continue
        except OSError:
            pass

        tmp = target.parent / f".{target.name}.{uuid.uuid4().hex[:8]}.tmp"
        try:
            tmp.write_bytes(new_bytes)
            os.replace(tmp, target)
        except OSError:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            target.write_bytes(new_bytes)

    return scan_workspace(root)


def delete_workspace_file(dir_path: str | Path, name: str) -> Dict[str, Any]:
    """Delete a file inside a workspace safely and return updated snapshot."""
    raw = str(dir_path or "").strip()
    if not raw:
        raise ValueError("Workspace directory path is required")
    root = Path(raw).expanduser().resolve()
    target = _safe_rel_path(root, name)
    if target.is_file():
        target.unlink()
    return scan_workspace(root)
