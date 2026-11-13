"""FastAPI server for the Cyclone IV VHDL simulator.

Two interfaces are exposed:

* ``/api/*`` - request/response JSON, used by the UI for compile and run.
* ``/ws``    - a small WebSocket protocol that mirrors the REST endpoints and
  emits stage/progress messages while GHDL works.

The frontend in ``../frontend`` is served as static files, so the whole app is
a single ``python -m backend serve`` process.
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
from fastapi.staticfiles import StaticFiles

from .device import DEVICE, DEVICES, get_device, set_device
from .ghdl_tool import GhdlNotFoundError
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
    if request.url.path.startswith("/static") or request.url.path == "/":
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


@app.get("/api/examples")
def examples() -> dict:
    return {"ok": True, "examples": _list_examples()}


@app.get("/api/examples/{example_id}")
def example(example_id: str):
    for item in _list_examples():
        if item["id"].lower() == example_id.lower():
            return {"ok": True, "example": item}
    return _error_response(f"Unknown example '{example_id}'", 404)


@app.post("/api/compile")
def compile_endpoint(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    vhdl = payload.get("vhdl", "")
    if not vhdl.strip():
        return _error_response("No VHDL source provided")
    top = payload.get("top") or None
    try:
        simulator = get_simulator()
    except GhdlNotFoundError as exc:
        return _error_response(str(exc), 503)
    result = simulator.compile_source(vhdl, top, payload.get("files"))
    status = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status, content=result)


@app.post("/api/simulate")
def simulate_endpoint(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    vhdl = payload.get("vhdl", "")
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

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON"})
                continue

            kind = message.get("type", "")
            try:
                if kind == "compile":
                    await _ws_compile(websocket, simulator, message)
                elif kind == "simulate":
                    await _ws_simulate(websocket, simulator, message)
                elif kind == "ping":
                    await websocket.send_json({"type": "pong"})
                else:
                    await websocket.send_json(
                        {"type": "error", "message": f"Unknown message type '{kind}'"}
                    )
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception("WebSocket handler failed")
                await websocket.send_json({"type": "error", "message": str(exc)})
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")


async def _ws_compile(websocket: WebSocket, simulator: Simulator, message: dict) -> None:
    vhdl = message.get("vhdl", "")
    if not vhdl.strip():
        await websocket.send_json({"type": "error", "message": "No VHDL source provided"})
        return
    await websocket.send_json({"type": "progress", "stage": "analyze"})
    result = await asyncio.to_thread(simulator.compile_source, vhdl, message.get("top"))
    await websocket.send_json({"type": "compiled", **result})


async def _ws_simulate(websocket: WebSocket, simulator: Simulator, message: dict) -> None:
    vhdl = message.get("vhdl", "")
    if not vhdl.strip():
        await websocket.send_json({"type": "error", "message": "No VHDL source provided"})
        return

    request = SimulationRequest.from_dict(message)
    await websocket.send_json({"type": "simulation_started"})
    for stage in ("analyze", "elaborate", "run"):
        await websocket.send_json({"type": "progress", "stage": stage})

    result = await asyncio.to_thread(simulator.simulate, request)
    await websocket.send_json({"type": "simulation_complete", **result})


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------


@app.get("/")
def index() -> FileResponse:
    index_file = FRONTEND_DIR / "index.html"
    if not index_file.exists():
        return JSONResponse(status_code=404, content={"message": "frontend/index.html not found"})
    return FileResponse(index_file)


if FRONTEND_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


__all__ = ["app", "get_simulator"]