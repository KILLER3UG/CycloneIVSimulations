"""Persistent live-stepping GHDL co-simulation session.

Owns one long-lived ``ghdl -r`` process running the generated textio wrapper
(see :mod:`backend.live_wrapper`), bridges semantic board input state
(keys / DIP / reset) to wrapper commands, parses telemetry frames, and
decodes mid-burst HD44780 LCD events and UART transitions.

Simulated time freezes while GHDL blocks on ``readline`` — the design only
advances inside ``step`` commands, so live interaction is exact and runaway
-free.  All subprocess cleanup is defensive: ``quit`` → stdin close → grace
wait → terminate → kill, plus an ``atexit`` sweep.
"""
from __future__ import annotations

import atexit
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .live_wrapper import build_live_wrapper
from .paths import bundle_root
from .peripherals import decode_uart

_STD_CHARS = set("UX01ZWLH-")


def _norm_meta(text: str) -> Any:
    """'0101' -> int; meta strings ('U','X','Z'...) -> uppercase string."""
    if text and all(ch in "01" for ch in text):
        return int(text, 2)
    return text.upper()


def _parse_time_ns(text: str) -> float:
    """Parse a wrapper timestamp into nanoseconds (float, exact to 2^53).

    The wrapper emits 'seconds ns_within_second' so the 32-bit VHDL integer
    can never overflow; a single legacy number is still accepted.
    """
    parts = text.split()
    try:
        if len(parts) >= 2:
            return float(int(parts[0])) * 1e9 + float(int(parts[1]))
        if parts:
            return float(parts[0])
    except (ValueError, IndexError):
        pass
    return 0.0


class LiveSession:
    """One persistent GHDL live-stepping run."""

    def __init__(
        self,
        ghdl_exe: str,
        entity_name: str,
        sources: List[tuple],
        wrapper: dict,
        clock_period_ns: float,
        workdir: Optional[Path] = None,
        on_frame: Optional[Callable[[dict], None]] = None,
        on_exit: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.ghdl_exe = ghdl_exe
        self.entity_name = entity_name
        self.sources = list(sources)
        self.wrapper = wrapper
        self.clock_period_ns = float(clock_period_ns)
        self.workdir = Path(workdir or tempfile.mkdtemp(prefix="cyclone_live_"))
        self.on_frame = on_frame
        self.on_exit = on_exit

        self.proc: Optional[subprocess.Popen] = None
        self._out_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._reader: Optional[threading.Thread] = None
        self._alive = False
        self._quit_sent = False
        self.sim_time_ns = 0.0
        self.last_frame: Optional[dict] = None
        self.start_error: Optional[str] = None
        self.reader_error: Optional[str] = None
        # rolling UART transition buffer (port -> [(t_ns, level)])
        self.uart_buffer: Dict[str, List[tuple]] = {}
        atexit.register(self.close)

    # -- process lifecycle -------------------------------------------------
    def start(self) -> bool:
        wd = self.workdir
        wd.mkdir(parents=True, exist_ok=True)
        # Analyze order matters: board device models first (the wrapper
        # instantiates them), then the design, then the wrapper itself.
        paths = []
        models_root = bundle_root() / "board" / "models"
        for model in self.wrapper.get("models") or []:
            src = models_root / f"{model}.vhd"
            if src.exists():
                dst = wd / f"{model}.vhd"
                shutil.copyfile(src, dst)
                paths.append(dst)
        for name, content in self.sources:
            path = wd / name
            path.write_text(content, encoding="utf-8")
            paths.append(path)
        wrapper_path = wd / "live_wrapper.vhd"
        wrapper_path.write_text(self.wrapper["vhdl"], encoding="utf-8")
        paths.append(wrapper_path)

        work = wd / "wk"
        work.mkdir(exist_ok=True)
        analyze = self._ghdl(["-a", "--std=08", f"--workdir={work}"] + [str(p) for p in paths])
        if analyze.returncode != 0:
            self.start_error = analyze.stderr[-2000:] or analyze.stdout[-2000:]
            return False
        elaborate = self._ghdl(["-e", "--std=08", f"--workdir={work}", f"live_{self.wrapper['entity'].lower()}"])
        if elaborate.returncode != 0:
            self.start_error = elaborate.stderr[-2000:] or elaborate.stdout[-2000:]
            return False

        self.proc = subprocess.Popen(
            [self.ghdl_exe, "-r", "--std=08", f"--workdir={work}",
             f"live_{self.wrapper['entity'].lower()}"],
            cwd=str(wd), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self._alive = True
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        return True

    def _ghdl(self, args: List[str]) -> subprocess.CompletedProcess:
        return subprocess.run([self.ghdl_exe] + args, cwd=str(self.workdir),
                              capture_output=True, text=True, timeout=300)

    def _read_loop(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        frame: Dict[str, Any] = {}
        parsed = 0
        try:
            # Event lines (L/X/G) are emitted by the wrapper DURING the step,
            # i.e. BEFORE the frame's own "F" line — buffer them and attach
            # them to the frame that starts next.
            pending: Dict[str, list] = {}
            for raw in self.proc.stdout:
                line = raw.rstrip("\r\n")
                if not line:
                    continue
                if line.startswith("F "):
                    frame = {"timeNs": _parse_time_ns(line[2:])}
                    for key, events in pending.items():
                        if events:
                            frame[key] = events
                    pending = {}
                elif line.startswith("N ") and "cycles" not in frame:
                    frame["cycles"] = int(line[2:] or 0)
                elif line.startswith("V "):
                    port, _, value = line[2:].partition("=")
                    values = frame.setdefault("values", {})
                    values[port] = _norm_meta(value)
                elif line.startswith("D "):
                    port, _, duty = line[2:].partition(" ")
                    duties = frame.setdefault("duty", {})
                    duties[port] = [int(x) for x in duty.split(",") if x != ""]
                elif line.startswith("B "):
                    toggles, _, active = line[2:].partition(" ")
                    frame["buzzer"] = {"toggles": int(toggles or 0),
                                       "activeCycles": int(active or 0)}
                elif line.startswith("C "):
                    frame["coin"] = [int(x) for x in line[2:].split(",") if x != ""]
                elif line.startswith("X "):
                    parts = line[2:].split()
                    if len(parts) >= 3:
                        t_ns = _parse_time_ns(parts[0] + " " + parts[1])
                        lvl = parts[2]
                    else:
                        t_ns, _, lvl = line[2:].partition(" ")
                    pending.setdefault("uartTransitions", []).append(
                        [float(t_ns or 0), 1 if lvl.strip() == "1" else 0])
                elif line.startswith("G "):
                    ln, _, packed = line[2:].partition(" ")
                    pending.setdefault("vgaLines", []).append([int(ln or 0), int(packed or 0)])
                elif line.startswith("L "):
                    parts = line[2:].split()
                    if len(parts) == 3:
                        pending.setdefault("lcdEvents", []).append(
                            [int(parts[0]), int(parts[1]), int(parts[2])])
                elif line == "END":
                    frame["type"] = "frame"
                    self.sim_time_ns = float(frame.get("timeNs", 0) or 0)
                    self.last_frame = frame
                    parsed += 1
                    if os.environ.get("CYCLESIM_LIVE_DEBUG") and parsed % 100 == 0:
                        print(f"[live-frames] {parsed}", flush=True)
                    if self.on_frame:
                        try:
                            self.on_frame(frame)
                        except Exception:
                            pass
                    frame = {}
                else:
                    # GHDL diagnostics / report lines
                    frame.setdefault("log", []).append(line)
        except Exception as exc:  # pragma: no cover - diagnostics
            self.reader_error = f"{type(exc).__name__}: {exc}"
        finally:
            self._alive = False
            if self.on_exit:
                try:
                    self.on_exit("closed")
                except Exception:
                    pass

    # -- commands ----------------------------------------------------------
    def send(self, command: str) -> bool:
        if not self._alive or self.proc is None or self.proc.stdin is None:
            return False
        with self._send_lock:
            if self._quit_sent:
                return False
            try:
                self.proc.stdin.write(command + "\n")
                self.proc.stdin.flush()
                return True
            except (OSError, ValueError):
                self._alive = False
                return False

    def set_bit(self, input_index: int, bit: int, value: int) -> bool:
        return self.send(f"S{input_index:03d}{bit:02d}{1 if value else 0}")

    def set_int(self, int_index: int, value: int) -> bool:
        sign = 1 if value < 0 else 0
        magnitude = abs(int(value)) % 100_000_000
        return self.send(f"I{int_index:03d}{sign}{magnitude:08d}")

    def step(self, cycles: int) -> bool:
        cycles = max(1, min(int(cycles), 9_999_999))
        return self.send(f"T{cycles:07d}")

    # -- live peripheral commands ------------------------------------------
    def uart_tx(self, byte: int, baud: int = 115200) -> bool:
        """Inject one 8N1 byte onto the DUT's UART RXD pin."""
        byte = int(byte) & 0xFF
        baud = max(50, min(int(baud), 20_000_000))
        return self.send(f"U{baud:08d}{byte:02X}")

    def ps2_inject(self, byte: int) -> bool:
        """Inject one PS/2 scancode byte (device-clocked frame)."""
        return self.send(f"P{int(byte) & 0xFF:02X}")

    def ir_trigger(self, addr: int = 0x00, command: int = 0x01) -> bool:
        """Fire one NEC IR frame (address + command bytes)."""
        return self.send(f"R{int(addr) & 0xFF:02X}{int(command) & 0xFF:02X}")

    def set_temp(self, celsius: int) -> bool:
        """Live-update the LM75A ambient temperature (integer °C)."""
        return self.send(f"M{1 if int(celsius) < 0 else 0}{abs(int(celsius)) % 100_000_000:08d}")

    def quit(self) -> None:
        self.send("Q")
        self._quit_sent = True

    @property
    def alive(self) -> bool:
        return self._alive and self.proc is not None and self.proc.poll() is None

    def close(self) -> None:
        """Defensive teardown: quit → stdin close → grace → terminate → kill."""
        if self.proc is None:
            return
        try:
            if not self._quit_sent:
                self.quit()
        except Exception:
            pass
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=2.0)
        except Exception:
            pass
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=1.0)
            except Exception:
                pass
        if self.proc.poll() is None:
            self.proc.kill()
        self._alive = False


# Registry of live sessions for atexit sweeping
_SESSIONS: List[LiveSession] = []


def _sweep() -> None:
    for session in list(_SESSIONS):
        try:
            session.close()
        except Exception:
            pass


atexit.register(_sweep)


class LiveController:
    """High-level bridge: board semantics ↔ wrapper commands ↔ frames.

    * maps keys/DIP/reset onto the DUT's input port bits (wired-AND shared
      bank on the A2.2: pin = released AND off),
    * parses wrapper frames into frontend-ready payloads (LED duties,
      SEG×DIG coincidence, buzzer Hz/DC, LCD state, UART bytes),
    * implements the Clock Pace loop (Single Cycle / 1 Hz / 100 Hz /
      10 kHz / Live Max).
    """

    PACES = {"single": 0, "1hz": 1, "100hz": 100, "10khz": 10_000, "max": -1}

    def __init__(
        self,
        ghdl_exe: str,
        entity: Any,
        sources: List[tuple],
        board_map: Any,
        profile: dict,
        clock_port: str,
        clock_period_ns: float,
        reset_port: Optional[str],
        reset_cycles: int,
        reset_active_high: bool,
        on_frame: Optional[Callable[[dict], None]] = None,
        on_exit: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.entity = entity
        self.board_map = board_map
        self.profile = profile
        self.clock_period_ns = float(clock_period_ns)
        self.reset_port = reset_port
        self.reset_cycles = int(reset_cycles)
        self.reset_active_high = bool(reset_active_high)

        buzzer_port = None
        buzzer_bit = 0
        buzzer_cfg = profile.get("buzzer") or {}
        buzzer_pin = str(buzzer_cfg.get("pin") or "").upper()
        if buzzer_pin:
            for port, pins in (board_map.pins or {}).items():
                for bit, pin in enumerate(pins or []):
                    if str(pin).upper() == buzzer_pin:
                        buzzer_port, buzzer_bit = port, bit
                        break

        lcd_cfg = profile.get("lcd") or {}
        lcd_pin_map = lcd_cfg.get("pins") or {}
        pin_to_port: Dict[str, str] = {}
        for port, pins in (board_map.pins or {}).items():
            for bit, pin in enumerate(pins or []):
                pin_to_port[str(pin).upper()] = port
        lcd_ports = None
        lcd_rs = pin_to_port.get(str(lcd_pin_map.get("LCD_RS", "")).upper())
        lcd_rw = pin_to_port.get(str(lcd_pin_map.get("LCD_RW", "")).upper())
        lcd_e = pin_to_port.get(str(lcd_pin_map.get("LCD_E", "")).upper())
        lcd_data = pin_to_port.get(str(lcd_pin_map.get("LCD_D", "")).upper())
        if lcd_e and lcd_rs and lcd_data:
            lcd_ports = {"rs": lcd_rs, "rw": lcd_rw, "e": lcd_e, "data": lcd_data}
        else:
            # Name-based fallback: designs may use lowercase port names.
            def _find_lcd_port(pat):
                for p in entity.ports:
                    if re.search(pat, p.name, re.I):
                        return p.name
                return None
            lcd_ports = {"rs": _find_lcd_port(r"lcd_rs"),
                         "rw": _find_lcd_port(r"lcd_rw"),
                         "e": _find_lcd_port(r"lcd_e"),
                         "data": _find_lcd_port(r"lcd_d")}

        # DIG×SEG coincidence tracking: find the design's SEG and DIG ports
        # (their pin sets must sit inside the board's segment/digit banks).
        disp = profile.get("displays") or {}
        seg_pins = {str(p).upper() for p in ((disp.get("pins") or {}).get("SEG")) or []}
        dig_pins = {str(p).upper() for p in ((disp.get("pins") or {}).get("DIG")) or []}
        seg_port = dig_port = None
        for port, plist in (board_map.pins or {}).items():
            ups = [str(p).upper() for p in plist or []]
            if not ups:
                continue
            if seg_port is None and all(p in seg_pins for p in ups):
                seg_port = port
            if dig_port is None and all(p in dig_pins for p in ups):
                dig_port = port
        seg_dig_map = None
        if seg_port and dig_port:
            seg_dig_map = {
                "seg_port": seg_port,
                "dig_port": dig_port,
                "seg_active_high": not bool(disp.get("segmentActiveLow", True)),
                "dig_active_high": not bool(disp.get("digitActiveLow", True)),
                "n_dig": int(disp.get("count", 4)) or 4,
                "n_seg": 8,
            }

        # Live peripheral injection/capture wiring (Phase 5).
        uart_cfg = profile.get("uart") or {}
        uart_tx_pin = str((uart_cfg.get("pins") or {}).get("UART_TXD") or uart_cfg.get("UART_TXD") or "").upper()
        uart_rx_pin = str((uart_cfg.get("pins") or {}).get("UART_RXD") or uart_cfg.get("UART_RXD") or "").upper()
        ps2_pins = (profile.get("ps2") or {}).get("pins") or {}
        ir_pin = str((profile.get("infrared") or {}).get("pin") or "").upper()
        vga_pins = (profile.get("vga") or {}).get("pins") or {}
        live_peripherals = {
            "uart_tx_port": pin_to_port.get(uart_tx_pin),
            "uart_rx_port": pin_to_port.get(uart_rx_pin),
            "ps2_clk_port": pin_to_port.get(str(ps2_pins.get("PS_CLOCK", "")).upper()),
            "ps2_data_port": pin_to_port.get(str(ps2_pins.get("PS_DATA", "")).upper()),
            "ir_port": pin_to_port.get(ir_pin),
            "vga_ports": {
                "hs": pin_to_port.get(str(vga_pins.get("VGA_HSYNC", "")).upper()),
                "vs": pin_to_port.get(str(vga_pins.get("VGA_VSYNC", "")).upper()),
                "r": pin_to_port.get(str(vga_pins.get("VGA_R", "")).upper()),
                "g": pin_to_port.get(str(vga_pins.get("VGA_G", "")).upper()),
                "b": pin_to_port.get(str(vga_pins.get("VGA_B", "")).upper()),
            },
            "i2c_buses": [
                {"scl_port": pin_to_port.get(bus.get("scl", "").upper()),
                 "sda_port": pin_to_port.get(bus.get("sda", "").upper()),
                 "model": (bus.get("device") or {}).get("part", ""),
                 "temperature": (bus.get("device") or {}).get("temperatureC", 25.0)}
                for bus in (profile.get("i2c") or {}).get("buses") or []
            ],
        }

        self.wrapper = build_live_wrapper(
            entity, clock_port, clock_period_ns,
            buzzer_port=buzzer_port, buzzer_bit=buzzer_bit,
            lcd_ports=lcd_ports, seg_dig_map=seg_dig_map,
            live_peripherals=live_peripherals,
        )
        self.on_frame = on_frame
        self.session = LiveSession(
            ghdl_exe, entity.name, sources, self.wrapper, clock_period_ns,
            on_frame=self._on_frame, on_exit=on_exit,
        )
        _SESSIONS.append(self.session)

        # Channel → input port/bit mapping (keys, switches, reset).
        self.key_pins = [str(p).upper() for p in (profile.get("buttons") or {}).get("pins") or []]
        self.sw_pins = [str(p).upper() for p in (profile.get("switches") or {}).get("pins") or []]
        self.reset_pin = str(profile.get("resetPin") or "").upper()
        self.buttons_active_low = bool((profile.get("buttons") or {}).get("activeLow", True))
        self.switches_active_low = bool((profile.get("switches") or {}).get("activeLow", True))

        self.input_index = {name: i for i, name in enumerate(self.wrapper["inputs"])}
        self.port_widths = {p.name: (p.width or 1) for p in entity.ports}
        # Reset polarity is a property of the DESIGN (detected/requested),
        # not of the board profile: the bridge maps logical assert/release
        # onto the physical pin level using THIS flag.
        self.reset_active_low = not bool(reset_active_high)
        self.uart_baud: Optional[int] = None
        self.vga_fb: Dict[int, int] = {}
        self.vga_max_line = 0
        self.vga_wraps = 0
        self.state = {"keys": [False] * len(self.key_pins),
                      "dip": [False] * len(self.sw_pins),
                      "reset": False}
        self._last_levels: Dict[tuple, int] = {}
        self.pace = "max"
        self.bounce = False
        self.frames_sent = 0
        self.cycles_sent = 0
        self.last_frame = None
        self.frame_seq = 0  # increments for every completed frame
        self._pending_frames: List[dict] = []
        # LCD/UART decode state
        self.lcd = self._empty_lcd()
        self.uart_buffers: Dict[str, List[tuple]] = {}
        self.uart_bytes: List[int] = []
        self._pending_frames: List[dict] = []

    # -- board semantics ---------------------------------------------------
    def _empty_lcd(self) -> dict:
        return {"lines": ["", ""], "cursor": 0, "cgram": [""] * 8,
                "backlight": True, "events": 0}

    def _channel_levels(self) -> Dict[str, List[int]]:
        """Raw pin levels per input port for the current key/DIP/reset state.

        Wired-AND shared bank: pin = released AND off (active-low board ->
        released/off = '1').  The DUT only ever sees the physical pin level.
        """
        levels: Dict[str, List[int]] = {}
        pins = self.board_map.pins or {}
        key_idle = 1 if self.buttons_active_low else 0
        sw_idle = 1 if self.switches_active_low else 0
        reset_idle = 1 if self.reset_active_low else 0
        reset_active = 0 if self.reset_active_low else 1
        for port, plist in pins.items():
            idx = self.input_index.get(port)
            if idx is None:
                continue
            bits = []
            for bit, raw_pin in enumerate(plist or []):
                pin = str(raw_pin or "").upper()
                if self.reset_pin and pin == self.reset_pin:
                    bits.append(reset_active if self.state["reset"] else reset_idle)
                    continue
                if pin in self.key_pins:
                    ki = self.key_pins.index(pin)
                    released = not self.state["keys"][ki]
                    sw = self.state["dip"][ki] if ki < len(self.state["dip"]) else False
                    off = not sw
                    level = 1 if (released and off) else 0
                    if not self.buttons_active_low:
                        level = 1 - level
                    bits.append(level)
                    continue
                if pin in self.sw_pins:
                    si = self.sw_pins.index(pin)
                    on = self.state["dip"][si]
                    level = 1 if (on == self.switches_active_low) else 0
                    bits.append(level)
                    continue
                bits.append(0)  # unbound input idles low (batch-TB default)
            levels[port] = bits
        return levels

    def push_inputs(self) -> int:
        """Send S commands for every bound input bit. Returns command count."""
        sent = 0
        levels = self._channel_levels()
        for port, bits in levels.items():
            idx = self.input_index.get(port)
            if idx is None:
                continue
            for bit, level in enumerate(bits):
                if self.session.set_bit(idx, bit, level):
                    sent += 1
        return sent

    def assert_reset(self) -> None:
        self.state["reset"] = True
        self.push_inputs()
        if self.reset_cycles > 0:
            self.session.step(self.reset_cycles)
        self.state["reset"] = False
        self.push_inputs()

    # -- frame handling ----------------------------------------------------
    def _on_frame(self, frame: dict) -> None:
        self.last_frame = frame
        self.frame_seq += 1
        self._decode_lcd(frame)
        self._decode_uart(frame)
        self._accumulate_vga(frame)
        self._pending_frames.append(frame)
        if self.on_frame:
            try:
                self.on_frame(frame)
            except Exception:
                pass

    def _decode_uart(self, frame: dict) -> None:
        """Decode 8N1 bytes from THIS frame's TXD transitions.

        Live caveat: a byte whose framing crosses a frame boundary is picked
        up on the next frame's tail — the batch decoder over the full capture
        stays the authoritative path.  The bit time comes from the last
        injected baud (a capture window can start mid-frame, which poisons
        the min-width estimate).
        """
        trans = frame.get("uartTransitions") or []
        if not trans:
            return
        baud = getattr(self, "uart_baud", None)
        hint = (1e9 / baud) if baud else None
        decoded = decode_uart([(float(t), v) for t, v in trans], bit_time_ns=hint)
        if decoded.get("bytes"):
            frame["uartBytes"] = decoded["bytes"]

    def _accumulate_vga(self, frame: dict) -> None:
        lines = frame.get("vgaLines") or []
        if not lines:
            return
        fb = getattr(self, "vga_fb", None)
        if fb is None:
            fb = {}
            self.vga_fb = fb
        for line, packed in lines:
            if line < getattr(self, "vga_max_line", 0):
                self.vga_wraps = getattr(self, "vga_wraps", 0) + 1
            fb[line] = packed
            self.vga_max_line = max(self.vga_max_line, line)
        frame["vga"] = {
            "lines": {str(k): v for k, v in sorted(fb.items())},
            "wraps": getattr(self, "vga_wraps", 0),
        }

    def _decode_lcd(self, frame: dict) -> None:
        events = frame.get("lcdEvents") or []
        if not events:
            return
        lcd = self.lcd
        ddram = getattr(self, "_ddram", None)
        if ddram is None:
            ddram = [0x20] * 80  # 2×16 visible + wraparound margin
            self._ddram = ddram
        cgram = getattr(self, "_cgram", None)
        if cgram is None:
            cgram = [0] * 64
            self._cgram = cgram
        addr = getattr(self, "_lcd_addr", 0)
        for rs, rw, db in events:
            lcd["events"] += 1
            if rw:
                continue  # reads (busy flag) do not change state
            if not rs:
                cmd = db
                if cmd == 0x01:
                    ddram[:] = [0x20] * 80
                    addr = 0
                elif cmd in (0x02, 0x03):
                    addr = 0
                elif 0x80 <= cmd <= 0xFF:
                    a = cmd - 0x80
                    addr = a if a < 40 or 64 <= a < 104 else (0 if a >= 104 else 64)
                # other commands (display on/off, shift...) are cosmetic-only
            else:
                ddram[addr % 80] = db
                addr = (addr + 1) % 80
        self._lcd_addr = addr
        lcd["cursor"] = addr
        row1 = "".join(chr(ddram[i]) if 32 <= ddram[i] < 127 else " "
                       for i in range(16))
        row2 = "".join(chr(ddram[64 + i]) if 32 <= ddram[64 + i] < 127 else " "
                       for i in range(16))
        lcd["lines"] = [row1, row2]
        lcd["cgram"] = cgram
        frame["lcd"] = {"lines": lcd["lines"], "cursor": lcd["cursor"],
                        "events": lcd["events"]}

    # -- pacing ------------------------------------------------------------
    def cycles_for_tick(self, interval_s: float) -> int:
        """Cycles to advance this tick for the selected pace."""
        if self.pace == "single":
            return 0  # single-step is user-triggered
        if self.pace == "max":
            return 200_000
        hz = self.PACES.get(self.pace, 0)
        if hz <= 0:
            return 0
        return max(1, int(round(hz * interval_s)))

    def apply_channel_state(self, keys: List[bool], dip: List[bool],
                            reset: bool, bounce: bool = False) -> int:
        """Push the physical pin levels for the current channel state.

        With ``bounce=True`` a changed channel injects a short deterministic
        contact-chatter burst (cycle-domain, via 1-cycle steps) so HDL
        debouncers can be exercised exactly like on a real board.  Default is
        off — deterministic tests are unaffected.
        """
        self.state["keys"] = list(keys) + self.state["keys"][len(keys):]
        self.state["dip"] = list(dip) + self.state["dip"][len(dip):]
        self.state["reset"] = bool(reset)
        levels = self._channel_levels()
        sent = 0
        for port, bits in levels.items():
            idx = self.input_index.get(port)
            if idx is None:
                continue
            for bit, level in enumerate(bits):
                key = (port, bit)
                changed = self._last_levels.get(key) != level
                if not bounce or not changed:
                    if self.session.set_bit(idx, bit, level):
                        sent += 1
                    self._last_levels[key] = level
                    continue
                # Deterministic chatter burst: alternate away/target for a few
                # cycles, then settle. Each step is one clock cycle.
                self._last_levels[key] = level
                for k in range(5):
                    chatter = level if k in (1, 3) else (1 - level)
                    if self.session.set_bit(idx, bit, chatter):
                        sent += 1
                    self.session.step(1)
                if self.session.set_bit(idx, bit, level):
                    sent += 1
        return sent

    def set_pace(self, pace: str) -> None:
        if pace in self.PACES:
            self.pace = pace


def build_live_controller(
    ghdl_exe: str,
    entity: Any,
    raw_sources: List[tuple],
    board_map: Any,
    profile: dict,
    clock_port: str,
    clock_period_ns: float,
    reset_port: Optional[str],
    reset_cycles: int,
    reset_active_high: bool,
    on_frame: Optional[Callable[[dict], None]] = None,
    on_exit: Optional[Callable[[str], None]] = None,
) -> tuple:
    """Translate sources (Verilog → VHDL), build the wrapper and session."""
    from .verilog_support import translate_verilog_sources

    sources, _line_maps, errors, _warnings = translate_verilog_sources(raw_sources)
    if errors:
        raise RuntimeError(errors[0].get("message", "Verilog translation failed"))
    controller = LiveController(
        ghdl_exe, entity, sources, board_map, profile, clock_port,
        clock_period_ns, reset_port, reset_cycles, reset_active_high,
        on_frame=on_frame, on_exit=on_exit,
    )
    return controller, sources
