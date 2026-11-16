"""PyInstaller frozen entry point for Cyclone IV Studio backend."""

from backend.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
