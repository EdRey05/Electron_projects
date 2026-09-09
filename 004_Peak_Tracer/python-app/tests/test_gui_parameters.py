"""Exercise the actual Electron argv builder against the actual Python parser."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from peaktrace.config import parse_args


@unittest.skipUnless(shutil.which('node'),'Node is needed for the Electron/CLI contract')
class GuiParameterTests(unittest.TestCase):
    def test_default_and_disabled_settings_parse_and_match(self):
        root=Path(__file__).resolve().parents[2]
        for disabled in (False,True):
            code="const {advancedDefaults,advancedArgs}=require('./electron/parameters');let v={...advancedDefaults};"
            if disabled:code+="for(const k in v)if(typeof v[k]==='boolean')v[k]=false;"
            code+="console.log(JSON.stringify({values:v,args:advancedArgs(v)}));"
            result=subprocess.run(['node','-e',code],cwd=root,capture_output=True,text=True,check=True)
            data=json.loads(result.stdout)
            args=parse_args(['--input-dir','a','--output-dir','b']+data['args'])
            for js,py in [('resolvePeaks','resolve_peaks'),('recallLowQuality','recall_low_quality'),
                          ('baselineSmooth','baseline_smooth'),('doSmooth','do_smooth'),
                          ('leadDropEnabled','lead_drop_enabled'),('stripWellId','strip_well_id'),
                          ('setAbiLimits','set_abi_limits'),('smoothWindow','smooth_window')]:
                self.assertEqual(data['values'][js],getattr(args,py))

    def test_unknown_setting_is_rejected(self):
        root=Path(__file__).resolve().parents[2]
        result=subprocess.run(['node','-e',"require('./electron/parameters').advancedArgs({typo:true})"],cwd=root,capture_output=True)
        self.assertNotEqual(result.returncode,0)
