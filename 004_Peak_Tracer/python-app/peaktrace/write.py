"""Serialize the final analyzed signal and its calls as one coherent ABIF result."""
from pathlib import Path
import struct
import numpy as np
from .abif import Entry, read_entries, pack_entries


def write_ab1(out_path, trace, pb, qv, ploc, p1am=None, set_abi_limits=True,
              clamp_max=None, map_params=None, p99_target=650, *,
              channels=None, clear_range=None, trim_probability=None, provenance=None):
    if map_params is not None:
        raise ValueError('Writer does not extrapolate raw coordinates; supply final channels')
    pb=np.asarray(pb,dtype=np.uint8);qv=np.asarray(qv,dtype=np.uint8);ploc=np.asarray(ploc)
    channels=channels if channels is not None else trace.channels
    if not len(pb)==len(qv)==len(ploc):raise ValueError('PBAS/PCON/PLOC lengths differ')
    if set(channels)!={9,10,11,12} or len({len(a) for a in channels.values()})!=1:
        raise ValueError('Four equal-length analyzed channels required')
    n=len(channels[9])
    if (np.any(~np.isfinite(ploc)) or np.any(ploc!=np.rint(ploc)) or
        np.any(ploc<0) or np.any(ploc>=n) or np.any(ploc>32767) or np.any(np.diff(ploc)<=0)):
        raise ValueError('PLOC must be strictly increasing, in bounds and fit signed int16')
    signal=np.array([channels[k] for k in range(9,13)],dtype=float)
    if not np.all(np.isfinite(signal)):raise ValueError('Non-finite analyzed signal')
    # One common gain preserves relative dye intensities. Gain never alters PCON.
    gain=1.
    p99=float(np.percentile(signal,99))
    if p99_target and p99>1:gain=p99_target/p99
    signal=np.clip(np.rint(signal*gain),0,32767).astype('>i2')
    entries={e.key:e for e in read_entries(Path(trace.src_path).read_bytes())}
    def replace(name,num,code,size,count,data):
        entries[(name,num)]=Entry(name,num,code,size,count,data)
    for num in (1,2):
        replace(b'PBAS',num,2,1,len(pb),pb.tobytes())
        replace(b'PCON',num,2,1,len(qv),qv.tobytes())
        replace(b'PLOC',num,4,2,len(ploc),ploc.astype('>i2').tobytes())
    for i in range(4):replace(b'DATA',9+i,4,2,n,signal[i].tobytes())
    # Amplitude corresponds to the called dye in the actual serialized signal.
    identities={ord(b):i for i,b in enumerate(trace.base_order)}
    amplitudes=np.array([signal[identities[b],int(p)] if b in identities else 0
                         for b,p in zip(pb,ploc)],dtype='>i2')
    replace(b'P1AM',1,4,2,len(pb),amplitudes.tobytes())
    if set_abi_limits and clear_range is not None:
        start,end=clear_range
        if not 0<=start<=end<=len(pb):raise ValueError('Invalid clear range')
        # phTR uses zero-based first/last included base, unlike our half-open interval.
        bounds=(start,end-1) if end>start else (-1,-1)
        replace(b'phTR',1,4,2,2,struct.pack('>hh',*bounds))
        replace(b'phTR',2,7,4,1,struct.pack('>f',trim_probability if trim_probability is not None else -1.))
    elif clear_range is not None:
        # Do not leave old clear-range indices attached to changed calls.
        replace(b'phTR',1,4,2,2,struct.pack('>hh',-1,-1))
        replace(b'phTR',2,7,4,1,struct.pack('>f',-1.))
    # SVER2 describes the inherited caller; an added custom tag identifies our processing.
    if provenance is not None:
        import json
        data=json.dumps(provenance,separators=(',',':')).encode('utf-8')
        replace(b'PT18',1,2,1,len(data),data)
    destination=Path(out_path)
    if destination.resolve()==Path(trace.src_path).resolve():raise ValueError('Cannot overwrite source AB1')
    destination.write_bytes(pack_entries(list(entries.values())))
    return gain
