"""Generate minimalist Cyclone IV Studio PNG & ICO app icons without third-party libs."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path


def _render_rgba(size: int) -> bytes:
    buf = bytearray(size * size * 4)
    # Dark slate square with rounded look, blue ring & IC chip die + gold pins
    pad = max(2, size // 12)
    pin_span = max(2, size // 8)
    chip_min = int(size * 0.28)
    chip_max = int(size * 0.72)

    for y in range(size):
        for x in range(size):
            idx = (y * size + x) * 4
            dx = abs(x - size / 2 + 0.5)
            dy = abs(y - size / 2 + 0.5)
            in_card = pad <= x < size - pad and pad <= y < size - pad
            if not in_card:
                buf[idx : idx + 4] = b"\x00\x00\x00\x00"
                continue

            # Corner bevel
            corner = (x < pad + 3 or x >= size - pad - 3) and (y < pad + 3 or y >= size - pad - 3)
            if corner and (dx + dy) > size - 2 * pad - 2:
                buf[idx : idx + 4] = b"\x00\x00\x00\x00"
                continue

            # Base board color (deep slate blue-black)
            r, g, b, a = 15, 23, 42, 255

            # Outer subtle blue border
            if x == pad or x == size - pad - 1 or y == pad or y == size - pad - 1:
                r, g, b = 37, 99, 235

            # Gold QFP pins radiating from chip
            on_v_pin = (chip_min + 2 <= x <= chip_max - 2) and (
                (chip_min - pin_span <= y < chip_min) or (chip_max < y <= chip_max + pin_span)
            ) and ((x * 6 // max(1, size)) % 2 == 0)
            on_h_pin = (chip_min + 2 <= y <= chip_max - 2) and (
                (chip_min - pin_span <= x < chip_min) or (chip_max < x <= chip_max + pin_span)
            ) and ((y * 6 // max(1, size)) % 2 == 0)
            if on_v_pin or on_h_pin:
                r, g, b = 234, 179, 8

            # Center FPGA package
            if chip_min <= x <= chip_max and chip_min <= y <= chip_max:
                r, g, b = 30, 41, 59
                if (
                    x in (chip_min, chip_max)
                    or y in (chip_min, chip_max)
                ):
                    r, g, b = 96, 165, 250
                # Inner glowing blue cyan diamond / 'IV' mark
                inner_d = abs(x - size * 0.5) + abs(y - size * 0.5)
                if inner_d < size * 0.14:
                    r, g, b = 59, 130, 246
                if abs(x - size * 0.36) < max(1, size * 0.03) and abs(y - size * 0.36) < max(1, size * 0.03):
                    r, g, b = 56, 189, 248

            buf[idx : idx + 4] = bytes((r, g, b, a))
    return bytes(buf)


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def _encode_png(size: int, rgba: bytes) -> bytes:
    raw_rows = bytearray()
    stride = size * 4
    for y in range(size):
        raw_rows.append(0)  # filter type 0
        raw_rows.extend(rgba[y * stride : (y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), level=9)
    return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


def _encode_ico(png_entries: list[tuple[int, bytes]]) -> bytes:
    header = struct.pack("<HHH", 0, 1, len(png_entries))
    offset = 6 + 16 * len(png_entries)
    dir_entries = bytearray()
    blobs = bytearray()
    for sz, png in png_entries:
        w = 0 if sz >= 256 else sz
        h = 0 if sz >= 256 else sz
        dir_entries.extend(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(png), offset))
        offset += len(png)
        blobs.extend(png)
    return header + bytes(dir_entries) + bytes(blobs)


def generate_icons(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 48, 128, 256]
    pngs = {sz: _encode_png(sz, _render_rgba(sz)) for sz in sizes}
    (out_dir / "32x32.png").write_bytes(pngs[32])
    (out_dir / "128x128.png").write_bytes(pngs[128])
    (out_dir / "128x128@2x.png").write_bytes(pngs[256])
    (out_dir / "icon.png").write_bytes(pngs[256])
    (out_dir / "icon.ico").write_bytes(_encode_ico([(sz, pngs[sz]) for sz in sizes]))
    print(f"Generated icons in {out_dir}")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    generate_icons(root / "src-tauri" / "icons")
