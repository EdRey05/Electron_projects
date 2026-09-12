"""Validated command-line configuration for the v1.8 analysis pipeline."""
import argparse
import math
from pathlib import Path


def parse_args(argv=None):
    p = argparse.ArgumentParser(prog='peaktrace_core', description='Peak Tracer: measured trace resolution and conservative basecalling')
    p.add_argument('--input-dir', required=True, type=Path)
    p.add_argument('--output-dir', required=True, type=Path)
    def boolean(name, default, help, negative=None):
        dest = name.replace('-', '_')
        group = p.add_mutually_exclusive_group()
        group.add_argument('--'+name, dest=dest, action='store_true', help=help)
        group.add_argument(negative or '--no-'+name, dest=dest, action='store_false')
        p.set_defaults(**{dest: default})
    boolean('preprocess', True, 'Use paired naming headers; never edit input')
    boolean('strip-well-id', True, 'Remove final well suffix from output names')
    boolean('emit-seq', True, 'Export the selected sequence range')
    boolean('write-qc-report', False, 'Also write the optional Excel summary')
    boolean('set-abi-limits', True, 'Write the computed clear range to phTR')
    boolean('lead-drop-enabled', False, 'Optional legacy first-low-Q-base removal', '--no-lead-drop')
    boolean('baseline-smooth', True, 'Subtract a slow baseline before resolution')
    boolean('do-smooth', True, 'Apply a light noise filter before resolution')
    boolean('resolve-peaks', True, 'Resolve measured peaks using regularized deconvolution')
    boolean('recall-low-quality', False, 'Experimentally revise strongly contradicted low-Q calls')
    boolean('write-sidecar-trace', False, 'Write analytical channels to a diagnostic sidecar')
    # Accept old negative switches for automation migration, but reject the unsafe paths.
    for name in ('rebasecall-data14', 'sharpen-peaks', 'enhanced-qv', 'refine-ploc'):
        boolean(name, False, 'Retired v1.7 option (enabling is rejected)')
    p.add_argument('--filename-suffix', default='')
    p.add_argument('--skip-shorter-than', type=int, default=0)
    p.add_argument('--lead-drop-qv', type=int, default=5)
    p.add_argument('--qv-to-n-threshold', type=int, default=2)
    p.add_argument('--smooth-window', type=int, default=7)
    p.add_argument('--resolution-strength', type=float, default=0.75)
    p.add_argument('--resolution-iterations', type=int, default=24)
    p.add_argument('--trim-quality', type=float, default=9)
    p.add_argument('--trim-window', type=int, default=40)
    p.add_argument('--seq-format', choices=('plain','abi'), default='plain')
    p.add_argument('--seq-range', choices=('clear','full'), default='clear')
    p.add_argument('--p99-target', type=int, default=650, help='Display gain only; zero preserves gain')
    # Old numeric arguments remain parseable for callers using --no-rebasecall-data14.
    p.add_argument('--min-rebasecall-len', type=int, default=1000, help=argparse.SUPPRESS)
    p.add_argument('--extend-min-snr', type=float, default=1.3, help=argparse.SUPPRESS)
    p.add_argument('--extend-stop-quiet', type=int, default=40, help=argparse.SUPPRESS)
    p.add_argument('--sharpen-factor', type=float, default=2.0, help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    for key in ('rebasecall_data14','sharpen_peaks','enhanced_qv','refine_ploc'):
        if getattr(args,key):
            p.error('--'+key.replace('_','-')+' is retired: use the v1.8 resolution pipeline')
    for key in ('skip_shorter_than','lead_drop_qv','qv_to_n_threshold','p99_target'):
        if getattr(args,key)<0:p.error(key+' must be nonnegative')
    if not 0 <= args.resolution_strength <= 0.95:p.error('resolution-strength must be in [0, 0.95]')
    if not 1 <= args.resolution_iterations <= 80:p.error('resolution-iterations must be in [1, 80]')
    if args.smooth_window<3 or args.smooth_window%2==0:p.error('smooth-window must be odd and at least 3')
    if args.trim_window<1 or not math.isfinite(args.trim_quality) or not 0<=args.trim_quality<=93:p.error('invalid trimming parameters')
    if args.qv_to_n_threshold>93 or args.lead_drop_qv>93:p.error('QV threshold must be at most 93')
    if any(c in args.filename_suffix for c in '/\\:*?"<>|') or args.filename_suffix.endswith(('.', ' ')):
        p.error('filename-suffix must be a safe filename component')
    return args
