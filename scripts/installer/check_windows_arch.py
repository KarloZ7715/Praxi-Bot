#!/usr/bin/env python3
"""Check the PE machine field of Windows executables before packaging or running them."""

import argparse
from pathlib import Path
import struct


MACHINES = {"arm64": 0xAA64, "x64": 0x8664, "x86": 0x014C}


def machine(path: Path) -> int:
    with path.open("rb") as stream:
        header = stream.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ValueError("missing DOS header")
        offset = struct.unpack_from("<I", header, 0x3C)[0]
        if offset < 64:
            raise ValueError("invalid PE header offset")
        stream.seek(offset)
        header = stream.read(24)
        if len(header) != 24 or header[:4] != b"PE\0\0":
            raise ValueError("missing PE/COFF header")
        return struct.unpack_from("<H", header, 4)[0]


def check(path: Path, arch: str) -> None:
    actual = machine(path)
    if actual != MACHINES[arch]:
        raise ValueError(f"machine 0x{actual:04x}, expected {arch} (0x{MACHINES[arch]:04x})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arch", choices=MACHINES, required=True)
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    for path in args.files:
        try:
            check(path, args.arch)
        except (OSError, ValueError) as error:
            parser.exit(1, f"{path}: {error}\n")
        print(f"{path}: {args.arch}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
