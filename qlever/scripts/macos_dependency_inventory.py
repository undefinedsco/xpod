"""Bounded path inventory from actual Ninja deps raw; no header bytes inferred."""
import hashlib
import os
from pathlib import Path

MAX_RAW=128*1024**2

def summarize(raw,roots):
    roots=sorted([(name,os.path.normpath(root)) for name,root in roots],key=lambda row:len(row[1]),reverse=True)
    unique={};count=0;digest=hashlib.sha256();path_bytes=0
    with Path(raw).open('rb') as stream:
        while True:
            line=stream.readline(65537)
            if not line:break
            count+=len(line)
            if len(line)>65536 or count>MAX_RAW:raise ValueError('Ninja dependency raw budget exceeded')
            digest.update(line)
            if not line.startswith(b'    '):continue
            value=line.strip().decode('utf8')
            if not value.startswith('/'):continue
            normalized=os.path.normpath(value)
            if '\x00' in normalized:raise ValueError('Invalid dependency path')
            if normalized in unique:continue
            path_bytes+=len(normalized.encode('utf8'))
            if len(unique)>=100000 or path_bytes>16*1024**2:raise ValueError('Ninja unique dependency budget exceeded')
            kind=next((name for name,root in roots if normalized==root or normalized.startswith(root+'/')),'unclassified')
            unique[normalized]=kind
    counts={}
    for kind in unique.values():counts[kind]=counts.get(kind,0)+1
    return dict(schemaVersion=1,status='dependency-path-observation',raw=dict(sizeBytes=count,sha256=digest.hexdigest()),
                totalUniquePaths=len(unique),counts=counts,paths=[dict(path=name,kind=unique[name]) for name in sorted(unique)],
                scope='Actual Ninja dependency paths only; file contents, source-kit coverage and SDK redistribution are not inferred')

if __name__=='__main__':
    import argparse,json
    parser=argparse.ArgumentParser();parser.add_argument('--raw',required=True);parser.add_argument('--roots',required=True);parser.add_argument('--out',required=True)
    args=parser.parse_args();result=summarize(args.raw,json.loads(args.roots))
    Path(args.out).write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    print(json.dumps(dict(schemaVersion=1,totalUniquePaths=result['totalUniquePaths'],counts=result['counts'],raw=result['raw']),sort_keys=True))
