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
    program = '''import json,subprocess,importlib.util,shutil,os,urllib.parse,re,sys,base64,hashlib
sys.excepthook=lambda t,v,tb: print(json.dumps({'inspectionExceptionType':t.__name__}))
print(json.dumps({'databaseTools':{'psql':bool(shutil.which('psql')),'psycopg':importlib.util.find_spec('psycopg') is not None,'psycopg2':importlib.util.find_spec('psycopg2') is not None}}))
containers=json.loads(subprocess.check_output(['docker','ps','--format','json']).decode().replace('}\\n{','},{').join(['[',']']))
print(json.dumps({'containers':[{'name':c['Names'],'image':c['Image']} for c in containers]}))
data=json.loads(subprocess.check_output(['docker','inspect','cs-platform-server']))[0]
env=dict(s.split('=',1) for s in data['Config']['Env'] if '=' in s)
print(json.dumps({'datasourceEnvironmentKeys':[k for k in env if 'DATASOURCE' in k.upper()]}))
public_pem=env.get('CCODE_CONTROLLER_PUBLIC_KEY_PEM','')
if public_pem:
 public_der=base64.b64decode(re.sub(r'-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\\s','',public_pem),validate=True)
 print(json.dumps({'controllerPublicKey':{'spkiDerSha256':hashlib.sha256(public_der).hexdigest(),'pemUtf8Sha256':hashlib.sha256(public_pem.encode()).hexdigest()}}))
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
sql="SELECT json_build_object('controllerTable',to_regclass('public.system_ccode_controller_release'),'folder',(SELECT row_to_json(f) FROM (SELECT id,tenant_id,library_code,parent_id,name,deleted FROM knowledge_base_folder WHERE id=166) f));"
db=subprocess.run(['psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-c',sql],env=db_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
if db.returncode:
 error=db.stderr.decode(errors='replace')
 print(json.dumps({'databaseErrorCodes':re.findall(r'ERROR:  ([0-9A-Z]{5})',error),'exitCode':db.returncode,
 'failureKinds':[s for s in ['could not translate host name','password authentication failed','SCRAM','SSL','Connection refused','timeout expired','no pg_hba.conf entry'] if s in error],
 'psqlVersion':subprocess.check_output(['psql','--version']).decode().strip()}))
 raise SystemExit('Database preflight failed')
print(json.dumps({'databasePreflight':json.loads(db.stdout)}))
if json.loads(db.stdout)['controllerTable']:
 schema_sql="SELECT json_build_object('columns',(SELECT json_agg(c ORDER BY ordinal_position) FROM (SELECT column_name,data_type,is_nullable,column_default,ordinal_position FROM information_schema.columns WHERE table_schema='public' AND table_name='system_ccode_controller_release') c),'constraints',(SELECT json_agg(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid='public.system_ccode_controller_release'::regclass),'sequence',pg_get_serial_sequence('public.system_ccode_controller_release','id'),'rows',(SELECT count(*) FROM public.system_ccode_controller_release));"
 checked=subprocess.run(['psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-c',schema_sql],env=db_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
 if checked.returncode: raise SystemExit('Schema inspection failed')
 print(json.dumps({'controllerSchema':json.loads(checked.stdout)}))
paths=data['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
for path in paths:
    with open(path) as f: compose=json.load(f)
    print(json.dumps({'file':path,'services':{name:{'image':s.get('image'),'environmentKeys':[entry.split('=',1)[0] for entry in s.get('environment',{})],
      'volumes':s.get('volumes',[]),'networks':s.get('networks',[]),'ports':s.get('ports',[]),'dependsOn':list(s.get('depends_on',{}))}
      for name,s in compose.get('services',{}).items()}}))
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
