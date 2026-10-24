import json
from pathlib import Path
import paramiko
import hashlib
import posixpath

repo = Path('E:/github/cs-platform-service')
host = '47.111.11.68'
lines = (repo / 'README.md').read_text(encoding='utf-8').splitlines()
line = next((s for s in lines if f'服务器 {host}:22' in s), None)
if line is None:
    raise SystemExit('Deployment credential entry unavailable')
password = line.split()[-1]
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.RejectPolicy())
try:
    client.connect(host, username='root', password=password, timeout=15,
                   auth_timeout=15, banner_timeout=15, allow_agent=False, look_for_keys=False)
    _, stdout, stderr = client.exec_command('docker inspect cs-platform-server', timeout=20)
    raw = stdout.read(2_000_000)
    status = stdout.channel.recv_exit_status()
    if status != 0:
        raise SystemExit('Container inspection unavailable')
    data = json.loads(raw)[0]
    env = dict(s.split('=', 1) for s in data['Config'].get('Env', []) if '=' in s)
    _, process_out, _ = client.exec_command('docker exec cs-platform-server cat /proc/1/cmdline', timeout=15)
    process_args = process_out.read(32768).decode().split('\0')
    process_args = [arg for arg in process_args if arg]
    print(json.dumps({'processArgNames': [a.split('=', 1)[0] if a.startswith('-') else
                      (a if a in ('java', '/app/app.jar') else '<value>') for a in process_args],
                      'hasLoaderPath': bool(env.get('LOADER_PATH')), 'hasClasspath': bool(env.get('CLASSPATH'))}))
    if process_out.channel.recv_exit_status() != 0 or '-jar' not in process_args:
        raise SystemExit('Nonstandard launcher; inspect effective classpath before packaging')
    jar_index = process_args.index('-jar')
    _, cwd_out, _ = client.exec_command('docker exec cs-platform-server readlink /proc/1/cwd', timeout=15)
    process_cwd = cwd_out.read(4096).decode().strip()
    jar_args = process_args[jar_index + 1:]
    if cwd_out.channel.recv_exit_status() != 0 or len(jar_args) != 1 or posixpath.normpath(
        posixpath.join(process_cwd, jar_args[0])) != '/app/app.jar' or any(
        arg in ('-cp', '-classpath', '--class-path') or arg.startswith('-Dloader.') for arg in process_args
    ) or env.get('LOADER_PATH') or env.get('CLASSPATH'):
        raise SystemExit('Additional loader configuration needs explicit packaging review')
    print(json.dumps({'launcher': 'java -jar /app/app.jar', 'externalClasspath': False}))
    print(json.dumps({
        'image': data['Config']['Image'], 'created': data['Created'],
        'status': data['State']['Status'], 'health': data['State'].get('Health', {}).get('Status'),
        'mounts': [{'source': m['Source'], 'destination': m['Destination']} for m in data['Mounts']],
        'controller_config_keys': [k for k in env if k.startswith('CCODE_')],
        'compose_project': data['Config'].get('Labels', {}).get('com.docker.compose.project'),
        'compose_files': data['Config'].get('Labels', {}).get('com.docker.compose.project.config_files'),
    }, ensure_ascii=False))
    sftp = client.open_sftp()
    for directory in ['/opt/cs-platform/releases/jdy-inventory-subscription-20261021',
                      '/opt/cs-platform/releases/jdy-all-subscriptions-20261020']:
        try:
            print(json.dumps({'directory': directory, 'files': sftp.listdir(directory)}, ensure_ascii=False))
        except OSError:
            print(json.dumps({'directory': directory, 'available': False}))
    artifact = '/opt/cs-platform/releases/jdy-inventory-subscription-20261021/app.jar'
    _, hashes, _ = client.exec_command(
        'docker exec cs-platform-server sha256sum /app/app.jar && sha256sum ' + artifact, timeout=30)
    hash_lines = hashes.read(2048).decode().splitlines()
    if hashes.channel.recv_exit_status() != 0 or len(hash_lines) != 2:
        raise SystemExit('Baseline digest unavailable')
    live_digest, artifact_digest = [s.split()[0] for s in hash_lines]
    if live_digest != artifact_digest:
        raise SystemExit('Running artifact differs from release artifact')
    staging = repo / '.local-data/ccode-controller-release'
    staging.mkdir(exist_ok=True)
    baseline = staging / 'baseline.jar'
    if not baseline.exists():
        temporary = staging / 'baseline.jar.downloading'
        sftp.get(artifact, str(temporary))
        with temporary.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != live_digest:
            raise SystemExit('Downloaded artifact digest mismatch')
        temporary.rename(baseline)
    with baseline.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != live_digest:
            raise SystemExit('Staged baseline is stale; preserve it and select a new release directory')
    manifest = {'image': data['Config']['Image'], 'imageId': data['Image'],
                'containerId': data['Id'], 'sha256': live_digest,
                'effectiveJar': '/app/app.jar', 'externalClasspath': False,
                'controllerConfigKeys': [k for k in env if k.startswith('CCODE_')],
                'composeFiles': data['Config'].get('Labels', {}).get('com.docker.compose.project.config_files')}
    (staging / 'baseline.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps({'baseline': str(baseline), 'bytes': baseline.stat().st_size,
                      'sha256': live_digest}))
    sftp.close()
finally:
    client.close()
