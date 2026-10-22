// Compatibility entry point; staging is owned by the shared toolchain.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'../../build-tools/Stage-LocalPython.ps1')],{stdio:'inherit',cwd:path.resolve(__dirname,'..')});
process.exit(r.status ?? 1);
