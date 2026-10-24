"""Upload encrypted source through existing authenticated knowledge APIs."""
import hashlib
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlsplit
import requests

STAGE=Path('E:/github/cs-platform-service/.local-data/ccode-controller-release')
BASE='https://dp.sccsai.com'

def run():
    evidence=STAGE/'knowledge-upload.json'
    if evidence.exists(): raise RuntimeError('Prior attempt exists; inspect instead of retrying')
    meta=json.loads((STAGE/'controller-v1.metadata.json').read_text())
    source=(STAGE/'controller-v1.ccskill').read_bytes()
    if hashlib.sha256(source).hexdigest()!=meta['sourceSha256']: raise RuntimeError('Source changed')
    spec=importlib.util.spec_from_file_location('browser_admin',Path(__file__).with_name('controller-browser-admin.py'))
    wb=importlib.util.module_from_spec(spec);spec.loader.exec_module(wb)
    try:
        items=wb.call('network',{'cmd':'list','filter':'/biz/knowledge-base/file/page'})['requests']
        item=next(x for x in reversed(items) if x['url'].startswith(BASE+'/admin-api/biz/knowledge-base/file/page?') and x['status']==200)
        detail=wb.call('network',{'cmd':'detail','requestId':item['requestId']})
        headers={k.lower():v for k,v in detail['requestHeaders'].items()}
        if headers.get('tenant-id')!='1' or headers.get('visit-tenant-id','1')!='1': raise RuntimeError('Wrong tenant')
        auth={'authorization':headers['authorization'],'tenant-id':'1'}
    finally:
        wb.call('network',{'cmd':'stop'})
    session=requests.Session();session.trust_env=False
    def api(method,path,**kwargs):
        response=session.request(method,BASE+'/admin-api'+path,headers=auth,timeout=30,allow_redirects=False,**kwargs)
        if response.status_code!=200: raise RuntimeError('API HTTP failure')
        result=response.json()
        if result.get('code')!=0:
            print(json.dumps({'failedRoute':path,'applicationCode':result.get('code')}))
            raise RuntimeError('API application failure')
        return result['data']
    folder=api('GET','/biz/knowledge-base/file/page',params={'folderId':166,'libraryCode':'pre-sale','pageNo':1,'pageSize':10})
    if folder['total']!=0: raise RuntimeError('Folder not empty; inspect before upload')
    policy=api('GET','/biz/knowledge-base/file/upload-policy',params={'libraryCode':'pre-sale','folderId':166,
        'fileName':'controller-v1.ccskill','contentType':'application/octet-stream'})
    url=urlsplit(policy['uploadUrl'])
    if url.scheme!='https' or not url.hostname or url.username or url.password: raise RuntimeError('Invalid object upload URL')
    with evidence.open('x',encoding='utf-8') as stream:
        json.dump({'phase':'uploading','sourceSha256':meta['sourceSha256'],'objectKey':policy['objectKey']},stream)
    # Bearer/cookie never go to object storage. Only the presigned upload URL is used.
    with requests.Session() as upload_session:
        upload_session.trust_env=False
        response=upload_session.put(policy['uploadUrl'],data=source,headers={'Content-Type':'application/octet-stream'},
                                    timeout=60,allow_redirects=False)
    if response.status_code not in (200,201,204): raise RuntimeError('Object upload failed')
    file=api('POST','/biz/knowledge-base/file/confirm-upload',json={
        'libraryCode':'pre-sale','folderId':166,'name':'总控派单 v1（加密源）','fileName':'controller-v1.ccskill',
        'extension':'ccskill','mimeType':'application/octet-stream','size':len(source),
        'ossUrl':policy['publicUrl'],'objectKey':policy['objectKey'],
        'remark':'CCode 总控签名加密源，仅用于中台受控发布。','tags':['CCode','加密源']})
    result={'phase':'uploaded','fileId':file['id'],'folderId':file['folderId'],
            'reviewStatus':file.get('reviewStatus'),'sourceSha256':meta['sourceSha256']}
    evidence.write_text(json.dumps(result),encoding='utf-8')
    print(json.dumps(result))

if __name__=='__main__':
    try:run()
    except Exception as error:
        raise SystemExit('Upload stopped: '+type(error).__name__+'; inspect saved phase before retry') from None
