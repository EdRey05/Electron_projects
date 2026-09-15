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
    report=(project/'docs/v2.0/NATIVE_EVIDENCE_RESULTS.md').read_text(encoding='utf-8')
    report=report.replace('(NEXT_STEPS.md)','(Peak_Tracer_v2.0_Next_Steps.md)').replace('(native-evidence/','(v2.0_validation/native_evidence/results/')
    (args.task/'Peak_Tracer_v2.0_Native_Evidence_Results.md').write_text(report,encoding='utf-8')
    plan=(project/'docs/v2.0/NEXT_STEPS.md').read_text(encoding='utf-8').replace('(NATIVE_EVIDENCE_RESULTS.md)','(Peak_Tracer_v2.0_Native_Evidence_Results.md)')
    (args.task/'Peak_Tracer_v2.0_Next_Steps.md').write_text(plan,encoding='utf-8')
    print(destination)


if __name__=='__main__':main()
