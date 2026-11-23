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
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import __version__
from .device import (
    DEVICE,
    DEVICES,
    get_active_board_id,
    get_active_board_raw,
    get_device,
    import_board_manifest,
    list_available_boards,
    select_board,
    set_device,
)
from .terminal import TerminalSession, cleanup_all_terminals, exec_terminal_command
from .paths import bundle_root, projects_dir, user_data_dir
from .device import BOARD
from .ghdl_tool import GhdlNotFoundError
from .live_session import LiveController, build_live_controller
from .session import SimSession
from .simulator import SimulationRequest, Simulator
from .testbench_gen import detect_clock, detect_reset
from .vhdl_parser import VHDLParser
from .waveform import map_board

FRONTEND_DIR = bundle_root() / "frontend"
EXAMPLES_DIR = bundle_root() / "examples"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cyclone.server")

app = FastAPI(title="Cyclone IV VHDL Simulator", version=__version__)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$|^tauri://localhost$|^https?://tauri\.localhost$",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
def _on_shutdown() -> None:
    """Never leave terminal child processes behind on server shutdown."""
    cleanup_all_terminals()


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
        # Shared GHDL analysis cache: re-running an interactive stimulus walk
        # (KEY/SW toggle) skips re-analysis entirely, so toggles feel immediate.
        lib_cache = Path(tempfile.gettempdir()) / "cyclone_iv_studio_ghdl_libcache"
        _simulator = Simulator(library_cache=lib_cache)
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
    "buzzb": "Real 4-tone latched buzzer (btn1..btn4 -> 500/800/1000/1600 Hz) with a 5 s release-hold timer on the passive speaker.",
}


def _example_description(name: str) -> str:
    return _DESCRIPTIONS.get(name, "Example design.")


# ---------------------------------------------------------------------------
# REST API
# ---------------------------------------------------------------------------


@app.get("/api/version")
def app_version() -> dict:
    return {"ok": True, "version": __version__}


@app.get("/api/health")
def health() -> dict:
    data_dir = str(user_data_dir())
    projects_dir()
    try:
        simulator = get_simulator()
        result = simulator.health()
        result["appVersion"] = __version__
        result["frontend"] = str(FRONTEND_DIR)
        result["userDataDir"] = data_dir
        result["device"] = DEVICE()
        return result
    except GhdlNotFoundError as exc:
        return {
            "ok": False,
            "appVersion": __version__,
            "ghdl": None,
            "version": None,
            "error": str(exc),
            "userDataDir": data_dir,
            "device": DEVICE(),
        }


@app.post("/api/device/select")
def device_select(payload: Dict[str, Any] = Body(...)) -> JSONResponse:
    key = str(payload.get("device", ""))
    try:
        device = set_device(key)
    except ValueError as exc:
        return _error_response(str(exc), 400)
    # The selected chip changes the I/O / resource warnings, so cached
    # compact results must not survive a device switch (same as board select).
    _clear_simulator_request_cache()
    return {"ok": True, "device": DEVICE(), "selected": device["key"]}


@app.get("/api/device")
def device() -> dict:
    return {"ok": True, "device": DEVICE(), "devices": DEVICES}


def _active_profile() -> dict:
    """Full active board profile: board fields + pin map + facts + layout."""
    raw = get_active_board_raw()
    profile = dict(raw["board"])
    profile["pinMap"] = raw.get("pinMap", {})
    profile["facts"] = raw.get("facts", [])
    profile.setdefault("id", raw.get("id"))
    profile.setdefault("layout3d", raw.get("layout3d", {}))
    return profile


def _clear_simulator_request_cache() -> None:
    """Drop interactive result caches so a board change cannot be served stale."""
    if _simulator is not None:
        try:
            _simulator.clear_request_cache()
        except Exception:  # pragma: no cover - cache is best-effort
            pass


@app.get("/api/boards")
def boards_list() -> dict:
    return {
        "ok": True,
        "activeBoard": get_active_board_id(),
        "boards": list_available_boards(),
    }


@app.post("/api/boards/select")
def boards_select(payload: Dict[str, Any] = Body(...)) -> Any:
    board_id = payload.get("board") or payload.get("id")
    try:
        select_board(str(board_id or ""))
    except ValueError as exc:
        return _error_response(str(exc), 400)
    _clear_simulator_request_cache()
    return {
        "ok": True,
        "activeBoard": get_active_board_id(),
        "board": _active_profile(),
        "device": DEVICE(),
    }


@app.post("/api/boards/import")
def boards_import(payload: Dict[str, Any] = Body(...)) -> Any:
    if not isinstance(payload, dict):
        return _error_response("Expected a board manifest object", 400)
    manifest = payload.get("manifest")
    raw = manifest if isinstance(manifest, dict) else payload
    select = True
    if isinstance(manifest, dict) and "select" in payload:
        flag = payload.get("select")
        select = flag if isinstance(flag, bool) else str(flag).lower() in ("1", "true", "yes", "on")
    try:
        import_board_manifest(raw, select=select)
    except (ValueError, TypeError, KeyError) as exc:
        return _error_response(str(exc), 400)
    _clear_simulator_request_cache()
    return {
        "ok": True,
        "activeBoard": get_active_board_id(),
        "board": _active_profile(),
        "device": DEVICE(),
        "boards": list_available_boards(),
    }


@app.get("/api/board")
def board() -> dict:
    """The *active* board profile plus its device (default: board/board.json)."""
    return {"ok": True, "board": _active_profile(), "device": DEVICE()}


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

    # Live interactive co-simulation (persistent GHDL stepping).
    live: Optional[LiveController] = None
    live_session: Optional[Any] = None  # backend.live_session.LiveSession
    live_queue: asyncio.Queue = asyncio.Queue()
    live_tasks: list = []
    live_stop_requested = False
    live_loop = asyncio.get_running_loop()

    def _on_live_frame(frame: dict) -> None:
        # reader thread → event loop
        live_loop.call_soon_threadsafe(live_queue.put_nowait, dict(frame))

    def _on_live_exit(reason: str) -> None:
        # The GHDL process ended on its own (crash or clean finish): the pace
        # loop stops silently, so tell the client explicitly.
        if live_stop_requested:
            return
        detail = ""
        if live_session is not None:
            detail = str(getattr(live_session, "reader_error", None) or "")
        live_loop.call_soon_threadsafe(
            live_queue.put_nowait,
            {"type": "live_stopped", "reason": str(reason or "ghdl-exited"),
             "detail": detail},
        )

    async def _live_frame_pump() -> None:
        sent = 0
        try:
            while True:
                frame = await live_queue.get()
                payload = dict(frame)
                # Telemetry frames carry the reader's internal "frame" marker;
                # the frontend dispatches on "live_frame".
                if payload.get("type") in (None, "frame"):
                    payload["type"] = "live_frame"
                await websocket.send_json(payload)
                sent += 1
                if os.environ.get("CYCLESIM_LIVE_DEBUG") and sent % 100 == 0:
                    logger.info("live pump sent=%d", sent)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("live frame pump ended")

    async def _live_pace_loop() -> None:
        interval = 1.0 / 30.0
        steps = 0
        try:
            while live is not None and live_session is not None and live_session.alive:
                if live.pace != "single":
                    cycles = live.cycles_for_tick(interval)
                    # Flow control: wait for the previous step's frame before
                    # queueing the next T command.  GHDL consumes steps slower
                    # than the pace ticks; without this the stdin pipe fills
                    # and the blocking write freezes the whole event loop.
                    if cycles > 0 and live.frame_seq >= steps:
                        live.session.step(cycles)
                        steps += 1
                        if os.environ.get("CYCLESIM_LIVE_DEBUG") and steps % 100 == 0:
                            logger.info("live pace steps=%d", steps)
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("live pace loop crashed")
            return
        logger.info("live pace loop ended (alive=%s)",
                    live_session.alive if live_session is not None else "no-session")

    async def _live_stop() -> None:
        nonlocal live, live_session, live_stop_requested
        live_stop_requested = True
        for task in live_tasks:
            task.cancel()
        live_tasks.clear()
        if live_session is not None:
            live_session.close()
        live = None
        live_session = None

    async def handle_live(kind: str, message: dict) -> None:
        nonlocal live, live_session, live_stop_requested
        if kind == "live_start":
            await _live_stop()
            live_stop_requested = False
            sources_in = []
            if message.get("files"):
                for item in message["files"]:
                    sources_in.append((str(item.get("name") or "design.vhd"),
                                       str(item.get("content") or "")))
            else:
                sources_in.append(("design.vhd", str(message.get("vhdl") or "")))
            design = VHDLParser().parse("\n".join(c for _n, c in sources_in))
            top = message.get("top")
            entity = None
            for ent in design.entities:
                if top and ent.name.lower() == str(top).lower():
                    entity = ent
                    break
            if entity is None:
                candidates = [e for e in design.entities if not e.name.lower().startswith("tb_")]
                entity = candidates[0] if candidates else (design.entities[0] if design.entities else None)
            if entity is None:
                await websocket.send_json({"type": "live_error", "message": "No entity found in source"})
                return
            try:
                nonlocal live_session
                live_session = None  # re-set below on success
                clock = detect_clock(entity)
                if message.get("clockPort"):
                    clock = next((p for p in entity.ports if p.name == message["clockPort"]), clock)
                if clock is None:
                    await websocket.send_json({"type": "live_error",
                                               "message": "no clock input detected — live mode needs a clock"})
                    return
                reset = detect_reset(entity)
                reset_port = message.get("resetPort") or (reset[0].name if reset else None)
                reset_active_high = bool(message.get("resetActiveHigh",
                                                     reset[1] if reset else True))
                controller, translated = build_live_controller(
                    simulator.ghdl.executable, entity, sources_in,
                    map_board(entity), BOARD, clock.name,
                    float(message.get("clockPeriod", 10.0) or 10.0),
                    reset_port, int(message.get("resetCycles", 2) or 0),
                    reset_active_high,
                    on_frame=_on_live_frame, on_exit=_on_live_exit,
                )
                live_session_local = controller.session
                if not live_session_local.start():
                    await websocket.send_json({"type": "live_error",
                                               "message": "GHDL live build failed",
                                               "detail": (live_session_local.start_error or "")[-2000:]})
                    return
                live = controller
                live_session = live_session_local
                controller.assert_reset()
                live_tasks.append(asyncio.create_task(_live_frame_pump()))
                live_tasks.append(asyncio.create_task(_live_pace_loop()))
                await websocket.send_json({
                    "type": "live_ready",
                    "entity": entity.name,
                    "clockPort": clock.name,
                    "clockPeriodNs": controller.clock_period_ns,
                    "inputs": controller.wrapper["inputs"],
                    "outputs": controller.wrapper["outputs"],
                    "pace": controller.pace,
                })
            except Exception as exc:
                logger.exception("live_start failed")
                await websocket.send_json({"type": "live_error", "message": str(exc)})
            return
        if kind == "live_input":
            if live is None:
                await websocket.send_json({"type": "live_error", "message": "live_start first"})
                return
            keys = message.get("keys") or []
            dip = message.get("dip") or []
            live.apply_channel_state([bool(k) for k in keys], [bool(d) for d in dip],
                                     bool(message.get("reset", False)),
                                     bounce=bool(message.get("bounce", False)))
            return
        if kind == "live_pace":
            if live is None:
                await websocket.send_json({"type": "live_error", "message": "live_start first"})
                return
            live.set_pace(str(message.get("pace", "max")))
            await websocket.send_json({"type": "live_pace", "pace": live.pace})
            return
        if kind == "live_step":
            if live is None or live_session is None:
                await websocket.send_json({"type": "live_error", "message": "live_start first"})
                return
            live.session.step(int(message.get("cycles", 1) or 1))
            return
        if kind == "live_uart_tx":
            if live is None:
                await websocket.send_json({"type": "live_error", "message": "live_start first"})
                return
            baud = int(message.get("baud", 115200) or 115200)
            live.uart_baud = baud
            sent = []
            for byte in message.get("bytes") or []:
                if live.session.uart_tx(int(byte), baud):
                    sent.append(int(byte) & 0xFF)
            await websocket.send_json({"type": "live_uart_tx", "bytes": sent, "baud": baud})
            return
        if kind == "live_ps2":
            if live is None:
                await websocket.send_json({"type": "live_error", "message": "live_start first"})
                return
            ok = live.session.ps2_inject(int(message.get("byte", 0) or 0))
            await websocket.send_json({"type": "live_ps2", "ok": bool(ok)})
            return
        if kind == "live_ir":
            if live is None:
                await websocket.send_json({"type": "live_error", "message": "live_start first"})
                return
            ok = live.session.ir_trigger(int(message.get("address", 0) or 0),
                                         int(message.get("command", 1) or 1))
            await websocket.send_json({"type": "live_ir", "ok": bool(ok)})
            return
        if kind == "live_temp":
            if live is None:
                await websocket.send_json({"type": "live_error", "message": "live_start first"})
                return
            ok = live.session.set_temp(int(message.get("celsius", 25) or 25))
            await websocket.send_json({"type": "live_temp", "celsius": int(message.get("celsius", 25) or 25),
                                       "ok": bool(ok)})
            return
        if kind == "live_stop":
            await _live_stop()
            await websocket.send_json({"type": "live_stopped"})
            return

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
                elif kind in ("live_start", "live_input", "live_pace", "live_step", "live_stop",
                              "live_uart_tx", "live_ps2", "live_ir", "live_temp"):
                    await handle_live(kind, message)
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
        for task in live_tasks:
            task.cancel()
        if live_session is not None:
            try:
                live_session.close()
            except Exception:  # pragma: no cover - defensive teardown
                pass
        if session is not None:
            try:
                await session.stop()
            except Exception:  # pragma: no cover - socket already dying
                pass


@app.websocket("/ws/terminal")
async def websocket_terminal(websocket: WebSocket) -> None:
    """Interactive OS shell with GHDL on PATH; killed on disconnect."""
    await websocket.accept()
    loop = asyncio.get_running_loop()
    outputs: asyncio.Queue[str] = asyncio.Queue()
    exits: asyncio.Queue[int] = asyncio.Queue()

    def on_output(text: str) -> None:
        loop.call_soon_threadsafe(outputs.put_nowait, text)

    def on_exit(code: int) -> None:
        loop.call_soon_threadsafe(exits.put_nowait, code)

    term = TerminalSession(on_output=on_output, on_exit=on_exit)
    try:
        # Off the event loop: a slow/stalled PTY spawn must not freeze every
        # other WebSocket and request served by this process.
        await asyncio.to_thread(term.start)
    except Exception as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close()
        return

    async def send_ready() -> None:
        await websocket.send_json({
            "type": "ready",
            "cwd": term.cwd,
            "ghdlOnPath": term.ghdl_on_path,
            "pid": getattr(term._proc, "pid", None),
        })

    await send_ready()

    async def receive_loop() -> None:
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
                if kind == "input":
                    term.write(str(message.get("data", "")))
                elif kind == "interrupt":
                    term.interrupt()
                elif kind == "resize":
                    term.resize(int(message.get("cols", 80)), int(message.get("rows", 24)))
                elif kind == "restart":
                    await asyncio.to_thread(term.close)
                    term.start()
                    await send_ready()
                else:
                    await websocket.send_json(
                        {"type": "error", "message": f"Unknown message type '{kind}'"}
                    )
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})

    async def pump() -> None:
        while True:
            data = await outputs.get()
            await websocket.send_json({"type": "output", "data": data})

    async def exit_watch() -> None:
        code = await exits.get()
        await websocket.send_json({"type": "exit", "code": code})

    # Drive the lifecycle from the receive task: it ends naturally on a
    # client disconnect.  Cancelling it mid-handshake is what makes Starlette's
    # TestClient raise CancelledError on websocket close, so only the helper
    # tasks are cancelled here.
    pump_task = asyncio.create_task(pump())
    exit_task = asyncio.create_task(exit_watch())
    try:
        await receive_loop()
    except WebSocketDisconnect:
        logger.info("terminal WebSocket client disconnected")
    except Exception:  # pragma: no cover - socket already failing
        pass
    finally:
        for task in (pump_task, exit_task):
            task.cancel()
        await asyncio.gather(pump_task, exit_task, return_exceptions=True)
        # taskkill/wait/join are blocking; keep the event loop responsive.
        await asyncio.to_thread(term.close)


@app.post("/api/terminal/exec")
def terminal_exec(payload: Dict[str, Any] = Body(...)) -> dict:
    command = str(payload.get("command") or "")
    if not command.strip():
        return {"ok": False, "error": "No command provided"}
    return exec_terminal_command(
        command,
        payload.get("cwd"),
        float(payload.get("timeout", 15.0)),
    )


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
        strict_pins=bool(message.get("strictPins", message.get("strict_pins", False))),
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