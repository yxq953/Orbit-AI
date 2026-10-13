"""Focused Thumb disassembly with PC-literal and copied-string annotations."""
from pathlib import Path
import struct
import sys
from capstone import Cs, CS_ARCH_ARM, CS_MODE_THUMB, CS_MODE_MCLASS
from capstone.arm import ARM_OP_MEM, ARM_REG_PC

root = Path(__file__).resolve().parent
raw = (root / 'vela_ap.bin.raw').read_bytes()
offset, size = (int(s, 0) for s in sys.argv[1:3])
base = 0x0c080000
md = Cs(CS_ARCH_ARM, CS_MODE_THUMB | CS_MODE_MCLASS)
md.detail = True
lines = []
for ins in md.disasm(raw[offset:offset + size], base + offset):
    note = ''
    for op in ins.operands:
        if op.type == ARM_OP_MEM and op.mem.base == ARM_REG_PC:
            literal = ((ins.address + 4) & ~3) + op.mem.disp - base
            if 0 <= literal <= len(raw) - 4:
                value = struct.unpack_from('<I', raw, literal)[0]
                note = f' ; literal raw+0x{literal:x} = 0x{value:08x}'
                string_off = value - (0x3c000000 - 0xe348)
                if 0xe348 <= string_off < 0x1d4f28:
                    string = raw[string_off:string_off + 150].split(b'\0')[0]
                    if string and all(c in (9, 10, 13) or 32 <= c < 127 for c in string):
                        note += ' ' + repr(string.decode('ascii'))
    lines.append(f'{ins.address:08x} raw+{ins.address-base:06x}: {ins.mnemonic:8} {ins.op_str}{note}')
text = '\n'.join(lines) + '\n'
(root / 'audio-investigation' / f'thumb-{offset:x}.txt').write_text(text, encoding='utf-8')
print(text)
