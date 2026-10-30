"""Small adapters around upstream processing; no GUI or runtime package installs."""
import ast
import importlib.util
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile

def load_upstream(name, filename):
    spec=importlib.util.spec_from_file_location(name,filename)
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module
    tree=ast.parse(Path(filename).read_text(encoding='utf-8-sig'),filename=str(filename))
    # Some upstream scripts auto-install optional packages. Only replace that
    # dependency guard; the actual processing functions execute unchanged.
    guard=ast.parse('def require(pkg, import_as=None):\n import importlib\n return importlib.import_module(import_as or pkg)\n').body[0]
    tree.body=[guard if isinstance(node,ast.FunctionDef) and node.name=='require' else node for node in tree.body]
    exec(compile(ast.fix_missing_locations(tree),str(filename),'exec'),module.__dict__)
    return module

def validate_archive(filename):
    with zipfile.ZipFile(filename) as archive:
        for item in archive.infolist():
            name=PurePosixPath(item.filename.replace('\\','/'))
            if name.is_absolute() or '..' in name.parts or ':' in item.filename or stat.S_ISLNK(item.external_attr>>16):
                raise ValueError('Unsafe archive member: '+item.filename)
        bad=archive.testzip()
        if bad:raise ValueError('Archive checksum failed: '+bad)

def private_word_conversion(source,output_directory,log):
    """Legacy DOC compatibility uses a private Word instance, never active Word."""
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    word=None;document=None
    try:
        word=win32com.client.DispatchEx('Word.Application')
        word.Visible=False;word.DisplayAlerts=0
        document=word.Documents.Open(str(Path(source).resolve()),ReadOnly=True)
        target=Path(output_directory)/(Path(source).stem+'.docx')
        document.SaveAs2(str(target.resolve()),FileFormat=16)
        return str(target)
    finally:
        if document:document.Close(False)
        if word:word.Quit()
        pythoncom.CoUninitialize()
