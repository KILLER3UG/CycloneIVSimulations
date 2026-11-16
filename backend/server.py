"""FastAPI server for the Cyclone IV VHDL simulator.

Two interfaces are exposed:

* ``/api/*`` - request/response JSON, used by the UI for compile and run.
* ``/ws``    - a small WebSocket protocol that mirrors the REST endpoints,
  emits stage/progress messages while GHDL works, and additionally streams a
  finished simulation cycle-by-cycle with real pause / step / stop / reset
  playback control (see ``backend/session.py``).

The frontend in ``../frontend`` is served as static files, so the whole app is
a single ``python -m backend serve`` process.  The frontend may live in its
original layout (``frontend/index.html``), as a built Vite app
(``frontend/dist/``) or with the legacy files moved aside
(``frontend/legacy/``); ``GET /`` and the static routes resolve whichever
layout is present.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .device import DEVICE, DEVICES, get_device, set_device
from .ghdl_tool import GhdlNotFoundError
from .session import SimSession
from .simulator import SimulationRequest, Simulator
from .vhdl_parser import VHDLParser

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
EXAMPLES_DIR = Path(__file__).resolve().parent.parent / "examples"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cyclone.server")

app = FastAPI(title="Cyclone IV VHDL Simulator", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def no_cache_static(request, call_next):
    """Never cache the frontend: it makes frontend edits invisible on reload."""
    response = await call_next(request)
    path = request.url.path
    if not path.startswith(("/api", "/docs", "/openapi.json")):
        response.headers["Cache-Control"] = "no-cache"
    return response

_simulator: Optional[Simulator] = None
_simulator_error: Optional[str] = None


def get_simulator() -> Simulator:
    global _simulator, _simulator_error
    if _simulator is not None:
        return _simulator
    try:
        _simulator = Simulator()
        _simulator_error = None
    except GhdlNotFoundError as exc:
        _simulator_error = str(exc)
        raise
    return _simulator


def _error_response(message: str, status_code: int = 400, errors=None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "message": message, "errors": errors or []},
    )


# ---------------------------------------------------------------------------
# Examples
# ---------------------------------------------------------------------------


def _list_examples() -> list:
    if not EXAMPLES_DIR.is_dir():
        return []
    examples = []
    for path in sorted(EXAMPLES_DIR.glob("*.vhd")):
        source = path.read_text(encoding="utf-8", errors="replace")
        design = VHDLParser().parse(source)
        entity = design.primary
        examples.append(
            {
                "id": path.stem,
                "name": path.stem,
                "file": path.name,
                "entity": entity.name if entity else None,
                "description": _example_description(path.stem),
                "source": source,
            }
        )
    return examples


_DESCRIPTIONS = {
    "counter": "8-bit free-running counter with synchronous reset, wired to the LEDs.",
    "gated_counter": "Counter that only runs while `enable` is high; try a toggle stimulus.",
    "seven_segment": "Hex input decoded onto a 7-segment display.",
    "traffic_light": "Moore finite state machine driving red / yellow / green LEDs.",
    "uart_tx": "Continuous 8N1 UART transmitter with a simulation-friendly TX_DIV.",
    "debounce": "Synchroniser and edge detector for a mechanical push button.",
    "sevseg_keys": "4-digit display driven by the DIP/keys (s1..s4); close S1 + any of S2..S4 and the lit glyph rotates across the tubes.",
}


def _example_description(name: str) -> str:
    return _DESCRIPTIONS.get(name, "Example design.")


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------


@app.get("/api/health")
def health() -> dict:
    try:
        simulator = get_simulator()
        result = simulator.health()
        result["frontend"] = str(FRONTEND_DIR)
        result["device"] = DEVICE()
        return result
    except GhdlNotFoundError as exc:
        return {
            "ok": False,
            "ghdl": None,
            "version": None,
            "error": str(exc),
            "device": DEVICE(),
        }


@app.post("/api/device/select")
def device_select(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    key = str(payload.get("device", ""))
    try:
        device = set_device(key)
    except ValueError as exc:
        return _error_response(str(exc), 400)
    return {"ok": True, "device": DEVICE(), "selected": device["key"]}


@app.get("/api/device")
def device() -> dict:
    return {"ok": True, "device": DEVICE(), "devices": DEVICES}


@app.get("/api/board")
def board() -> dict:
    """The canonical board profile (pins, polarities, parts, tags).

    The frontend and backend both load their board parameters from
    board/board.json; this endpoint exposes it to the UI.  The shape is
    ``{"ok": true, "board": {...}, "device": {...}}`` so the UI can use
    ``data.board`` directly as its profile.
    """
    from .device import load_board_json
    raw = load_board_json()
    profile = dict(raw["board"])
    profile["pinMap"] = raw["pinMap"]
    profile["facts"] = raw["facts"]
    return {"ok": True, "board": profile, "device": DEVICE()}


@app.get("/api/examples")
def examples() -> dict:
    return {"ok": True, "examples": _list_examples()}


@app.get("/api/examples/{example_id}")
def example(example_id: str):
    for item in _list_examples():
        if item["id"].lower() == example_id.lower():
            return {"ok": True, "example": item}
    return _error_response(f"Unknown example '{example_id}'", 404)


def _extract_vhdl(payload: Dict[str, Any]) -> str:
    """Return primary HDL source from ``vhdl`` or fall back to non-empty ``files``."""
    vhdl = payload.get("vhdl") or ""
    if isinstance(vhdl, str) and vhdl.strip():
        return vhdl
    for item in payload.get("files") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").lower()
        content = item.get("content")
        if content is None:
            content = item.get("vhdl")
        if isinstance(content, str) and content.strip() and (
            not name or name.endswith((".vhd", ".vhdl", ".v", ".sv"))
        ):
            return content
    return vhdl if isinstance(vhdl, str) else ""


@app.post("/api/compile")
def compile_endpoint(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    vhdl = _extract_vhdl(payload)
    if not vhdl.strip():
        return _error_response("No VHDL source provided")
    top = payload.get("top") or None
    try:
        simulator = get_simulator()
    except GhdlNotFoundError as exc:
        return _error_response(str(exc), 503)
    strict_pins = bool(payload.get("strictPins", payload.get("strict_pins", False)))
    result = simulator.compile_source(
        vhdl,
        top,
        payload.get("files"),
        payload.get("qsf"),
        strict_pins=strict_pins,
    )
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@app.post("/api/simulate")
def simulate_endpoint(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    vhdl = _extract_vhdl(payload)
    if not vhdl.strip():
        return _error_response("No VHDL source provided")
    try:
        simulator = get_simulator()
    except GhdlNotFoundError as exc:
        return _error_response(str(exc), 503)
    request = SimulationRequest.from_dict(payload)
    result = simulator.simulate(request)
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@app.get("/api/simulate")
def simulate_options() -> dict:
    return {
        "ok": True,
        "options": {
            "duration": {"min": 10, "max": 1000000, "default": 1000},
            "clockPeriod": {"min": 1, "max": 1000, "default": 10},
            "resetCycles": {"min": 0, "max": 1000, "default": 2},
            "stimulusKinds": ["constant", "toggle", "pulse", "sequence"],
        },
    }


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        simulator = get_simulator()
        health_info = simulator.health()
    except GhdlNotFoundError as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close()
        return

    await websocket.send_json(
        {
            "type": "hello",
            "ghdl": health_info.get("ghdl"),
            "version": health_info.get("version"),
        }
    )

    # At most one playback session per connection; sim_start replaces it.
    session: Optional[SimSession] = None

    async def handle_sim(kind: str, message: dict) -> None:
        nonlocal session
        if kind == "sim_start":
            # Only one active session per connection: stop (and join) the
            # previous one before the replacement takes over.
            if session is not None:
                await session.stop()
            replacement = SimSession(simulator)
            if await replacement.start(message, websocket.send_json):
                session = replacement
            return
        if session is None:
            await websocket.send_json(
                {"type": "sim_error", "message": f"{kind} requires sim_start first", "errors": []}
            )
            return
        if kind == "sim_pause":
            await session.pause()
        elif kind == "sim_resume":
            await session.resume()
        elif kind == "sim_step":
            await session.step(message.get("cycles", 1))
        elif kind == "sim_stop":
            await session.stop()
        elif kind == "sim_reset":
            await session.reset()

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON"})
                continue
            if not isinstance(message, dict):
                await websocket.send_json(
                    {"type": "error", "message": "Invalid message: expected a JSON object"}
                )
                continue

            kind = message.get("type", "")
            try:
                if kind == "compile":
                    await _ws_compile(websocket, simulator, message)
                elif kind == "simulate":
                    await _ws_simulate(websocket, simulator, message)
                elif kind == "ping":
                    await websocket.send_json({"type": "pong"})
                elif kind in ("sim_start", "sim_pause", "sim_resume", "sim_step", "sim_stop", "sim_reset"):
                    await handle_sim(kind, message)
                else:
                    await websocket.send_json(
                        {"type": "error", "message": f"Unknown message type '{kind}'"}
                    )
            except WebSocketDisconnect:
                raise
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception("WebSocket handler failed")
                try:
                    await websocket.send_json({"type": "error", "message": str(exc)})
                except Exception:
                    break
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    finally:
        if session is not None:
            try:
                await session.stop()
            except Exception:  # pragma: no cover - socket already dying
                pass


async def _ws_compile(websocket: WebSocket, simulator: Simulator, message: dict) -> None:
    vhdl = _extract_vhdl(message)
    if not vhdl.strip():
        await websocket.send_json({"type": "error", "message": "No VHDL source provided"})
        return
    request_id = message.get("requestId")
    await websocket.send_json({"type": "progress", "stage": "analyze", "requestId": request_id})
    result = await asyncio.to_thread(
        simulator.compile_source,
        vhdl,
        message.get("top"),
        message.get("files"),
        message.get("qsf"),
    )
    await websocket.send_json({"type": "compiled", "requestId": request_id, **result})


async def _ws_simulate(websocket: WebSocket, simulator: Simulator, message: dict) -> None:
    vhdl = _extract_vhdl(message)
    if not vhdl.strip():
        await websocket.send_json({"type": "error", "message": "No VHDL source provided"})
        return

    request_id = message.get("requestId")
    request = SimulationRequest.from_dict(message)
    await websocket.send_json({"type": "simulation_started", "requestId": request_id})
    for stage in ("analyze", "elaborate", "run"):
        await websocket.send_json({"type": "progress", "stage": stage, "requestId": request_id})

    result = await asyncio.to_thread(simulator.simulate, request)
    await websocket.send_json({"type": "simulation_complete", "requestId": request_id, **result})


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
#
# The frontend is being restructured into a Vite app, so any of three layouts
# may be present at a given time:
#
#   1. frontend/dist/index.html    (built Vite app)
#   2. frontend/legacy/index.html  (previous files moved aside)
#   3. frontend/index.html         (original flat layout)
#
# ``GET /`` and the static routes below resolve these in priority order so
# the server keeps working in every state.

_INDEX_CANDIDATES = ("dist/index.html", "legacy/index.html", "index.html")
_STATIC_ROOTS = ("dist", "legacy", ".")


def _resolve_frontend(relative: str) -> Optional[Path]:
    """Find ``relative`` under the frontend roots (traversal-safe)."""
    if not relative:
        return None
    for root in _STATIC_ROOTS:
        base = (FRONTEND_DIR / root).resolve()
        candidate = (base / relative).resolve()
        try:
            candidate.relative_to(base)
        except ValueError:
            continue  # path escape attempt; try the next root
        if candidate.is_file():
            return candidate
    return None


@app.get("/")
def index() -> FileResponse:
    for relative in _INDEX_CANDIDATES:
        candidate = FRONTEND_DIR / relative
        if candidate.is_file():
            return FileResponse(candidate)
    return JSONResponse(status_code=404, content={"message": "frontend/index.html not found"})


def _serve_static(static_path: str):
    found = _resolve_frontend(static_path)
    if found is None:
        return JSONResponse(
            status_code=404,
            content={"message": f"frontend file '{static_path}' not found"},
        )
    return FileResponse(found)


@app.get("/static/{static_path:path}")
def static_under_prefix(static_path: str):
    """Legacy ``/static/...`` asset URLs, resolved against all layouts."""
    return _serve_static(static_path)


@app.get("/{static_path:path}")
def static_file(static_path: str):
    """Root-relative asset URLs (e.g. Vite's ``/assets/...``)."""
    return _serve_static(static_path)


__all__ = ["app", "get_simulator"]