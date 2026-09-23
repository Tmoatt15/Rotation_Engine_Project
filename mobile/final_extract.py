import json,collections
p=r'C:\Users\tcast\Downloads\rotation-engine-diagnostic-2026-09-19T03-44-43-999Z.json'; d=json.load(open(p,encoding='utf-8')); t=next(x for x in d['teams'] if x['name']=='Real Folsom'); ss={x['name']:x['schedule'] for x in t['saved_schedules'] if x['name'] in ('Switch','Switch 1.0')}
def nm(x):
 if isinstance(x,str): return x
 if isinstance(x,dict): return x.get('name') or x.get('player_name') or x.get('player') or str(x)
 return str(x)
def extract(b):
 # expected diagnostic shape: each block has gk/defenders/midfielders/forwards or GK/D/M/F
 out={}
 for key,lab in [('gk','GK'),('GK','GK'),('goalkeeper','GK'),('d','D'),('D','D'),('defenders','D'),('m','M'),('M','M'),('midfielders','M'),('f','F'),('F','F'),('forwards','F')]:
  if key in b: out[lab]=[nm(z) for z in (b[key] if isinstance(b[key],list) else [b[key]])]
 if 'players' in b and isinstance(b['players'],dict):
  for k,v in b['players'].items(): out[k]=[nm(z) for z in (v if isinstance(v,list) else [v])]
 if 'assignments' in b and isinstance(b['assignments'],dict):
  for k,v in b['assignments'].items(): out[k]=[nm(z) for z in (v if isinstance(v,list) else [v])]
 return out
def fmt(a): return ' | '.join(f'{k}: {", ".join(v)}' for k,v in a.items())
for n,q in ss.items():
 print('\n### '+n); print('warnings:',json.dumps(q.get('warnings'),ensure_ascii=False)); print('errors:',json.dumps(q.get('errors'),ensure_ascii=False)); print('blocks:',len(q.get('blocks',[])))
 prev=None; trans=[]; totals=collections.Counter()
 for i,b in enumerate(q['blocks'],1):
  a=extract(b); print(f'B{i}: '+fmt(a));
  for pos,vals in a.items(): totals.update(vals)
  if prev:
   old={(pos,x) for pos,vs in prev.items() for x in vs}; new={(pos,x) for pos,vs in a.items() for x in vs};
   groups={pos for pos in set(prev)|set(a) if set(prev.get(pos,[]))!=set(a.get(pos,[]))}
   exact=[]
   people=set(x for vs in prev.values() for x in vs)|set(x for vs in a.values() for x in vs)
   for pl in sorted(people):
    po=next((p for p,v in prev.items() if pl in v),None); pn=next((p for p,v in a.items() if pl in v),None)
    if po!=pn: exact.append(f'{pl}: {po}->{pn}')
   if groups or exact: print('  transition:', 'group changes='+','.join(sorted(groups))+'; position changes='+('; '.join(exact) or 'none'))
  prev=a
 print('assignment/block totals:',dict(totals))
for i,(x,y) in enumerate(zip(ss['Switch']['blocks'],ss['Switch 1.0']['blocks']),1):
 a,b=extract(x),extract(y); dif=[]
 for pos in sorted(set(a)|set(b)):
  if a.get(pos)!=b.get(pos): dif.append(f'{pos}: {", ".join(a.get(pos,[]))} -> {", ".join(b.get(pos,[]))}')
 if dif: print(f'\nDIFF B{i}: '+'; '.join(dif))
