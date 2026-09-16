"""Resolve archived task paths after the v1.7 documentation consolidation.

Keep provenance/manifests immutable. Only evaluation-time file lookup changes.
"""
from pathlib import Path


def archived_path(value):
    original=Path(value)
    if 'analysis_v1.7' not in original.parts:return original
    index=original.parts.index('analysis_v1.7')
    return relocated(Path(*original.parts[:index]),original)


def relocated(task, value):
    task=Path(task);original=Path(value)
    try:relative=original.relative_to(task).as_posix()
    except ValueError:return original
    for old,new in (('analysis_v1.7/samples/','shared_resources/samples/'),
                    ('analysis_v1.7/packaged_v1.6/','shared_resources/packaged_v1.6/'),
                    ('analysis_v1.7/','docs/v1.7/evidence/')):
        if relative.startswith(old):
            candidate=task/(new+relative[len(old):])
            return candidate if candidate.exists() else original
    return original
