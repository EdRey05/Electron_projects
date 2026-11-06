"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.5
Date: Oct 31, 2026
Notes: Primer Log validation reworked to the path-state pattern: the entry
    revalidates on KeyRelease/Paste edits (fail-closed gate, 500 ms debounced
    cancelable revalidation, generation counter so stale validation results
    are dropped), and Process only runs the exact path that last validated.
    The queue pump is now persistent (re-arms on every pass) so every run
    after the first still logs, re-enables the gate and shows its summary;
    a run that ended with an error popup does not also flash the Done popup.
    Workbook handles are closed in finally. Only 'input addon' is required
    in the Primer Log; 'Obsolete input addon(completed)' is checked and
    reported as optional. Job fields follow the canonical job-log naming
    (Work No.). Header matching in the shared helper is whitespace-normalized
    on both the workbook-column and the candidate side.
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
# Unique package name (not the generic 'workflows'): every hub app loads in
# ONE process, and plain 'workflows' would merge with every other app's
# workflows directory by sys.path order.
from qcd_workflows.vector_map_prep_biopython import VectorMapPrepBioPython
from qcd_workflows.vector_map_prep_snapgene import VectorMapPrepSnapGene

# --- Workflow Configuration ---
WORKFLOWS_TO_LOAD = [
    ("Vector Map Prep (SnapGene)", VectorMapPrepSnapGene),
    ("Vector Map Prep (BioPython)", VectorMapPrepBioPython),
]

# Sheet required in the Primer Log workbook (the live sheet used by the
# QC workflows).
EXPECTED_PRIMER_LOG_SHEET = "input addon"

# Optional historical sheet consumed by the QC workflows when present.
# Reported as a warning when missing; never blocks validation.
OPTIONAL_COMPLETED_SHEET = "Obsolete input addon(completed)"


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

        # --- Path-state bookkeeping for the Primer Log entry ---
        # _primerlog_gen: bumped at every (re)validation start; validation
        # results from an older generation are dropped instead of overwriting
        # the state of a newer validation.
        # _validated_primerlog_path: the exact path whose validation produced
        # the current primerlog_valid state; Process refuses to run when the
        # entry text no longer matches it.
        self._primerlog_gen = 0
        self._validated_primerlog_path = None
        self._val_after_id = None

        # --- Log infrastructure ---
        self.log_queue = queue.Queue()
        self.processing_thread = None
        self._error_shown_for_run = False

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

        # Fail-closed path-state: every edit to the entry invalidates the
        # previous validation state and schedules a debounced revalidation.
        self._bind_primerlog_entry_events()

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

        # --- Work No. input ---
        self.ids_frame = ctk.CTkFrame(self.master, fg_color="transparent")
        self.ids_frame.pack(pady=(5, 5), padx=15, fill="both", expand=True)

        ctk.CTkLabel(
            self.ids_frame,
            text="Paste Work No. (one per line)",
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
    def _bind_primerlog_entry_events(self):
        # CTkEntry.bind writes the binding onto the inner entry; readbacks
        # would need ._entry, but the binding itself works.
        self.entry_primerlog.bind(
            "<KeyRelease>", self._on_primerlog_entry_changed, add="+"
        )
        self.entry_primerlog.bind(
            "<<Paste>>", self._on_primerlog_entry_changed, add="+"
        )

    def _on_primerlog_entry_changed(self, _event=None):
        # Fail closed immediately: the current valid state no longer belongs
        # to whatever text is now in the entry.
        self._validated_primerlog_path = None
        self.primerlog_valid = False
        self._refresh_process_button()

        text = self.entry_primerlog.get().strip()
        if not text:
            self._reset_validation_visuals()
            return

        # Debounced cancelable revalidation while the user keeps typing.
        if self._val_after_id is not None:
            try:
                self.master.after_cancel(self._val_after_id)
            except Exception:
                pass
        self._val_after_id = self.master.after(
            500, lambda: self._start_validation_thread(self.entry_primerlog.get())
        )

    def _reset_validation_visuals(self):
        # Neutral (unvalidated) visuals without touching the gate flags.
        self.entry_primerlog.configure(
            border_width=1,
            border_color=ctk.ThemeManager.theme["CTkEntry"]["border_color"],
        )
        self.primerlog_validation_label.configure(
            text="",
            text_color=ctk.ThemeManager.theme["CTkLabel"]["text_color"],
        )

    def setup_initial_paths(self, primer_log_path):
        if primer_log_path:
            self.entry_primerlog.delete(0, "end")
            self.entry_primerlog.insert(0, primer_log_path)
            self._start_validation_thread(primer_log_path)

    def _start_validation_thread(self, file_path):
        # A new validation supersedes any pending debounce and any running
        # validation (stale results are dropped by generation check).
        if self._val_after_id is not None:
            try:
                self.master.after_cancel(self._val_after_id)
            except Exception:
                pass
            self._val_after_id = None
        self._primerlog_gen += 1
        gen = self._primerlog_gen
        self._update_validation_ui(None, None, None, "Validating...")

        thread = threading.Thread(
            target=self._validate_file,
            args=(file_path, gen),
            daemon=True,
        )
        thread.start()

    def _validate_file(self, file_path, gen):
        wb = None
        try:
            if not file_path:
                self.master.after(
                    0, self._update_validation_ui, file_path, gen, False, "File not found."
                )
                return

            if not os.path.exists(file_path):
                self.master.after(
                    0, self._update_validation_ui, file_path, gen, False, "File not found."
                )
                return

            wb = openpyxl.load_workbook(file_path, read_only=True)
            sheet_names_lower = {s.lower() for s in wb.sheetnames}

            if EXPECTED_PRIMER_LOG_SHEET.lower() not in sheet_names_lower:
                self.master.after(
                    0,
                    self._update_validation_ui,
                    file_path,
                    gen,
                    False,
                    f"Sheet '{EXPECTED_PRIMER_LOG_SHEET}' not found.",
                )
                return

            # The historical 'Obsolete input addon(completed)' sheet is
            # optional for the workflows; surface it when absent but do not
            # fail the file over it.
            if OPTIONAL_COMPLETED_SHEET.lower() not in sheet_names_lower:
                self.master.after(
                    0,
                    self._update_validation_ui,
                    file_path,
                    gen,
                    True,
                    "Validated (optional sheet 'Obsolete input addon(completed)' not found)",
                )
                return

            self.master.after(
                0, self._update_validation_ui, file_path, gen, True, "Validated"
            )
        except Exception:
            self.master.after(
                0,
                self._update_validation_ui,
                file_path,
                gen,
                False,
                "Not a valid Excel file.",
            )
        finally:
            if wb is not None:
                try:
                    wb.close()
                except Exception:
                    pass

    def _update_validation_ui(self, file_path, gen, is_valid, message=None):
        if gen is not None and gen != self._primerlog_gen:
            # Stale validation result for a superseded request.
            return
        if is_valid is True:
            self.primerlog_valid = True
            self._validated_primerlog_path = file_path
            self.entry_primerlog.configure(border_color="dark green", border_width=2)
            self.primerlog_validation_label.configure(
                text=f"\u2714 {message}", text_color="green"
            )
        elif is_valid is False:
            self.primerlog_valid = False
            self._validated_primerlog_path = None
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
        # Persistent pump: it ALWAYS re-arms (unless the window is gone), so
        # every run -- not just the first -- streams its log, re-enables the
        # Process button and shows its summary. DONE/ERROR only change the
        # run state; a DONE after an already-shown ERROR stays popup-silent.
        try:
            if not self.master.winfo_exists():
                return
        except Exception:
            return

        try:
            while True:
                message = self.log_queue.get_nowait()
                if message == "DONE":
                    self.processing_thread = None
                    self._refresh_process_button()
                    if not self._error_shown_for_run:
                        messagebox.showinfo(
                            "Done", "Finished. Check the log for details."
                        )
                    self._error_shown_for_run = False
                elif isinstance(message, tuple) and len(message) >= 3 and message[0] == "ERROR":
                    self.processing_thread = None
                    self._error_shown_for_run = True
                    self._refresh_process_button()
                    messagebox.showerror(message[1], message[2])
                else:
                    self.log(message)
        except queue.Empty:
            pass
        try:
            self.master.after(100, self._start_log_queue_pump)
        except Exception:
            pass

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
            messagebox.showerror("No IDs", "Please paste Work No. into the text field.")
            return

        work_nos = [line.strip() for line in raw_ids.splitlines() if line.strip()]
        if not work_nos:
            messagebox.showerror("No IDs", "No valid IDs parsed from input.")
            return

        primer_log = self.entry_primerlog.get()
        validated_path = self._validated_primerlog_path
        if (
            not validated_path
            or os.path.abspath(str(validated_path)) != os.path.abspath(str(primer_log))
        ):
            # The valid state belongs to a different path than the entry now
            # shows: re-validation has not confirmed the entered file.
            messagebox.showerror(
                "Primer Log Changed",
                "The entered Primer Log has not been re-validated.\n"
                "Edit the field again or use Select once to validate it.",
            )
            return

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
        self._error_shown_for_run = False

        self.log(f"Starting '{workflow_name}' for {len(work_nos)} Work No....")

        self.processing_thread = threading.Thread(
            target=active_workflow.run_processing_task,
            args=(primer_log, output_dir, work_nos),
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