"""Round 18: how much less reliable is an unpriced (Sleeper-only) number?

Reads docs/backtest/round16-data.json (no database). Numbers there are the
weekly number as the screens read it, before any discount: [value, 'm'|'p'].
The app now takes 1 off a 'p' number (Round 17), so we do the same.
"""
import json, math, random, sys
from collections import defaultdict

D = json.load(open(sys.argv[1]))
LAST = D['meta']['lastPlayed']
SKILL = {'QB', 'RB', 'WR', 'TE'}
pos = lambda i: (D['players'].get(i) or [None, ''])[1]
pts = lambda i, w: D['actual'].get(str(w), {}).get(i, 0)
played = {i: set(ws) for i, ws in D['played'].items()}
did = lambda i, w: pts(i, w) != 0 or w in played.get(i, set())
inj = lambda i, w: (D['injuries'].get(str(w), {}).get(i) or '').lower()
DISC = 1.0

rows = []
for w in range(1, LAST + 1):
    for i, (n, b) in D['numbers'].get(str(w), {}).items():
        if pos(i) not in SKILL or n < 3: continue
        status = inj(i, w)
        if status in ('out', 'doubtful'): continue  # those are real holes, never a judgment call
        rows.append(dict(id=i, w=w, p=pos(i), raw=n, n=n - DISC if b == 'p' else n, un=b == 'p',
                         q=status == 'questionable', played=did(i, w), a=pts(i, w)))

def mean(xs): return sum(xs) / len(xs) if xs else float('nan')
def sd(xs):
    m = mean(xs); return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) if len(xs) > 1 else float('nan')

print(f'rows (number 3+, not Out/Doubtful): {len(rows)}; priced {sum(not r["un"] for r in rows)}, unpriced {sum(r["un"] for r in rows)}')
for label, keep in [('played only', lambda r: r['played']), ('all, a no-show scores 0', lambda r: True)]:
    print(f'\n== {label} ==')
    for name, f in [('priced', lambda r: not r['un']), ('unpriced', lambda r: r['un']),
                    ('priced, Questionable', lambda r: not r['un'] and r['q']), ('unpriced, Questionable', lambda r: r['un'] and r['q']),
                    ('priced, healthy', lambda r: not r['un'] and not r['q']), ('unpriced, healthy', lambda r: r['un'] and not r['q'])]:
        rr = [r for r in rows if keep(r) and f(r)]
        res = [r['a'] - r['n'] for r in rr]
        print(f'  {name:24s} n {len(rr):5d}  bias(actual-number) {mean(res):+.2f}  spread(sd) {sd(res):.2f}  miss {mean([abs(x) for x in res]):.2f}')
    print('  by number band (sd of actual-number): priced | unpriced')
    for lo, hi in [(3, 7), (7, 10), (10, 13), (13, 17), (17, 99)]:
        a = [r['a'] - r['n'] for r in rows if keep(r) and not r['un'] and lo <= r['n'] < hi]
        b = [r['a'] - r['n'] for r in rows if keep(r) and r['un'] and lo <= r['n'] < hi]
        print(f'   {lo:>2}-{hi if hi < 99 else "up":>2}: {sd(a):.2f} (n {len(a)}, bias {mean(a):+.2f}) | {sd(b):.2f} (n {len(b)}, bias {mean(b):+.2f})')
    # relative spread: sd / number level
    for name, f in [('priced', lambda r: not r['un']), ('unpriced', lambda r: r['un'])]:
        rr = [r for r in rows if keep(r) and f(r)]
        print(f'  {name}: average number {mean([r["n"] for r in rr]):.2f}, spread per point of number {sd([r["a"]-r["n"] for r in rr])/mean([r["n"] for r in rr]):.3f}')

# Head to head: same position, same week. Win rate of the higher number by gap.
def pairs(kind, keep):
    out = []
    for w in range(1, LAST + 1):
        for p in SKILL:
            rr = [r for r in rows if r['w'] == w and r['p'] == p and keep(r)]
            for x in range(len(rr)):
                for y in range(x + 1, len(rr)):
                    a, b = rr[x], rr[y]
                    hi, lo = (a, b) if a['n'] >= b['n'] else (b, a)
                    g = hi['n'] - lo['n']
                    if g > 8: continue
                    if kind == 'pp' and (hi['un'] or lo['un']): continue
                    if kind == 'up' and not (hi['un'] and not lo['un']): continue   # unpriced leads a priced one
                    if kind == 'pu' and not (not hi['un'] and lo['un']): continue   # priced leads an unpriced one
                    if kind == 'uqp' and not (hi['un'] and hi['q'] and not lo['un']): continue
                    out.append((g, hi['a'] > lo['a'], hi['a'] - lo['a'], f'{w}:{p}'))
    return out

BANDS = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 8)]
def table(ps, title):
    print(f'\n{title} ({len(ps)} pairs)')
    for lo, hi in BANDS:
        s = [x for x in ps if lo <= x[0] < hi]
        if s: print(f'   gap {lo}-{hi}: higher wins {100*mean([x[1] for x in s]):.0f}% of {len(s)}, margin {mean([x[2] for x in s]):+.2f}')

def win_at_least(ps, g0):
    s = [x for x in ps if x[0] >= g0]
    return mean([x[1] for x in s]), len(s)

for label, keep in [('played only', lambda r: r['played']), ('all, a no-show scores 0', lambda r: True)]:
    print(f'\n######## {label}')
    pp, up, pu, uqp = (pairs(k, keep) for k in ('pp', 'up', 'pu', 'uqp'))
    table(pp, 'priced vs priced')
    table(up, 'UNPRICED number leads a priced one')
    table(pu, 'priced number leads an unpriced one')
    table(uqp, 'UNPRICED + Questionable leads a priced one')
    # Logistic-free bar: find gap g where unpriced-leading win rate within [g, g+1.5) first matches
    # what priced-vs-priced achieves in [2, 3.5) (just over the 2.0 bar).
    ref = mean([x[1] for x in pp if 2 <= x[0] < 3.5])
    print(f'\n  priced vs priced, gap 2 to 3.5: {100*ref:.1f}% (what clearing the 2.0 bar buys)')
    for g in [2, 2.5, 3, 3.5, 4, 4.5, 5]:
        s = [x for x in up if g <= x[0] < g + 1.5]
        s2 = [x for x in uqp if g <= x[0] < g + 1.5]
        print(f'   unpriced leads by {g} to {g+1.5}: {100*mean([x[1] for x in s]):.1f}% (n {len(s)})   +Questionable: {100*mean([x[1] for x in s2]) if s2 else float("nan"):.1f}% (n {len(s2)})')
    # bootstrap the crossover with week:position groups
    groups = defaultdict(list)
    for x in up: groups[x[3]].append(x)
    gk = list(groups)
    rnd = random.Random(18)
    cross = []
    for _ in range(1000):
        samp = [x for k in (rnd.choice(gk) for _ in gk) for x in groups[k]]
        c = None
        for g in [x / 4 for x in range(8, 25)]:
            s = [x for x in samp if g <= x[0] < g + 1.5]
            if s and mean([x[1] for x in s]) >= ref: c = g; break
        cross.append(c if c is not None else 6.0)
    cross.sort()
    print(f'  gap where an unpriced lead first wins as often as a priced lead just over 2.0: median {cross[500]}, 90% range {cross[50]} to {cross[950]}')

# ---- Same-confidence bar from a logistic fit: P(higher wins) = 1/(1+exp(-(a+b*gap)))
def logfit(ps):
    a, b = 0.0, 0.1
    for _ in range(60):
        ga = gb = haa = hab = hbb = 0.0
        for g, win, *_ in ps:
            p = 1 / (1 + math.exp(-(a + b * g))); y = 1.0 if win else 0.0
            ga += y - p; gb += (y - p) * g
            w = p * (1 - p); haa += w; hab += w * g; hbb += w * g * g
        det = haa * hbb - hab * hab
        a += (hbb * ga - hab * gb) / det; b += (haa * gb - hab * ga) / det
    return a, b
def bar_for(pp, xx, g0=2.0):
    a0, b0 = logfit(pp); a1, b1 = logfit(xx)
    target = a0 + b0 * g0
    return (target - a1) / b1, 1 / (1 + math.exp(-target))
def boot(pp, xx, n=300):
    gp = defaultdict(list); gx = defaultdict(list)
    for x in pp: gp[x[3]].append(x)
    for x in xx: gx[x[3]].append(x)
    keys = sorted(set(gp) | set(gx)); rnd = random.Random(7); out = []
    for _ in range(n):
        ks = [rnd.choice(keys) for _ in keys]
        out.append(bar_for([x for k in ks for x in gp[k]], [x for k in ks for x in gx[k]])[0])
    out.sort(); return out[int(n * .05)], out[int(n * .95)]
for label, keep in [('played only', lambda r: r['played']), ('real outcome, no-show = 0', lambda r: True)]:
    pp = pairs('pp', keep); up = pairs('up', keep); uqp = pairs('uqp', keep)
    def pq(k):  # priced Questionable leads a priced one
        out = []
        for w in range(1, LAST + 1):
            for p in SKILL:
                rr = [r for r in rows if r['w'] == w and r['p'] == p and keep(r) and not r['un']]
                for x in rr:
                    if not x['q']: continue
                    for y in rr:
                        if y is x or y['q'] or x['n'] < y['n'] or x['n'] - y['n'] > 8: continue
                        out.append((x['n'] - y['n'], x['a'] > y['a'], x['a'] - y['a'], f'{w}:{p}'))
        return out
    pqp = pq(0)
    uh = [x for x in up]  # all unpriced leads
    print(f'\n== logistic same-confidence bar, {label}')
    b, conf = bar_for(pp, up); lo, hi = boot(pp, up)
    print(f'  priced vs priced at 2.0 wins {100*conf:.1f}%; an unpriced lead reaches that at {b:.2f} (90% range {lo:.2f} to {hi:.2f})')
    b, _ = bar_for(pp, uqp); lo, hi = boot(pp, uqp)
    print(f'  unpriced AND Questionable lead reaches it at {b:.2f} (90% range {lo:.2f} to {hi:.2f}), n {len(uqp)}')
    b, _ = bar_for(pp, pqp); lo, hi = boot(pp, pqp)
    print(f'  priced AND Questionable lead reaches it at {b:.2f} (90% range {lo:.2f} to {hi:.2f}), n {len(pqp)}')
# no-show rates
for name, f in [('priced Q', lambda r: not r['un'] and r['q']), ('unpriced Q', lambda r: r['un'] and r['q']), ('priced healthy', lambda r: not r['un'] and not r['q']), ('unpriced healthy', lambda r: r['un'] and not r['q'])]:
    rr = [r for r in rows if f(r)]
    print(f'no-show rate {name}: {100*mean([not r["played"] for r in rr]):.0f}% of {len(rr)}')
