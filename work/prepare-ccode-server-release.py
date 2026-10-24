"""Stage a reviewed artifact and root-only config. Does not build or restart services."""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import paramiko

repo = Path('E:/github/cs-platform-service')
stage = repo / '.local-data/ccode-controller-release'
release = '/opt/cs-platform/releases/ccode-controller-20261021'
image_tag = 'cs-platform-server:ccode-controller-20261021'
report = json.loads((stage / 'artifact-diff.json').read_text(encoding='utf-8'))
for relative, expected in report['sourceHashes'].items():
    if hashlib.sha256((repo / relative).read_bytes()).hexdigest() != expected:
        raise SystemExit('Reviewed Java source changed; rebuild the release')
with (stage / 'app.jar').open('rb') as stream:
    if hashlib.file_digest(stream, 'sha256').hexdigest() != report['sha256']:
        raise SystemExit('Reviewed artifact changed')
spec = importlib.util.spec_from_file_location('ccode_admin_keys', Path(__file__).with_name('ccode-admin-keys.py'))
keys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keys)
storage = keys.dpapi((stage / 'signing/storage-key.dpapi').read_bytes(), decrypt=True)
if len(storage) != 32:
    raise SystemExit('Invalid storage key')
public = (stage / 'signing/public-key.pem').read_text(encoding='utf-8')
if hashlib.sha256(public.encode()).hexdigest() != 'af5badd5898fcaaf68ae054373a81c1e9439dd86ac4f10c6159838239b5ed275':
    raise SystemExit('Public trust mismatch')
override = {'services': {'server': {'image': image_tag, 'environment': {
    'CCODE_CONTROLLER_ENABLED': 'true', 'CCODE_CONTROLLER_KNOWLEDGE_FOLDER_ID': '166',
    'CCODE_CONTROLLER_PUBLIC_KEY_PEM': public,
    'CCODE_CONTROLLER_STORAGE_KEY_BASE64': base64.b64encode(storage).decode(),
}}}}
host = '47.111.11.68'
line = next(s for s in (repo / 'README.md').read_text(encoding='utf-8').splitlines()
            if f'服务器 {host}:22' in s)
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.RejectPolicy())
try:
    client.connect(host, username='root', password=line.split()[-1], timeout=15,
                   auth_timeout=15, banner_timeout=15, allow_agent=False, look_for_keys=False)
    _, stdout, _ = client.exec_command('docker inspect cs-platform-server', timeout=20)
    live = json.loads(stdout.read(2_000_000))[0]
    if stdout.channel.recv_exit_status() != 0:
        raise SystemExit('Live container inspection failed')
    baseline = report['baseline']
    if live['Image'] != baseline['imageId'] or live['Config']['Image'] != baseline['image']:
        raise SystemExit('Live image changed; reconcile before release')
    _, stdout, _ = client.exec_command('docker exec cs-platform-server sha256sum /app/app.jar', timeout=30)
    if stdout.read(1024).decode().split()[0] != baseline['sha256'] or stdout.channel.recv_exit_status() != 0:
        raise SystemExit('Live artifact changed')
    sftp = client.open_sftp()
    # Exclusive directory creation prevents overwriting an unknown previous attempt.
    sftp.mkdir(release, mode=0o700)
    sftp.chmod(release, 0o700)
    sftp.mkdir(release + '/image', mode=0o700)
    def write(name, content):
        with sftp.open(release + '/' + name, 'wx') as stream:
            stream.write(content)
        sftp.chmod(release + '/' + name, 0o600)
    write('override.json', json.dumps(override).encode())
    compose_files = live['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    project = live['Config']['Labels']['com.docker.compose.project']
    if project != 'cs-platform':
        raise SystemExit('Unexpected compose project')
    snapshots = []
    for index, path in enumerate(compose_files):
        with sftp.open(path, 'rb') as stream:
            content = stream.read()
        snapshot = 'rollback-compose-' + str(index) + '.json'
        write(snapshot, content)
        snapshots.append({'original': path, 'snapshot': release + '/' + snapshot,
                          'sha256': hashlib.sha256(content).hexdigest()})
    plan = {'baselineImage': baseline['image'], 'baselineImageId': baseline['imageId'],
            'baselineSha256': baseline['sha256'], 'artifactSha256': report['sha256'],
            'image': image_tag, 'composeFiles': compose_files, 'composeProject': project,
            'rollbackSnapshots': snapshots,
            'projectWorkingDirectory': live['Config']['Labels'].get('com.docker.compose.project.working_dir'),
            'releaseDirectory': release, 'deployed': False}
    write('deployment-plan.json', json.dumps(plan, indent=2).encode())
    write('image/Dockerfile', ('FROM ' + baseline['imageId'] + '\nCOPY app.jar /app/app.jar\n').encode())
    sftp.put(str(stage / 'app.jar'), release + '/image/app.jar.part', confirm=True)
    sftp.chmod(release + '/image/app.jar.part', 0o644)
    _, stdout, _ = client.exec_command('sha256sum ' + release + '/image/app.jar.part', timeout=30)
    if stdout.read(1024).decode().split()[0] != report['sha256'] or stdout.channel.recv_exit_status() != 0:
        raise SystemExit('Uploaded artifact mismatch; preserve staging and investigate')
    sftp.rename(release + '/image/app.jar.part', release + '/image/app.jar')
    print(json.dumps({'staged': True, 'releaseDirectory': release, 'sha256': report['sha256'],
                      'built': False, 'deployed': False}))
finally:
    client.close()
