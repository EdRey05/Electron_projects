const assert=require('node:assert/strict');
const {parseIni,resolvePath}=require('../electron/config.cjs');
const ini=parseIni('[Tool]\npass_dir_as_kwarg = Primer_Log:primer_log_path; Reference_Sequences:reference_files_path\npath = C:\\data\\sample#1;final.xlsx\n; comment\n# comment\n');
assert.equal(ini.sections.Tool.pass_dir_as_kwarg,'Primer_Log:primer_log_path; Reference_Sequences:reference_files_path');
assert.equal(ini.sections.Tool.path,'C:\\data\\sample#1;final.xlsx');
assert.equal(resolvePath('B8. Gene Synthesis, "folder\\file.xlsx"',{'B8. Gene Synthesis':'Q:'}),'Q:\\folder\\file.xlsx');
assert.equal(resolvePath('B8. Gene Synthesis, "folder"',{}),'');
assert.equal(resolvePath('C:/data/a,b#1.xlsx'),'C:\\data\\a,b#1.xlsx');
console.log('Hub INI and path resolution: all argument pairs, literal #/semicolon, labeled paths and comma-containing absolute paths passed.');
