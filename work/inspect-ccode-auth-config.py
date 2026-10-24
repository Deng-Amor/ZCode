"""Read only selected non-secret deployment settings; never print Docker environment."""
import json
from pathlib import Path
import paramiko

repo = Path('E:/github/cs-platform-service')
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
    data = json.loads(stdout.read(2_000_000))[0]
    if stdout.channel.recv_exit_status() != 0:
        raise SystemExit('Container inspection failed')
    env = dict(s.split('=', 1) for s in data['Config'].get('Env', []) if '=' in s)
    result = {'image': data['Config']['Image']}
    for name in ('CS_CAPTCHA_ENABLE', 'SPRING_PROFILES_ACTIVE'):
        value = env.get(name)
        result[name] = value if value and len(value) < 80 else '<unset or nonstandard>'
    result['hasSpringApplicationJson'] = 'SPRING_APPLICATION_JSON' in env
    print(json.dumps(result))
finally:
    client.close()
