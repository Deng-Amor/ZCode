"""Private administrative WebBridge helper; never print raw network details."""
import json
import subprocess
import uuid
from pathlib import Path

def call(action, args=None):
    path=Path(__file__).parent/('webbridge-req-'+uuid.uuid4().hex+'.json')
    try:
        path.write_text(json.dumps({'action':action,'args':args or {},'session':'ccode-controller-kb'},ensure_ascii=False),encoding='utf-8')
        result=subprocess.run(['curl.exe','-sS','--max-time','30','-X','POST','http://127.0.0.1:10086/command',
                               '-H','Content-Type: application/json','--data-binary','@'+str(path)],
                              stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35)
        if result.returncode: raise RuntimeError('WebBridge transport failed')
        data=json.loads(result.stdout)
        if not data.get('ok'): raise RuntimeError('WebBridge action failed')
        return data['data']
    finally:
        path.unlink(missing_ok=True)
