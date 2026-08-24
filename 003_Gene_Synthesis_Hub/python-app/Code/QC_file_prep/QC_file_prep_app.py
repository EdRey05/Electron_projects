"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 2.2
Date: Mar 30, 2026
Notes: Fixed issue with hub-passed directories.
"""

import configparser
import os
import re
import sys
import threading

import customtkinter as ctk
from tkinter import filedialog

# --- Hub Integration: Path Setup ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.append(SCRIPT_DIR)

# --- Workflow Configuration ---
# To add a new workflow to the application:
# 1. Import the workflow's main class below.
from workflows.inhouse_newnames import InHouseNewNames
from workflows.inhouse_oldnames import InHouseOldNames
from workflows.internal_renaming import InternalRenaming
from workflows.wgk_correction import WgkCorrection
from workflows.resuspension_prep import ResuspensionPrep

# 2. Add a tuple to this list: (Display Name, ClassName)
WORKFLOWS_TO_LOAD = [
    ("In-House New Names", InHouseNewNames),
    ("In-House Old Names", InHouseOldNames),
    ("Internal Renaming", InternalRenaming),
    ("WGK Correction", WgkCorrection),
    ("Resuspension Prep", ResuspensionPrep),
]


class QCFilePrepApp(ctk.CTkFrame):
    """Main application class for the BBI QC File Prep Hub."""

    def __init__(self, master=None, initial_input_folder=None, output_folder=None, gel_ladder_path=None, gene_invoicing_db_path=None, job_log_path=None, **kwargs):
        """Initializes the main application window and all its components."""
        super().__init__(master, **kwargs)
        self.pack(fill="both", expand=True)

        # --- Window Configuration ---
        # Set a fixed size to prevent resizing when switching workflows.
        # Using a wider default (1300) to accommodate workflows with long text fields.
        if self.master:
            self.master.geometry("1000x720")

        # --- Theme Configuration (Hub-consistent) ---
        # Apply the same appearance mode and theme as the Gene Synthesis Hub
        ctk.set_appearance_mode("Light")
        theme_path = os.path.join(os.path.dirname(SCRIPT_DIR), "app_theme_midnight.json")
        if os.path.exists(theme_path):
            ctk.set_default_color_theme(theme_path)
        else:
            # Fallback to blue theme if midnight theme not found
            ctk.set_default_color_theme("blue")

        # --- 1. Common Setup ---
        # Read from hub's default_directories.ini (parent directory)
        self.config = configparser.ConfigParser()
        hub_config_path = os.path.join(os.path.dirname(os.path.dirname(SCRIPT_DIR)), "default_directories.ini")
        self.config.read(hub_config_path)
        self.drive_dictionary = self.create_drive_dictionary()
        
        # Store hub-passed paths for workflows to use
        self.hub_paths = {
            'Gene_Invoicing_Db': gene_invoicing_db_path,
            'Gel_Ladder': gel_ladder_path,
            'Job_Log': job_log_path,
        }

        self.input_folder = ctk.StringVar()
        if initial_input_folder:
            self.input_folder.set(initial_input_folder)

        # --- 2. Create Common UI Elements ---
        top_panel = ctk.CTkFrame(self)
        top_panel.pack(fill="x", padx=12, pady=12)

        folder_frame = ctk.CTkFrame(top_panel)
        folder_frame.pack(pady=8)
        ctk.CTkLabel(
            folder_frame,
            text="Folder with Zips:",
            font=ctk.CTkFont(size=13, weight="bold")
        ).pack(side="left", padx=8)
        ctk.CTkEntry(folder_frame, textvariable=self.input_folder, width=450).pack(
            side="left", padx=8
        )
        ctk.CTkButton(
            folder_frame, text="Select Folder", command=self.change_input_folder
        ).pack(side="left")

        # --- Create Log Box and Process Button ---
        self.logbox = ctk.CTkTextbox(self, height=240)
        self.process_button = ctk.CTkButton(
            self, text="Process", command=self.start_processing
        )
        self.process_button.configure(state="disabled")

        # Add a single, centralized trace to the input folder
        self.input_folder.trace_add("write", self.on_input_folder_change)

        # --- 3. Create the Workflow Selector (Dropdown) ---
        # Dropdown replaces tabs for better scalability with many workflows
        workflow_names = [name for name, _ in WORKFLOWS_TO_LOAD]
        self.selected_workflow = ctk.StringVar(value=workflow_names[0] if workflow_names else "")

        selector_frame = ctk.CTkFrame(self)
        selector_frame.pack(fill="x", padx=12, pady=(8, 4))

        ctk.CTkLabel(
            selector_frame,
            text="Select Workflow:",
            font=ctk.CTkFont(size=13, weight="bold")
        ).pack(side="left", padx=(0, 8))
        self.workflow_dropdown = ctk.CTkOptionMenu(
            selector_frame,
            variable=self.selected_workflow,
            values=workflow_names,
            command=self.on_workflow_change
        )
        self.workflow_dropdown.pack(side="left", fill="x", expand=True)

        # --- 4. Create Container for Workflow UI ---
        self.workflow_container = ctk.CTkFrame(self, height=180)
        self.workflow_container.pack(fill="x", padx=12, pady=0)
        self.workflow_container.pack_propagate(False)  # Prevent shrinking

        # --- 5. Load Each Workflow ---
        self.workflows = {}

        for name, workflow_class in WORKFLOWS_TO_LOAD:
            # Create a wrapper frame for each workflow
            workflow_frame = ctk.CTkFrame(self.workflow_container, fg_color="transparent")
            workflow_instance = workflow_class(self)
            workflow_instance.create_ui(workflow_frame)
            workflow_instance.frame = workflow_frame  # Store reference for show/hide
            self.workflows[name] = workflow_instance

        # --- 6. Pack the Log Box and Process Button ---
        self.logbox.pack(fill="both", expand=True, padx=12, pady=12)
        self.process_button.pack(pady=(0, 12))

        # --- 7. Final Setup ---
        # Initialize workflow visibility - show only the first workflow
        if WORKFLOWS_TO_LOAD:
            initial_workflow_name = WORKFLOWS_TO_LOAD[0][0]
            # Hide all workflows first
            for name, workflow in self.workflows.items():
                workflow.frame.pack_forget()
            # Show the initial workflow
            self.workflows[initial_workflow_name].frame.pack(fill="both", expand=True)
            self.log(f"--- Loaded '{initial_workflow_name}' workflow ---")
            self.workflows[initial_workflow_name].setup_default_paths()
        else:
            self.log("[ERROR] \t No workflows are configured to load.")

    def on_workflow_change(self, selected_name=None):
        """Handles the event when a new workflow is selected from the dropdown.

        Clears the log, hides all workflows, shows the selected one, and calls
        its setup method.
        """
        # Clear the logbox for a fresh start on the new workflow.
        self.logbox.delete("1.0", "end")

        # Get the selected workflow name
        if selected_name is None:
            selected_name = self.selected_workflow.get()

        # Hide all workflow frames first
        for name, workflow in self.workflows.items():
            workflow.frame.pack_forget()

        # Show the selected workflow
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
        """Starts the processing task for the currently selected workflow.

        Validates inputs, disables the process button to prevent multiple runs,
        and starts the workflow's processing task in a separate thread to keep
        the GUI responsive.
        """
        selected_workflow_name = self.selected_workflow.get()
        active_workflow = self.workflows[selected_workflow_name]

        if not active_workflow.validate_inputs():
            return

        self.process_button.configure(state="disabled")
        threading.Thread(
            target=active_workflow.run_processing_task, daemon=True
        ).start()

    def change_input_folder(self):
        """Opens a dialog to select the input folder and updates the corresponding variable."""
        folder_selected = filedialog.askdirectory()
        if folder_selected:
            self.input_folder.set(folder_selected)

    def on_input_folder_change(self, *args):
        """
        Centralized handler to enable/disable the process button based on input folder content.
        """
        selected_folder = os.path.normpath(self.input_folder.get().strip())
        if not selected_folder or not os.path.isdir(selected_folder):
            self.process_button.configure(state="disabled")
            return

        zip_files = [
            f for f in os.listdir(selected_folder) if f.lower().endswith(".zip")
        ]
        if not zip_files:
            self.log(f"[WARNING] \t No zip files found in folder: {selected_folder}")
            self.process_button.configure(state="disabled")
        else:
            self.log(
                f"[OK] \t Found {len(zip_files)} zip file(s) in folder: {selected_folder}"
            )
            self.process_button.configure(state="normal")

    def create_drive_dictionary(self) -> dict:
        """
        Parses command-line arguments to create a mapping of drive labels to letters.

        This allows for portable path configurations. For example, a command-line
        argument like '"BBI_MAIN=D:"' will map the label 'BBI_MAIN' to the 'D:' drive.

        Returns:
            A dictionary mapping drive labels to drive letters (e.g., {'BBI_MAIN': 'D:'}).
        """
        drive_dictionary = {}
        for arg in sys.argv[1:]:
            if "=" in arg:
                # Handle both "Label=Drive" and Label=Drive formats
                label, drive = arg.split("=", 1)
                label = label.strip('"').strip("'")
                drive = drive.strip('"').strip("'")
                drive_dictionary[label] = drive
        return drive_dictionary

    def make_path_from_config(self, section: str, key: str):
        """
        Constructs a full, absolute path from a drive label and subpath in default_settings.ini.

        Reads a configuration value (e.g., "BBI_MAIN, /path/to/folder"), looks up the
        drive letter for the label (e.g., 'BBI_MAIN' -> 'D:'), and joins them to
        create a full path (e.g., 'D:\\path\\to\\folder').

        Args:
            section: The section in the default_settings.ini file (e.g., 'PATHS').
            key: The key within the section whose value contains the path info.

        Returns:
            The constructed absolute path as a string, or None if an error occurs.
        """
        try:
            # Read the raw string from the config file, e.g., "BBI_MAIN, /some/folder"
            config_string = self.config.get(section, key)
            # Split the string by the first comma into two parts: the drive label and the subpath.
            parts = [p.strip() for p in config_string.split(",", 1)]
            if len(parts) != 2:
                self.log(
                    f"[ERROR] \t Invalid format for '{key}' in config. Expected 'Label, Path'."
                )
                return None
            drive_label, subpath = parts
            # Clean up the subpath by removing any surrounding quotes.
            subpath = subpath.strip('"').strip("'")
            # Look up the drive letter (e.g., 'D:') using the label (e.g., 'BBI_MAIN').
            drive_letter = self.drive_dictionary.get(drive_label)
            if not drive_letter:
                self.log(f"[WARNING] \t Drive for label '{drive_label}' not found.")
                return None
            # Join the drive letter and subpath into a valid OS-specific path.
            # os.sep ensures the correct path separator ('\' or '/') is used.
            return os.path.join(drive_letter, os.sep, subpath)
        except (configparser.NoSectionError, configparser.NoOptionError):
            self.log(
                f"[WARNING] 	 Could not find '{key}' in section '[{section}]' of default_directories.ini."
            )
            return None


if __name__ == "__main__":
    root = ctk.CTk()
    root.title("BBI QC File Prep Hub")
    root.geometry("1200x650")
    
    # Apply hub-consistent theme
    ctk.set_appearance_mode("Light")
    theme_path = os.path.join(os.path.dirname(SCRIPT_DIR), "app_theme_midnight.json")
    if os.path.exists(theme_path):
        ctk.set_default_color_theme(theme_path)
    else:
        ctk.set_default_color_theme("blue")
    
    app = QCFilePrepApp(master=root)
    root.mainloop()