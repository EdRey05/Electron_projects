"""Plan all output names before writing. Naming never mutates source files."""
import re
from pathlib import Path


def safe_stem(name):
    if (not name or name in ('.','..') or name.endswith(('.', ' ')) or
        any(c in name for c in '/\\:*?"<>|') or any(ord(c)<32 for c in name)):
        raise ValueError(f'Unsafe output name: {name!r}')
    if name.split('.')[0].upper() in {'CON','PRN','AUX','NUL',*(f'COM{i}' for i in range(1,10)),*(f'LPT{i}' for i in range(1,10))}:
        raise ValueError(f'Reserved Windows output name: {name}')
    return name


def output_stem(src,args):
    name=src.stem
    if args.preprocess:
        names=[]
        for suffix in ('.fa','.fasta','.txt'):
            sidecar=src.with_suffix(suffix)
            if not sidecar.exists():continue
            first=sidecar.read_text(encoding='utf-8-sig').splitlines()
            if not first:continue
            header=first[0].strip()
            # A plain .txt note must not become a sample-name instruction.
            if suffix=='.txt' and not header.startswith('>') and not header.lower().endswith('.ab1'):continue
            if suffix!='.txt' and not header.startswith('>'):raise ValueError(f'Invalid FASTA header: {sidecar.name}')
            candidate=header.lstrip('>').strip()
            if candidate.lower().endswith('.ab1'):candidate=candidate[:-4]
            names.append(safe_stem(candidate))
        if len(set(names))>1:raise ValueError(f'Conflicting companion names for {src.name}')
        if names:name=names[0]
    if args.strip_well_id:name=re.sub(r'_[A-H]\d{2}$','',name,flags=re.I)
    return safe_stem(name+args.filename_suffix)


def plan_batch(in_dir,out_dir,args):
    in_dir=Path(in_dir).resolve();out_dir=Path(out_dir).resolve()
    if in_dir==out_dir:raise ValueError('Input and output folders must differ')
    paths=sorted(p for p in in_dir.iterdir() if p.is_file() and p.suffix.lower()=='.ab1')
    plan=[];seen=set()
    for src in paths:
        stem=output_stem(src,args)
        if stem.casefold() in seen:raise ValueError(f'Output filename collision: {stem}')
        seen.add(stem.casefold())
        for suffix in ('.ab1','.seq'):
            dst=out_dir/(stem+suffix)
            if dst.exists():raise ValueError(f'Output already exists: {dst.name}; choose an empty result folder')
        plan.append((src,stem))
    return plan
