"""Review exactly the uploaded ciphertext, then publish through the knowledge route."""
import hashlib
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlsplit
import requests

STAGE=Path('E:/github/cs-platform-service/.local-data/ccode-controller-release')
BASE='https://dp.sccsai.com'

def run():
    evidence=STAGE/'knowledge-publication.json'
    if evidence.exists(): raise RuntimeError('Prior publication attempt exists; inspect instead of retrying')
    upload=json.loads((STAGE/'knowledge-upload.json').read_text())
    meta=json.loads((STAGE/'controller-v1.metadata.json').read_text())
    if upload['phase']!='uploaded' or upload['fileId']!=5615 or upload['folderId']!=166:
        raise RuntimeError('Unexpected upload record')
    if upload['sourceSha256']!=meta['sourceSha256']: raise RuntimeError('Source identity differs')
    spec=importlib.util.spec_from_file_location('wb',Path(__file__).with_name('controller-browser-admin.py'))
    wb=importlib.util.module_from_spec(spec);spec.loader.exec_module(wb)
    try:
        items=wb.call('network',{'cmd':'list','filter':'/biz/knowledge-base/file/page'})['requests']
        detail=None
        for item in reversed(items):
            if not item['url'].startswith(BASE+'/admin-api/biz/knowledge-base/file/page?') or item['status']!=200: continue
            candidate=wb.call('network',{'cmd':'detail','requestId':item['requestId']})
            body=candidate.get('body')
            if isinstance(body,str): body=json.loads(body)
            if isinstance(body,dict) and body.get('code')==0:
                detail=candidate
                break
        if detail is None: raise RuntimeError('No successful authenticated source request')
        headers={k.lower():v for k,v in detail['requestHeaders'].items()}
        if headers.get('tenant-id')!='1' or headers.get('visit-tenant-id','1')!='1': raise RuntimeError('Wrong tenant')
        auth={'authorization':headers['authorization'],'tenant-id':'1'}
    finally: wb.call('network',{'cmd':'stop'})
    session=requests.Session();session.trust_env=False
    def api(method,path,**kwargs):
        response=session.request(method,BASE+'/admin-api'+path,headers=auth,timeout=45,allow_redirects=False,**kwargs)
        if response.status_code!=200: raise RuntimeError('API HTTP failure')
        result=response.json()
        if result.get('code')!=0:
            print(json.dumps({'failedRoute':path,'applicationCode':result.get('code')}))
            raise RuntimeError('API application failure')
        return result['data']
    file=api('GET','/biz/knowledge-base/review/get',params={'fileId':5615})
    if (file['fileId']!=5615 or file['folderId']!=166 or file['libraryCode']!='pre-sale'
            or file['fileName']!='controller-v1.ccskill' or file['size']!=meta['sourceBytes']
            or file['reviewStatus']!='PENDING'): raise RuntimeError('Review target differs')
    url=urlsplit(file['downloadUrl'])
    if url.scheme!='https' or not url.hostname or url.username or url.password: raise RuntimeError('Invalid download URL')
    with requests.Session() as storage:
        storage.trust_env=False
        with storage.get(file['downloadUrl'],timeout=30,allow_redirects=False,stream=True) as response:
            if response.status_code!=200: raise RuntimeError('Ciphertext download failed')
            digest=hashlib.sha256();size=0
            for chunk in response.iter_content(16384):
                size+=len(chunk)
                if size>meta['sourceBytes']: raise RuntimeError('Ciphertext size exceeded')
                digest.update(chunk)
    if size!=meta['sourceBytes'] or digest.hexdigest()!=meta['sourceSha256']: raise RuntimeError('Ciphertext differs')
    state={'phase':'approving','fileId':5615,'sourceSha256':meta['sourceSha256']}
    with evidence.open('x',encoding='utf-8') as stream:json.dump(state,stream)
    api('POST','/biz/knowledge-base/review/approve',json={'fileId':5615,
        'reviewRemark':'已核对签名信任根、密文完整性及总控专用目录，用于 CCode 受控发布。'})
    current=api('GET','/biz/knowledge-base/file/get',params={'id':5615})
    if current['reviewStatus']!='APPROVED' or current['folderId']!=166: raise RuntimeError('Approval not confirmed')
    state['phase']='publishing';evidence.write_text(json.dumps(state),encoding='utf-8')
    grant=api('POST','/system/ccode-controller/knowledge/publish',json={'fileId':5615,'sourceSha256':meta['sourceSha256']})
    if grant['skillId']!='controller' or grant['version']!=1 or grant['digest']!=meta['payloadSha256']:
        raise RuntimeError('Published identity mismatch')
    state.update({'phase':'published','skillId':grant['skillId'],'version':grant['version'],'digest':grant['digest']})
    evidence.write_text(json.dumps(state),encoding='utf-8')
    print(json.dumps(state))

if __name__=='__main__':
    try:run()
    except Exception as error:
        raise SystemExit('Publication stopped: '+type(error).__name__+'; inspect saved phase before retry') from None
