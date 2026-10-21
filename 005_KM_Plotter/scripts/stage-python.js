#!/usr/bin/env node
/**
 * Stage a portable CPython runtime + a venv with the KM Plotter's Python deps.
 *
 * The Electron app's main process spawns `python-app/runtime-venv/Scripts/python.exe`
 * to run `km_core.py`. This script:
 *
 *   1. Locates the bundled CPython at `~/.local/share/uv/python/cpython-3.11.*`.
 *      (uv-managed python-build-standalone — same artifact python-build-standalone
 *      publishes, no symlinks, no external state.)
 *   2. Copies it into `python-app/runtime/` if not already there.
 *   3. Creates `python-app/runtime-venv/` and installs `python-app/requirements.txt`.
 *
 * The runtime + venv are gitignored. Run this once before the first
 * `npm run package:portable` on a build host.
 *
 * Usage:
 *   node scripts/stage-python.js            # full stage
 *   node scripts/stage-python.js --no-copy  # skip copy if runtime/ already populated
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT, "python-app", "runtime");
const VENV_DIR = path.join(ROOT, "python-app", "runtime-venv");
const REQUIREMENTS = path.join(ROOT, "python-app", "requirements.txt");
const SKIP_COPY = process.argv.includes("--no-copy");

function findPortablePython() {
  // Standard uv layout: %APPDATA%\uv\python\cpython-<ver>-windows-x86_64-none
  const envOverride = process.env.PYTHON_BUNDLE;
  if (envOverride && fs.existsSync(path.join(envOverride, "python.exe"))) {
    return envOverride;
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, "AppData", "Roaming", "uv", "python"),
    path.join(home, "AppData", "Local", "uv", "python"),
    path.join(process.env.LOCALAPPDATA || "", "uv", "python"),
    path.join(process.env.APPDATA || "", "uv", "python"),
  ];

  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    const entries = fs.readdirSync(base).filter((e) => e.startsWith("cpython-"));
    // Prefer the highest-versioned CPython.
    entries.sort().reverse();
    for (const entry of entries) {
      const exe = path.join(base, entry, "python.exe");
      if (fs.existsSync(exe)) return path.join(base, entry);
    }
  }
  return null;
}

function copyDir(src, dst) {
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  // Use robocopy on Windows for a fast recursive copy; fall back to manual walk.
  if (process.platform === "win32") {
    const r = spawnSync(
      "robocopy",
      [src, dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS"],
      { stdio: "inherit" }
    );
    // Robocopy exit codes: 0–7 = success, 8+ = failure.
    if (r.status === null || r.status >= 8) {
      throw new Error(`robocopy failed (status=${r.status})`);
    }
  } else {
    fs.cpSync(src, dst, { recursive: true });
  }
}

function main() {
  if (!SKIP_COPY) {
    console.log("→ Locating portable CPython...");
    const src = findPortablePython();
    if (!src) {
      console.error(
        "❌ No portable CPython found. Install one with:\n" +
          "   uv python install 3.11\n" +
          "   ... or download from https://github.com/astral-sh/python-build-standalone/releases\n" +
          "   ... then re-run this script."
      );
      process.exit(1);
    }
    console.log(`   source: ${src}`);
    console.log(`   target: ${RUNTIME_DIR}`);
    copyDir(src, RUNTIME_DIR);
    console.log("✓ Runtime copied.");
  } else {
    console.log("(skip-copy) Assuming runtime/ is already populated.");
  }

  const pyExe = path.join(RUNTIME_DIR, "python.exe");
  if (!fs.existsSync(pyExe)) {
    console.error(`❌ Runtime python.exe not found at ${pyExe}`);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(VENV_DIR, "Scripts", "python.exe"))) {
    console.log("→ Creating runtime-venv...");
    execFileSync(pyExe, ["-m", "venv", VENV_DIR], { stdio: "inherit" });
    console.log("✓ venv created.");
  } else {
    console.log("(venv already exists)");
  }

  const venvPy = path.join(VENV_DIR, "Scripts", "python.exe");
  console.log("→ Installing requirements (this can take a minute)...");
  execFileSync(venvPy, ["-m", "pip", "install", "--upgrade", "pip", "wheel"], { stdio: "inherit" });
  execFileSync(venvPy, ["-m", "pip", "install", "-r", REQUIREMENTS], { stdio: "inherit" });

  console.log("\n✅ Done.");
  console.log(`   Runtime:     ${RUNTIME_DIR}`);
  console.log(`   Venv python: ${venvPy}`);
  console.log("\nYou can now run:");
  console.log("   npm run dev                 # development");
  console.log("   npm run package:portable    # build + package");
}

main();
