"""Opt-in TraceTuner quality reassessment of the final serialized trace.

Use -recalln, not -nocall (which reuses PCON in upstream 3.0.6beta).
Require unchanged A/C/G/T identities and call count. Keep original peak labels;
TraceTuner's fitted positions describe its internal assignment only. Restore
ambiguous input calls with Q0 instead of accepting inferred replacements.
"""
import hashlib
from pathlib import Path
import subprocess
import tempfile
import numpy as np
from .write import write_ab1


def parse_phd(text):
    lines=[line.strip() for line in text.splitlines()]
    if lines.count('BEGIN_DNA')!=1 or lines.count('END_DNA')!=1:
        raise ValueError('TraceTuner must return exactly one PHD DNA block')
    start=lines.index('BEGIN_DNA');end=lines.index('END_DNA')
    if end<=start+1:raise ValueError('Empty or malformed TraceTuner DNA block')
    rows=[line.split() for line in lines[start+1:end] if line]
    if any(len(row)!=3 or len(row[0])!=1 or row[0].upper() not in 'ACGTN' for row in rows):
        raise ValueError('Invalid TraceTuner PHD row')
    try:q=np.array([int(r[1]) for r in rows],dtype=np.int64);pos=np.array([int(r[2]) for r in rows],dtype=np.int64)
    except (ValueError,OverflowError) as e:raise ValueError('Invalid TraceTuner numeric field') from e
    if np.any(q<0) or np.any(q>93):raise ValueError('TraceTuner quality outside [0,93]')
    return np.frombuffer(''.join(r[0].upper() for r in rows).encode(),dtype=np.uint8).copy(),q.astype(np.uint8),pos


def reassess(trace,channels,bases,positions,qualities,args):
    engine=Path(args.tracetuner_executable).resolve()
    if not engine.is_file():raise ValueError('TraceTuner executable does not exist')
    chemistry=trace.tags.get('PDMF1',b'')
    if isinstance(chemistry,bytes):chemistry=chemistry.decode('ascii',errors='replace')
    if '3730' not in chemistry.upper() or 'POP7' not in chemistry.upper() or 'BDTV3' not in chemistry.upper():
        raise ValueError('Experimental quality mode requires verified 3730 POP7 BDTv3 metadata')
    digest=hashlib.sha256(engine.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix='peaktrace-qv-') as directory:
        temp=Path(directory);staged=temp/'trace.ab1'
        # Score exactly the rounded integer channels the final AB1 writer emits.
        write_ab1(staged,trace,bases,qualities,positions,channels=channels,
                  p99_target=args.p99_target,set_abi_limits=False)
        staged_hash=hashlib.sha256(staged.read_bytes()).hexdigest()
        command=[str(engine),'-3730','-recalln','-p','trace.ab1']
        try:
            run=subprocess.run(command,cwd=temp,capture_output=True,timeout=args.tracetuner_timeout,
                               creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        except subprocess.TimeoutExpired as e:raise ValueError('TraceTuner scoring timed out') from e
        except OSError as e:raise ValueError(f'TraceTuner launch failed: {e}') from e
        if run.returncode:raise ValueError(f'TraceTuner failed ({run.returncode}): '+run.stderr.decode(errors='replace')[-1500:])
        outputs=list(temp.glob('*.phd.1'))
        if len(outputs)!=1:raise ValueError('TraceTuner did not produce one PHD result')
        phd_bytes=outputs[0].read_bytes();called,qv,fitted=parse_phd(phd_bytes.decode('ascii'))
        if len(called)!=len(bases):raise ValueError('TraceTuner changed call count in quality-only mode')
        pure=np.isin(bases,list(b'ACGT'))
        if np.any(called[pure]!=bases[pure]):raise ValueError('TraceTuner changed an existing A/C/G/T call')
        if np.any(fitted<0) or np.any(fitted>=len(channels[9])) or np.any(np.diff(fitted)<0):
            raise ValueError('Invalid TraceTuner fitted positions')
        qv[~pure]=0
        diagnostics=dict(engine='TraceTuner',engine_sha256=digest,engine_path=str(engine),
            engine_options=command[1:],lookup_table='ABI 3730 POP7 BDTv3 built-in',
            staged_ab1_sha256=staged_hash,phd_sha256=hashlib.sha256(phd_bytes).hexdigest(),
            calibration='Published engine table; not independently calibrated for our enhanced traces',
            call_policy='Original bases and label positions retained; ambiguous bases assigned Q0',
            engine_fitted_positions=fitted.tolist(),
            fitted_position_duplicates=int((np.diff(fitted)==0).sum()),
            fitted_position_mean_absolute_shift=float(np.abs(fitted-positions).mean()),
            qualities_increased=int((qv>qualities).sum()),qualities_decreased=int((qv<qualities).sum()),
            ambiguous_bases_zeroed=int((~pure).sum()),stderr=run.stderr.decode(errors='replace')[-2000:])
        return qv,diagnostics
