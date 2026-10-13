"""Wrap a raw byte range in an analysis-only ELF with a Thumb mapping symbol.

The chosen virtual address is an analyst hypothesis, not original ELF metadata.
Usage: python audio_make_elf.py OFFSET SIZE ADDRESS OUTPUT_NAME
"""
from pathlib import Path
import struct
import sys

root = Path(__file__).resolve().parent
offset, size, address = (int(v, 0) for v in sys.argv[1:4])
raw = (root / 'vela_ap.bin.raw').read_bytes()[offset:offset + size]
names = b'\0.text\0.shstrtab\0.symtab\0.strtab\0'
strings = b'\0$t\0'
data = bytearray(256)
parts = []
for blob in [raw, names, bytes(16) + struct.pack('<IIIBBH', 1, address, 0, 0, 0, 1), strings]:
    data.extend(bytes((-len(data)) % 4))
    parts.append((len(data), len(blob)))
    data.extend(blob)
data.extend(bytes((-len(data)) % 4))
shoff = len(data)
data.extend(bytes(40))
for name, kind, flags, addr, index, link, info, align, entsize in [
    (1, 1, 6, address, 0, 0, 0, 2, 0),
    (7, 3, 0, 0, 1, 0, 0, 1, 0),
    (17, 2, 0, 0, 2, 4, 2, 4, 16),
    (25, 3, 0, 0, 3, 0, 0, 1, 0),
]:
    start, length = parts[index]
    data.extend(struct.pack('<IIIIIIIIII', name, kind, flags, addr, start, length, link, info, align, entsize))
header = b'\x7fELF' + bytes([1, 1, 1, 0]) + bytes(8)
header += struct.pack('<HHIIIIIHHHHHH', 2, 40, 1, address | 1, 0, shoff,
                      0x5000000, 52, 0, 0, 40, 5, 2)
data[:52] = header
out = root / 'audio-investigation' / sys.argv[4]
out.write_bytes(data)
print(out)
