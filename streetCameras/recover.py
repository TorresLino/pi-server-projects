#!/usr/bin/env python3
import re
import struct
import subprocess
import sys
from pathlib import Path


def extract_sps_pps(ref_mp4: Path) -> tuple[bytes, bytes]:
    ref_h264 = Path("/tmp/ref_single_extract.h264")
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", str(ref_mp4),
            "-c:v", "copy", "-bsf:v", "h264_mp4toannexb",
            "-f", "h264", str(ref_h264),
        ],
        check=True,
    )
    data = ref_h264.read_bytes()
    ref_h264.unlink(missing_ok=True)

    starts = [m.start() for m in re.finditer(b"\x00\x00\x01", data)]
    sps = pps = None
    for i, s in enumerate(starts):
        nal_start = s + 3
        nal_end = starts[i + 1] if i + 1 < len(starts) else len(data)
        if nal_start >= len(data):
            continue
        nal_type = data[nal_start] & 0x1F
        nal_bytes = data[nal_start:nal_end].rstrip(b"\x00")
        if nal_type == 7 and sps is None:
            sps = b"\x00\x00\x00\x01" + nal_bytes
        elif nal_type == 8 and pps is None:
            pps = b"\x00\x00\x00\x01" + nal_bytes
        if sps and pps:
            break

    if not sps or not pps:
        raise RuntimeError(f"Could not extract SPS and PPS from {ref_mp4}")
    return sps, pps


def main() -> int:
    if len(sys.argv) < 3:
        print(f"Usage: {Path(sys.argv[0]).name} <working.mp4> <corrupted.mp4> [fps]", file=sys.stderr)
        return 1

    ref_mp4 = Path(sys.argv[1]).resolve()
    bad_mp4 = Path(sys.argv[2]).resolve()
    fps = sys.argv[3] if len(sys.argv) > 3 else "25"

    out_mp4 = bad_mp4.parent / f"recovered_{bad_mp4.name}"
    patched_h264 = Path(f"/tmp/{bad_mp4.stem}_patched.h264")

    sps, pps = extract_sps_pps(ref_mp4)
    data = bad_mp4.read_bytes()

    pos = 0x30
    nal_count = 0
    with patched_h264.open("wb") as out:
        out.write(sps)
        out.write(pps)
        while pos + 4 <= len(data):
            nal_len = struct.unpack(">I", data[pos : pos + 4])[0]
            pos += 4
            if nal_len == 0 or pos + nal_len > len(data):
                break
            out.write(b"\x00\x00\x00\x01")
            out.write(data[pos : pos + nal_len])
            pos += nal_len
            nal_count += 1

    if nal_count == 0:
        patched_h264.unlink(missing_ok=True)
        print(f"Error: 0 NAL units found in {bad_mp4}", file=sys.stderr)
        return 1

    res = subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-err_detect", "ignore_err",
            "-r", fps,
            "-i", str(patched_h264),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23",
            str(out_mp4),
        ]
    )
    patched_h264.unlink(missing_ok=True)

    if res.returncode != 0 or not out_mp4.exists() or out_mp4.stat().st_size == 0:
        print(f"Error: failed to produce {out_mp4}", file=sys.stderr)
        return 1

    print(f"Saved {out_mp4} ({nal_count} NAL units)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())