#!/usr/bin/env python3
"""Synchronize or verify the single-source VERSION string across all manifests."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")


def read_version() -> str:
    raw = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    if not SEMVER_RE.match(raw):
        raise ValueError(f"Invalid VERSION {raw!r}; expected X.Y.Z semver")
    return raw


def _sync_json(path: Path, key_path: tuple[str, ...], ver: str, write: bool) -> list[str]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    obj = data
    for k in key_path[:-1]:
        obj = obj[k]
    leaf = key_path[-1]
    cur = obj.get(leaf)
    if cur == ver:
        return []
    if write:
        obj[leaf] = ver
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")
        return [f"updated {path.relative_to(ROOT)}: {cur!r} -> {ver!r}"]
    return [f"mismatch in {path.relative_to(ROOT)}: expected {ver!r}, found {cur!r}"]


def _sync_regex(
    path: Path,
    pattern: re.Pattern[str],
    replacement_fn,
    ver: str,
    write: bool,
) -> list[str]:
    if not path.exists():
        return []
    orig = path.read_text(encoding="utf-8")
    m = pattern.search(orig)
    if not m:
        return [f"pattern not found in {path.relative_to(ROOT)}"]
    cur = m.group(1)
    if cur == ver:
        return []
    if write:
        updated = pattern.sub(lambda match: replacement_fn(match, ver), orig, count=1)
        path.write_text(updated, encoding="utf-8", newline="")
        return [f"updated {path.relative_to(ROOT)}: {cur!r} -> {ver!r}"]
    return [f"mismatch in {path.relative_to(ROOT)}: expected {ver!r}, found {cur!r}"]


def run_sync(write: bool) -> tuple[bool, list[str]]:
    ver = read_version()
    notes: list[str] = []

    notes.extend(_sync_json(ROOT / "package.json", ("version",), ver, write))
    notes.extend(_sync_json(ROOT / "frontend" / "package.json", ("version",), ver, write))
    notes.extend(_sync_json(ROOT / "src-tauri" / "tauri.conf.json", ("version",), ver, write))

    notes.extend(
        _sync_regex(
            ROOT / "backend" / "__init__.py",
            re.compile(r'__version__\s*=\s*"([^"]+)"'),
            lambda m, v: f'__version__ = "{v}"',
            ver,
            write,
        )
    )
    notes.extend(
        _sync_regex(
            ROOT / "frontend" / "src" / "state.js",
            re.compile(r'appVersion:\s*"([^"]+)"'),
            lambda m, v: f'appVersion: "{v}"',
            ver,
            write,
        )
    )
    notes.extend(
        _sync_regex(
            ROOT / "src-tauri" / "Cargo.toml",
            re.compile(r'(?m)^version\s*=\s*"([^"]+)"'),
            lambda m, v: f'version = "{v}"',
            ver,
            write,
        )
    )

    if write:
        return True, notes
    mismatches = [n for n in notes if n.startswith(("mismatch", "pattern"))]
    return len(mismatches) == 0, notes


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Check or synchronize Cyclone IV Studio VERSION.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="verify all files match VERSION (default)")
    group.add_argument("--write", action="store_true", help="update all files to match VERSION")
    args = parser.parse_args(argv)

    ok, notes = run_sync(write=bool(args.write))
    for line in notes:
        print(line)
    if args.write:
        print(f"Synced to VERSION={read_version()}")
        return 0
    if ok:
        print(f"OK: all manifests match VERSION={read_version()}")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
