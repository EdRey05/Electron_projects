"""Resolve archived task paths after documentation consolidation.

Keep provenance/manifests immutable. Only evaluation-time file lookup changes.
"""
from pathlib import Path


def archived_path(value):
    original=Path(value)
    markers=[original.parts.index(m) for m in ('analysis_v1.7','v1.8_validation','v1.9_validation') if m in original.parts]
    if not markers:return original
    index=min(markers)
    return relocated(Path(*original.parts[:index]),original)


def relocated(task, value):
    task=Path(task);original=Path(value)
    try:relative=original.relative_to(task).as_posix()
    except ValueError:return original
    for old,new in (('v1.8_validation/sample4/2-P1905969_2026-08-28/','shared_resources/samples/sample4/2-P1905969_2026-08-28/'),
                    ('v1.8_validation/sample4/3-P1905969_2026-08-28/','shared_resources/samples/sample4/3-P1905969_2026-08-28/'),
                    ('v1.8_validation/','docs/v1.8/evidence/'),
                    ('v1.9_validation/','docs/v1.9/evidence/'),
                    ('analysis_v1.7/samples/','shared_resources/samples/'),
                    ('analysis_v1.7/packaged_v1.6/','shared_resources/packaged_v1.6/'),
                    ('analysis_v1.7/','docs/v1.7/evidence/')):
        if relative.startswith(old) or relative==old.rstrip('/'):
            candidate=task/(new+relative[len(old):] if relative.startswith(old) else new.rstrip('/'))
            return candidate if candidate.exists() else original
    return original
