import json, collections
p=r'C:\Users\tcast\Downloads\rotation-engine-diagnostic-2026-09-19T03-44-43-999Z.json'; d=json.load(open(p,encoding='utf-8')); t=next(x for x in d['teams'] if x['name']=='Real Folsom')
for s in t['saved_schedules']:
 print('\nSCHEDULE',s['name'], 'keys',s['schedule'].keys())
 if s['name'] in ('Switch','Switch 1.0'):
  q=s['schedule']; print('warnings=',json.dumps(q.get('warnings'),ensure_ascii=False)); print('errors=',json.dumps(q.get('errors'),ensure_ascii=False)); print('position_rows=',json.dumps(q.get('position_rows'),ensure_ascii=False)); print('blocks=',json.dumps(q.get('blocks'),ensure_ascii=False))
