"""Minimal .xlsx writer (no openpyxl dependency).

Writes a single-sheet workbook with all values written as inline strings
(so no sharedStrings.xml needed). Output is a proper Office Open XML file
that Excel/LibreOffice/Numbers will open.

Usage:
    writer = XlsxWriter()
    writer.add_row(["col1", "col2", "col3"])
    writer.add_row(["a", "b", "c"])
    writer.write("output.xlsx")
"""
import zipfile
from xml.sax.saxutils import escape
from pathlib import Path


class XlsxWriter:
    def __init__(self):
        self.rows = []  # list of list of (value, type) where type is 'n' or 'inlineStr'

    def add_row(self, values):
        """Add a row of values. All written as inline strings."""
        self.rows.append([(str(v) if v is not None else "", "inlineStr") for v in values])

    def add_row_mixed(self, values):
        """Add a row with mixed numeric and string values."""
        row = []
        for v in values:
            if v is None or v == "":
                row.append(("", "inlineStr"))
            elif isinstance(v, (int, float)):
                row.append((v, "n"))
            else:
                row.append((str(v), "inlineStr"))
        self.rows.append(row)

    def write(self, path):
        """Write the .xlsx file. path can be str or Path."""
        if isinstance(path, str):
            path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        # Build sheet1.xml
        sheet_xml = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                     '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">']
        for row_idx, row in enumerate(self.rows, start=1):
            sheet_xml.append(f'<row r="{row_idx}">')
            for col_idx, (value, ctype) in enumerate(row):
                col_letter = _col_letter(col_idx)
                if ctype == "n":
                    sheet_xml.append(f'<c r="{col_letter}{row_idx}"><v>{value}</v></c>')
                else:  # inlineStr
                    safe = escape(str(value)) if value else ""
                    sheet_xml.append(f'<c r="{col_letter}{row_idx}" t="inlineStr"><is><t xml:space="preserve">{safe}</t></is></c>')
            sheet_xml.append('</row>')
        sheet_xml.append('</worksheet>')
        sheet_xml_bytes = "".join(sheet_xml).encode("utf-8")

        workbook_xml = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""

        workbook_rels = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""

        root_rels = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

        content_types = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""

        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", content_types)
            zf.writestr("_rels/.rels", root_rels)
            zf.writestr("xl/workbook.xml", workbook_xml)
            zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
            zf.writestr("xl/worksheets/sheet1.xml", sheet_xml_bytes)


def _col_letter(idx):
    """0->A, 1->B, ..., 25->Z, 26->AA, ..."""
    s = ""
    idx += 1
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        s = chr(65 + rem) + s
    return s