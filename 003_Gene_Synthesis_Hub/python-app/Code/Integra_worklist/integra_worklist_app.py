"""
Bio Basic Inc. - Canada
Made by: Eduardo Reyes, Ph.D.
Contact: ed5reyes@outlook.com

Version: 4.6
Date: Nov 4, 2026
Notes: Row sort becomes a selector next to Auto-assign wells:
    - Sample number (last 4 digits of Work No.) (default): Work No. digits 6-9 cast to int, ASC
    - None (paste order): no sorting at all; with auto-assign wells the
      target wells are generated in the pasted row order — the
      "everything already prepared, just need the worklist" mode; pooling
      still optional
    - Seq reactions, then digits: reactions (DESC), digits (ASC), then
      plate position; requires the Seq reactions column (hidden otherwise)
    - Manual wells always keep the user's row order (info note shown when
      a sort mode is picked with manual wells)
    - Restores the v4.3 behavior the v4.4 audit round lost:
      feature-locked editor columns hide again (Clone with Pool
      replicates off, Seq well with Auto-assign wells on), Work No.
      digits 6-9 keys survive appended suffixes, ties keep the pasted
      order
    - Keeps the v4.4 audit fixes: numeric Seq reactions handling, the
      _BulkAbort error flow, the Plasmid No. source-well regex guard,
      pooled validation blank-Clone keys, duplicate manual target well
      rejection, validation rebuild on rerun, and the Clear worklist
      button
"""

###############################################################################

# Import the required libraries
import re

import numpy as np
import pandas as pd
import streamlit as st

# Streamlit App setup
st.set_page_config(
    page_title="Worklist Automation", page_icon=":bar_chart:", layout="wide"
)
st.title("Create worklist for Integra liquid handler")
st.markdown(
    """<hr style="border: none; height: 5px; background-color: #444;">""",
    unsafe_allow_html=True,
)

# Make tabs for the options
bulk_mode_tab, single_entries_tab = st.tabs(["Bulk mode", "Single entries"])
st.markdown(
    """<hr style="border: none; height: 5px; background-color: #444;">""",
    unsafe_allow_html=True,
)

# Create initial plate layouts (used by all modes)
plate_rows = ["A", "B", "C", "D", "E", "F", "G", "H"]
plate_cols_96 = range(1, 13)
plate_wells_96 = [f"(#{r}{c})" for c in plate_cols_96 for r in plate_rows]
# Bare well keys ("A1".."H12") for sorting and manual-well comparisons
_sort_well_keys = [w.replace("(#", "").replace(")", "") for w in plate_wells_96]


def _norm_well(value):
    """Normalize a well spelling like '(#A1)' or ' a1 ' to the bare 'A1' form."""
    return (
        str(value).replace("(", "").replace(")", "").replace("#", "").strip().upper()
    )


def _sort_digits(series):
    """Work No. digits at positions 6-9 cast to int.

    Work numbers are 9 chars in the common case, so this reads the last
    4 characters; longer values keep the same key because additions are
    appended at the end (pooling suffixes, Stbl marks), never before.
    """
    return pd.to_numeric(
        series.fillna("").astype(str).str.strip().str.slice(5, 9),
        errors="coerce",
    )


def assign_and_sort_worklist(df, *, pool, autowell, sort_mode):
    """Pooling, well assignment and row ordering for bulk mode.

    Pure helper (no Streamlit calls) so the order logic stays testable.
    Returns (error message or None, assigned df).

    Row order by sort mode (only applied on generated wells; manual wells
    always keep the user's own row order):
    - 'Seq reactions, then digits': Seq reactions (DESC), then Work No.
      digits 6-9 (ASC), then plate position (ASC)
    - 'Sample number (last 4 digits of Work No.)': Work No. digits 6-9 (ASC)
    - 'None (paste order)': no sorting; wells are generated in paste order
    """
    df = df.copy()

    def _digit_key_error():
        _bad = ", ".join(
            f"'{v}'" for v in df.loc[_digits.isna(), "work_no"].astype(str).head(10)
        )
        return (
            "Error: these Work No. values have no readable digits at "
            "positions 6-9 (expected 4 digits there, like XV1690506 giving "
            f"506):\n{_bad}"
        )

    if autowell and sort_mode == "Seq reactions, then digits":
        # Numeric sorting: sorting the raw strings would mis-order 9 vs 10
        if df["Seq_reactions"].isnull().any() or (df["Seq_reactions"] == "").any():
            return (
                "Error: the reaction sort is selected, but some rows are "
                "missing a 'Seq reactions' number.",
                df,
            )
        numeric_reactions = pd.to_numeric(
            df["Seq_reactions"].astype(str).str.strip(), errors="coerce"
        )
        if numeric_reactions.isnull().any():
            return (
                "Error: the reaction sort is selected, but the 'Seq "
                "reactions' contains non-numeric values.",
                df,
            )
        df["Seq_reactions"] = numeric_reactions

        _digits = _sort_digits(df["work_no"])
        if _digits.isnull().any():
            return (_digit_key_error(), df)
        # Ties (same reaction + same digits) keep the pasted order
        df = (
            df.assign(_sort_digits=_digits)
            .sort_values(
                ["Seq_reactions", "_sort_digits"],
                ascending=[False, True],
                kind="mergesort",
            )
            .reset_index(drop=True)
        )
    elif autowell and sort_mode == "Sample number (last 4 digits of Work No.)":
        # Order by the Work No. digits 6-9 alone
        _digits = _sort_digits(df["work_no"])
        if _digits.isnull().any():
            return (_digit_key_error(), df)
        df = (
            df.assign(_sort_digits=_digits)
            .sort_values("_sort_digits", kind="mergesort")
            .reset_index(drop=True)
        )
    # 'None (paste order)' and manual wells: no pre-sort

    if autowell:
        # --- AUTO-ASSIGN WELLS ---
        if pool:
            # Auto-assign wells AND pool replicates
            assigned_wells = {}
            well_index = 0
            seq_well_values = []

            for i, row in df.iterrows():
                clone_id = row.get("Clone")
                clone_key = (
                    clone_id
                    if pd.notna(clone_id) and clone_id != ""
                    else f"__row_{i}"
                )

                if clone_key in assigned_wells:
                    seq_well_values.append(assigned_wells[clone_key])
                else:
                    if well_index >= len(
                        plate_wells_96
                    ):  # Check against plate size
                        return (
                            "Error: More than "
                            f"{len(plate_wells_96)} unique clone groups found. "
                            "Cannot assign to a 96-well plate.",
                            df,
                        )
                    assigned_well = plate_wells_96[well_index]
                    assigned_wells[clone_key] = assigned_well
                    seq_well_values.append(assigned_well)
                    well_index += 1
            df["Seq_well"] = (
                seq_well_values  # Assign the generated well list
            )
        else:
            # Auto-assign wells, NO pooling
            if len(df) > len(plate_wells_96):
                return (
                    f"Error: There are {len(df)} samples, but only "
                    f"{len(plate_wells_96)} wells available on the plate.",
                    df,
                )
            # Assign wells sequentially to the (potentially sorted) dataframe
            df["Seq_well"] = plate_wells_96[: len(df)]
    else:
        # --- MANUAL WELL ASSIGNMENT ---
        # Validation: Ensure Seq_well is filled
        if df["Seq_well"].isnull().any() or (df["Seq_well"] == "").any():
            return (
                "Error: 'Auto-assign wells' is unchecked, but some rows are "
                "missing a 'Seq well' value.",
                df,
            )

        if pool:
            # Manual wells AND pool replicates
            # Validation: Check for consistency within clone groups
            inconsistent_clones = []
            clones_to_check = df[df["Clone"].notna() & (df["Clone"] != "")]
            for clone_id, group in clones_to_check.groupby("Clone"):
                if group["Seq_well"].nunique() > 1:
                    wells = ", ".join(group["Seq_well"].unique())
                    inconsistent_clones.append(
                        f"Clone '{clone_id}' has conflicting wells: {wells}"
                    )

            if inconsistent_clones:
                return (
                    "Error: 'Pool replicates' is checked, but there are "
                    "inconsistencies in manual well assignments:\n\n"
                    + "\n".join(inconsistent_clones),
                    df,
                )
        else:
            # Manual wells, no pooling: no two rows may share a target
            # well (checked on normalized spellings so '(#A1)' and
            # 'A1' still compare equal)
            norm_wells = df["Seq_well"].astype(str).map(_norm_well)
            dup_wells = sorted(set(norm_wells[norm_wells.duplicated()]))
            if dup_wells:
                return (
                    "Error: 'Pool replicates' is unchecked, but multiple rows "
                    "share the same Seq well: " + ", ".join(dup_wells),
                    df,
                )

    # Final sort (reaction sort on generated wells only): reactions (DESC)
    # then plate position (ASC). Wells sort on normalized bare keys so
    # manually entered 'A1' and generated '(#A1)' compare equal; unknown
    # formats sort to the end but keep their entered spelling in the
    # output. Digits/paste-order modes are already in target order, and
    # manual wells skip sorting: the user's row order is their layout.
    if autowell and sort_mode == "Seq reactions, then digits":
        df = df.assign(
            _rx_sort=pd.to_numeric(df["Seq_reactions"], errors="coerce"),
            _well_sort=pd.Categorical(
                df["Seq_well"].astype(str).map(_norm_well),
                categories=_sort_well_keys,
                ordered=True,
            ),
        )
        df = (
            df.sort_values(
                ["_rx_sort", "_well_sort"],
                ascending=[False, True],
                kind="mergesort",
            )
            .reset_index(drop=True)
            .drop(columns=["_rx_sort", "_well_sort"])
        )

    return (None, df.drop(columns=["_sort_digits"], errors="ignore"))


class _BulkAbort(Exception):
    """Skips the rest of the bulk results without stopping the whole app.

    Replaces st.stop() inside the bulk pipeline: st.stop() also kills the
    validation section and the Single entries tab that render below it.
    """


# Columns accumulated by the Single entries mode
_single_entry_columns = [
    "work_no",
    "Source_spot",
    "Source_well",
    "Target_spot",
    "Target_well",
    "Transfer_volume",
    "Automation_string",
]

################################## BULK MODE ####################################
with bulk_mode_tab:
    st.subheader("Bulk Mode")

    # Layout, first row for input widgets, second for output widgets
    bm_row1_col1, bm_row1_col2 = st.columns([1.15, 4])
    st.markdown(
        """<hr style="border: none; height: 5px; background-color: #444;">""",
        unsafe_allow_html=True,
    )
    bm_row2_col1, bm_row2_col2 = st.columns([1.15, 4])

    # Show widgets for basic features
    with bm_row1_col1:
        # Basic required info
        bm_row1_col1_subcol1, bm_row1_col1_subcol2 = st.columns([1, 1], gap="medium")
        with bm_row1_col1_subcol1:
            bm_source_spot = st.selectbox(
                "Source spot",
                options=["A", "B", "C"],
                index=1,
            )
        with bm_row1_col1_subcol2:
            bm_target_spot = st.selectbox(
                "Target spot",
                options=["A", "B", "C"],
                index=2,
            )
        bm_transfer_volume = st.slider(
            "Volume to transfer",
            min_value=5,
            max_value=200,
            step=5,
            value=85,
        )

        st.divider()

        # Additional features
        pool_checkbox = st.checkbox(
            "Pool replicates",
            value=True,
            key="pool_replicates",
        )
        autowell_checkbox = st.checkbox(
            "Auto-assign wells",
            value=True,
            key="auto_well",
        )
        sort_mode = st.selectbox(
            "Row sort",
            options=["Sample number (last 4 digits of Work No.)", "None (paste order)", "Seq reactions, then digits"],
            index=0,
            key="sort_mode",
        )

        st.divider()

        # Buttons to create relevant docs
        bm_row1_col1_subcol3, bm_row1_col1_subcol4 = st.columns([1, 1], gap="small")
        with bm_row1_col1_subcol3:
            create_worklist = st.button("Create worklist", type="primary")
        with bm_row1_col1_subcol4:
            # The button is disabled if the worklist DF doesn't exist
            create_validation = st.button(
                "Create validation",
                type="primary",
                disabled="bm_df" not in st.session_state,
                key="create_validation_button",
            )

    # Create initial empty df
    bm_df_columns = [
        "work_no",
        "bbi_id",
        "Clone",
        "plasmid_no",
        "Notes",
        "Concentration",
        "ratio_260_280",
        "ratio_260_230",
        "Seq_reactions",
        "Seq_well",
    ]

    bm_df = pd.DataFrame("", index=range(96), columns=bm_df_columns)

    # Column aliases for display matching extraction log format
    _COLUMN_LABELS = {
        "work_no": "Work No.",
        "bbi_id": "BBI ID",
        "Clone": "Clone and Plate Source",
        "plasmid_no": "Plasmid No.",
        "Notes": "Notes",
        "Concentration": "Concentration",
        "ratio_260_280": "OD260/280",
        "ratio_260_230": "OD260/230",
        "Seq_reactions": "Seq reactions",
        "Seq_well": "Seq well",
    }

    # Build column_config for data_editor: canonical labels in every mode,
    # and feature-locked columns hidden for the modes where they are not
    # relevant (None = hidden): Clone only matters with pooling on,
    # Seq well only for manual assignment, Seq reactions only when the
    # reaction sort is active on generated wells
    _editor_col_config = {
        col: (
            None
            if (
                (col == "Clone" and not pool_checkbox)
                or (col == "Seq_well" and autowell_checkbox)
                or (
                    col == "Seq_reactions"
                    and (
                        sort_mode != "Seq reactions, then digits"
                        or not autowell_checkbox
                    )
                )
            )
            else st.column_config.TextColumn(_COLUMN_LABELS[col])
        )
        for col in bm_df_columns
    }

    # Show editable widget to accept input in a 96-well plate-like format
    with bm_row1_col2:
        st.caption("Paste up to 96 rows")
        bm_displayed_df = st.data_editor(
            bm_df,
            width="stretch",
            key="bm_displayed_df",
            column_config=_editor_col_config,
        )

    # Make the worklist when the button is pressed (or refresh a shown one).
    # _BulkAbort skips the rest of the bulk results WITHOUT stopping the app:
    # the validation section and the Single entries tab keep rendering.
    if create_worklist or "bm_df" in st.session_state:
        try:
            # 1. Filter for rows that the user actually filled in.
            bm_current = bm_displayed_df.copy()
            work_filled = (
                bm_current["work_no"].fillna("").astype(str).str.strip() != ""
            )
            plasmid_filled = (
                bm_current["plasmid_no"].fillna("").astype(str).str.strip() != ""
            )
            active_df = bm_current[work_filled & plasmid_filled].copy()

            def _fmt_cell(v):
                s = str(v).strip()
                return s if s else "(blank)"

            # 2. Warn about rows missing one of the two key columns.
            partial_rows = bm_current[work_filled != plasmid_filled]
            if not partial_rows.empty:
                _dropped = []
                for i, row in partial_rows.head(10).iterrows():
                    if str(row["plasmid_no"]).strip() == "":
                        _dropped.append(
                            f"row {i + 1}: Work No. '{_fmt_cell(row['work_no'])}' "
                            "has no Plasmid No."
                        )
                    else:
                        _dropped.append(
                            f"row {i + 1}: Plasmid No. '{_fmt_cell(row['plasmid_no'])}' "
                            "has no Work No."
                        )
                if len(partial_rows) > 10:
                    _dropped.append(f"... and {len(partial_rows) - 10} more rows")
                st.warning(
                    "Rows missing Work No. or Plasmid No. are excluded from the "
                    "worklist:\n" + "\n".join(_dropped)
                )

            # 3. If no valid rows, nothing to build; skip the section cleanly.
            if active_df.empty:
                if create_worklist:  # Only show the prompt on a button click
                    st.warning(
                        "Please fill in at least one row with both 'Work No.' "
                        "and 'Plasmid No.'."
                    )
                raise _BulkAbort()

            # 4. Plasmid No. format guard: each value must contain a readable
            #    source well (T0618P2A1 -> A1; two-digit plates and Stbl
            #    suffixes are fine, missing/ambiguous wells are not).
            src_wells = (
                active_df["plasmid_no"]
                .astype(str)
                .str.strip()
                .str.extract(
                    r"([A-H](?:1[0-2]|[1-9]))(?:Stbl.*)?$", flags=re.IGNORECASE
                )[0]
            )
            if src_wells.isna().any():
                _bad_list = ", ".join(
                    f"'{_fmt_cell(v)}'"
                    for v in active_df.loc[src_wells.isna(), "plasmid_no"]
                    .astype(str)
                    .head(10)
                )
                st.error(
                    "Error: these Plasmid No. values do not contain a readable "
                    f"source well (expected like T0618P2A1, giving well A1):\n"
                    f"{_bad_list}"
                )
                raise _BulkAbort()
            active_df["Source_well"] = src_wells.str.upper()

            # 5-7. Pooling, well assignment and row ordering:
            #   Sample number (last 4 digits of Work No.): Work No. digits 6-9 (ASC)
            #   None (paste order): no sorting, wells in paste order
            #   Seq reactions, then digits: reactions (DESC), digits 6-9
            #     (ASC), then plate position (ASC); reactions required
            #   Manual wells: always the user's own row order
            sort_error, active_df = assign_and_sort_worklist(
                active_df,
                pool=pool_checkbox,
                autowell=autowell_checkbox,
                sort_mode=sort_mode,
            )
            if sort_error:
                st.error(sort_error)
                raise _BulkAbort()

            if not autowell_checkbox and sort_mode != "None (paste order)":
                st.info(
                    "Auto-assign wells is unchecked: the rows keep the order "
                    "they were entered in (row sorting only applies with "
                    "generated wells)."
                )

            # 8. Finalize the DataFrame for output
            # Add constant values from the UI
            active_df["Source_spot"] = bm_source_spot
            active_df["Target_spot"] = bm_target_spot
            active_df["Transfer_volume"] = bm_transfer_volume

            active_df["Target_well"] = (
                active_df["Seq_well"].astype(str).str.replace(
                    r"[#\(\)]", "", regex=True
                )
            )
            active_df["Automation_string"] = active_df.apply(
                lambda row: f"{row['work_no']};{row['Source_spot']};{row['Source_well']};{row['Target_spot']};{row['Target_well']};{row['Transfer_volume']}",
                axis=1,
            )

            # Save the processed dataframe to session state for display
            st.session_state["bm_df"] = active_df

            # 9. Prepare for display and download
            # Get the updated df, keep only the automation string and rename column as the software utilises
            final_worklist2 = st.session_state["bm_df"]["Automation_string"]
            final_worklist2 = final_worklist2.rename(
                "SampleID;SourceDeckPosition;SourceWell;TargetDeckPosition;TargetWell;TransferVolume [µl]"
            )

            with bm_row2_col1:
                worklist2_name = st.text_input("Worklist Name", key="worklist2_name")
                download_worklist2 = st.download_button(
                    "Download Worklist",
                    data=final_worklist2.to_csv(index=False),
                    file_name=f"{(worklist2_name or '').strip() or 'worklist'}.csv",
                    mime="text/csv",
                    type="primary",
                    key="download_worklist2",
                )

            with bm_row2_col2:
                # Create a temporary DataFrame for display by dropping unwanted columns
                display_df = st.session_state["bm_df"].drop(
                    columns=[
                        "bbi_id",
                        "Notes",
                        "Concentration",
                        "ratio_260_280",
                        "ratio_260_230",
                        "Source_spot",
                        "Target_spot",
                        "Transfer_volume",
                    ]
                )
                st.dataframe(display_df, width="stretch")

            # 10. Validation df — rebuilt on every rerun so it always matches
            #     the displayed worklist; the button only reveals the section.
            validation_df = st.session_state["bm_df"].copy()
            validation_df["Clone"] = validation_df["Clone"].fillna("")

            # Define columns to keep (input order matches extraction log format)
            validation_columns = [
                "work_no",
                "bbi_id",
                "Clone",
                "plasmid_no",
                "Notes",
                "Concentration",
                "ratio_260_280",
                "ratio_260_230",
            ]

            # --- Conditionally consolidate rows if pooling is enabled ---
            if st.session_state.get("pool_replicates", False):
                # Pool key = Clone, but every blank-Clone row is its own
                # sample (mirrors the worklist well pooler, which gives each
                # blank-Clone row a separate well). Cleared Clone cells are
                # "" after the fillna above, so no null leaks into grouping.
                validation_df["_pool_key"] = np.where(
                    validation_df["Clone"] != "",
                    validation_df["Clone"],
                    "__row_" + validation_df.index.astype(str),
                )

                # Convert numeric columns to numeric types, coercing errors to NaN
                validation_df["Concentration"] = pd.to_numeric(
                    validation_df["Concentration"], errors="coerce"
                )
                validation_df["ratio_260_280"] = pd.to_numeric(
                    validation_df["ratio_260_280"], errors="coerce"
                )
                validation_df["ratio_260_230"] = pd.to_numeric(
                    validation_df["ratio_260_230"], errors="coerce"
                )

                # Consolidate by pool key; sort=False keeps first-appearance order
                aggregated_df = (
                    validation_df.groupby("_pool_key", sort=False)
                    .agg(
                        {
                            "Clone": "first",
                            "work_no": "first",
                            "bbi_id": "first",
                            "plasmid_no": lambda x: (
                                x.iloc[0]
                                if len(x) == 1
                                else x.iloc[0] + "x" + str(len(x))
                            ),
                            "Notes": "first",
                            "Concentration": "mean",
                            "ratio_260_280": "mean",
                            "ratio_260_230": "mean",
                        }
                    )
                    .reset_index()
                )

                validation_df = aggregated_df[validation_columns].copy()

                # Round the mean values to 3 decimal places
                validation_df[["Concentration", "ratio_260_280", "ratio_260_230"]] = (
                    validation_df[
                        ["Concentration", "ratio_260_280", "ratio_260_230"]
                    ].round(3)
                )
            else:
                # If not pooling, we still need to keep the row order and columns
                validation_df = validation_df[validation_columns]

            # Rename columns to match extraction log format
            validation_df = validation_df.rename(
                columns={
                    "work_no": "Work No.",
                    "bbi_id": "BBI ID",
                    "Clone": "Clone and Plate Source",
                    "plasmid_no": "Plasmid No.",
                    "ratio_260_280": "OD260/280",
                    "ratio_260_230": "OD260/230",
                }
            )

            # Save the processed DataFrame to session state
            st.session_state["validation_df"] = validation_df

            if create_validation and "bm_df" in st.session_state:
                # The button reveals the section; the data itself refreshes live
                st.session_state["show_validation"] = True

            # --- Display the validation section once it has been revealed ---
            if st.session_state.get("show_validation", False) and (
                "validation_df" in st.session_state
            ):
                st.markdown("---")
                st.subheader("Validation Data")

                val_row_col1, val_row_col2 = st.columns([1.15, 4])
                with val_row_col1:
                    # Use a new key for the text input to avoid conflicts
                    validation_name = st.text_input(
                        "Validation File Name", key="validation_name_input"
                    )
                    download_validation = st.download_button(
                        "Download Validation",
                        data=st.session_state["validation_df"].to_csv(index=False),
                        file_name=(
                            f"{(validation_name or '').strip() or 'validation'}.csv"
                        ),
                        mime="text/csv",
                        type="primary",
                        key="download_validation",
                    )
                with val_row_col2:
                    st.dataframe(st.session_state["validation_df"], width="stretch")
        except _BulkAbort:
            pass

############################## SINGLE ENTRIES MODE ##############################
with single_entries_tab:
    st.subheader("Single entries")

    row1_col1, row1_col2, row1_col3, row1_col4 = st.columns(4)
    plate_cols_96_48 = range(1, 7)
    row2_col1, row2_col2, row2_col3 = st.columns([2.5, 0.25, 1.25])

    # Display widgets to enter sample information
    with row1_col1:
        work_no = st.text_input(
            "Work No.",
            key="work_no",
            placeholder="None",
        )
    with row1_col2:
        source_spot = st.selectbox(
            "Source Spot",
            options=["A", "B", "C"],
            index=1,
            key="source_spot",
        )
    with row1_col3:
        target_spot = st.selectbox(
            "Target Spot",
            options=["A", "B", "C"],
            index=2,
            key="target_spot",
        )
    with row1_col4:
        transfer_volume = st.slider(
            "Transfer Volume",
            min_value=5,
            max_value=200,
            step=5,
            value=85,
            key="transfer_volume",
        )

    # Create buttons in a grid
    for row in plate_rows:
        # Generate the buttons for the 96-well plate
        with row2_col1:
            cols_1to12 = st.columns(12)

            for col_index, col in enumerate(plate_cols_96):
                # Generate button label (e.g., A1, B2, etc.)
                button_label = f"{row}{col}"
                # Display button in the appropriate column
                with cols_1to12[col_index]:
                    if st.button(
                        button_label,
                        key=button_label + "_96",
                    ):
                        # Update session state when a button is clicked
                        st.session_state["source_well"] = button_label

        # Generate the buttons for the 48-well plate
        with row2_col3:
            cols_1to6 = st.columns(6)
            for col_index2, col2 in enumerate(plate_cols_96_48):
                # Generate button label (e.g., A1, B2, etc.)
                button_label2 = f"{row}{col2}"
                # Display button in the appropriate column
                with cols_1to6[col_index2]:
                    if st.button(button_label2, key=button_label2 + "_48"):
                        # Update session state when a button is clicked
                        st.session_state["target_well"] = button_label2

    # Show additional widgets to preview and add or clear the selection
    (row3_col1, row3_col2, row3_col3, row3_col4, row3_col5, row3_col6, row3_col7) = (
        st.columns([3, 1, 3, 1, 3, 2, 3])
    )
    row4_col1, row4_col2 = st.columns([4, 1])

    # Error prevention/handling
    if work_no == "":
        st.session_state["error_1"] = True
    else:
        st.session_state["error_1"] = False
    if "source_well" not in st.session_state or st.session_state["source_well"] == "":
        st.session_state["error_2"] = True
    else:
        st.session_state["error_2"] = False
    if "target_well" not in st.session_state or st.session_state["target_well"] == "":
        st.session_state["error_3"] = True
    else:
        st.session_state["error_3"] = False

    # Messages to explicitely show what has been clicked for each sample
    message_1 = f"Transfer: {st.session_state.get('work_no', '')}"
    message_2 = f"From: {st.session_state.get('source_well', '')}"
    message_3 = f"To: {st.session_state.get('target_well', '')}"
    with row3_col1:
        (st.success if not st.session_state["error_1"] else st.error)(message_1)
    with row3_col3:
        (st.success if not st.session_state["error_2"] else st.error)(message_2)
    with row3_col5:
        (st.success if not st.session_state["error_3"] else st.error)(message_3)

    with row3_col7:
        add_to_worklist = st.button("Add sample", type="primary", key="add_to_worklist")

    # Add current selection and sample info to worklist
    if add_to_worklist:
        df = st.session_state.get(
            "df",
            pd.DataFrame(columns=_single_entry_columns),
        )

        # Check forany missing info that would trigger an error
        if (
            st.session_state["error_1"]
            or st.session_state["error_2"]
            or st.session_state["error_3"]
        ):
            st.rerun()
        else:
            # Add current selection and sample info to worklist
            new_row = {
                "work_no": work_no,
                "Source_spot": source_spot,
                "Source_well": st.session_state["source_well"],
                "Target_spot": target_spot,
                "Target_well": st.session_state["target_well"],
                "Transfer_volume": transfer_volume,
                "Automation_string": f"{work_no};{source_spot};{st.session_state['source_well']};{target_spot};{st.session_state['target_well']};{transfer_volume}",
            }
            df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
            st.session_state["df"] = df

            # Reset only the well buttons (for multiple samples with same gene ID) and rerun the app
            st.session_state["source_well"] = ""
            st.session_state["target_well"] = ""
            st.rerun()

    # Display current worklist
    if "df" in st.session_state:
        with row4_col1:
            st.dataframe(st.session_state["df"], width="stretch")

        final_worklist = st.session_state["df"]["Automation_string"]
        final_worklist = final_worklist.rename(
            "SampleID;SourceDeckPosition;SourceWell;TargetDeckPosition;TargetWell;TransferVolume [µl]"
        )

        with row4_col2:
            worklist_name = st.text_input("Save worklist as")
            clear_worklist = st.button(
                "Clear worklist", type="secondary", key="clear_single_worklist"
            )
            download_worklist = st.download_button(
                "Download Worklist",
                data=final_worklist.to_csv(index=False),
                file_name=f"{(worklist_name or '').strip() or 'worklist'}.csv",
                mime="text/csv",
                type="primary",
                key="download_worklist",
            )
        # Reset the accumulated rows and well selection on request
        if clear_worklist:
            st.session_state["df"] = pd.DataFrame(columns=_single_entry_columns)
            st.session_state["source_well"] = ""
            st.session_state["target_well"] = ""
            st.rerun()
