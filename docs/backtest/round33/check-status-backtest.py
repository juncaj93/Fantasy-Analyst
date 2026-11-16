import json, sys
from datetime import datetime, timezone, timedelta
d = json.load(open(sys.argv[1]))
ET = timezone(timedelta(hours=-5))
def ts(s): return datetime.fromisoformat(s.replace('Z', '+00:00'))
kick_by_event = {g['eventId']: g['gameStart'] for g in d['lookTimes']}
# club kickoff per week from fixtures [week, team, opp, kickoff]
club_kick = {}
for w, a, b, k in d['fixtures']:
    club_kick[(w, a)] = k; club_kick[(w, b)] = k
mine = set()
for w, s in d['starters'].items():
    for pid in (s.get('1') if isinstance(s, dict) else []) or []: mine.add((int(w), str(pid)))
out = {}
for wk in ('9', '10'):
    w = int(wk); moments = d['meta']['moments'][wk]
    for ev, labels in d['linePresence'][wk].items():
        if 'kick' not in labels: continue
        live = set(labels['kick'])
        earlier = set()
        for lab in ('tue9pm', 'sat12pm', 'sun11am'):
            if lab in labels: earlier |= set(labels[lab])
        for pid in earlier - live:
            club = d['clubs'].get(pid)
            k = kick_by_event.get(ev) or club_kick.get((w, club))
            if not k: continue
            # earlier label must be before kickoff
            if not any(lab in labels and pid in labels[lab] and ts(moments[lab]) < ts(k) for lab in ('tue9pm','sat12pm','sun11am')): continue
            status = (d['injuries'].get(wk) or {}).get(pid)
            suppressed = status in ('Out', 'Doubtful', 'IR')
            played = w in (d['played'].get(pid) or []) or (d['actual'].get(wk) or {}).get(pid) is not None or (d['livePoints'].get(wk) or {}).get(pid) is not None
            day = ts(k).astimezone(ET).strftime('%a')
            name = (d['players'].get(pid) or [pid])[0]
            out.setdefault((w, day), []).append((name, ts(k).astimezone(ET).strftime('%a %-I:%M %p'), status, suppressed, played, (w, pid) in mine))
tot = {}
for (w, day), rows in sorted(out.items()):
    print(f'week {w} {day}:')
    for name, k, status, sup, played, m in rows:
        tag = 'suppressed (already ' + status + ')' if sup else ('FALSE ALARM (played)' if played else 'TRUE (did not play)')
        print(f'   {name:26} kick {k:13} report {status or "-":12} {tag}{"  [Alex starter]" if m else ""}')
        if not sup:
            t = tot.setdefault((w, day), [0, 0]); t[0 if not played else 1] += 1
print('flags shown: (true, false alarms)', {f'wk{w} {d_}': v for (w, d_), v in tot.items()})
# Thursday coverage
for wk in ('9','10'):
    thu = [ev for ev, labels in d['linePresence'][wk].items() if kick_by_event.get(ev) and ts(kick_by_event[ev]).astimezone(ET).strftime('%a') == 'Thu']
    print('week', wk, 'Thursday games with saved looks:', len(thu), [sorted(d['linePresence'][wk][e].keys()) for e in thu])
