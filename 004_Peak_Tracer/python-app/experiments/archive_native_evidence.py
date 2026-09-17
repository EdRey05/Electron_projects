"""Mirror native evidence records beside the task wiki without replacing history."""
import argparse
from pathlib import Path
import shutil


def main():
    p=argparse.ArgumentParser();p.add_argument('--task',type=Path,required=True);args=p.parse_args()
    project=Path(__file__).resolve().parents[2];source=project/'build/native-evidence'
    destination=args.task/'v2.0_validation/native_evidence/results';destination.mkdir(parents=True,exist_ok=True)
    for name in ('summary.json','examples.json','synthetic.json','synthetic-refined.json','synthetic-holdout.json',
                 'synthetic-challenge.png','real-pair-examples.png','real-pair-screen.png','tests.log','audit.log',
                 'sample4-refined.log','sample5-refined.log','sample4.log','sample5.log'):
        shutil.copy2(source/name,destination/name)
    report=(project/'docs/v2.0/CURRENT_STATE.md').read_text(encoding='utf-8')
    report=report.replace('(native-evidence/','(v2.0_validation/native_evidence/results/')
    report=report.replace('(neighbor-interference/','(v2.0_validation/neighbor_interference/')
    (args.task/'Peak_Tracer_v2.0_Current_State.md').write_text(report,encoding='utf-8')
    print(destination)


if __name__=='__main__':main()
