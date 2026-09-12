"""ABIF input: preserve tag-number channels and make base identities explicit."""
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np
from Bio import SeqIO

CHANNELS = (9, 10, 11, 12)


@dataclass
class Trace:
    src_path: Path
    channels: dict = field(default_factory=dict)
    pb_in: np.ndarray = field(default_factory=lambda: np.array([],dtype=np.uint8))
    qv_in: np.ndarray = field(default_factory=lambda: np.array([],dtype=np.uint8))
    ploc_in: np.ndarray = field(default_factory=lambda: np.array([],dtype=np.int32))
    tags: dict = field(default_factory=dict)
    call_set: int = 2

    @property
    def n_scans(self):return len(next(iter(self.channels.values()))) if self.channels else 0
    @property
    def n_bases(self):return len(self.pb_in)
    @property
    def base_order(self):
        order=self.tags.get('FWO_1',b'').decode('ascii')
        if len(order)!=4 or set(order)!=set('ACGT'):raise ValueError('Missing or invalid FWO_1 base order')
        return order
    @property
    def channel_of_base(self):return {base:9+i for i,base in enumerate(self.base_order)}
    @property
    def base_channels(self):return {base:self.channels[ch] for base,ch in self.channel_of_base.items()}


def _asarr(value):
    if value is None:return np.array([],dtype=np.uint8)
    if isinstance(value,(bytes,bytearray)):return np.frombuffer(value,dtype=np.uint8).copy()
    return np.atleast_1d(value)


def read_ab1(path: Path, use_edited=False):
    tags=SeqIO.read(path,'abi').annotations['abif_raw']
    selected=1 if use_edited else 2
    if not all(f'{tag}{selected}' in tags for tag in ('PBAS','PCON','PLOC')):
        selected=3-selected
    trace=Trace(src_path=Path(path),tags=dict(tags),call_set=selected)
    trace.channels={ch:_asarr(tags.get(f'DATA{ch}')).astype(np.float64) for ch in CHANNELS}
    trace.pb_in=_asarr(tags.get(f'PBAS{selected}')).astype(np.uint8)
    trace.qv_in=_asarr(tags.get(f'PCON{selected}')).astype(np.uint8)
    trace.ploc_in=_asarr(tags.get(f'PLOC{selected}')).astype(np.int32)
    trace.base_order
    if len({len(v) for v in trace.channels.values()})!=1 or trace.n_scans==0:
        raise ValueError('Analyzed channels must have equal nonzero lengths')
    if not (len(trace.pb_in)==len(trace.qv_in)==len(trace.ploc_in)):
        raise ValueError('PBAS/PCON/PLOC lengths differ')
    if np.any(trace.ploc_in<0) or np.any(trace.ploc_in>=trace.n_scans):
        raise ValueError('Input PLOC outside analyzed signal')
    if np.any(np.diff(trace.ploc_in)<0):raise ValueError('Input PLOC is not ordered')
    return trace


def write_seq(path, pb, ploc=None, qv=None, *, format='plain', clear_range=None):
    """Plain or two-filename-line ABI export; optional half-open clear range."""
    sequence=bytes(pb).decode('ascii')
    if clear_range is not None:sequence=sequence[slice(*clear_range)]
    if format=='abi':sequence=(path.stem+'      \r\n')*2+sequence
    elif format!='plain':raise ValueError('Unknown sequence export format')
    path.write_bytes(sequence.encode('ascii'))
