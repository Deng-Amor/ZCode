"""Explicit server-only cutover/rollback with durable, secret-free status."""
import ast
import json
import sys
from pathlib import Path
import paramiko

ROOT = '/opt/cs-platform/releases/ccode-controller-20261021'
MODE = sys.argv[1] if len(sys.argv) == 2 else 'status'
if MODE not in ('status', 'deploy', 'rollback'):
    raise SystemExit('Use status, deploy, or rollback')

# Reuse the reviewed full effective-config comparison immediately before mutation.
tree = ast.parse(Path(__file__).with_name('preflight-ccode-cutover.py').read_text(encoding='utf-8'))
preflight = next(ast.literal_eval(n.value) for n in ast.walk(tree)
                 if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'program' for t in n.targets))
preflight = preflight[:preflight.index("print(json.dumps({'configurationVerified'")]
preflight += '''
current_hash=subprocess.check_output(original+['config','--hash','server']).decode().strip().split()[-1]
if current_hash!=live['Config']['Labels'].get('com.docker.compose.config-hash'):
 raise RuntimeError('Effective baseline drifted')
'''

worker = '''import hashlib,json,os,sys,time,subprocess,fcntl
os.umask(0o077)
root=ROOT_VALUE
mode=MODE_VALUE
def state(value):
 value['mode']=mode
 value['time']=int(time.time())
 with open(root+'/'+mode+'-status.next','w') as stream: json.dump(value,stream)
 os.rename(root+'/'+mode+'-status.next',root+'/'+mode+'-status.json')
lock=open(root+'/cutover.lock','a')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
try:
 state({'phase':'preflight'})
 if mode=='deploy':
  exec(PREFLIGHT_VALUE)
  if live['State'].get('Health',{}).get('Status')!='healthy': raise RuntimeError('Baseline is not healthy')
  if not after['services']['server'].get('healthcheck'): raise RuntimeError('Healthcheck missing')
  evidence={'baselineImageId':plan['baselineImageId'],'newImageId':built['imageId'],
   'baselineImage':plan['baselineImage'],'composeProject':plan['composeProject'],
   'projectWorkingDirectory':plan['projectWorkingDirectory'],'files':{}}
  for name,value in [('rollback-resolved',before),('deploy-resolved',after)]:
   # Compose config already escapes the command: preserve it and require an exact round trip.
   raw=json.dumps(value).encode('utf-8')
   path=root+'/'+name+'.json'
   with open(path,'xb') as stream: stream.write(raw)
   evidence['files'][name]=hashlib.sha256(raw).hexdigest()
   if config(prefix+['-f',path])!=value: raise RuntimeError('Frozen config differs')
  with open(root+'/cutover-evidence.json','x') as stream: json.dump(evidence,stream)
  command=prefix+['-f',root+'/deploy-resolved.json']
 else:
  # Recovery is independent of the new override, new image tag, and container existence.
  with open(root+'/cutover-evidence.json') as stream: evidence=json.load(stream)
  path=root+'/rollback-resolved.json'
  with open(path,'rb') as stream:
   if hashlib.sha256(stream.read()).hexdigest()!=evidence['files']['rollback-resolved']:
    raise RuntimeError('Rollback snapshot changed')
  inspect=subprocess.run(['docker','inspect','cs-platform-server'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  if inspect.returncode==0:
   live=json.loads(inspect.stdout)[0]
   if live['Image'] not in [evidence['baselineImageId'],evidence['newImageId']]:
    raise RuntimeError('Unrelated live image')
  else:
   # Distinguish a missing target from a daemon/transport failure.
   names=subprocess.check_output(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
   if 'cs-platform-server' in names: raise RuntimeError('Cannot inspect existing container')
  plan=evidence
  command=['docker','compose','--project-name',evidence['composeProject'],
   '--project-directory',evidence['projectWorkingDirectory'],'-f',path]
  old=json.loads(subprocess.check_output(['docker','image','inspect',plan['baselineImage']]))[0]
  if old['Id']!=plan['baselineImageId']: raise RuntimeError('Rollback image changed')
 expected_id=evidence['newImageId'] if mode=='deploy' else evidence['baselineImageId']
 state({'phase':'recreating','expectedImageId':expected_id})
 with open(root+'/'+mode+'-compose.log','xb') as log:
  result=subprocess.run(command+['up','-d','--no-deps','--pull','never','server'],stdout=log,stderr=subprocess.STDOUT,timeout=180)
 if result.returncode: raise RuntimeError('Compose failed')
 deadline=time.time()+480
 while time.time()<deadline:
  current=json.loads(subprocess.check_output(['docker','inspect','cs-platform-server']))[0]
  health=current['State'].get('Health',{}).get('Status')
  if current['Image']!=expected_id: raise RuntimeError('Unexpected running image')
  state({'phase':'awaiting-health','health':health,'imageId':current['Image']})
  if health=='healthy':
   state({'phase':'healthy','health':health,'imageId':current['Image']})
   break
  if health=='unhealthy' or not current['State']['Running']: raise RuntimeError('Unhealthy container')
  time.sleep(5)
 else:
  state({'phase':'health-timeout','expectedImageId':expected_id})
  sys.exit(2)
except BaseException as error:
 if isinstance(error,SystemExit) and error.code==2: raise
 state({'phase':'needs-inspection','errorType':type(error).__name__})
 sys.exit(1)
'''.replace('ROOT_VALUE', repr(ROOT)).replace('MODE_VALUE', repr(MODE)).replace('PREFLIGHT_VALUE', repr(preflight))

host = '47.111.11.68'
line = next(s for s in Path('E:/github/cs-platform-service/README.md').read_text(encoding='utf-8').splitlines()
            if f'服务器 {host}:22' in s)
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.RejectPolicy())
try:
    client.connect(host, username='root', password=line.split()[-1], timeout=15,
                   auth_timeout=15, banner_timeout=15, allow_agent=False, look_for_keys=False)
    if MODE == 'status':
        program = '''import json,os,subprocess
root=ROOT_VALUE
result={}
for mode in ['deploy','rollback']:
 path=root+'/'+mode+'-status.json'
 if os.path.exists(path):
  with open(path) as stream: result[mode]=json.load(stream)
inspect=subprocess.run(['docker','inspect','cs-platform-server'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if inspect.returncode==0:
 live=json.loads(inspect.stdout)[0]
 result['live']={'imageId':live['Image'],'running':live['State']['Running'],'health':live['State'].get('Health',{}).get('Status')}
else:
 names=subprocess.check_output(['docker','ps','-a','--format','{{.Names}}']).decode().splitlines()
 result['live']={'state':'inspect-failed' if 'cs-platform-server' in names else 'missing'}
print(json.dumps(result))
'''.replace('ROOT_VALUE', repr(ROOT))
    else:
        program = '''import os,subprocess,json
os.umask(0o077)
root=ROOT_VALUE
mode=MODE_VALUE
path=root+'/'+mode+'-worker.py'
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as stream: stream.write(WORKER_VALUE)
with open(root+'/'+mode+'-worker.log','xb') as log:
 process=subprocess.Popen(['python3',path],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
print(json.dumps({'launched':True,'mode':mode,'pid':process.pid}))
'''.replace('ROOT_VALUE', repr(ROOT)).replace('MODE_VALUE', repr(MODE)).replace('WORKER_VALUE', repr(worker))
    stdin, stdout, stderr = client.exec_command('python3 -', timeout=30)
    stdin.write(program)
    stdin.channel.shutdown_write()
    output = stdout.read(8000).decode()
    code = stdout.channel.recv_exit_status()
    if code:
        raise SystemExit('Operation failed or outcome unknown; inspect status before retry')
    print(output)
finally:
    client.close()
