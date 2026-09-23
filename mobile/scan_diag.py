import json
p=r'C:\Users\tcast\Downloads\rotation-engine-diagnostic-2026-09-19T03-44-43-999Z.json'
d=json.load(open(p,encoding='utf-8'))
def scan(x,path='root'):
 if isinstance(x,dict):
  text=' '.join(str(v) for v in x.values() if isinstance(v,(str,int,float)))
  if 'switch' in text.lower() or 'real folsom' in text.lower(): print('MATCH',path,json.dumps(x,ensure_ascii=False)[:8000])
  for k,v in x.items(): scan(v,path+'.'+str(k))
 elif isinstance(x,list):
  for i,v in enumerate(x): scan(v,path+f'[{i}]')
scan(d)
