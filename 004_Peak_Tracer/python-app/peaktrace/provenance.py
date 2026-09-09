"""Identify the exact processing source without requiring Git at runtime."""
from functools import lru_cache
import hashlib
from pathlib import Path
from . import __version__


@lru_cache(maxsize=1)
def processor_identity():
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob('*.py')):
        digest.update(path.name.encode('utf-8') + b'\0')
        # Normalize checkout line endings so Windows and Unix identify the same code.
        digest.update(path.read_bytes().replace(b'\r\n', b'\n') + b'\0')
    return {'processor': 'Peak Tracer ' + __version__,
            'processor_source_sha256': digest.hexdigest()}
