"""Execute the bundled reference's processing with inert Streamlit widgets.

No Streamlit server, GUI, downloads or instrument access. The actual reference
algorithm executes unchanged; only UI input/output calls are supplied by a stub.
"""
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import pandas as pd

request=json.load(sys.stdin)
class Widgets(ModuleType):
    def __init__(self):
        super().__init__('streamlit')
        self.session_state={}
        self.column_config=SimpleNamespace(TextColumn=lambda *a,**k:None)
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def __getattr__(self,key): return lambda *a,**k:None
    def tabs(self,labels): return [self]*len(labels)
    def columns(self,widths,**kwargs): return [self]*(widths if isinstance(widths,int) else len(widths))
    def selectbox(self,label,options,index=0,**kwargs):
        return request['options']['source' if 'source' in label.lower() else 'target']
    def slider(self,label,**kwargs): return request['options']['volume']
    def checkbox(self,label,value=True,key=None,**kwargs):
        field='pool' if 'Pool' in label else 'autoWells' if 'wells' in label else 'autoSort'
        result=request['options'][field]
        if key:self.session_state[key]=result
        return result
    def button(self,label,**kwargs): return label in ('Create worklist','Create validation')
    def data_editor(self,df,**kwargs): return pd.DataFrame(request['rows'],columns=df.columns)
    def text_input(self,*args,**kwargs): return ''
    def stop(self): raise ValueError('Reference rejected the input')

widgets=Widgets();sys.modules['streamlit']=widgets
source=Path(__file__).resolve().parent.parent/'python-app/Code/Integra_worklist/integra_worklist_app.py'
exec(compile(source.read_text(encoding='utf-8-sig'),str(source),'exec'),{'__name__':'__reference_oracle__'})
print(json.dumps({'automation':widgets.session_state['bm_df']['Automation_string'].tolist(),
                  'validation':json.loads(widgets.session_state['validation_df'].to_json(orient='values'))}))
