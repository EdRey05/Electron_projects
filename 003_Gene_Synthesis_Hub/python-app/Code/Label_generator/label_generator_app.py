"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.1
Date: Oct 13, 2026
Notes: Label Generator subapp shell, modeled after the QC File Prep app
    (workflow dropdown + shared Process button + log box). It is a
    general router: every workflow registers through the
    WORKFLOWS_TO_LOAD list below, and all processing specifics live in
    the workflow module's own docstring. Launches from the Gene
    Synthesis Hub ("tkinter_import" entry) with no directory
    requirements; container height and log size are tuned for the
    Sg Relabeling results table. v1.1 removes the __init__ theme
    application (an always-missing theme path fell back to the blue
    theme and mutated the hub process's global ctk theme, re-styling
    every app opened afterwards); the app now inherits the hub
    appearance like the other subapps, and main() uses the standard
    standalone convention (System + blue).
"""

import configparser
import os
import sys
import threading

import customtkinter as ctk

# --- Hub Integration: Path Setup ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.append(SCRIPT_DIR)

# --- Workflow Configuration ---
# To add a new workflow to the application:
# 1. Import the workflow's main class below.
from workflows.sg_relabeling import SgRelabeling
from tools.measurement_table import MeasurementTable  # noqa: F401 (re-export)

# 2. Add a tuple to this list: (Display Name, ClassName)
WORKFLOWS_TO_LOAD = [
    ("Sg Relabeling", SgRelabeling),
]


class LabelGeneratorApp(ctk.CTkFrame):
    """Main application class for the BBI Label Generator."""

    def __init__(self, master=None, **kwargs):
        """Initializes the main application window and all its components."""
        super().__init__(master, **kwargs)
        self.pack(fill="both", expand=True)

        # --- Window Configuration ---
        if self.master:
            self.master.geometry("1000x720")

        # Appearance/theme: NOT set here. The hub owns the process-wide
        # appearance (Light + app_theme_midnight.json); apps that re-apply a
        # theme in __init__ mutate ctk's GLOBAL theme state and re-style every
        # app launched afterwards. Standalone runs get the standard-app theme
        # in main() below.

        # --- 1. Common Setup ---
        # Read from hub's default_directories.ini (parent directory)
        self.config = configparser.ConfigParser()
        hub_config_path = os.path.join(
            os.path.dirname(os.path.dirname(SCRIPT_DIR)), "default_directories.ini"
        )
        self.config.read(hub_config_path)
        self.drive_dictionary = self.create_drive_dictionary()

        # Store hub-passed paths for workflows to use (none required yet)
        self.hub_paths = {}

        # --- 2. Create the Workflow Selector (Dropdown) ---
        workflow_names = [name for name, _ in WORKFLOWS_TO_LOAD]
        self.selected_workflow = ctk.StringVar(
            value=workflow_names[0] if workflow_names else ""
        )

        selector_frame = ctk.CTkFrame(self)
        selector_frame.pack(fill="x", padx=12, pady=(12, 4))

        ctk.CTkLabel(
            selector_frame,
            text="Select Workflow:",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(side="left", padx=(0, 8))
        self.workflow_dropdown = ctk.CTkOptionMenu(
            selector_frame,
            variable=self.selected_workflow,
            values=workflow_names,
            command=self.on_workflow_change,
        )
        self.workflow_dropdown.pack(side="left", fill="x", expand=True)

        # --- 3. Create Container for Workflow UI ---
        # The table workflow is the visual focus: container is the larger
        # pane, the log box the smaller one (heights swapped per Ed).
        self.workflow_container = ctk.CTkFrame(self, height=440)
        self.workflow_container.pack(fill="x", padx=12, pady=0)
        self.workflow_container.pack_propagate(False)  # Prevent shrinking

        # --- 4. Load Each Workflow ---
        self.workflows = {}

        for name, workflow_class in WORKFLOWS_TO_LOAD:
            workflow_frame = ctk.CTkFrame(
                self.workflow_container, fg_color="transparent"
            )
            workflow_instance = workflow_class(self)
            workflow_instance.create_ui(workflow_frame)
            workflow_instance.frame = workflow_frame  # Store reference for show/hide
            self.workflows[name] = workflow_instance

        # --- 5. Create Log Box and Process Button ---
        # Log is the SMALLER pane: the workflow UI (table) dominates.
        self.logbox = ctk.CTkTextbox(self, height=150)
        self.process_button = ctk.CTkButton(self, text="Process", command=self.start_processing)
        self.process_button.configure(state="disabled")

        self.logbox.pack(fill="both", expand=True, padx=12, pady=12)
        self.process_button.pack(pady=(0, 12))

        # --- 6. Final Setup ---
        if WORKFLOWS_TO_LOAD:
            initial_workflow_name = WORKFLOWS_TO_LOAD[0][0]
            for name, workflow in self.workflows.items():
                workflow.frame.pack_forget()
            self.workflows[initial_workflow_name].frame.pack(fill="both", expand=True)
            self.log(f"--- Loaded '{initial_workflow_name}' workflow ---")
            self.workflows[initial_workflow_name].setup_default_paths()
        else:
            self.log("[ERROR] \t No workflows are configured to load.")

    def on_workflow_change(self, selected_name=None):
        """Handles the event when a new workflow is selected from the dropdown."""
        self.logbox.delete("1.0", "end")

        if selected_name is None:
            selected_name = self.selected_workflow.get()

        for name, workflow in self.workflows.items():
            workflow.frame.pack_forget()

        active_workflow = self.workflows[selected_name]
        active_workflow.frame.pack(fill="both", expand=True)

        self.log(f"--- Switched to '{selected_name}' workflow ---")
        active_workflow.setup_default_paths()

    def update_log_gui(self, msg: str):
        """Helper method to insert message into the logbox on the main GUI thread."""
        self.logbox.insert("end", msg + "\n")
        self.logbox.see("end")

    def log(self, msg: str):
        """Schedules a message to be appended to the logbox in a thread-safe way."""
        self.after(0, self.update_log_gui, msg)

    def start_processing(self):
        """Validates inputs and runs the workflow's processing task in a thread."""
        selected_workflow_name = self.selected_workflow.get()
        active_workflow = self.workflows[selected_workflow_name]

        if not active_workflow.validate_inputs():
            return

        self.process_button.configure(state="disabled")
        threading.Thread(
            target=active_workflow.run_processing_task, daemon=True
        ).start()

    def create_drive_dictionary(self) -> dict:
        """
        Parses command-line arguments to create a mapping of drive labels to letters.
        """
        drive_dictionary = {}
        for arg in sys.argv[1:]:
            if "=" in arg:
                label, drive = arg.split("=", 1)
                label = label.strip('"').strip("'")
                drive = drive.strip('"').strip("'")
                drive_dictionary[label] = drive
        return drive_dictionary

    def make_path_from_config(self, section: str, key: str):
        """
        Constructs a full, absolute path from a drive label and subpath in
        default_directories.ini.
        """
        try:
            config_string = self.config.get(section, key)
            parts = [p.strip() for p in config_string.split(",", 1)]
            if len(parts) != 2:
                self.log(
                    f"[ERROR] \t Invalid format for '{key}' in config. Expected 'Label, Path'."
                )
                return None
            drive_label, subpath = parts
            subpath = subpath.strip('"').strip("'")
            drive_letter = self.drive_dictionary.get(drive_label)
            if not drive_letter:
                self.log(f"[WARNING] \t Drive for label '{drive_label}' not found.")
                return None
            return os.path.join(drive_letter, os.sep, subpath)
        except (configparser.NoSectionError, configparser.NoOptionError):
            self.log(
                f"[WARNING] \t Could not find '{key}' in section '[{section}]' of default_directories.ini."
            )
            return None


if __name__ == "__main__":
    # Standalone entry point: own process, standard-app appearance.
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")
    root = ctk.CTk()
    root.title("BBI Label Generator")
    root.geometry("1000x720")
    app = LabelGeneratorApp(master=root)
    root.mainloop()