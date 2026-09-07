# Peak Tracer

In-house replacement for Nucleics Auto PeakTrace RP. Processes Sanger `.ab1` chromatograms (baseline subtract → Savitzky-Golay / wavelet smoothing → re-basecall → `.ab1` output) using an open-source Python pipeline (Biopython + NumPy + SciPy), wrapped in a React + Vite + Electron desktop UI.

## Features

- **Batch `.ab1` Processing:** Select an input folder containing raw Sanger chromatogram files and process all files in batch.
- **Multiple Processing Modes:**
  - **Raw Proportional (RP):** Performs baseline cleaning, trace smoothing, and amplitude rescaling while preserving proportional peak heights.
  - **Full PeakTrace:** Applies peak resolution and sharpening algorithms to enhance trace clarity.
  - **Pass-through:** Converts and standardizes files without modifying trace data.
- **Advanced Processing Controls:** Configurable baseline cleaning window, Savitzky-Golay smoothing order/level, quality score trimming thresholds, 3'-end trimming, mixed-peak thresholds, and well ID stripping.
- **Live Execution Streaming:** IPC-based live progress streaming per file with detailed QC stats and status reports.
- **Optional Output Files:** Can emit corresponding FASTA `.seq` text files alongside updated `.ab1` chromatograms.
- **Multi-core Parallel Processing:** Configurable worker threads for fast batch execution on modern desktop systems.

## Prerequisites

- **Node.js:** v18 or higher with `npm`.
- **Python:** v3.11+ (required for local development).

## Installation & Setup

1. **Navigate to the application folder:**

   ```bash
   cd 004_Peak_Tracer
   ```

2. **Install Node.js dependencies:**

   ```bash
   npm install
   ```

3. **Set up the Python environment:**

   Create a Python virtual environment under `python-app/runtime` and install dependencies:

   ```bash
   # Using uv (recommended):
   uv venv python-app/runtime --python 3.11
   uv pip install --python python-app/runtime/Scripts/python.exe -r python-app/requirements.txt

   # Or standard venv / pip on Windows:
   python -m venv python-app/runtime
   python-app\runtime\Scripts\pip.exe install -r python-app\requirements.txt
   ```

## Running the Application

- **Development Mode (Vite + Electron with DevTools):**

  ```bash
  npm run dev
  ```

- **Standard Electron Launch:**

  ```bash
  npm start
  ```

## Building & Packaging

- **Build Frontend Assets:**

  ```bash
  npm run build
  ```

- **Package Desktop Application:**

  - **Default package (electron-builder):**
    ```bash
    npm run package
    ```
  - **Windows installer & unpacked folder:**
    ```bash
    npm run package:win
    ```
  - **Windows Portable single executable:**
    ```bash
    npm run package:portable
    ```

Built artifacts land in the `release/` directory. Standalone packages include the bundled Python environment under `resources/python-app/`, eliminating external Python dependencies on user machines.

## Conventions

Follows the repository conventions:
- Folder structure: `004_Peak_Tracer/`
- Clean source commits only (build artifacts ignored via `.gitignore`)
