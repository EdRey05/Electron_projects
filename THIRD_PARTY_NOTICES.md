# Third-party components and existing notices

The root MIT license applies to project contributions that can be licensed under it. It does not replace existing copyright/license notices in source, templates, datasets, or bundled dependencies, or grant rights over external company data and services.

Portable builds contain third-party software, including Electron/Chromium, npm dependencies, and, for Python-backed apps, CPython and Python packages. Hub includes RapidOCR and onnxruntime, whose OCR models ship inside the rapidocr wheel. Those components retain their own licenses and notices. Preserve them when redistributing applications, and review the exact locked dependency set for the release you distribute. This file is not an exhaustive dependency-license audit.

Microsoft Word is neither supplied nor licensed by this repository. It is an optional external requirement of Hub's legacy .doc conversion workflow.

Demo recordings and fixtures added to the catalog use generated synthetic data. They do not include patient records, company workbooks, or real instrument runs. FFmpeg is a recording tool used inside the disposable demo guest, not an application dependency shipped in this repository.


GSH's ONNX runtime package also includes app-local Microsoft Visual C++ runtime files (MSVCP140.dll and MSVCP140_1.dll), version14.44.35211.0, extracted from Microsoft's checksum-pinned signed redistributable. Microsoft retains its copyright and license terms; included RTF notices are preserved under the bundled Python runtime's licenses/microsoft-vc directory. The source/version and hashes are recorded in build-tools/msvc-runtime.json and exported build evidence. No system-wide installer is run by the app.
