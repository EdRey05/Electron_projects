"""
BBI hub launcher for the Electron build.

Why this file exists
--------------------
The original BBI hub (`gene_synthesis_hub.py`) launches `tkinter_import`
subapps IN-PROCESS: it importlib-loads the subapp module, instantiates the
class with the resolved kwargs (`AppClass(master=toplevel, **kwargs)`), and
keeps it as a child window of the hub.

The Electron shell cannot do that — the renderer is a separate process and
the Python side is a child process. The Electron main process used to spawn
`python <entry>.py --kwarg=<path>` and relied on each subapp parsing its
own `--kwarg=` arguments. That contract does NOT hold across the suite:

  * Only `sequencing_reference_files_app.py` parses `--<kwarg>=` args.
  * `QC_file_prep`, `Label_generator`, `QC_digestion_design`,
    `Ligation_layout`, `ColonyPCR_layout`, `Primer_finder`,
    `Sequencing_order_form`, `Sequencing_file_organizer` and
    `BATCH_QC_report` take their paths through the CONSTRUCTOR only.
  * `Integra_worklist` (streamlit) takes no path kwargs at all.

So the Electron shell silently launched those apps with unconfigured paths —
the app opened, but every directory was empty until the operator re-picked
it by hand. This launcher closes that gap.

What it does
------------
1. Reads `app_information.txt` and `default_directories.ini` from the
   bundled `python-app/` tree.
2. Resolves the `pass_dir_as_kwarg` / `pass_template_as_kwarg` /
   `pass_db_as_kwarg` entries to real absolute paths (same glob-newest
   semantics as the Python hub).
3. Launches the requested subapp the way the BBI hub does:
   - `tkinter_import` -> importlib-load the module, build a CTkToplevel,
     inject the resolved kwargs into the constructor, run it in a child
     window of this launcher window.
   - `streamlit` -> `streamlit run <entry>` with the resolved kwargs
     appended to the command line.
4. Owns the process-wide CTk appearance (Light + app_theme_midnight.json)
   exactly like the BBI hub, so the subapps look identical to how they look
   under the BBI hub.

Usage
-----
    python hub_launcher.py --app="QC File Prep"
    python hub_launcher.py --app="Integra Worklist"

Electron calls this with `--app=<section name>`; the section name is the
human-readable app name from `app_information.txt`.
"""

import argparse
import configparser
import glob
import importlib.util
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# CustomTkinter is optional here: the streamlit path does not need it, and
# a missing CTk should not stop a streamlit app from launching.
try:
    import customtkinter as ctk
except ImportError:  # pragma: no cover - streamlit-only fallback
    ctk = None


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------


def read_config():
    """Read the hub's app registry and directory config."""
    app_info_path = os.path.join(SCRIPT_DIR, "app_information.txt")
    dir_config_path = os.path.join(SCRIPT_DIR, "default_directories.ini")

    app_cfg = configparser.ConfigParser()
    app_cfg.read(app_info_path, encoding="utf-8")
    dir_cfg = configparser.ConfigParser()
    dir_cfg.read(dir_config_path, encoding="utf-8")
    return app_cfg, dir_cfg, dir_config_path


def drive_dictionary(argv):
    """Map drive labels to letters from `Label=Drive` args (BBI contract)."""
    mapping = {}
    for arg in argv:
        if "=" in arg and not arg.startswith("--"):
            label, drive = arg.split("=", 1)
            mapping[label.strip('"').strip("'")] = drive.strip('"').strip("'")
    return mapping


def resolve_path(raw, drives):
    """Turn `Label, "sub\\path"` into an absolute path using the drive map."""
    if not raw:
        return None
    parts = [p.strip() for p in raw.split(",", 1)]
    if len(parts) != 2:
        return raw
    drive_label, subpath = parts
    subpath = subpath.strip('"').strip("'")
    drive_letter = drives.get(drive_label)
    if not drive_letter:
        return None
    return os.path.join(drive_letter, os.sep, subpath)


def glob_latest(directory, pattern):
    """Newest match for a simple glob — mirrors the Python hub's sort order."""
    if not os.path.isdir(directory):
        return None
    matches = sorted(glob.glob(os.path.join(directory, pattern)))
    matches = [m for m in matches if os.path.isfile(m)]
    return matches[-1] if matches else None


def prepare_kwargs(app, dir_cfg, drives):
    """
    Resolve the app's `pass_*_as_kwarg` entries into real paths.

    Returns (kwargs_dict, cmd_args_list, missing_labels).
    """
    kwargs = {}
    cmd_args = []
    missing = []

    if "pass_dir_as_kwarg" in app:
        for pair in app["pass_dir_as_kwarg"].split(";"):
            if not pair.strip():
                continue
            try:
                dir_key, kwarg_name = [p.strip() for p in pair.split(":")]
            except ValueError:
                continue
            raw = None
            if dir_cfg.has_section("Paths") and dir_cfg.has_option("Paths", dir_key):
                raw = dir_cfg.get("Paths", dir_key)
            if not raw:
                missing.append(dir_key)
                continue
            resolved = resolve_path(raw, drives)
            if resolved and os.path.exists(resolved):
                kwargs[kwarg_name] = resolved
                cmd_args.append(f"--{kwarg_name}={resolved}")
            else:
                missing.append(dir_key)

    if "pass_template_as_kwarg" in app:
        templates_dir = os.path.join(SCRIPT_DIR, "Templates")
        for pair in app["pass_template_as_kwarg"].split(";"):
            if not pair.strip():
                continue
            try:
                kwarg_name, pattern = [p.strip() for p in pair.split(":")]
            except ValueError:
                continue
            found = glob_latest(templates_dir, pattern)
            if found:
                kwargs[kwarg_name] = found
                cmd_args.append(f"--{kwarg_name}={found}")

    if "pass_db_as_kwarg" in app:
        db_dir = os.path.join(SCRIPT_DIR, "Databases")
        for pair in app["pass_db_as_kwarg"].split(";"):
            if not pair.strip():
                continue
            try:
                kwarg_name, pattern = [p.strip() for p in pair.split(":")]
            except ValueError:
                continue
            found = glob_latest(db_dir, pattern)
            if found:
                kwargs[kwarg_name] = found
                cmd_args.append(f"--{kwarg_name}={found}")

    return kwargs, cmd_args, missing


# ---------------------------------------------------------------------------
# Launchers
# ---------------------------------------------------------------------------


def launch_tkinter(app, kwargs, root):
    """Importlib-load the subapp and mount it as a child window."""
    entry = app.get("entry", "")
    class_name = app.get("class_name")
    app_path = os.path.join(SCRIPT_DIR, "Code", app.get("path", ""))
    module_path = os.path.join(app_path, entry)

    if not os.path.exists(module_path) or not class_name:
        raise FileNotFoundError(
            f"App entry or class name is misconfigured for '{app.get('name')}'"
        )

    module_name = os.path.splitext(entry)[0]
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    module = importlib.util.module_from_spec(spec)
    sys.path.append(app_path)
    try:
        spec.loader.exec_module(module)
    finally:
        if app_path in sys.path:
            sys.path.remove(app_path)

    app_class = getattr(module, class_name)
    toplevel = ctk.CTkToplevel(root)
    toplevel.title(app.get("name", "App"))
    app_class(master=toplevel, **kwargs)
    toplevel.transient(root)
    toplevel.grab_set()
    return toplevel


def launch_streamlit(app, kwargs, dir_config_path, drives):
    """Run a streamlit subapp with its resolved kwargs on the command line."""
    entry = app.get("entry", "")
    app_path = os.path.join(SCRIPT_DIR, "Code", app.get("path", ""))
    cmd = [sys.executable, "-m", "streamlit", "run", entry, "--server.headless", "false"]
    cmd.append("--")
    cmd.append(f"--config={dir_config_path}")
    for label, drive in drives.items():
        cmd.append(f"{label}={drive}")
    for key, value in kwargs.items():
        cmd.append(f"--{key}={value}")
    return subprocess.Popen(cmd, cwd=app_path)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="BBI hub launcher (Electron build)")
    parser.add_argument("--app", required=True, help="App name from app_information.txt")
    args, extra = parser.parse_known_args()

    app_cfg, dir_cfg, dir_config_path = read_config()
    drives = drive_dictionary(extra)

    section = None
    for name in app_cfg.sections():
        if name.strip().lower() == args.app.strip().lower():
            section = name
            break
    if section is None:
        print(f"ERROR: app '{args.app}' not found in app_information.txt", file=sys.stderr)
        print("Available: " + ", ".join(app_cfg.sections()), file=sys.stderr)
        return 2

    app = dict(app_cfg[section])
    app["name"] = section
    kwargs, cmd_args, missing = prepare_kwargs(app, dir_cfg, drives)

    if missing:
        print(
            "WARNING: unresolved directory keys: " + ", ".join(sorted(set(missing))),
            file=sys.stderr,
        )
    for key, value in sorted(kwargs.items()):
        print(f"resolved {key} = {value}", file=sys.stderr)

    category = app.get("category", "").lower()

    if category == "streamlit":
        proc = launch_streamlit(app, kwargs, dir_config_path, drives)
        proc.wait()
        return 0

    if ctk is None:
        print(
            "ERROR: customtkinter is not installed in the bundled runtime; "
            "this app cannot be launched.",
            file=sys.stderr,
        )
        return 3

    # The hub owns the process-wide appearance — the same Light +
    # app_theme_midnight.json the BBI hub applies. Subapps must NOT set
    # their own theme in __init__ (that mutates CTk's global state and
    # re-styles every app opened afterwards).
    ctk.set_appearance_mode("Light")
    theme_path = os.path.join(SCRIPT_DIR, "app_theme_midnight.json")
    if os.path.exists(theme_path):
        os.chdir(SCRIPT_DIR)  # ctk resolves the theme name relative to cwd
        ctk.set_default_color_theme("app_theme_midnight.json")

    root = ctk.CTk()
    root.title("Gene Synthesis Hub")
    root.geometry("1000x600")

    try:
        launch_tkinter(app, kwargs, root)
    except Exception as exc:  # noqa: BLE001 - surface the failure to the shell
        print(f"ERROR: failed to launch '{section}': {exc}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        try:
            from tkinter import messagebox

            messagebox.showerror("Launch Error", f"Failed to launch '{section}':\n{exc}")
        except Exception:
            pass
        return 4

    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
