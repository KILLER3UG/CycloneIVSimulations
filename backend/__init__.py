"""Cyclone IV VHDL simulation backend.

The package is deliberately import-light: importing ``backend`` does not pull in
FastAPI or start anything.  See ``backend.__main__`` for the command line
interface and ``backend.server`` for the HTTP/WebSocket API.
"""

__version__ = "0.2.0"

__all__ = ["__version__"]