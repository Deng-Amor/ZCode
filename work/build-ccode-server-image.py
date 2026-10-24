"""Build the staged image only. No running container is replaced or started."""
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
    program = '''import hashlib,json,os,subprocess,sys
sys.excepthook=lambda t,v,tb: print(json.dumps({'buildExceptionType':t.__name__}))
root='/opt/cs-platform/releases/ccode-controller-20261021'
with open(root+'/deployment-plan.json') as stream: plan=json.load(stream)
context=root+'/image'
if set(os.listdir(context))!={'Dockerfile','app.jar'}: raise SystemExit('Unexpected build context')
with open(context+'/Dockerfile') as stream:
 old_dockerfile=stream.read()
 if old_dockerfile!='FROM '+plan['baselineImageId']+'\\nCOPY app.jar /app/app.jar\\n': raise SystemExit('Unexpected Dockerfile')
digest=hashlib.sha256()
with open(context+'/app.jar','rb') as stream:
 while True:
  chunk=stream.read(1024*1024)
  if not chunk: break
  digest.update(chunk)
if digest.hexdigest()!=plan['artifactSha256']: raise SystemExit('Artifact mismatch')
base=json.loads(subprocess.check_output(['docker','image','inspect',plan['baselineImageId']]))[0]
existing=subprocess.run(['docker','image','inspect',plan['image']],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if existing.returncode==0: raise SystemExit('Release image exists; inspect before retry')
tag=json.loads(subprocess.check_output(['docker','image','inspect',plan['baselineImage']]))[0]
if tag['Id']!=plan['baselineImageId']: raise SystemExit('Base tag changed')
for snapshot in plan['rollbackSnapshots']:
 with open(snapshot['snapshot'],'rb') as stream:
  if hashlib.sha256(stream.read()).hexdigest()!=snapshot['sha256']: raise SystemExit('Rollback snapshot changed')
if not os.path.isfile(root+'/build.log'): raise SystemExit('Original failure evidence missing')
fd=os.open(root+'/Dockerfile.failed-image-id',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as stream: stream.write(old_dockerfile)
fd=os.open(context+'/Dockerfile.next',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as stream: stream.write('FROM '+plan['baselineImage']+'\\nCOPY app.jar /app/app.jar\\n')
os.rename(context+'/Dockerfile.next',context+'/Dockerfile')
log_fd=os.open(root+'/build-attempt2.log',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(log_fd,'wb') as log:
 result=subprocess.run(['docker','build','--pull=false','--network=none','-t',plan['image'],context],
  stdout=log,stderr=subprocess.STDOUT,timeout=300)
if result.returncode: raise SystemExit('Image build failed; inspect restricted build log')
image=json.loads(subprocess.check_output(['docker','image','inspect',plan['image']]))[0]
tag=json.loads(subprocess.check_output(['docker','image','inspect',plan['baselineImage']]))[0]
if tag['Id']!=plan['baselineImageId']: raise SystemExit('Base tag changed during build')
base_layers=base['RootFS']['Layers']
new_layers=image['RootFS']['Layers']
if image['RootFS']['Type']!=base['RootFS']['Type'] or len(new_layers)!=len(base_layers)+1 or new_layers[:-1]!=base_layers:
 raise SystemExit('Built image does not preserve exact baseline layers')
for field in ['Entrypoint','Cmd','Env','User','Healthcheck','ExposedPorts','Volumes','WorkingDir']:
 if image['Config'].get(field)!=base['Config'].get(field): raise SystemExit('Image runtime configuration changed')
result={'built':True,'image':plan['image'],'imageId':image['Id'],
 'artifactSha256':plan['artifactSha256'],'runtimeConfigPreserved':True,'baselineLayersPreserved':True,'deployed':False}
fd=os.open(root+'/build-result.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as stream: json.dump(result,stream)
print(json.dumps(result))
'''
    stdin, stdout, _ = client.exec_command('python3 -', timeout=330)
    stdin.write(program)
    stdin.channel.shutdown_write()
    output = stdout.read(20000).decode()
    print(output)
    if stdout.channel.recv_exit_status() != 0:
        raise SystemExit('Server image build did not report success; preserve evidence')
finally:
    client.close()
