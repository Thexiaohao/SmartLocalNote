"""Extract only 16x16 and 32x32 frames from assets/icon.ico into daemon/tray.ico."""

from __future__ import annotations

import pathlib
import struct


def extract_tray_ico(src_path: pathlib.Path, dst_path: pathlib.Path, keep_sizes: set[int] = {16, 32}) -> int:
    data = src_path.read_bytes()
    if len(data) < 6:
        raise ValueError(f"Invalid ICO header: {src_path}")
    reserved, img_type, count = struct.unpack("<HHH", data[:6])
    if reserved != 0 or img_type != 1:
        raise ValueError(f"Not a valid ICO file: {src_path}")

    kept: list[tuple[bytes, bytes]] = []
    for i in range(count):
        off = 6 + i * 16
        entry = data[off : off + 16]
        w = entry[0] or 256
        h = entry[1] or 256
        bytes_in_res, image_offset = struct.unpack("<II", entry[8:16])
        if w in keep_sizes and h in keep_sizes:
            payload = data[image_offset : image_offset + bytes_in_res]
            kept.append((entry[:8], payload))

    if not kept:
        raise ValueError(f"No frames matching {keep_sizes} in {src_path}")

    out = bytearray(struct.pack("<HHH", 0, 1, len(kept)))
    cursor = 6 + 16 * len(kept)
    for meta8, payload in kept:
        out.extend(meta8)
        out.extend(struct.pack("<II", len(payload), cursor))
        cursor += len(payload)
    for _, payload in kept:
        out.extend(payload)

    dst_path.parent.mkdir(parents=True, exist_ok=True)
    dst_path.write_bytes(bytes(out))
    return len(out)


if __name__ == "__main__":
    root = pathlib.Path(__file__).resolve().parent.parent
    src = root / "assets" / "icon.ico"
    dst = root / "daemon" / "tray.ico"
    sz = extract_tray_ico(src, dst)
    print(f"Created {dst} ({sz} bytes)")
