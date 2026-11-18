#!/usr/bin/env python3
"""Build the frozen Python + FastAPI + GHDL sidecar bundle for Cyclone IV Studio."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.ghdl_tool import GhdlNotFoundError, find_ghdl  # noqa: E402


def _ignore_junk(_src: str, names: list[str]) -> set[str]:
    return {n for n in names if n in ("__pycache__", ".pytest_cache") or n.endswith(".pyc")}


def build_sidecar() -> Path:
    dist_front = ROOT / "frontend" / "dist"
    if not (dist_front / "index.html").is_file():
        raise RuntimeError(f"Missing built frontend at {dist_front}. Run 'cd frontend && npm run build' first.")

    try:
        ghdl_bin = Path(find_ghdl()).resolve()
    except GhdlNotFoundError as exc:
        raise RuntimeError(f"GHDL must be installed to build the sidecar: {exc}") from exc

    ghdl_root = ghdl_bin.parent.parent
    if not (ghdl_root / "bin").is_dir() or not (ghdl_root / "lib").is_dir():
        raise RuntimeError(f"Unexpected GHDL directory layout at {ghdl_root}; expected bin/ and lib/.")

    work_root = ROOT / "packaging" / "build"
    py_dist = work_root / "dist"
    py_work = work_root / "work"
    py_spec = work_root / "spec"
    sidecar_dir = ROOT / "src-tauri" / "sidecar" / "cyclone-backend"

    for d in (work_root, sidecar_dir):
        if d.exists():
            shutil.rmtree(d)
    py_dist.mkdir(parents=True, exist_ok=True)
    py_work.mkdir(parents=True, exist_ok=True)
    py_spec.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "cyclone-backend",
        "--paths",
        str(ROOT),
        "--distpath",
        str(py_dist),
        "--workpath",
        str(py_work),
        "--specpath",
        str(py_spec),
        "--hidden-import",
        "uvicorn.logging",
        "--hidden-import",
        "uvicorn.loops.auto",
        "--hidden-import",
        "uvicorn.protocols.http.auto",
        "--hidden-import",
        "uvicorn.protocols.websockets.auto",
        "--hidden-import",
        "uvicorn.lifespan.on",
        "--collect-submodules",
        "websockets",
        "--collect-all",
        "winpty",
        "--exclude-module",
        "pytest",
        str(ROOT / "packaging" / "sidecar_entry.py"),
    ]
    print("Running PyInstaller:", " ".join(cmd))
    subprocess.run(cmd, cwd=str(ROOT), check=True)

    built = py_dist / "cyclone-backend"
    if not (built / "cyclone-backend.exe").is_file():
        raise RuntimeError(f"PyInstaller did not produce {built / 'cyclone-backend.exe'}")

    sidecar_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(built, sidecar_dir, ignore=_ignore_junk)

    # Copy ONLY clean-room hardware metadata, open device models, examples, built UI, and licenses.
    # Excludes board/schematic/ (PDFs), board/photos/, and board/vendor/ (.sof/.pof/vendor examples).
    board_dst = sidecar_dir / "board"
    board_dst.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "board" / "board.json", board_dst / "board.json")

    # Declarative board profiles (default board copy + extra built-in boards).
    boards_src = ROOT / "boards"
    if boards_src.is_dir():
        shutil.copytree(boards_src, sidecar_dir / "boards", ignore=_ignore_junk)

    models_src = ROOT / "board" / "models"
    if models_src.is_dir():
        shutil.copytree(models_src, board_dst / "models", ignore=_ignore_junk)

    examples_dst = sidecar_dir / "examples"
    examples_dst.mkdir(parents=True, exist_ok=True)
    for vhd in sorted((ROOT / "examples").glob("*.vhd")):
        shutil.copy2(vhd, examples_dst / vhd.name)

    shutil.copytree(dist_front, sidecar_dir / "frontend" / "dist")

    ghdl_dst = sidecar_dir / "ghdl"
    shutil.copytree(ghdl_root / "bin", ghdl_dst / "bin")
    shutil.copytree(ghdl_root / "lib", ghdl_dst / "lib")

    for doc in ("VERSION", "CHANGELOG.md", "THIRD_PARTY_LICENSES.md"):
        src_doc = ROOT / doc
        if src_doc.is_file():
            shutil.copy2(src_doc, sidecar_dir / doc)

    total_files = sum(1 for p in sidecar_dir.rglob("*") if p.is_file())
    total_mb = sum(p.stat().st_size for p in sidecar_dir.rglob("*") if p.is_file()) / (1024 * 1024)
    print(f"Sidecar ready at {sidecar_dir} ({total_files} files, {total_mb:.1f} MB)")
    return sidecar_dir


if __name__ == "__main__":
    build_sidecar()
