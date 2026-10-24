"""Read deployment shape while withholding environment values and database secrets."""
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
    program = '''import json,subprocess,importlib.util,shutil,os,urllib.parse,re,sys
sys.excepthook=lambda t,v,tb: print(json.dumps({'inspectionExceptionType':t.__name__}))
print(json.dumps({'databaseTools':{'psql':bool(shutil.which('psql')),'psycopg':importlib.util.find_spec('psycopg') is not None,'psycopg2':importlib.util.find_spec('psycopg2') is not None}}))
containers=json.loads(subprocess.check_output(['docker','ps','--format','json']).decode().replace('}\\n{','},{').join(['[',']']))
print(json.dumps({'containers':[{'name':c['Names'],'image':c['Image']} for c in containers]}))
data=json.loads(subprocess.check_output(['docker','inspect','cs-platform-server']))[0]
env=dict(s.split('=',1) for s in data['Config']['Env'] if '=' in s)
print(json.dumps({'datasourceEnvironmentKeys':[k for k in env if 'DATASOURCE' in k.upper()]}))
jdbc=env['SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_URL']
if not jdbc.startswith('jdbc:'): raise SystemExit('Unsupported database URL')
url=urllib.parse.urlparse(jdbc[5:])
print(json.dumps({'jdbcScheme':url.scheme}))
if url.scheme!='postgresql': raise SystemExit('Unsupported database')
resolved=subprocess.run(['docker','exec','cs-platform-server','getent','ahostsv4',url.hostname],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
if resolved.returncode: raise SystemExit('Database container DNS unavailable')
db_host=resolved.stdout.decode().split()[0]
db_env=os.environ.copy()
db_env.update(PGHOST=url.hostname,PGHOSTADDR=db_host,PGPORT=str(url.port or 5432),PGDATABASE=urllib.parse.unquote(url.path.lstrip('/')),
 PGUSER=env['SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_USERNAME'],PGPASSWORD=env['SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_PASSWORD'],
 PGCONNECT_TIMEOUT='10',PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000')
for key,value in urllib.parse.parse_qs(url.query).items():
 if key=='sslmode': db_env['PGSSLMODE']=value[0]
sql="SELECT json_build_object('release',(SELECT row_to_json(r) FROM (SELECT skill_id,version,digest,source_knowledge_file_id,source_archive_digest,revoked,tenant_id,deleted,length(encrypted_envelope) AS encrypted_length FROM public.system_ccode_controller_release WHERE tenant_id=1 AND skill_id='controller' AND version=1) r),'file',(SELECT row_to_json(f) FROM (SELECT id,folder_id,library_code,file_name,review_status,size,tenant_id,deleted FROM public.knowledge_base_file WHERE id=5615) f));"
result=subprocess.run(['psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',sql],env=db_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
if result.returncode: raise SystemExit('Publication inspection failed')
print(json.dumps({'publication':json.loads(result.stdout)}))
'''
    stdin, stdout, stderr = client.exec_command('python3 -', timeout=30)
    stdin.write(program)
    stdin.channel.shutdown_write()
    output = stdout.read(50000)
    if stdout.channel.recv_exit_status() != 0:
        print(output.decode())
        raise SystemExit('Deployment config inspection failed')
    print(output.decode())
finally:
    client.close()
