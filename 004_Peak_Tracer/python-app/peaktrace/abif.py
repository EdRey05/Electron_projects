"""Small ABIF container codec. Unknown valid tags and raw data remain opaque."""
from dataclasses import dataclass
import struct

DIRECTORY = struct.Struct('>4sIHHIIII')


@dataclass(frozen=True)
class Entry:
    name: bytes
    number: int
    code: int
    size: int
    count: int
    data: bytes

    @property
    def key(self):return self.name,self.number


def read_entries(buf):
    if len(buf)<34 or buf[:4]!=b'ABIF':raise ValueError('Not an ABIF container')
    root=DIRECTORY.unpack_from(buf,6)
    count,offset=root[4],root[6]
    if root[3]!=28 or offset<34 or count>100000 or offset+28*count>len(buf):
        raise ValueError('Invalid ABIF directory span')
    entries=[];seen=set()
    for i in range(count):
        pos=offset+28*i
        name,num,code,size,n,byte_count,address,_=DIRECTORY.unpack_from(buf,pos)
        if (name,num) in seen:raise ValueError('Duplicate ABIF tag')
        seen.add((name,num))
        if byte_count<=4:data=buf[pos+20:pos+20+byte_count]
        else:
            if address<34 or address+byte_count>len(buf):raise ValueError(f'Invalid data span: {name!r}{num}')
            data=buf[address:address+byte_count]
        entries.append(Entry(name,num,code,size,n,data))
    return entries


def pack_entries(entries):
    if len({e.key for e in entries})!=len(entries):raise ValueError('Duplicate ABIF tag')
    buf=bytearray(34);directory=[]
    for e in entries:
        if len(e.name)!=4:raise ValueError('ABIF tag must contain four bytes')
        if len(e.data)<=4:address=int.from_bytes(e.data.ljust(4,b'\0'),'big')
        else:
            address=len(buf);buf.extend(e.data)
        directory.append(DIRECTORY.pack(e.name,e.number,e.code,e.size,e.count,len(e.data),address,0))
    offset=len(buf)
    for entry in directory:buf.extend(entry)
    buf[:6]=b'ABIF'+struct.pack('>H',101)
    buf[6:34]=DIRECTORY.pack(b'tdir',1,1023,28,len(entries),28*len(entries),offset,0)
    return bytes(buf)
