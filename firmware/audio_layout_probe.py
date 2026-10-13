"""Validate OTA deflate members and find candidate flash string pointers."""
from pathlib import Path
import hashlib
import json
import struct
import zlib

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'audio-investigation'
ota = (ROOT / 'miwear.watch.o65_v3.100.105_full_987d7afe.bin').read_bytes()
members = []
pos = 0
while True:
    pos = ota.find(b'PK\x03\x04', pos)
    if pos < 0:
        break
    offset = pos
    pos += 4
    try:
        fields = struct.unpack_from('<I5H3I2H', ota, offset)
        _, version, flags, method, time, date, crc, size, raw_size, namelen, extralen = fields
        name = ota[offset + 30:offset + 30 + namelen].decode('ascii')
        if name not in ('vela_ap.bin', 'vela_audio.bin'):
            continue
        start = offset + 30 + namelen + extralen
        payload = ota[start:start + size]
        raw = zlib.decompress(payload, -15) if method == 8 else payload
        existing = (ROOT / (name + '.raw')).read_bytes()
        members.append(dict(name=name, header_offset=offset, payload_offset=start,
                            compressed_size=size, raw_size=len(raw),
                            crc_ok=(zlib.crc32(raw) & 0xffffffff) == crc,
                            size_ok=len(raw) == raw_size,
                            sha256=hashlib.sha256(raw).hexdigest(), matches_existing=raw == existing))
    except (ValueError, struct.error, zlib.error):
        continue

ap = (ROOT / 'vela_ap.bin.raw').read_bytes()
seeds = ['wechat_init', 'wechat_js_invoke_function', 'system.record',
         'js_invoke_function', 'js_regist_task_callback', 'startRecord',
         'verifyAuth', 'com.tencent.wechatrtos']
refs = []
for seed in seeds:
    p = 0
    while True:
        p = ap.find(seed.encode() + b'\0', p)
        if p < 0:
            break
        # Startup at 0xac8 copies raw [0xe348,0x1d4f28) to 0x3c000000.
        # 0x1c is an executable-alias candidate; keep it labelled as such.
        for base in (0x0c080000, 0x2c080000, 0x3c000000 - 0xe348, 0x1c000000 - 0xe348):
            needle = struct.pack('<I', base + p)
            candidates = []
            q = 0
            while True:
                q = ap.find(needle, q)
                if q < 0:
                    break
                if q % 4 == 0:
                    candidates.append(hex(q))
                q += 1
            if candidates:
                refs.append(dict(string=seed, string_offset=hex(p), candidate_base=hex(base),
                                 pointer_locations=candidates))
        p += 1
result = dict(ota_members=members, candidate_pointer_refs=refs,
              caveat='Pointer matches are data evidence, not verified executable xrefs or authorization gates.')
OUT.mkdir(exist_ok=True)
(OUT / 'layout-evidence.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result, indent=2))
