# Merge Round 16's file (weeks 1-7 numbers and projections) with the Round 29 gather (weeks 8 on).
# python3 -I merge.py <round16-data.json> <gather.json> <out.json>
import json, sys
old = json.load(open(sys.argv[1])); new = json.load(open(sys.argv[2]))
first = min(int(w) for w in new['numbers']) if new['numbers'] else 8
out = dict(new)
out['players'] = {**{k: v[:3] for k, v in old['players'].items()}, **{k: list(v) for k, v in new['players'].items()}}
out['proj'] = {**{w: v for w, v in old['proj'].items() if int(w) < first}, **new['proj']}
out['numbers'] = {**{w: v for w, v in old['numbers'].items() if int(w) < first}, **new['numbers']}
# Actual points: the stored copy for every week; for a week still being played, the live Sleeper points fill the rostered players.
act = {w: dict(v) for w, v in new['actual'].items()}
for w, v in old['actual'].items():
    if w not in act: act[w] = dict(v)
cw = str(new['meta']['currentWeek'])
live = new.get('livePoints', {}).get(cw, {})
if cw in act or live:
    act.setdefault(cw, {})
    for pid, v in live.items():
        if pid in new['players']: act[cw][pid] = round(float(v), 1)
out['actual'] = act
out['meta'] = dict(new['meta'])
out['meta']['merged'] = {'numbersFromRound16': sorted(int(w) for w in old['numbers'] if int(w) < first), 'numbersFromRound29': sorted(int(w) for w in new['numbers'])}
json.dump(out, open(sys.argv[3], 'w'))
print('merged: numbers weeks', sorted(int(w) for w in out['numbers']), 'actual weeks', sorted(int(w) for w in out['actual']), 'players', len(out['players']))
