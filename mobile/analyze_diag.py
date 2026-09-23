import json, collections
p=r'C:\Users\tcast\Downloads\rotation-engine-diagnostic-2026-09-19T03-44-43-999Z.json'; d=json.load(open(p,encoding='utf-8')); t=next(x for x in d['teams'] if x['name']=='Real Folsom'); ss={s['name']:s['schedule'] for s in t['saved_schedules'] if s['name'] in ('Switch','Switch 1.0')}
def pname(x):
 if isinstance(x,str): return x
 if isinstance(x,dict): return x.get('name') or x.get('player_name') or x.get('player') or json.dumps(x,separators=(',',':'))
 return str(x)
def block(b):
 if not isinstance(b,dict): return b
 # preserve all assignment-like fields, compact
 return {k:v for k,v in b.items()}
for n,q in ss.items():
 print('\n===',n,'==='); print('warnings',json.dumps(q.get('warnings'),ensure_ascii=False)); print('errors',json.dumps(q.get('errors'),ensure_ascii=False)); print('starts',q.get('block_start_minutes'),'lengths',q.get('block_lengths_minutes')); print('blocks')
 for i,b in enumerate(q['blocks'],1): print(i,json.dumps(block(b),ensure_ascii=False,separators=(',',':')))
# Generic recursive extraction of player-position pairs per block

def assignments(b):
 out=[]
 if isinstance(b,dict):
  for k,v in b.items():
   if k.lower() in ('players','assignments','positions','position_assignments','lineup') and isinstance(v,(dict,list)):
    if isinstance(v,dict):
     for pos,pl in v.items(): out.append((str(pos),pname(pl)))
    else:
     for z in v:
      if isinstance(z,dict): out.append((z.get('position','?'),pname(z.get('player') or z.get('player_name') or z)))
  # common direct position keys
  for pos in ('GK','D','M','F'):
   if pos in b: 
    vals=b[pos] if isinstance(b[pos],list) else [b[pos]]
    out += [(pos,pname(x)) for x in vals]
 return out
for n,q in ss.items():
 print('\n',n,'NORMALIZED')
 prev=None; counts=collections.Counter()
 for i,b in enumerate(q['blocks'],1):
  a=assignments(b); print('B',i,' '.join(f'{p}={x}' for p,x in a)); counts.update(x for p,x in a)
  if prev is not None: print(' CHANGE',[(p,x,y) for p,x in prev if (p,x) not in a], '->',[(p,x) for p,x in a if (p,x) not in prev])
  prev=a
 print('COUNTS',dict(counts))
# compare raw blocks and normalized assignment sets
print('\n=== CROSS-SCHEDULE DIFFERENCES ===')
a=ss['Switch']['blocks']; b=ss['Switch 1.0']['blocks']; print('block counts',len(a),len(b))
for i,(x,y) in enumerate(zip(a,b),1):
 if x!=y: print('B',i,'Switch',json.dumps(x,ensure_ascii=False,separators=(',',':')),'Switch1.0',json.dumps(y,ensure_ascii=False,separators=(',',':')))
