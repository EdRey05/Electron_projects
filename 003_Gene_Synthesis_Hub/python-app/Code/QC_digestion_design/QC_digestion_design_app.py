"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.2
Date: Jun 22, 2026
Notes: Standardized appearance and initial loading to match the rest of the
    hub's apps. Primer Log is now a required, validated file (autodetected from
    hub config, sheet 'input addon' checked in a background thread).
    Process button stays disabled until Primer Log validates.
"""

import os
import sys
import threading
import queue
import tkinter as tk

import openpyxl

import customtkinter as ctk
from tkinter import filedialog, messagebox


# --- Hub Integration: Path Setup ---
# Add the script's directory to the Python path. This allows the app
# to find the 'workflows' module when launched from the hub.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.append(SCRIPT_DIR)

# --- Workflow Imports ---
from workflows.vector_map_prep_biopython import VectorMapPrepBioPython
from workflows.vector_map_prep_snapgene import VectorMapPrepSnapGene

# --- Workflow Configuration ---
WORKFLOWS_TO_LOAD = [
    ("Vector Map Prep (SnapGene)", VectorMapPrepSnapGene),
    ("Vector Map Prep (BioPython)", VectorMapPrepBioPython),
]

# Sheet expected in the Primer Log workbook (matches the helper module used
# by every other app that consumes the Primer Log).
EXPECTED_PRIMER_LOG_SHEET = "input addon"

# Sheet checked by the QC workflows themselves. Surfaced here so the user
# gets a single consistent validation message when the Primer Log is loaded.
QC_WORKFLOW_SHEETS = ("input addon", "Obsolete input addon(completed)")


class QCDesignApp:
    def __init__(self, master, primer_log_path=None):
        self.master = master
        master.title("QC Digestion Design")
        master.geometry("820x620")

        # --- Workflow state ---
        self.workflows = {}
        self.active_workflow_name = ctk.StringVar()

        # --- Validation flags ---
        self.primerlog_valid = False

        # --- Log infrastructure ---
        self.log_queue = queue.Queue()
        self.processing_thread = None

        self._build_ui()

        # Pre-fill + validate the Primer Log after the UI renders.
        self.master.after(
            200, lambda: self.setup_initial_paths(primer_log_path)
        )

        self._load_workflows()
        self._start_log_queue_pump()

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        # --- Primer Log (required, autodetected) ---
        self.primerlog_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        self.primerlog_frame.pack(pady=(15, 10), padx=15, fill="x")

        ctk.CTkLabel(
            self.primerlog_frame,
            text="Primer Log",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        entry_frame = ctk.CTkFrame(self.primerlog_frame, fg_color="transparent")
        entry_frame.pack(fill="x", pady=(2, 2))

        self.entry_primerlog = ctk.CTkEntry(entry_frame, border_width=1)
        self.entry_primerlog.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.button_primerlog = ctk.CTkButton(
            entry_frame,
            text="Select",
            command=self.browse_primerlog,
            width=90,
        )
        self.button_primerlog.pack(side="right")

        self.primerlog_validation_label = ctk.CTkLabel(
            self.primerlog_frame,
            text="",
            font=ctk.CTkFont(size=14),
            anchor="w",
            justify="left",
        )
        self.primerlog_validation_label.pack(fill="x")

        # --- Workflow selector ---
        self.workflow_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        self.workflow_frame.pack(pady=(5, 5), padx=15, fill="x")

        ctk.CTkLabel(
            self.workflow_frame,
            text="Workflow",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        workflow_names = [name for name, _ in WORKFLOWS_TO_LOAD]
        self.workflow_menu = ctk.CTkOptionMenu(
            self.workflow_frame,
            values=workflow_names,
            variable=self.active_workflow_name,
            command=self.on_workflow_change,
            width=560,
        )
        self.workflow_menu.pack(pady=(4, 0))

        # --- Output folder (hidden for SnapGene workflow) ---
        self.output_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        self.output_frame.pack(pady=(5, 5), padx=15, fill="x")

        ctk.CTkLabel(
            self.output_frame,
            text="Output Folder",
            font=ctk.CTkFont(size=18, weight="bold"),
        ).pack(anchor="center")

        output_entry_frame = ctk.CTkFrame(self.output_frame, fg_color="transparent")
        output_entry_frame.pack(fill="x", pady=(2, 2))

        self.output_dir = tk.StringVar(
            value=os.path.join(
                os.path.expanduser("~"), "Documents", "QC Design Exports"
            )
        )
        self.entry_output = ctk.CTkEntry(output_entry_frame, border_width=1)
        self.entry_output.configure(textvariable=self.output_dir)
        self.entry_output.pack(side="left", fill="x", expand=True, padx=(0, 10))

        self.button_output = ctk.CTkButton(
            output_entry_frame,
            text="Select",
            command=self.choose_output_dir,
            width=90,
        )
        self.button_output.pack(side="right")

        # --- JobIDs input ---
        self.ids_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        self.ids_frame.pack(pady=(5, 5), padx=15, fill="both", expand=True)

        ctk.CTkLabel(
            self.ids_frame,
            text="Paste JobIDs (one per line)",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="w")

        self.txt_ids = ctk.CTkTextbox(
            self.ids_frame, border_width=1, fg_color="white", text_color="black"
        )
        self.txt_ids.pack(fill="both", expand=True, pady=(4, 0))

        # --- Action buttons ---
        button_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        button_frame.pack(pady=(10, 5), padx=15, fill="x")
        button_frame.grid_columnconfigure((0, 2), weight=2)
        button_frame.grid_columnconfigure(1, weight=1)

        self.btn_process = ctk.CTkButton(
            button_frame,
            text="Process IDs",
            command=self.process_ids,
            font=ctk.CTkFont(size=14, weight="bold"),
            height=38,
            fg_color="#3C702D",
            hover_color="#4CAF50",
        )
        self.btn_process.configure(state="disabled", fg_color="gray50")
        self.btn_process.grid(row=0, column=1, sticky="ew")

        self.btn_clear = ctk.CTkButton(
            button_frame,
            text="Clear IDs",
            command=self.clear_ids,
            font=ctk.CTkFont(size=14),
            height=38,
        )
        self.btn_clear.grid(row=0, column=3, sticky="ew", padx=(10, 0))

        # --- Log frame ---
        log_frame = ctk.CTkFrame(self.master)
        log_frame.pack(pady=(10, 15), padx=15, fill="both", expand=True)

        ctk.CTkLabel(
            log_frame,
            text="Log / Progress",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(anchor="w", padx=10, pady=(5, 2))

        self.log_textbox = ctk.CTkTextbox(
            log_frame,
            activate_scrollbars=True,
            state="disabled",
            fg_color="white",
            text_color="black",
        )
        self.log_textbox.pack(expand=True, fill="both", padx=10, pady=(2, 10))

    # ----------------------------------------------------------- Workflows
    def _load_workflows(self):
        for name, wf_class in WORKFLOWS_TO_LOAD:
            self.workflows[name] = wf_class(self)

        if WORKFLOWS_TO_LOAD:
            initial = WORKFLOWS_TO_LOAD[0][0]
            self.active_workflow_name.set(initial)
            self.on_workflow_change(initial)

    def on_workflow_change(self, selected_workflow_name):
        self.log(f"--- Switched to '{selected_workflow_name}' workflow ---")
        # SnapGene saves to its own default location; hide the output folder.
        if selected_workflow_name == "Vector Map Prep (SnapGene)":
            self.output_frame.pack_forget()
        else:
            # Re-pack with the same options used during initial build.
            self.output_frame.pack(pady=(5, 5), padx=15, fill="x")

    # ------------------------------------------------------------- Browsers
    def browse_primerlog(self):
        filename = filedialog.askopenfilename(filetypes=[("Excel files", "*.xlsx")])
        if filename:
            self.entry_primerlog.delete(0, "end")
            self.entry_primerlog.insert(0, filename)
            self._start_validation_thread(filename)

    def choose_output_dir(self):
        path = filedialog.askdirectory(
            title="Select output directory", initialdir=self.output_dir.get()
        )
        if path:
            self.output_dir.set(path)

    def clear_ids(self):
        self.txt_ids.delete("1.0", "end")

    # ----------------------------------------------------- Validation core
    def setup_initial_paths(self, primer_log_path):
        if primer_log_path:
            self.entry_primerlog.delete(0, "end")
            self.entry_primerlog.insert(0, primer_log_path)
            self._start_validation_thread(primer_log_path)

    def _start_validation_thread(self, file_path):
        # Reset entry + label to a neutral state before validating.
        self._update_validation_ui(None, "Validating...")

        thread = threading.Thread(
            target=self._validate_file,
            args=(file_path,),
            daemon=True,
        )
        thread.start()

    def _validate_file(self, file_path):
        if not file_path:
            self.master.after(0, self._update_validation_ui, False, "File not found.")
            return

        if not os.path.exists(file_path):
            self.master.after(0, self._update_validation_ui, False, "File not found.")
            return

        try:
            wb = openpyxl.load_workbook(file_path, read_only=True)
            sheet_names_lower = {s.lower() for s in wb.sheetnames}

            missing = [
                s for s in QC_WORKFLOW_SHEETS if s.lower() not in sheet_names_lower
            ]
            if missing:
                msg = f"Missing expected sheet(s): {', '.join(missing)}"
                self.master.after(0, self._update_validation_ui, False, msg)
                return

            # The Primer Log itself uses 'input addon' (live sheet). Flag it
            # if even that one is missing -- it should have been caught above.
            if EXPECTED_PRIMER_LOG_SHEET.lower() not in sheet_names_lower:
                self.master.after(
                    0,
                    self._update_validation_ui,
                    False,
                    f"Sheet '{EXPECTED_PRIMER_LOG_SHEET}' not found.",
                )
                return

            self.master.after(0, self._update_validation_ui, True, "Validated")
        except Exception:
            self.master.after(
                0, self._update_validation_ui, False, "Not a valid Excel file."
            )

    def _update_validation_ui(self, is_valid, message):
        self.primerlog_valid = bool(is_valid)

        if is_valid is True:
            self.entry_primerlog.configure(border_color="dark green", border_width=2)
            self.primerlog_validation_label.configure(
                text=f"\u2714 {message}", text_color="green"
            )
        elif is_valid is False:
            self.entry_primerlog.configure(border_color="#D32F2F", border_width=2)
            self.primerlog_validation_label.configure(
                text=f"\u2716 Invalid: {message}", text_color="#D32F2F"
            )
        else:  # resetting to neutral
            self.entry_primerlog.configure(
                border_width=1,
                border_color=ctk.ThemeManager.theme["CTkEntry"]["border_color"],
            )
            self.primerlog_validation_label.configure(
                text=message or "",
                text_color=ctk.ThemeManager.theme["CTkLabel"]["text_color"],
            )

        self._refresh_process_button()

    def _refresh_process_button(self):
        if self.primerlog_valid:
            self.btn_process.configure(state="normal", fg_color="#3C702D")
        else:
            self.btn_process.configure(state="disabled", fg_color="gray50")

    # ---------------------------------------------------------------- Log
    def log(self, message):
        if self.log_textbox and self.log_textbox.winfo_exists():
            self.log_textbox.configure(state="normal")
            self.log_textbox.insert("end", str(message) + "\n")
            self.log_textbox.see("end")
            self.log_textbox.configure(state="disabled")

    def _log_threaded(self, message):
        self.master.after(0, self.log, message)

    def _start_log_queue_pump(self):
        try:
            while True:
                message = self.log_queue.get_nowait()
                if message == "DONE":
                    self.btn_process.configure(state="normal", fg_color="#3C702D")
                    self.processing_thread = None
                    messagebox.showinfo(
                        "Done", "Finished. Check the log for details."
                    )
                    return
                elif isinstance(message, tuple) and message[0] == "ERROR":
                    self.btn_process.configure(state="normal", fg_color="#3C702D")
                    self.processing_thread = None
                    messagebox.showerror(message[1], message[2])
                    return
                else:
                    self.log(message)
        except queue.Empty:
            pass
        self.master.after(100, self._start_log_queue_pump)

    # ----------------------------------------------------------- Processing
    def process_ids(self):
        if self.processing_thread and self.processing_thread.is_alive():
            messagebox.showwarning("In Progress", "Processing is already running.")
            return

        if not self.primerlog_valid:
            messagebox.showerror(
                "Primer Log Missing",
                "Please choose a valid Primer Log that contains the 'input addon' sheet.",
            )
            return

        raw_ids = self.txt_ids.get("1.0", "end").strip()
        if not raw_ids:
            messagebox.showerror("No IDs", "Please paste JobIDs into the text field.")
            return

        jobids = [line.strip() for line in raw_ids.splitlines() if line.strip()]
        if not jobids:
            messagebox.showerror("No IDs", "No valid IDs parsed from input.")
            return

        primer_log = self.entry_primerlog.get()
        output_dir = self.output_dir.get().strip()
        workflow_name = self.active_workflow_name.get()
        active_workflow = self.workflows.get(workflow_name)
        if not active_workflow:
            messagebox.showerror(
                "Workflow Error", f"Could not find the selected workflow: {workflow_name}"
            )
            return

        # SnapGene saves to its own default folder; the other workflows need a
        # real output directory on disk.
        needs_output_dir = workflow_name != "Vector Map Prep (SnapGene)"
        if needs_output_dir:
            if not output_dir:
                messagebox.showerror(
                    "Output Folder Error",
                    "Please choose an output folder for this workflow.",
                )
                return
            if not os.path.isdir(output_dir):
                try:
                    os.makedirs(output_dir, exist_ok=True)
                except Exception as e:
                    messagebox.showerror(
                        "Output Folder Error",
                        f"Could not create output folder: {e}",
                    )
                    return

        # Reset UI for the new run.
        self.log_textbox.configure(state="normal")
        self.log_textbox.delete("1.0", "end")
        self.log_textbox.configure(state="disabled")
        self.btn_process.configure(state="disabled", fg_color="gray50")

        self.log(f"Starting '{workflow_name}' for {len(jobids)} JobIDs...")

        self.processing_thread = threading.Thread(
            target=active_workflow.run_processing_task,
            args=(primer_log, output_dir, jobids),
            daemon=True,
        )
        self.processing_thread.start()


# Backwards-compatibility alias. The hub config refers to this name.
QCDesignFrame = QCDesignApp


if __name__ == "__main__":
    root = ctk.CTk()
    root.geometry("820x620")
    ctk.set_appearance_mode("System")
    ctk.set_default_color_theme("blue")
    QCDesignApp(master=root)
    root.mainloop()