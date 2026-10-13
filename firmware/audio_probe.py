"""Read-only RPK/native audio evidence scan. Python standard library only."""
from pathlib import Path
import hashlib, json, re, zipfile

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'audio-investigation'
OUT.mkdir(exist_ok=True)
pattern = re.compile(r'@(?:system|service)\.[\w.]+|@app-module/[\w.]+|loadLibrary|WECHAT_APP|startRecord|stopRecord|recordNoop|record|voice|audio|microphone|permission', re.I)
inventory = []
hits = []
for p in sorted((ROOT / 'rpk_extract').glob('*.rpk')):
    with zipfile.ZipFile(p) as z:
        item = {'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'members': z.namelist(), 'manifests': []}
        for n in z.namelist():
            if n.endswith('/'):
                continue
            b = z.read(n)
            if n.endswith('manifest.json'):
                item['manifests'].append({'member': n, 'content': json.loads(b)})
            if n.endswith(('.js', '.json', '.ux', '.txt')):
                s = b.decode('utf-8', errors='replace')
                for m in pattern.finditer(s):
                    hits.append({'rpk': p.name, 'member': n, 'character_offset': m.start(), 'token': m.group(), 'context': s[max(0,m.start()-180):m.end()+260]})
                if 'wechatrtos' in p.name:
                    dest = OUT / 'wechat' / n
                    if dest.resolve().is_relative_to((OUT / 'wechat').resolve()):
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(b)
        inventory.append(item)
(OUT / 'rpk-inventory.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding='utf-8')
(OUT / 'rpk-hits.json').write_text(json.dumps(hits, ensure_ascii=False, indent=2), encoding='utf-8')
native_pattern = re.compile(rb'record|voice|audio|WECHAT|loadLibrary|permission|signature|whitelist|allowlist|pcm0c|SelMic|SelCap|Capture|library|dlopen|silk|js_|task_id|func_name|request_body', re.I)
native = []
for name in ['vela_ap.bin.raw', 'vela_audio.bin.raw', 'recorder.res.raw', 'voice.res.raw']:
    p = ROOT / name
    b = p.read_bytes()
    rows = []
    for m in re.finditer(rb'[\x20-\x7e]{4,}', b):
        if native_pattern.search(m.group()):
            rows.append({'offset': m.start(), 'offset_hex': hex(m.start()), 'text': m.group().decode('ascii')})
    native.append({'file': name, 'sha256': hashlib.sha256(b).hexdigest(), 'size': len(b), 'header_hex': b[:64].hex(), 'strings': rows})
    (OUT / (name + '.strings.tsv')).write_text('\n'.join(f"{r['offset_hex']}\t{r['text']}" for r in rows), encoding='utf-8')
(OUT / 'native-evidence.json').write_text(json.dumps(native, ensure_ascii=False, indent=2), encoding='utf-8')
for i in inventory:
    print(i['file'], [(m['content'].get('package'), m['content'].get('features'), m['content'].get('permissions')) for m in i['manifests']])
print('RPK hits:', len(hits))
print('Native strings:', [(i['file'],len(i['strings']),i['header_hex'][:32]) for i in native])
