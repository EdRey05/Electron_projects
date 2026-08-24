"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 1.1
Date: Aug 11, 2026

Notes: Workflow for automating SnapGene to create .dna files. Adds two
    user-facing safeguards driven by a modal dialog (thread-safe via
    Tk's after() + threading.Event):

    1. Pre-start "Ready" dialog. Replaces the silent 5-second sleep with
        a modal dialog the user must acknowledge, followed by a visible
        10-second countdown before any keystrokes fire.

    2. Mid-run focus check. Before each JobID's automation block, verifies
        SnapGene is the foreground window (via win32gui). If not, shows a
        3-button dialog: Retry (recheck focus and restart current JobID),
        Continue (proceed anyway), or Cancel Run (abort).

    pyautogui FailSafe (mouse to top-left corner) remains the fastest
    abort mechanism during the actual automation.
"""

import threading
import time

import pandas as pd
import pyautogui
import pyperclip

from .helpers import get_row_for_jobid, get_field_from_row


# --- Foreground-window detection (lazy import for non-Windows safety) ---
def _is_snapgene_foreground():
    """Return True if SnapGene is the foreground window.

    Uses win32gui (Windows only). On other platforms, returns True so
    the workflow still runs -- it just skips the safeguard.
    """
    try:
        import win32gui  # type: ignore
    except ImportError:
        return True

    try:
        hwnd = win32gui.GetForegroundWindow()
        title = win32gui.GetWindowText(hwnd) or ""
        return "snapgene" in title.lower()
    except Exception:
        # Fail safe: if we can't tell, assume not foreground so the
        # dialog appears rather than silently running.
        return False


# --- Thread-safe dialog helpers ---
# SnapGene automation runs in a worker thread, but customtkinter widgets
# must be created on the Tk main thread. We schedule dialog construction
# via master.after() and signal the worker's choice back with threading
# Events.

def _show_ready_dialog(master, jobid_count):
    """Show the pre-start 'Ready' dialog. Blocks until user clicks OK or
    Cancel. Returns 'ok' or 'cancel'.
    """
    import customtkinter as ctk

    result = {"choice": "cancel"}
    closed = {"flag": False}
    dialog = ctk.CTkToplevel(master)
    dialog.title("Ready to Start")
    dialog.geometry("440x200")
    dialog.resizable(False, False)
    dialog.transient(master)
    dialog.grab_set()

    ctk.CTkLabel(
        dialog,
        text="Ready to Launch SnapGene Automation",
        font=ctk.CTkFont(size=16, weight="bold"),
    ).pack(pady=(20, 8), padx=20)

    body = (
        f"All {jobid_count} JobID(s) are loaded.\n\n"
        "Click OK, then switch to SnapGene during the countdown."
    )
    ctk.CTkLabel(dialog, text=body, justify="center").pack(pady=(0, 16), padx=20)

    button_row = ctk.CTkFrame(dialog, fg_color="transparent")
    button_row.pack(pady=(0, 16), padx=20, fill="x")
    button_row.grid_columnconfigure((0, 1), weight=1)

    def choose(choice):
        if closed["flag"]:
            return
        closed["flag"] = True
        result["choice"] = choice
        try:
            dialog.grab_release()
        except Exception:
            pass
        try:
            dialog.destroy()
        except Exception:
            pass

    dialog.protocol("WM_DELETE_WINDOW", lambda: choose("cancel"))

    ctk.CTkButton(
        button_row, text="Cancel", command=lambda: choose("cancel"),
        fg_color="gray", hover_color="#5A5A5A",
    ).grid(row=0, column=0, padx=6, sticky="ew")

    ok_btn = ctk.CTkButton(
        button_row, text="OK", command=lambda: choose("ok"),
        fg_color="#3C702D", hover_color="#4CAF50",
    )
    ok_btn.grid(row=0, column=1, padx=6, sticky="ew")
    ok_btn.focus_set()
    dialog.bind("<Return>", lambda _e: choose("ok"))
    dialog.bind("<Escape>", lambda _e: choose("cancel"))

    dialog.wait_window()
    return result["choice"]


def _show_pre_start_countdown_dialog(master, seconds):
    """Show a read-only countdown dialog for `seconds`. The user can
    still abort by moving the mouse to the screen corner (pyautogui
    FailSafe). Returns True to proceed, False if FailSafe triggered.
    """
    import customtkinter as ctk

    aborted = {"flag": False}
    dialog = ctk.CTkToplevel(master)
    dialog.title("Starting in...")
    dialog.geometry("320x160")
    dialog.resizable(False, False)
    dialog.transient(master)
    dialog.grab_set()

    ctk.CTkLabel(
        dialog,
        text="Switch to SnapGene now",
        font=ctk.CTkFont(size=14, weight="bold"),
    ).pack(pady=(18, 6), padx=20)

    countdown_label = ctk.CTkLabel(
        dialog, text="", font=ctk.CTkFont(size=36, weight="bold"),
    )
    countdown_label.pack(pady=(0, 12), padx=20)

    # Generation counter so any in-flight tick() callback can detect
    # it's stale and bail out instead of touching destroyed widgets.
    gen = {"n": 0}

    def fail_safe_abort():
        if aborted["flag"]:
            return
        aborted["flag"] = True
        gen["n"] += 1
        try:
            dialog.grab_release()
        except Exception:
            pass
        try:
            dialog.destroy()
        except Exception:
            pass

    state = {"remaining": seconds, "my_gen": 0}

    def tick():
        if aborted["flag"]:
            return
        if state["my_gen"] != gen["n"]:
            return

        # FailSafe check: mouse to top-left corner of the screen.
        try:
            x, y = pyautogui.position()
            if x == 0 and y == 0:
                fail_safe_abort()
                return
        except pyautogui.FailSafeException:
            fail_safe_abort()
            return
        except Exception:
            pass

        if state["remaining"] <= 0:
            try:
                dialog.grab_release()
                dialog.destroy()
            except Exception:
                pass
            return

        state["remaining"] -= 1
        try:
            countdown_label.configure(text=f"{state['remaining']} ...")
        except Exception:
            return

        if not aborted["flag"]:
            state["my_gen"] = gen["n"]
            dialog.after(1000, tick)

    try:
        countdown_label.configure(text=f"{state['remaining']} ...")
    except Exception:
        pass
    state["my_gen"] = gen["n"]
    dialog.after(1000, tick)
    dialog.wait_window()
    return not aborted["flag"]


def _show_switch_countdown_dialog(master, seconds):
    """Show a short read-only countdown dialog used after the user
    clicks Retry/Continue in the focus-loss dialog. Gives them time to
    click SnapGene and bring it to the foreground before the next
    foreground check runs. No abort button (per user request).
    """
    import customtkinter as ctk

    dialog = ctk.CTkToplevel(master)
    dialog.title("Switching to SnapGene...")
    dialog.geometry("300x140")
    dialog.resizable(False, False)
    dialog.transient(master)
    dialog.grab_set()

    ctk.CTkLabel(
        dialog,
        text="Switch to SnapGene now",
        font=ctk.CTkFont(size=14, weight="bold"),
    ).pack(pady=(16, 6), padx=20)

    countdown_label = ctk.CTkLabel(
        dialog, text="", font=ctk.CTkFont(size=32, weight="bold"),
    )
    countdown_label.pack(pady=(0, 14), padx=20)

    state = {"remaining": seconds}

    def tick():
        if state["remaining"] <= 0:
            try:
                dialog.grab_release()
                dialog.destroy()
            except Exception:
                pass
            return
        state["remaining"] -= 1
        try:
            countdown_label.configure(text=f"{state['remaining']} ...")
        except Exception:
            return
        dialog.after(1000, tick)

    try:
        countdown_label.configure(text=f"{state['remaining']} ...")
    except Exception:
        pass
    dialog.after(1000, tick)
    dialog.wait_window()


def _show_focus_loss_dialog(master, jid):
    """Show the mid-run 'SnapGene lost focus' dialog. Returns one of:
    'retry', 'continue', 'cancel'.
    """
    import customtkinter as ctk

    result = {"choice": "cancel"}
    closed = {"flag": False}
    dialog = ctk.CTkToplevel(master)
    dialog.title("SnapGene Lost Focus")
    dialog.geometry("460x250")
    dialog.resizable(False, False)
    dialog.transient(master)
    dialog.grab_set()

    ctk.CTkLabel(
        dialog,
        text="SnapGene Lost Focus",
        font=ctk.CTkFont(size=16, weight="bold"),
    ).pack(pady=(20, 8), padx=20)

    body = (
        f"SnapGene is no longer the active window\n"
        f"before processing JobID {jid}.\n\n"
        "Switch back to SnapGene, then choose an option:"
    )
    ctk.CTkLabel(dialog, text=body, justify="center").pack(pady=(0, 14), padx=20)

    button_row = ctk.CTkFrame(dialog, fg_color="transparent")
    button_row.pack(pady=(0, 16), padx=20, fill="x")
    button_row.grid_columnconfigure((0, 1, 2), weight=1)

    def choose(choice):
        if closed["flag"]:
            return
        closed["flag"] = True
        result["choice"] = choice
        try:
            dialog.grab_release()
        except Exception:
            pass
        try:
            dialog.destroy()
        except Exception:
            pass

    # X button on the title bar counts as Cancel Run.
    dialog.protocol("WM_DELETE_WINDOW", lambda: choose("cancel"))

    # Retry: recheck focus and restart the current JobID
    ctk.CTkButton(
        button_row, text="Retry", command=lambda: choose("retry"),
        fg_color="#3C702D", hover_color="#4CAF50",
    ).grid(row=0, column=0, padx=4, sticky="ew")

    # Continue: skip the focus check for this JobID and proceed anyway
    ctk.CTkButton(
        button_row, text="Continue", command=lambda: choose("continue"),
    ).grid(row=0, column=1, padx=4, sticky="ew")

    # Cancel Run: abort the whole run
    ctk.CTkButton(
        button_row, text="Cancel Run", command=lambda: choose("cancel"),
        fg_color="#D32F2F", hover_color="#B71C1C",
    ).grid(row=0, column=2, padx=4, sticky="ew")

    dialog.bind("<Return>", lambda _e: choose("retry"))
    dialog.bind("<Escape>", lambda _e: choose("cancel"))
    dialog.wait_window()
    return result["choice"]


class _MainThreadResult:
    """Holder used by _ask_main_thread to ferry a value (or exception)
    from the Tk main thread back to a worker thread.
    """

    __slots__ = ("value", "exc")
    value: object
    exc: "Exception | None"

    def __init__(self):
        self.value = None
        self.exc = None


def _ask_main_thread(master, fn, *args):
    """Run `fn(*args)` on the Tk main thread and return its result.

    Uses an Event + a _MainThreadResult to ferry the return value back
    to the calling (worker) thread. If fn raises, the exception is
    re-raised in the caller.
    """
    holder = _MainThreadResult()
    done = threading.Event()

    def runner():
        try:
            holder.value = fn(*args)
        except Exception as e:
            holder.exc = e
        finally:
            done.set()

    master.after(0, runner)
    done.wait()
    if holder.exc is not None:
        raise holder.exc
    return holder.value


class VectorMapPrepSnapGene:
    def __init__(self, app_instance):
        self.app = app_instance
        self.log_queue = app_instance.log_queue

    # --- per-JobID automation block (unchanged behavior) ---
    def _automate_one(self, jid, vector, insert):
        """Run the pyautogui sequence for a single JobID. Caller is
        responsible for any focus verification and retry handling.
        """
        # 1. New file
        pyautogui.hotkey("ctrl", "n")
        time.sleep(0.75)
        # 2. Paste vector sequence
        pyperclip.copy(vector)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(3.0)  # Pause for SnapGene to render the annotated plasmid
        # 3. Tab to name field
        pyautogui.press("tab", presses=19, interval=0.2)
        time.sleep(0.75)

        # 4. Paste JobID as the file name
        pyperclip.copy(jid)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.75)
        # 5. Tab to 'Create' button and press Enter
        pyautogui.press("tab")
        time.sleep(0.75)
        pyautogui.press("enter")
        time.sleep(2.0)  # Longer pause for file to open

        if insert:
            # 6. Find insert
            pyautogui.hotkey("ctrl", "f")
            time.sleep(0.75)
            # 7. Paste insert sequence
            pyperclip.copy(insert)
            pyautogui.hotkey("ctrl", "v")
            time.sleep(0.75)
            # 8. Press Enter to find
            pyautogui.press("enter")
            time.sleep(0.75)
            # 9. Add feature
            pyautogui.hotkey("ctrl", "t")
            time.sleep(0.75)
            # 10. Type feature name
            pyperclip.copy("Insert")
            pyautogui.hotkey("ctrl", "v")
            time.sleep(0.75)
            # 11. Press Enter to confirm
            pyautogui.press("enter")
            time.sleep(0.75)

        # 12. Save file
        pyautogui.hotkey("ctrl", "s")
        time.sleep(0.75)
        # 13. Type JobID as filename
        pyperclip.copy(jid)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.75)
        # 14. Press Enter to save
        pyautogui.press("enter")
        time.sleep(0.75)
        # 15. Close file
        pyautogui.hotkey("ctrl", "w")
        time.sleep(0.75)

    def run_processing_task(self, excel_path, output_dir, jobids):
        """The main processing logic for this workflow, run in a thread."""
        # output_dir is ignored in this workflow as SnapGene saves to its default folder.
        master = self.app.master

        try:
            xls = pd.ExcelFile(excel_path, engine="openpyxl")
            sheet_names = xls.sheet_names
        except Exception as e:
            self.log_queue.put(
                ("ERROR", "Excel Read Error", f"Could not read Excel workbook: {e}")
            )
            return

        target_sheets = ["input addon", "Obsolete input addon(completed)"]
        sheets_to_load = [
            s for s in sheet_names if s.lower() in (ts.lower() for ts in target_sheets)
        ]

        if not sheets_to_load:
            self.log_queue.put(
                (
                    "ERROR",
                    "Sheets Missing",
                    f"Expected sheets not found: {target_sheets}",
                )
            )
            return

        dfs = {}
        for sheet in sheets_to_load:
            try:
                df = pd.read_excel(
                    excel_path, sheet_name=sheet, engine="openpyxl", dtype=object
                )
                dfs[sheet] = df
                self.log_queue.put(f"Loaded sheet: {sheet} ({len(df)} rows)")
            except Exception as e:
                self.log_queue.put(f"Warning: Failed to load sheet {sheet}: {e}")

        # --- Step 1: Gather all data in memory first ---
        self.log_queue.put("Gathering data for all JobIDs...")
        records_to_process = []
        for jid in jobids:
            row = None
            for sheet in sheets_to_load:
                row = get_row_for_jobid(dfs.get(sheet), jid)
                if row is not None:
                    break

            if row is None:
                self.log_queue.put(f"  -> JobID {jid} not found. Skipping.")
                continue

            final_vector = get_field_from_row(
                row, ["Final Vector", "FinalVector"], fallback_index=8
            )
            insert_seq = get_field_from_row(
                row, ["Insert Seq", "InsertSeq"], fallback_index=7
            )

            if not final_vector:
                self.log_queue.put(f"  -> No 'Final Vector' for {jid}. Skipping.")
                continue

            records_to_process.append(
                {"jobid": jid, "vector": final_vector, "insert": insert_seq}
            )
            self.log_queue.put(f"  -> Data for {jid} collected.")

        if not records_to_process:
            self.log_queue.put("No valid records found to process.")
            self.log_queue.put("DONE")
            return

        # --- Step 2: Pre-start "Ready" dialog ---
        total = len(records_to_process)
        self.log_queue.put(
            f"\nAll {total} JobID(s) loaded. Waiting for user confirmation..."
        )
        self.log_queue.put(
            "A dialog will appear. Click OK, then switch to SnapGene."
        )

        try:
            choice = _ask_main_thread(
                master, _show_ready_dialog, master, total
            )
        except Exception as e:
            self.log_queue.put(f"Could not show ready dialog: {e}")
            self.log_queue.put("Aborted before automation started.")
            self.log_queue.put("DONE")
            return

        if choice != "ok":
            self.log_queue.put("Aborted by user before automation started.")
            self.log_queue.put("DONE")
            return

        # --- Step 3: 10-second pre-start countdown ---
        self.log_queue.put("Starting in 10 seconds. Switch to SnapGene now.")
        try:
            proceed = _ask_main_thread(
                master, _show_pre_start_countdown_dialog, master, 10
            )
        except Exception as e:
            self.log_queue.put(f"Could not show countdown dialog: {e}")
            self.log_queue.put("Aborted during countdown.")
            self.log_queue.put("DONE")
            return

        if not proceed:
            self.log_queue.put("Aborted by user during countdown (FailSafe).")
            self.log_queue.put("DONE")
            return

        self.log_queue.put("Launching SnapGene automation...")

        # --- Step 4: Per-JobID automation with focus check ---
        try:
            for i, record in enumerate(records_to_process, start=1):
                jid = record["jobid"]
                vector = record["vector"]
                insert = record["insert"]
                self.log_queue.put(f"[{i}/{total}] Processing: {jid}")

                # Mid-run focus check (with retry loop).
                # After Retry/Continue the user has just clicked a button on
                # the app, so focus is on the app -- not SnapGene. We give
                # them a short countdown to switch windows before the next
                # foreground check runs.
                while True:
                    if _is_snapgene_foreground():
                        break  # proceed with automation

                    self.log_queue.put(
                        f"  -> SnapGene is not the foreground window before {jid}."
                    )
                    try:
                        action = _ask_main_thread(
                            master, _show_focus_loss_dialog, master, jid
                        )
                    except Exception as e:
                        self.log_queue.put(f"Could not show focus-loss dialog: {e}")
                        self.log_queue.put("Aborting run.")
                        return

                    if action == "cancel":
                        self.log_queue.put(
                            f"Aborted by user after focus loss on JobID {jid}."
                        )
                        return

                    if action in ("retry", "continue"):
                        # Show the short switch countdown so the user can
                        # click SnapGene to bring it to the foreground
                        # before we re-check focus.
                        self.log_queue.put(
                            f"  -> {action.capitalize()} selected. "
                            "Give the user 5 seconds to switch to SnapGene."
                        )
                        try:
                            _ask_main_thread(
                                master, _show_switch_countdown_dialog, master, 5
                            )
                        except Exception as e:
                            self.log_queue.put(
                                f"Could not show switch countdown: {e}"
                            )
                            # Treat as if the countdown completed; fall
                            # through to the focus re-check.
                        if action == "continue":
                            self.log_queue.put(
                                f"  -> Continuing past focus check for {jid}."
                            )
                            break
                        # action == "retry": loop and recheck focus

                # Run the actual automation block
                try:
                    self._automate_one(jid, vector, insert)
                except pyautogui.FailSafeException:
                    self.log_queue.put(
                        f"  -> Aborted via pyautogui FailSafe on JobID {jid}."
                    )
                    self.log_queue.put("Aborting run.")
                    return
                except Exception as e:
                    self.log_queue.put(
                        f"  -> An error occurred during automation for {jid}: {e}"
                    )
                    self.log_queue.put("  -> Aborting automation.")
                    self.log_queue.put(
                        (
                            "ERROR",
                            "Automation Error",
                            f"An error occurred: {e}\nProcessing stopped.",
                        )
                    )
                    return
        finally:
            # ALWAYS reach this block, even on exceptions or early returns.
            # Guarantees the app's queue pump sees DONE and re-enables
            # the Process IDs button.
            #
            # Brief sleep before the final puts: gives the app's queue
            # pump (master.after(100, ...)) a chance to drain any earlier
            # log messages and also makes sure "Automation complete."
            # shows up AFTER all per-JobID log lines, in the right order.
            time.sleep(0.3)
            self.log_queue.put("\nAutomation complete.")
            self.log_queue.put("DONE")