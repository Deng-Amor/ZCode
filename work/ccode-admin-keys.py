"""Provision administrator keys. Secret output is always Windows-user DPAPI protected."""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def dpapi(data, *, decrypt=False):
    if os.name != 'nt':
        raise RuntimeError('Windows administrator session required')
    source_buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source = Blob(len(data), source_buffer)
    target = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob),
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    # CRYPTPROTECT_UI_FORBIDDEN; default scope is the current Windows user.
    try:
        if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
            raise RuntimeError('Windows key protection unavailable')
        return ctypes.string_at(target.data, target.size)
    finally:
        ctypes.memset(source_buffer, 0, len(data))
        if target.data:
            ctypes.memset(target.data, 0, target.size)
            kernel.LocalFree(target.data)


def provision(directory):
    directory = Path(directory).resolve(strict=True)
    if any(directory.iterdir()):
        raise RuntimeError('Key directory must be empty; existing keys must not be replaced')
    key = Ed25519PrivateKey.generate()
    private = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                serialization.NoEncryption())
    public = key.public_key().public_bytes(serialization.Encoding.PEM,
                                          serialization.PublicFormat.SubjectPublicKeyInfo)
    storage = os.urandom(32)
    protected_private, protected_storage = dpapi(private), dpapi(storage)
    # Provisioning consistency check before writing any key; never print recovered bytes.
    if dpapi(protected_private, decrypt=True) != private or dpapi(protected_storage, decrypt=True) != storage:
        raise RuntimeError('Key protection round trip failed')
    metadata = {'schemaVersion': 1, 'algorithm': 'Ed25519', 'storageAlgorithm': 'AES-256-GCM',
                'localProtection': 'Windows DPAPI CurrentUser',
                'publicKeySha256': hashlib.sha256(public).hexdigest()}
    for name, content in [('private-key.dpapi', protected_private), ('storage-key.dpapi', protected_storage),
                          ('public-key.pem', public), ('metadata.json', json.dumps(metadata).encode())]:
        with (directory / name).open('xb') as stream:
            stream.write(content)
    print(json.dumps(metadata))


if __name__ == '__main__':
    import sys
    if len(sys.argv) != 2:
        raise SystemExit('Usage: ccode-admin-keys.py <empty ACL-restricted administrator directory>')
    try:
        provision(sys.argv[1])
    except Exception:
        raise SystemExit('Administrator key provisioning failed; preserve partial files and investigate') from None
