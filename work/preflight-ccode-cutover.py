"""Read-only comparison of effective production compose configurations."""
import json
from pathlib import Path
import paramiko

host = '47.111.11.68'
line = next(s for s in Path('E:/github/cs-platform-service/README.md').read_text(encoding='utf-8').splitlines()
            if f'服务器 {host}:22' in s)
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.RejectPolicy())
try:
    client.connect(host, username='root', password=line.split()[-1], timeout=15,
                   auth_timeout=15, banner_timeout=15, allow_agent=False, look_for_keys=False)
    program = '''import hashlib,json,subprocess,sys
sys.excepthook=lambda t,v,tb: print(json.dumps({'preflightExceptionType':t.__name__}))
root='/opt/cs-platform/releases/ccode-controller-20261021'
with open(root+'/deployment-plan.json') as stream: plan=json.load(stream)
with open(root+'/build-result.json') as stream: built=json.load(stream)
live=json.loads(subprocess.check_output(['docker','inspect','cs-platform-server']))[0]
if live['Image']!=plan['baselineImageId']: raise SystemExit('Live image changed')
image=json.loads(subprocess.check_output(['docker','image','inspect',plan['image']]))[0]
if image['Id']!=built['imageId']: raise SystemExit('Prepared image changed')
if not plan['projectWorkingDirectory']: raise SystemExit('Missing compose working directory')
for snapshot in plan['rollbackSnapshots']:
 for path in [snapshot['original'],snapshot['snapshot']]:
  with open(path,'rb') as stream:
   if hashlib.sha256(stream.read()).hexdigest()!=snapshot['sha256']: raise SystemExit('Compose source changed')
prefix=['docker','compose','--project-name',plan['composeProject'],'--project-directory',plan['projectWorkingDirectory']]
original=prefix[:]
for path in plan['composeFiles']: original+=['-f',path]
updated=original+['-f',root+'/override.json']
def config(command):
 result=subprocess.run(command+['config','--format','json'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 if result.returncode: raise SystemExit('Compose render failed')
 return json.loads(result.stdout)
before=config(original)
after=config(updated)
expected=json.loads(json.dumps(before))
with open(root+'/override.json') as stream: override=json.load(stream)['services']['server']
if set(override)!=set(['image','environment']): raise SystemExit('Unexpected override fields')
if set(override['environment'])!=set(['CCODE_CONTROLLER_ENABLED','CCODE_CONTROLLER_KNOWLEDGE_FOLDER_ID','CCODE_CONTROLLER_PUBLIC_KEY_PEM','CCODE_CONTROLLER_STORAGE_KEY_BASE64']): raise SystemExit('Unexpected controller settings')
expected['services']['server']['image']=plan['image']
expected['services']['server'].setdefault('environment',{}).update(override['environment'])
if after!=expected: raise SystemExit('Unexpected compose changes')
print(json.dumps({'configurationVerified':True,'changedService':'server','changedFields':['image','four controller environment values'],
 'liveHealth':live['State'].get('Health',{}).get('Status'),'newImageId':image['Id'],
 'healthcheck':image['Config'].get('Healthcheck'),'projectWorkingDirectory':plan['projectWorkingDirectory'],
 'otherServicesUnchanged':True}))
'''
    stdin, stdout, _ = client.exec_command('python3 -', timeout=50)
    stdin.write(program)
    stdin.channel.shutdown_write()
    output = stdout.read(15000).decode()
    print(output)
    if stdout.channel.recv_exit_status() != 0:
        raise SystemExit('Cutover preflight did not pass')
finally:
    client.close()
