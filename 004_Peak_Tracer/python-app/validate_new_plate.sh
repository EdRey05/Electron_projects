#!/usr/bin/env bash
# validate_new_plate.sh — One-shot validation for a new plate.zip from Ed.
#
# Usage:  validate_new_plate.sh PLATE.zip
#
# Behavior:
#   - Unzips PLATE.zip into <work_dir>
#   - Discovers 2-X (input) and 3-X (gold) folders automatically
#   - Runs peaktrace_core + 4-metric validation
#   - Writes HTML summary report at <work_dir>/out/validation_summary.html
#
# Prerequisites:
#   - peaktrace_core.py and validate_plate.py at the path below
#   - Python venv at the path below

set -euo pipefail

PLATE_ZIP="${1:-}"
if [ -z "$PLATE_ZIP" ]; then
    echo "Usage: $0 PLATE.zip"
    exit 1
fi

if [ ! -f "$PLATE_ZIP" ]; then
    echo "ERROR: File not found: $PLATE_ZIP"
    exit 2
fi

WORK_DIR=$(mktemp -d)
PLATE_NAME=$(basename "$PLATE_ZIP" .zip)
echo "[setup] work dir: $WORK_DIR"
echo "[setup] plate: $PLATE_NAME"

# Extract
echo "[extract] $PLATE_ZIP -> $WORK_DIR"
unzip -q "$PLATE_ZIP" -d "$WORK_DIR/extracted"

# Auto-discover input + gold folders
INPUT_DIR=$(ls -d "$WORK_DIR/extracted"/2-* | head -1)
GOLD_DIR=$(ls -d "$WORK_DIR/extracted"/3-* | head -1)
if [ -z "$INPUT_DIR" ] || [ -z "$GOLD_DIR" ]; then
    echo "ERROR: Could not find 2-* and 3-* folders in extracted/"
    ls "$WORK_DIR/extracted"
    exit 3
fi
echo "[discover] input: $INPUT_DIR"
echo "[discover] gold:  $GOLD_DIR"

# Run validation (auto-runs pipeline)
OUT_DIR="$WORK_DIR/out"
PYTHON="C:/Users/Administrator/AppData/Local/hermes/profiles/gene-synt-hermes/cache/inspect_ab1/.venv/Scripts/python.exe"
PYAPP="C:/Users/Administrator/Desktop/Github_EdRey05/Electron_projects/004_Peak_Tracer/python-app"

"$PYTHON" "$PYAPP/validate_plate.py" \
    --input-dir "$INPUT_DIR" \
    --output-dir "$OUT_DIR" \
    --gold-dir "$GOLD_DIR" \
    --name "$PLATE_NAME"

echo ""
echo "=========================================="
echo "DONE. Open this file for the summary:"
echo "  $OUT_DIR/validation_summary.html"
echo "=========================================="
