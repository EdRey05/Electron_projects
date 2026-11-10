"""Extract pinned app-local CRT files from Microsoft's signed Burn/CAB bundle.

Uses only the staged Python standard library and Windows expand.exe. It never
executes an installer or changes the host/guest system runtime.
"""
from pathlib import Path
import hashlib
import json
import shutil
import struct
import subprocess
import sys


def extract(installer, directory, runtime, specification):
    directory.mkdir(parents=True, exist_ok=True)
    data = installer.read_bytes()
    if hashlib.sha256(data).hexdigest().upper() != specification['sha256']:
        raise ValueError('Microsoft package checksum mismatch')
    containers = []
    cursor = 0
    while True:
        offset = data.find(b'MSCF', cursor)
        if offset < 0:
            break
        cursor = offset + 4
        if offset + 36 > len(data):
            continue
        size = struct.unpack_from('<I', data, offset + 8)[0]
        if data[offset + 4:offset + 8] != bytes(4) or size < 36 or offset + size > len(data):
            continue
        cabinet = directory / f'container-{offset}.cab'
        cabinet.write_bytes(data[offset:offset + size])
        target = directory / f'container-{offset}'
        target.mkdir(exist_ok=True)
        subprocess.run(['expand.exe', '-F:*', str(cabinet), str(target)], check=True, capture_output=True)
        containers.append(target)
    if not containers:
        raise ValueError('No Microsoft CAB containers found')
    for container in containers:
        for payload in list(container.iterdir()):
            if payload.is_file() and payload.read_bytes()[:4] == b'MSCF':
                target = container / (payload.name + '-files')
                target.mkdir(exist_ok=True)
                subprocess.run(['expand.exe', '-F:*', str(payload), str(target)], check=True, capture_output=True)
    wanted = {entry['sha256']: entry['file'] for entry in specification['files']}
    found = set()
    for file in directory.rglob('*'):
        if not file.is_file() or file.suffix == '.cab':
            continue
        content = file.read_bytes()
        if content.startswith(b'{\\rtf'):
            licenses = runtime / 'licenses' / 'microsoft-vc'
            licenses.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, licenses / (file.name + '.rtf'))
        digest = hashlib.sha256(content).hexdigest().upper()
        if digest not in wanted:
            continue
        pe = struct.unpack_from('<I', content, 0x3c)[0]
        if content[pe:pe + 4] != b'PE\0\0' or struct.unpack_from('<H', content, pe + 4)[0] != 0x8664:
            raise ValueError('Expected x64 Microsoft runtime DLL')
        name = wanted[digest]
        shutil.copyfile(file, runtime / name)
        found.add(name)
    if found != set(wanted.values()):
        raise ValueError(f'Microsoft runtime files missing: {set(wanted.values()) - found}')
    return sorted(found)


if __name__ == '__main__':
    installer, directory, runtime, spec = map(Path, sys.argv[1:])
    specification = json.loads(spec.read_text(encoding='utf-8-sig'))
    print(json.dumps(extract(installer, directory, runtime, specification)))
