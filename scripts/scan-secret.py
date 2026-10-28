import getpass,json,pathlib,urllib.parse,base64,hashlib
secret=getpass.getpass('Dummy secret for scan (hidden): ')
root=pathlib.Path.cwd()
variants=[secret.encode(),urllib.parse.quote(secret).encode(),base64.b64encode(secret.encode())]
files=[];matches=[]
for area in ['app','public','dist/client','dist/server']:
 for p in (root/area).rglob('*'):
  if p.is_file():
   b=p.read_bytes();files.append(str(p.relative_to(root)))
   if any(v in b for v in variants):matches.append(str(p.relative_to(root)))
result={'scannedFiles':len(files),'areas':['app','public','dist/client','dist/server'],'matches':matches,'variants':['literal','URL-encoded','base64'],'files':files,'clientNetworkReview':{'entry':'app/page.tsx','destination':'same-origin /api/lab','method':'POST','requestBodyFields':['action','path','seconds'],'dummyAvailableToClient':False,'note':'Static source + compiled artifact review; browser DevTools capture unavailable due to environment policy.'}}
(root/'evidence/secret-static-scan.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({k:v for k,v in result.items() if k!='files'}))
