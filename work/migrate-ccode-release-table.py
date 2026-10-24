"""Create the new controller table transactionally; never alter existing business tables."""
import json
from pathlib import Path
import paramiko

repo = Path('E:/github/cs-platform-service')
host = '47.111.11.68'
line = next(s for s in (repo / 'README.md').read_text(encoding='utf-8').splitlines()
            if f'服务器 {host}:22' in s)
schema = (repo / 'sql/ccode-controller.sql').read_text(encoding='utf-8')
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.RejectPolicy())
try:
    client.connect(host, username='root', password=line.split()[-1], timeout=15,
                   auth_timeout=15, banner_timeout=15, allow_agent=False, look_for_keys=False)
    program = '''import json,subprocess,os,urllib.parse,re,sys
sys.excepthook=lambda t,v,tb: print(json.dumps({'migrationExceptionType':t.__name__}))
data=json.loads(subprocess.check_output(['docker','inspect','cs-platform-server']))[0]
if data['Config']['Image']!='cs-platform-server:jdy-inventory-subscription-20261021':
 raise SystemExit('Deployment baseline changed')
env=dict(s.split('=',1) for s in data['Config']['Env'] if '=' in s)
jdbc=env['SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_URL']
if not jdbc.startswith('jdbc:postgresql://'): raise SystemExit('Unsupported database URL')
url=urllib.parse.urlparse(jdbc[5:])
resolved=subprocess.run(['docker','exec','cs-platform-server','getent','ahostsv4',url.hostname],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
if resolved.returncode: raise SystemExit('Database DNS unavailable')
db_env=os.environ.copy()
db_env.update(PGHOST=url.hostname,PGHOSTADDR=resolved.stdout.decode().split()[0],PGPORT=str(url.port or 5432),
 PGDATABASE=urllib.parse.unquote(url.path.lstrip('/')),PGUSER=env['SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_USERNAME'],
 PGPASSWORD=env['SPRING_DATASOURCE_DYNAMIC_DATASOURCE_MASTER_PASSWORD'],PGCONNECT_TIMEOUT='10')
for key,value in urllib.parse.parse_qs(url.query).items():
 if key=='sslmode': db_env['PGSSLMODE']=value[0]
prefix="""BEGIN;
SET LOCAL search_path=public;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('ccode-controller-schema-v1',0));
DO $$ BEGIN
 IF to_regclass('public.system_ccode_controller_release') IS NOT NULL THEN
  RAISE EXCEPTION 'Controller table exists; inspect before continuing';
 END IF;
END $$;
"""
result=subprocess.run(['psql','-X','-q','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],
 input=(prefix+schema+'\\nCOMMIT;\\n').encode('utf-8'),env=db_env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45)
if result.returncode:
 print(json.dumps({'migration':'failed','sqlStates':re.findall(r'ERROR:  ([0-9A-Z]{5})',result.stderr.decode(errors='replace'))}))
 raise SystemExit(1)
print(json.dumps({'migration':'committed','table':'system_ccode_controller_release','businessTablesModified':False}))
'''
    program = 'schema = ' + repr(schema) + '\n' + program
    stdin, stdout, _ = client.exec_command('python3 -', timeout=55)
    stdin.write(program)
    stdin.channel.shutdown_write()
    output = stdout.read(10000).decode()
    code = stdout.channel.recv_exit_status()
    print(output)
    if code:
        raise SystemExit('Migration did not report success; inspect authoritative schema before retry')
finally:
    client.close()
