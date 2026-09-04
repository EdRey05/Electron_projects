"""Rebuild the v1.6 zip with the fixed app.asar.

Critical: the asar MUST contain a package.json (electron-builder normally synthesizes
this). Without it, Electron fails to load the app and the exe silently does nothing.
We copy dist/ to a staging dir, add a template package.json, pack the asar, then
rebuild the zip.

Writes to Peak_Tracer_v1.6_<timestamp>.zip if the previous new-zip is locked
(common: Windows Defender holds zips for several minutes after creation).
Run from terminal: python make_zip.py
"""
import json, os, shutil, time, zipfile
from pathlib import Path
from datetime import datetime

wu = Path(r"C:\Users\Administrator\Desktop\Github_EdRey05\Electron_projects\004_Peak_Tracer\release\win-unpacked")
src_dist = Path(r"C:\Users\Administrator\Desktop\Github_EdRey05\Electron_projects\004_Peak_Tracer\dist")
template_pkg = Path(r"C:\Users\Administrator\Desktop\Github_EdRey05\Electron_projects\004_Peak_Tracer\scripts\asar-package.json")
asar_out = wu / "resources" / "app.asar"
task_dir = Path(r"C:\Users\Administrator\Desktop\ERA_BioAutomations\Gene_Synthesis_Agent\Tasks\Ongoing\Peak_trace")
cache_dir = Path(r"C:\Users\Administrator\AppData\Local\hermes\profiles\gene-synt-hermes\cache")

# Use timestamped name to dodge any Windows file locks on previous copies
stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
final_zip = task_dir / f"Peak_Tracer_v1.6_{stamp}.zip"
cache_zip = cache_dir / f"Peak_Tracer_v1.6_{stamp}.zip"

print(f"writing to {final_zip.name}")

# Remove the stray top-level dist/ at win-unpacked (Electron only loads from resources/)
top_dist = wu / "dist"
if top_dist.exists():
    shutil.rmtree(top_dist, ignore_errors=True)
    print(f"removed stray top-level dist/")

# ---- Repack app.asar with synthesized package.json ----
asar_stage = Path(r"C:\Users\Administrator\AppData\Local\Temp\asar-pack-stage")
if asar_stage.exists():
    shutil.rmtree(asar_stage, ignore_errors=True)
shutil.copytree(src_dist, asar_stage)
shutil.copy2(template_pkg, asar_stage / "package.json")
print(f"asar stage ready: {asar_stage}")

import subprocess
print("packing asar...")
r = subprocess.run(
    ["npx.cmd", "--yes", "@electron/asar", "pack", str(asar_stage), str(asar_out)],
    capture_output=True, text=True, timeout=120
)
print(f"pack rc: {r.returncode}")
if r.returncode != 0:
    print("STDERR:", r.stderr[:500])
    raise SystemExit(1)
shutil.rmtree(asar_stage, ignore_errors=True)

asar_data = asar_out.read_bytes()
print(f"asar size: {len(asar_data)} bytes")
for needle in ["Preprocessing + PT", "Strips well-ID", "Plate folder", "package.json", '"name"']:
    present = needle.encode("latin-1") in asar_data
    print(f"  asar has '{needle}': {present}")

# ---- Stage win-unpacked and zip ----
stage = Path(r"C:\Users\Administrator\AppData\Local\Temp\peak-tracer-v1.6-stage")
if stage.exists():
    shutil.rmtree(stage, ignore_errors=True)
stage_root = stage / "Peak_Tracer_v1.6"
shutil.copytree(wu, stage_root)

t0 = time.time()
with zipfile.ZipFile(final_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    file_count = 0
    total_bytes = 0
    for root, dirs, files in os.walk(stage_root):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            if f.endswith(".pyc"):
                continue
            full = Path(root) / f
            arc = full.relative_to(stage)
            zf.write(full, arc)
            file_count += 1
            try:
                total_bytes += full.stat().st_size
            except OSError:
                pass
elapsed = time.time() - t0

print(f"\nzip: {file_count} files, {total_bytes/1024/1024:.1f} MB uncompressed, {final_zip.stat().st_size/1024/1024:.1f} MB compressed, took {elapsed:.1f}s")

with zipfile.ZipFile(final_zip) as zf:
    names = zf.namelist()
    asar_present = "Peak_Tracer_v1.6/resources/app.asar" in names
    print(f"\n  app.asar in zip: {asar_present}")
    if asar_present:
        asar = zf.read("Peak_Tracer_v1.6/resources/app.asar")
        for needle in ["Preprocessing + PT", "Strips well-ID", "Plate folder", "Show advanced", '"name"', "package.json"]:
            present = needle.encode("latin-1") in asar
            print(f"    '{needle}' in asar: {present}")
    pyvenv = [n for n in names if "pyvenv.cfg" in n]
    print(f"  pyvenv.cfg in zip: {pyvenv or 'NONE (good)'}")

shutil.copy2(final_zip, cache_zip)

shutil.rmtree(stage, ignore_errors=True)

print(f"\nFinal: {final_zip}")
print(f"Cache: {cache_zip}")