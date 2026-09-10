"""Preserve v2.0 research evidence outside ignored build products."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--task',type=Path,required=True)
    a=parser.parse_args();repo=Path(__file__).resolve().parents[2];build=repo/'build/v20'
    docs=repo/'docs/v2.0';root=a.task/'v2.0_validation';root.mkdir(parents=True,exist_ok=True)
    def copy(src,dst):
        dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
    for plate in ('sample4','sample5'):
        for path in (build/plate).rglob('*'):
            if path.is_file() and (path.suffix in ('.txt','.json','.png') or path.name.endswith('.phd.1')):
                copy(path,root/'experiments'/plate/path.relative_to(build/plate))
        for path in (build/plate/'audit').iterdir():
            copy(path,root/plate/'comparison'/path.name)
        copy(build/plate/'audit/audit.json',docs/f'{plate}_audit.json')
        copy(build/plate/'summary.json',docs/f'{plate}_engine_comparison.json')
        copy(build/plate/'audit/quality_regions.png',docs/'figures'/f'{plate}_quality_regions.png')
        results=json.loads((root/'experiments'/plate/'results.json').read_text())
        for row in results['reads']:
            for run in row['runs'].values():
                if 'phd' in run:
                    old=repo/Path(run['phd']);run['phd']=str(root/'experiments'/plate/old.relative_to(build/plate))
        (root/'experiments'/plate/'results.json').write_text(json.dumps(results,indent=2))
    for name in ('pos1_quality.png','u0827_quality.png'):
        copy(build/'sample4/audit'/name,docs/'figures'/name)
    for path in (build/'pilot').rglob('*'):
        if path.is_file() and (path.suffix in ('.txt','.json') or path.name.endswith('.phd.1')):
            copy(path,root/'experiments/pilot'/path.relative_to(build/'pilot'))
    pilot=json.loads((root/'experiments/pilot/results.json').read_text())
    for row in pilot['reads']:
        for run in row['runs'].values():
            if 'phd' in run:
                old=repo/Path(run['phd']);run['phd']=str(root/'experiments/pilot'/old.relative_to(build/'pilot'))
    (root/'experiments/pilot/results.json').write_text(json.dumps(pilot,indent=2))
    for name in ('probes/probes.json','preservation.json','tests.log','compile.log','cli-sample4.log','cli-sample5.log'):
        copy(build/name,root/'experiments'/name)
    copy(build/'probes/probes.json',docs/'engine_probes.json')
    copy(build/'preservation.json',docs/'preservation.json')
    for src,name in [(build/'ttuner.exe','ttuner.exe'),(build/'tracetuner-source.tar.xz','tracetuner-source.tar.xz'),
                     (build/'LICENSE.TraceTuner.txt','LICENSE.txt'),(build/'tracetuner_3.0.6beta/README.txt','UPSTREAM_README.txt'),
                     (build/'debian/copyright','DEBIAN_COPYRIGHT.txt'),(repo/'python-app/scripts/build_tracetuner.ps1','build_tracetuner.ps1')]:
        copy(src,root/'engine'/name)
    identity=dict(distribution='TraceTuner 3.0.6~beta+dfsg',internal_banner='TT_3.0.4beta',
        source_url='https://deb.debian.org/debian/pool/main/t/tracetuner/tracetuner_3.0.6~beta+dfsg.orig.tar.xz',
        source_sha256=hashlib.sha256((build/'tracetuner-source.tar.xz').read_bytes()).hexdigest(),
        engine_sha256=hashlib.sha256((build/'ttuner.exe').read_bytes()).hexdigest(),
        compiler='Zig 0.14.1 (Python-distributed portable wheel)',
        compiler_archive_sha256=hashlib.sha256((build/'ziglang-0.14.1-py3-none-win_amd64.whl').read_bytes()).hexdigest(),
        flags=['cc','-target','x86_64-windows-gnu','-std=gnu99','-O2','-D__WIN32','-DOS_NAME="Windows"',
               '-Wno-implicit-function-declaration','-Wno-int-conversion'],
        source_modifications='None; Debian patch archive inspected but not applied',
        license='GPL-2.0-or-later per source headers and Debian copyright')
    for target in (docs/'engine_build.json',root/'engine/build.json'):
        target.write_text(json.dumps(identity,indent=2))
    copy(docs/'PLAN.md',a.task/'Peak_Tracer_v2.0_Plan.md')
    report=(docs/'RESULTS.md').read_text()
    # The task-root report's figures must resolve beside the wiki, too.
    for name in ('pos1_quality.png','u0827_quality.png'):
        report=report.replace(f'(figures/{name})',f'(v2.0_validation/sample4/comparison/{name})')
    for plate in ('sample4','sample5'):
        report=report.replace(f'(figures/{plate}_quality_regions.png)',f'(v2.0_validation/{plate}/comparison/quality_regions.png)')
    (a.task/'Peak_Tracer_v2.0_Results.md').write_text(report)
    print('Archived engine, source, PHD/log evidence, audits and report mirrors:',root)


if __name__=='__main__':main()
