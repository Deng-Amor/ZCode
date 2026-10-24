"""Prepare an allowlisted class patch against the exact running production dependencies."""
import hashlib
import copy
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile

repo = Path('E:/github/cs-platform-service')
stage = repo / '.local-data/ccode-controller-release'
baseline = stage / 'baseline.jar'
manifest = json.loads((stage / 'baseline.json').read_text(encoding='utf-8'))
with baseline.open('rb') as stream:
    if hashlib.file_digest(stream, 'sha256').hexdigest() != manifest['sha256']:
        raise SystemExit('Baseline hash mismatch')
sources = {
    'cs-platform-spring-boot-starter-web': [
        'cn/iocoder/cs/framework/apilog/core/filter/ApiAccessLogFilter.java',
        'cn/iocoder/cs/framework/web/config/CsWebAutoConfiguration.java',
        *['cn/iocoder/cs/framework/web/core/handler/' + name + '.java' for name in
          ['GlobalExceptionHandler', 'CcodePayloadExceptionResolver', 'CcodePayloadPrivacy']],
    ],
    'cs-platform-module-infra': [
        'cn/iocoder/cs/module/infra/framework/file/core/client/FileClient.java',
        'cn/iocoder/cs/module/infra/framework/file/core/client/s3/S3FileClient.java',
    ],
    'cs-platform-module-system': [
        'cn/iocoder/cs/module/system/controller/admin/ccode/CcodeController.java',
        'cn/iocoder/cs/module/system/dal/dataobject/ccode/CcodeControllerReleaseDO.java',
        'cn/iocoder/cs/module/system/dal/mysql/ccode/CcodeControllerReleaseMapper.java',
        'cn/iocoder/cs/module/system/service/ccode/CcodeControllerService.java',
        'cn/iocoder/cs/module/system/service/ccode/CcodeControllerCrypto.java',
    ],
    'cs-platform-biz': [
        'cn/iocoder/cs/module/biz/knowledgebase/service/KnowledgeBaseService.java',
        'cn/iocoder/cs/module/biz/knowledgebase/service/impl/KnowledgeBaseServiceImpl.java',
        'cn/iocoder/cs/module/biz/knowledgebase/service/CcodeControllerKnowledgeService.java',
        'cn/iocoder/cs/module/biz/knowledgebase/controller/CcodeControllerKnowledgeController.java',
    ],
}
def source_path(module, name):
    root = repo / ('cs-platform-framework' if module.startswith('cs-platform-spring-') else '')
    return root / module / 'src/main/java' / name

def signed(archive, *, boot_marker=False):
    # Spring Boot 为已签名依赖生成空标记；仅外层精确空标记可原样保留。
    names = [info.filename for info in archive.infolist()
             if not (boot_marker and info.filename == 'META-INF/BOOT.SF'
                     and info.file_size == 0 and archive.read(info) == b'')]
    return any(re.match(r'META-INF/[^/]+\.(SF|RSA|DSA|EC)$', n, re.I)
               or n.upper().startswith('META-INF/SIG-') for n in names)

def owns(entry, stem):
    return entry == stem + '.class' or (entry.startswith(stem + '$') and entry.endswith('.class'))

def digest(data):
    return hashlib.sha256(data).hexdigest()

def unique_entries(archive):
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise SystemExit('Duplicate ZIP entry makes artifact interpretation ambiguous')

dependencies = stage / 'dependencies'
if dependencies.exists() and any(dependencies.iterdir()):
    raise SystemExit('Dependency directory must be empty; do not mix baseline dependencies')
dependencies.mkdir(exist_ok=True)
compiled = stage / 'compiled'
if compiled.exists():
    raise SystemExit('Compiled directory already exists; retain evidence and use a new staging directory')
compiled.mkdir()
source_manifest = {}
snapshot_paths = []
for module, names in sources.items():
    for name in names:
        path = source_path(module, name)
        content = path.read_bytes()
        source_manifest[str(path.relative_to(repo)).replace('\\', '/')] = digest(content)
        snapshot = stage / 'sources' / module / name
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        snapshot.write_bytes(content)
        snapshot_paths.append(str(snapshot))
stems = {module: [n[:-5] for n in names] for module, names in sources.items()}
module_entries = {}
with zipfile.ZipFile(baseline) as boot:
    unique_entries(boot)
    if signed(boot, boot_marker=True):
        raise SystemExit('Signed boot jar requires a signing-aware release process')
    boot_manifest = boot.read('META-INF/MANIFEST.MF').decode('utf-8')
    if re.search(r'(?im)^[^:\r\n]*(?:digest|signature-version)[^:\r\n]*:', boot_manifest):
        raise SystemExit('Outer manifest contains signature metadata')
    if 'Main-Class: org.springframework.boot.loader.launch.JarLauncher' not in boot_manifest:
        raise SystemExit('Unsupported Spring Boot launcher')
    for entry in boot.infolist():
        if not entry.filename.startswith('BOOT-INF/lib/') or not entry.filename.endswith('.jar'):
            continue
        name = Path(entry.filename).name
        if entry.filename != 'BOOT-INF/lib/' + name:
            raise SystemExit('Unexpected dependency path')
        data = boot.read(entry)
        (dependencies / name).write_bytes(data)
        module = next((m for m in sources if name.startswith(m + '-') and name[len(m)+1:len(m)+2].isdigit()), None)
        if module:
            if module in module_entries or entry.compress_type != zipfile.ZIP_STORED:
                raise SystemExit('Ambiguous or compressed target nested jar')
            module_entries[module] = entry.filename
        with zipfile.ZipFile(io.BytesIO(data)) as nested:
            unique_entries(nested)
            for owner, targets in stems.items():
                if owner != module and any(owns(n, stem) for n in nested.namelist() for stem in targets):
                    raise SystemExit('Duplicate target class outside expected module')
    if set(module_entries) != set(sources):
        raise SystemExit('Missing baseline module')
    if any(owns(n.removeprefix('BOOT-INF/classes/'), stem)
           for n in boot.namelist() if n.startswith('BOOT-INF/classes/')
           for targets in stems.values() for stem in targets):
        raise SystemExit('Target class shadowed by application classes')

jdk = repo / '.local-data/tools/jdk-17.0.20.1+1/bin'
lombok = list(dependencies.glob('lombok-*.jar'))
if not lombok:
    # Lombok is build-only; use the explicitly installed Maven artifact, never a source processor search.
    lombok = list((repo / '.local-data/tools/repository/org/projectlombok/lombok').glob('*/lombok-*.jar'))
    lombok = [p for p in lombok if not p.name.endswith(('-sources.jar', '-javadoc.jar'))]
if len(lombok) != 1:
    raise SystemExit('Select exactly one recorded Lombok processor version')
args = [str(jdk / 'javac.exe'), '--release', '17', '-encoding', 'UTF-8', '-parameters',
        '-implicit:none', '-sourcepath', '', '-cp', str(dependencies / '*'),
        '-processorpath', str(lombok[0]), '-processor', 'lombok.launch.AnnotationProcessorHider$AnnotationProcessor',
        '-d', str(compiled), *snapshot_paths]
result = subprocess.run(args, capture_output=True)
(stage / 'compile.log').write_bytes(result.stdout + result.stderr)
if result.returncode:
    print((result.stdout + result.stderr).decode('utf-8', errors='replace')[-7000:])
    raise SystemExit('Production dependency compilation failed')

outputs = {str(p.relative_to(compiled)).replace('\\', '/'): p.read_bytes() for p in compiled.rglob('*.class')}
if any(stem + '.class' not in outputs for targets in stems.values() for stem in targets):
    raise SystemExit('Missing expected compiled source class')
if any(not any(owns(n, stem) for targets in stems.values() for stem in targets) for n in outputs):
    raise SystemExit('Compiler generated a non-allowlisted class')
patches, changes = {}, {}
with zipfile.ZipFile(baseline) as boot:
    for module, entry in module_entries.items():
        target = io.BytesIO()
        replacement = {n: b for n, b in outputs.items() if any(owns(n, stem) for stem in stems[module])}
        with zipfile.ZipFile(io.BytesIO(boot.read(entry))) as old, zipfile.ZipFile(target, 'w') as new:
            if signed(old):
                raise SystemExit('Signed nested jar cannot be patched')
            before = {i.filename: digest(old.read(i)) for i in old.infolist()}
            for info in old.infolist():
                if not any(owns(info.filename, stem) for stem in stems[module]):
                    new.writestr(copy.copy(info), old.read(info))
                elif info.filename in replacement:
                    new.writestr(copy.copy(info), replacement.pop(info.filename))
            for n, b in replacement.items():
                new.writestr(n, b, compress_type=zipfile.ZIP_DEFLATED)
        patches[entry] = target.getvalue()
        with zipfile.ZipFile(io.BytesIO(patches[entry])) as new:
            after = {i.filename: digest(new.read(i)) for i in new.infolist()}
        changed = [n for n in sorted(before.keys() | after.keys()) if before.get(n) != after.get(n)]
        if any(not any(owns(n, stem) for stem in stems[module]) for n in changed):
            raise SystemExit('Non-allowlisted nested change')
        changes[entry] = [{'entry': n, 'before': before.get(n), 'after': after.get(n)} for n in changed]
    output = stage / 'app.jar'
    with zipfile.ZipFile(output, 'x') as new:
        for info in boot.infolist():
            # writestr 会修改 ZipInfo 的偏移；保留原对象供基线完整性核对。
            new.writestr(copy.copy(info), patches.get(info.filename, boot.read(info)))
    with zipfile.ZipFile(output) as new:
        outer_changes = [i.filename for i in boot.infolist() if digest(boot.read(i)) != digest(new.read(i.filename))]
    if set(outer_changes) != set(patches):
        raise SystemExit('Unexpected outer artifact changes')
with output.open('rb') as stream:
    artifact_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
report = {'baseline': manifest, 'sourceHashes': source_manifest, 'compilerArguments': args,
          'jdkVersion': subprocess.run([str(jdk / 'javac.exe'), '-version'], capture_output=True, text=True).stdout.strip(),
          'processorSha256': digest(lombok[0].read_bytes()), 'changes': changes,
          'sha256': artifact_digest, 'acceptedBootMarker': 'Spring Boot empty BOOT.SF marker; not signature verification',
          'runtimeVerified': False, 'deployed': False}
(stage / 'artifact-diff.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'artifact': str(output), 'sha256': artifact_digest,
                  'changedModules': len(changes), 'changedClasses': sum(map(len, changes.values()))}))
