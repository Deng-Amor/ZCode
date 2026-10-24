"""Administrator-only in-memory ZIP signing/sealing. Never ships with CCode."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import unicodedata
import zipfile
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SOURCE = Path('D:/Backup/Documents/WXWork/1688857356957104/Cache/File/2026-10/总控派单.zip')
STAGE = Path('E:/github/cs-platform-service/.local-data/ccode-controller-release')
KEYS = STAGE / 'signing'
OUTPUT = STAGE / 'controller-v1.ccskill'
META = STAGE / 'controller-v1.metadata.json'
EXPECTED_PATHS = {'SKILL.md', 'references/复盘-20261014.md', 'references/复盘-20261015.md',
                  'references/复盘-20261017.md', 'references/班车与清单池.md', 'references/通道与并行.md'}

def run():
    if OUTPUT.exists() or META.exists():
        raise RuntimeError('Release already prepared; do not overwrite')
    spec = importlib.util.spec_from_file_location('admin_keys', Path(__file__).with_name('ccode-admin-keys.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    files, seen = [], set()
    total = 0
    with zipfile.ZipFile(SOURCE) as archive:
        if len(archive.infolist()) > 64: raise RuntimeError('Too many archive entries')
        for entry in archive.infolist():
            if entry.is_dir(): continue
            if not entry.filename.startswith('总控派单/'): raise RuntimeError('Unexpected archive root')
            name = entry.filename[len('总控派单/'):]
            if name not in EXPECTED_PATHS: raise RuntimeError('Unexpected source path')
            if (not name.endswith('.md') or '\\' in name or ':' in name
                    or any(p in ('', '.', '..') for p in name.split('/'))
                    or any(ord(c) < 32 for c in name)
                    or unicodedata.normalize('NFC', name) != name
                    or name.upper() in seen or stat.S_ISLNK(entry.external_attr >> 16)):
                raise RuntimeError('Invalid source entry')
            if entry.file_size > 1024 * 1024: raise RuntimeError('Source entry too large')
            seen.add(name.upper())
            with archive.open(entry) as stream: data = stream.read(1024 * 1024 + 1)
            total += len(data)
            if len(data) > 1024 * 1024 or total > 4 * 1024 * 1024: raise RuntimeError('Source too large')
            data.decode('utf-8', errors='strict')
            if b'PRIVATE KEY-----' in data: raise RuntimeError('Private material in source')
            files.append({'path': name, 'contentBase64': base64.b64encode(data).decode(),
                          'sha256': hashlib.sha256(data).hexdigest()})
    if {item['path'] for item in files} != EXPECTED_PATHS: raise RuntimeError('Unexpected source manifest')
    files.sort(key=lambda item: item['path'])
    encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    payload = encode({'schemaVersion': 1, 'skillId': 'controller', 'name': '总控派单', 'version': 1, 'files': files})
    key = Ed25519PrivateKey.from_private_bytes(module.dpapi((KEYS/'private-key.dpapi').read_bytes(), decrypt=True))
    public_bytes = (KEYS/'public-key.pem').read_bytes()
    if hashlib.sha256(public_bytes).hexdigest() != 'af5badd5898fcaaf68ae054373a81c1e9439dd86ac4f10c6159838239b5ed275':
        raise RuntimeError('Deployment trust fingerprint mismatch')
    public = serialization.load_pem_public_key(public_bytes)
    signature = key.sign(payload)
    public.verify(signature, payload)
    envelope = encode({'schemaVersion': 1, 'payloadBase64': base64.b64encode(payload).decode(),
                       'signatureBase64': base64.b64encode(signature).decode()})
    cipher = AESGCM(module.dpapi((KEYS/'storage-key.dpapi').read_bytes(), decrypt=True))
    nonce = os.urandom(12)
    aad = b'ccode-knowledge-source-v1/1/166/storage-v1'
    sealed = cipher.encrypt(nonce, envelope, aad)
    if cipher.decrypt(nonce, sealed, aad) != envelope: raise RuntimeError('Sealing failed')
    source = encode({'schemaVersion': 1, 'keyId': 'storage-v1',
                     'encryptedEnvelope': base64.b64encode(nonce + sealed).decode()})
    metadata = {'schemaVersion': 1, 'skillId': 'controller', 'version': 1, 'tenantId': 1,
                'folderId': 166, 'fileCount': len(files), 'expandedBytes': total,
                'payloadSha256': hashlib.sha256(payload).hexdigest(),
                'sourceSha256': hashlib.sha256(source).hexdigest(), 'sourceBytes': len(source),
                'inputArchiveSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest()}
    with OUTPUT.open('xb') as stream: stream.write(source)
    with META.open('x', encoding='utf-8') as stream: json.dump(metadata, stream)
    print(json.dumps(metadata))

if __name__ == '__main__':
    try: run()
    except Exception as error:
        raise SystemExit('Source preparation stopped: '+type(error).__name__+'; preserve existing artifacts') from None
