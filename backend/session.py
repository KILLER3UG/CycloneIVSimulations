"""Server-side playback sessions for streamed GHDL simulations.

A :class:`SimSession` wraps one :meth:`Simulator.simulate` run for a single
WebSocket connection and turns the resulting cycle waveform into a paced,
controllable stream:

* the GHDL run itself happens unchanged in a worker thread;
* the result crosses into the event loop through a thread-safe queue;
* an async stream task emits ``cycle_batch`` messages with pacing derived
  from the board clock, so ``await websocket.send_json`` provides natural
  backpressure when the client is slow;
* ``pause`` / ``resume`` / ``step`` / ``stop`` / ``reset`` mutate a small
  thread-safe state machine that the stream task re-checks on every batch.

State machine::

    idle -> compiling -> running -> paused
                     |            \\-> done
                     \\-> error     \\-> stopped
    any active state (compiling | running | paused) -> stopped

Only one session per connection is meaningful; the server creates a fresh
:class:`SimSession` per ``sim_start`` and stops the previous one first.
"""

from __future__ import annotations

import asyncio
import logging
import math
import threading
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from .device import BOARD
from .simulator import SimulationRequest, Simulator

logger = logging.getLogger("cyclone.session")

#: An async callable that pushes one JSON-serialisable message to the client.
Emit = Callable[[Dict[str, Any]], Awaitable[None]]

#: Maximum number of cycles carried by one ``cycle_batch`` message.
BATCH_SIZE = 32
#: Wall-clock window (seconds) covered by one paced batch.  A batch is sent
#: every ``BATCH_SIZE`` cycles or every ``BATCH_INTERVAL`` seconds, whichever
#: comes first.
BATCH_INTERVAL = 0.05
#: How long ``stop()`` waits for the GHDL worker thread to exit.
JOIN_TIMEOUT = 10.0

#: States in which a session owns a live or replaying simulation.
ACTIVE_STATES = frozenset({"compiling", "running", "paused"})


def parse_speed(value: Any) -> Tuple[Optional[float], Optional[str]]:
    """Validate the optional ``speed`` playback multiplier.

    ``speed`` is a multiple of board real time: the stream targets
    ``clockHz * speed`` cycles per second.  ``None`` (the default) means max
    speed.  Returns ``(speed, error_message)``; ``speed is None`` with no
    error means "run at max speed".
    """
    if value is None:
        return None, None
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("", "max", "fastest"):
            return None, None
        if lowered == "real":
            value = 1.0
        else:
            try:
                value = float(lowered)
            except ValueError:
                return None, "speed must be a positive number, 'real' or 'max'"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, "speed must be a positive number, 'real' or 'max'"
    speed = float(value)
    if not math.isfinite(speed) or speed <= 0:
        return None, "speed must be a positive finite number"
    return speed, None


class SimSession:
    """Replays one GHDL simulation over a WebSocket with playback control.

    The heavy GHDL work runs in a daemon worker thread (``Simulator.simulate``
    is called untouched); everything the client observes — ``sim_ready``,
    paced ``cycle_batch`` messages, ``sim_done`` / ``sim_error`` — is emitted
    through the ``emit`` callback given to :meth:`start`.
    """

    def __init__(
        self,
        simulator: Simulator,
        *,
        clock_hz: Optional[float] = None,
        batch_size: int = BATCH_SIZE,
        batch_interval: float = BATCH_INTERVAL,
        join_timeout: float = JOIN_TIMEOUT,
    ) -> None:
        self._simulator = simulator
        self._batch_size = max(1, int(batch_size))
        self._batch_interval = max(0.001, float(batch_interval))
        self._join_timeout = float(join_timeout)
        self._clock_hz = float(clock_hz) if clock_hz else float(BOARD.get("clockHz") or 50_000_000)

        self._lock = threading.RLock()
        self._state = "idle"
        self._speed: Optional[float] = None
        # Audit N1: per-run invalidation.  ``_run_seq`` is bumped by every
        # ``start()`` and every ``stop()``; a worker thread or pump task whose
        # captured run id no longer matches is stale (its run was replaced or
        # stopped) and must never apply a state change or stream a message.
        # ``_stop_event`` is the stop flag of the *current* run only — a fresh
        # Event is created per ``start()``, so a replaced run's late results
        # cannot be "un-stopped" by the next start clearing a shared flag.
        self._run_seq = 0
        self._stop_event = threading.Event()
        self._cancel_token: dict = {"cancelled": False, "proc": None}
        # Bumped whenever the stream is (re)started; a stream task exits as
        # soon as its generation no longer matches the session's.
        self._generation = 0

        self._cycles: List[dict] = []
        self._final: Dict[str, Any] = {}
        self._board_image: Optional[Dict[str, Any]] = None
        self._signals: List[dict] = []
        self._board: Dict[str, Any] = {}
        self._entity: Dict[str, Any] = {}
        self._clock_ns = 10.0
        self._cursor = 0

        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._emit: Optional[Emit] = None
        self._pump_task: Optional[asyncio.Task] = None

        # Stats window (reset on every stream (re)start).
        self._run_started: Optional[float] = None
        self._run_emitted = 0

    # -- introspection -----------------------------------------------------

    @property
    def state(self) -> str:
        """Current state (cheap read; string assignment is atomic)."""
        return self._state

    @property
    def active(self) -> bool:
        return self._state in ACTIVE_STATES

    @property
    def cursor(self) -> int:
        with self._lock:
            return self._cursor

    @property
    def total_cycles(self) -> int:
        with self._lock:
            return len(self._cycles)

    # -- lifecycle ---------------------------------------------------------

    async def start(self, request: Dict[str, Any], emit: Emit) -> bool:
        """Start a new simulation, replacing any active session on this
        connection (only one session per connection is kept alive).

        A replaced run is invalidated by run generation: even when its worker
        thread outlives ``stop()``'s join timeout (GHDL runs take tens of
        seconds), it can no longer apply state or stream messages (audit N1).

        Returns ``True`` when a simulation was started; ``False`` when the
        request was rejected (a ``sim_error`` was emitted instead).
        """
        if self.active:
            await self.stop()

        speed, speed_error = parse_speed(request.get("speed"))
        if speed_error:
            await emit({"type": "sim_error", "message": speed_error, "errors": []})
            return False

        self._loop = asyncio.get_running_loop()
        self._emit = emit
        queue: asyncio.Queue = asyncio.Queue()
        with self._lock:
            # Audit N1: invalidate any previous run of this same object.  A
            # replaced run's worker thread can outlive stop()'s join timeout
            # (GHDL runs take tens of seconds), so the replacement must carry
            # a fresh run id + stop event that the stale worker cannot inherit.
            self._run_seq += 1
            run_id = self._run_seq
            stop_event = threading.Event()
            self._stop_event = stop_event
            self._state = "compiling"
            self._speed = speed
            self._cycles = []
            self._final = {}
            self._signals = []
            self._board = {}
            self._entity = {}
            self._cursor = 0
            self._run_started = None
            self._run_emitted = 0
            self._generation += 1
            self._cancel_token = {"cancelled": False, "proc": None}
            self._pump_task = self._loop.create_task(self._pump(queue, run_id))
        self._thread = threading.Thread(
            target=self._worker,
            args=(dict(request), self._loop, queue, run_id, stop_event, self._cancel_token),
            name=f"sim-session-{id(self):x}",
            daemon=True,
        )
        self._thread.start()
        return True

    async def stop(self) -> None:
        """Stop playback and the worker thread.

        The worker thread is joined (up to ``JOIN_TIMEOUT`` seconds) and the
        in-flight GHDL subprocess is killed via ``Simulator.cancel()`` (ENG-03
        implemented): a stop no longer waits for the simulation's own wall
        clock.  Its results are discarded, never streamed: the run's
        generation is invalidated here.

        A ``sim_stopped`` acknowledgement is emitted when this transitions an
        active session (compiling/running/paused); stopping an already
        finished, failed or stopped session is silent.
        """
        with self._lock:
            was_active = self._state in ACTIVE_STATES
            self._run_seq += 1  # audit N1: any worker/pump of a prior run is stale
            self._stop_event.set()  # the current run's stop flag
            self._generation += 1  # any live stream task exits on next check
            self._state = "stopped"
            cursor = self._cursor
            total = len(self._cycles)
            thread = self._thread
            pump_task = self._pump_task
            self._pump_task = None
        # Emit sim_stopped BEFORE the cancel/pump teardown: any in-flight
        # cycle_batch (already pulled by the pump) may still land on the
        # wire afterwards, and the strict stop ordering the UI and the QA
        # tests rely on must hold (sim_stopped last).
        if was_active:
            await self._safe_emit(
                {"type": "sim_stopped", "cursor": cursor, "totalCycles": total}
            )
        # ENG-03: kill the in-flight GHDL child via THIS session's per-run
        # cancel token — a stopped session no longer simulates in the
        # background for up to its own 900 s budget, and no other session's
        # run can be hit by the kill (tokens are per-run).
        try:
            self._simulator.cancel(self._cancel_token)
        except Exception:  # defensive: never block the stop path
            pass
        # Audit N1: cancel the pump task so a replaced/stopped run can never
        # deliver its late results to the client.
        if pump_task is not None and not pump_task.done():
            pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            # GHDL cannot be interrupted mid-run; wait for it to finish so the
            # thread is never orphaned (daemon => worst case the interpreter
            # never blocks on exit).
            try:
                await asyncio.to_thread(thread.join, self._join_timeout)
            except RuntimeError:  # no running loop (defensive)
                thread.join(self._join_timeout)
            if thread.is_alive():
                logger.warning("simulation worker thread did not exit within %ss", self._join_timeout)

    # -- playback control --------------------------------------------------

    async def pause(self) -> None:
        with self._lock:
            state = self._state
            if state == "running":
                self._state = "paused"
            ok = state in ("running", "paused")
            cursor = self._cursor
        if not ok:
            await self._emit_error(f"sim_pause requires a running session (state: {state})")
            return
        await self._safe_emit({"type": "sim_paused", "cursor": cursor, "playing": False})

    async def resume(self) -> None:
        with self._lock:
            state = self._state
            if state == "paused":
                self._state = "running"
                generation = self._spawn_stream_locked()
            else:
                generation = None
            ok = state in ("running", "paused")
            cursor = self._cursor
        if not ok:
            await self._emit_error(f"sim_resume requires a paused session (state: {state})")
            return
        if generation is not None:
            self._loop.create_task(self._stream(generation))
        await self._safe_emit({"type": "sim_resumed", "cursor": cursor, "playing": True})

    async def step(self, cycles: Any = 1) -> None:
        try:
            count = int(cycles)
        except (TypeError, ValueError):
            await self._emit_error("sim_step 'cycles' must be an integer")
            return
        if count < 1:
            await self._emit_error("sim_step 'cycles' must be >= 1")
            return

        with self._lock:
            state = self._state
            if state != "paused":
                batch: List[dict] = []
                finished = False
                ok = False
            else:
                batch = self._cycles[self._cursor : self._cursor + count]
                self._cursor += len(batch)
                finished = bool(self._cycles) and self._cursor >= len(self._cycles)
                if finished:
                    self._state = "done"
                ok = True
                cursor = self._cursor
                stats = self._stats_locked()
        if not ok:
            await self._emit_error(f"sim_step requires a paused session (state: {state})")
            return
        await self._safe_emit(
            {
                "type": "cycle_batch",
                "cycles": batch,
                "cursor": cursor,
                "playing": False,
                "stats": stats,
            }
        )
        if finished:
            await self._safe_emit(
                {"type": "sim_done", "final": self._final, "totalCycles": len(self._cycles)}
            )

    async def reset(self) -> None:
        """Return the cursor to cycle 0, keeping the previous play mode."""
        with self._lock:
            state = self._state
            if state == "running":
                self._cursor = 0
                generation = self._spawn_stream_locked()
            elif state == "paused":
                self._cursor = 0
                self._run_started = None
                self._run_emitted = 0
                generation = None
            else:
                generation = None
                state = None  # sentinel: invalid
        if state is None:
            await self._emit_error("sim_reset requires an active (running or paused) session")
            return
        if generation is not None:
            self._loop.create_task(self._stream(generation))
        await self._safe_emit({"type": "sim_reset", "cursor": 0, "playing": state == "running"})

    # -- worker thread -----------------------------------------------------

    def _worker(
        self,
        request: Dict[str, Any],
        loop: asyncio.AbstractEventLoop,
        queue: asyncio.Queue,
        run_id: int,
        stop_event: threading.Event,
        cancel_token: dict,
    ) -> None:
        """Run Simulator.simulate unchanged and post one result event."""

        def post(kind: str, payload: Any = None) -> None:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, (kind, payload))
            except RuntimeError:
                # Event loop closed (client gone): nothing to report to.
                pass

        try:
            sim_request = SimulationRequest.from_dict(request)
            result = self._simulator.simulate(sim_request, cancel_token)
        except Exception as exc:  # defensive: simulate() usually returns errors
            post("error", {"message": f"Simulation failed: {exc}", "errors": []})
            return

        # Audit N1: a run that was stopped or replaced while GHDL was still
        # working must never deliver results.  The per-run stop event catches
        # the stop of *this* run even after a replacement created a new event,
        # and the run-id check catches any replacement or later stop.
        if stop_event.is_set() or self._run_id_stale(run_id):
            return

        if not result.get("ok"):
            errors = [item for item in (result.get("errors") or []) if isinstance(item, dict)]
            message = errors[0].get("message") if errors else None
            post(
                "error",
                {
                    "message": message or "Simulation failed",
                    "errors": errors,
                    "logs": (result.get("logs") or "")[-4000:],
                },
            )
            return

        waveforms = result.get("waveforms") or {}
        post(
            "ready",
            {
                "cycles": waveforms.get("cycles") or [],
                "signals": [
                    {
                        "name": signal.get("name"),
                        "width": signal.get("width"),
                        "direction": signal.get("direction"),
                    }
                    for signal in waveforms.get("signals") or []
                ],
                "board": result.get("board") or {},
                "entity": result.get("entity") or {},
                "final": waveforms.get("final") or {},
                # Compact refresh (no cycles): the persistence-of-vision board
                # image the client paints directly, so an input change does not
                # ship ~20 MB of per-cycle samples.
                "boardImage": waveforms.get("boardImage") or None,
                "clockNs": float(sim_request.clock_period),
                # Peripheral decode of THIS run (UART/buzzer/VGA/model dumps):
                # the client must not re-simulate to fetch them — a second
                # GHDL run per Run click burned a core for nothing.
                "peripherals": result.get("peripherals") or {},
                "stimulusMap": result.get("stimulusMap"),
            },
        )

    # -- event-loop side ---------------------------------------------------

    def _run_id_stale(self, run_id: int) -> bool:
        """True when run ``run_id`` was stopped or replaced (audit N1)."""
        with self._lock:
            return run_id != self._run_seq

    async def _pump(self, queue: asyncio.Queue, run_id: int) -> None:
        """Deliver the worker's single result event to the client.

        The pump task is bound to one run: on stop/replace it is cancelled,
        and it re-checks its run generation before applying anything.
        """
        try:
            kind, payload = await queue.get()
            if kind == "ready":
                await self._begin_stream(payload, run_id)
            elif kind == "error":
                with self._lock:
                    if self._run_id_stale(run_id) or self._state == "stopped":
                        return
                    self._state = "error"
                await self._safe_emit({"type": "sim_error", **payload})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("simulation session pump failed")
            with self._lock:
                if self._state not in ("stopped", "error"):
                    self._state = "error"

    async def _begin_stream(self, payload: Dict[str, Any], run_id: int) -> None:
        with self._lock:
            # Audit N1: drop results from a run that was stopped or replaced
            # while its worker was still running (the stale-run hijack).
            if run_id != self._run_seq or self._state == "stopped":
                return
            self._cycles = payload["cycles"]
            self._signals = payload["signals"]
            self._board = payload["board"]
            self._entity = payload["entity"]
            self._final = payload["final"]
            self._board_image = payload.get("boardImage")
            self._clock_ns = payload["clockNs"]
            self._cursor = 0
            self._state = "running"
            generation = self._spawn_stream_locked()
        await self._safe_emit(
            {
                "type": "sim_ready",
                "totalCycles": len(self._cycles),
                "clockNs": self._clock_ns,
                "signals": self._signals,
                "board": self._board,
                "entity": self._entity,
                "peripherals": payload.get("peripherals") or {},
                "stimulusMap": payload.get("stimulusMap"),
                # Compact refresh (board-only result): no per-cycle replay, the
                # client paints the board image in sim_done. True only when
                # there are no cycles to stream (a full run still streams, even
                # though it also carries the board image for the settled view).
                "compactBoard": len(self._cycles) == 0,
            }
        )
        await self._stream(generation)

    def _spawn_stream_locked(self) -> int:
        """Register a fresh stream generation (call with the lock held)."""
        self._generation += 1
        self._run_started = time.perf_counter()
        self._run_emitted = 0
        return self._generation

    async def _stream(self, generation: int) -> None:
        """Emit paced ``cycle_batch`` messages until paused/stopped/done."""
        try:
            while True:
                with self._lock:
                    if self._state != "running" or generation != self._generation:
                        return
                    if self._cursor >= len(self._cycles):
                        self._state = "done"
                        done_message = {
                            "type": "sim_done",
                            "final": self._final,
                            "totalCycles": len(self._cycles),
                        }
                        if self._board_image is not None:
                            done_message["boardImage"] = self._board_image
                        emit_done = True
                    else:
                        count, delay = self._pacing_locked()
                        batch = self._cycles[self._cursor : self._cursor + count]
                        self._cursor += len(batch)
                        self._run_emitted += len(batch)
                        cursor = self._cursor
                        stats = self._stats_locked()
                        emit_done = False

                if emit_done:
                    await self._safe_emit(done_message)
                    return

                await self._safe_emit(
                    {
                        "type": "cycle_batch",
                        "cycles": batch,
                        "cursor": cursor,
                        "playing": True,
                        "stats": stats,
                    }
                )
                # Yield to the event loop even at max speed so control
                # messages are processed between batches.
                await asyncio.sleep(delay)

        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("cycle stream failed")
            with self._lock:
                if self._state == "running":
                    self._state = "error"

    # -- pacing / stats ----------------------------------------------------

    def _pacing_locked(self) -> Tuple[int, float]:
        """Cycles per batch and the delay after it (call with lock held)."""
        if self._speed is None:
            return self._batch_size, 0.0
        target = self._clock_hz * self._speed  # cycles per second
        if target <= 0:
            return self._batch_size, 0.0
        per_window = int(target * self._batch_interval)
        count = max(1, min(self._batch_size, per_window))
        return count, count / target

    def _stats_locked(self) -> Dict[str, Any]:
        elapsed = time.perf_counter() - self._run_started if self._run_started else 0.0
        cycles_per_second = (self._run_emitted / elapsed) if elapsed > 0 else 0.0
        real_speed = (cycles_per_second / self._clock_hz * 100.0) if self._clock_hz > 0 else 0.0
        return {
            "cyclesPerSecond": round(cycles_per_second, 1),
            "targetSpeed": self._clock_hz,
            "realSpeed": round(real_speed, 2),
            "engineLoad": None,  # replay of a finished GHDL run: no live engine
        }

    # -- helpers -----------------------------------------------------------

    async def _safe_emit(self, message: Dict[str, Any]) -> None:
        emit = self._emit
        if emit is None:
            return
        await emit(message)

    async def _emit_error(self, message: str) -> None:
        await self._safe_emit({"type": "sim_error", "message": message, "errors": []})


__all__ = [
    "ACTIVE_STATES",
    "BATCH_INTERVAL",
    "BATCH_SIZE",
    "JOIN_TIMEOUT",
    "SimSession",
    "parse_speed",
]
