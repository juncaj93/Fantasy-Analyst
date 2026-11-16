// Round 29: rows read and written by source. node cost.mjs <bundle.json> <sqlindex.json> [window label]
import { readFileSync } from 'node:fs';
const B = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const IDX = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const label = process.argv[4] ?? 'last 72 hours';
const W = B.statements?.[label];
if (!W) throw new Error(`no window ${label}`);
const norm = (s) => s.toLowerCase().replace(/'[^']*'/g, '?').replace(/\b\d+(\.\d+)?\b/g, '?').replace(/\?(\s*,\s*\?)+/g, '?').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
const index = IDX.map((e) => ({ ...e, n: norm(e.sql) }));
const match = (q) => {
  const nq = norm(q);
  let best = null;
  for (const e of index) {
    let k = 0;
    const m = Math.min(nq.length, e.n.length);
    while (k < m && nq[k] === e.n[k]) k++;
    const score = k / Math.max(30, Math.min(nq.length, e.n.length));
    if (!best || score > best.score) best = { score, e };
  }
  return best && best.score > 0.5 ? best.e : null;
};
const rows = W.list.map((r) => ({ ...r, src: match(r.q) }));
const by = new Map();
for (const r of rows) {
  const key = r.src ? `${r.src.file}:${r.src.line}` : `(unmatched) ${r.q.slice(0, 60)}`;
  const v = by.get(key) ?? { read: 0, written: 0, calls: 0, q: r.q };
  v.read += r.read; v.written += r.written; v.calls += r.calls; by.set(key, v);
}
const totalR = rows.reduce((s, r) => s + r.read, 0), totalW = rows.reduce((s, r) => s + r.written, 0);
console.log(`${label}: sampled ${totalR.toLocaleString()} read, ${totalW.toLocaleString()} written; hourly totals ${W.hourlyRead.toLocaleString()} read, ${W.hourlyWritten.toLocaleString()} written`);
console.log('top sources by rows read:');
for (const [k, v] of [...by].sort((a, b) => b[1].read - a[1].read).slice(0, 30)) console.log(`  ${v.read.toLocaleString().padStart(11)} ${(100 * v.read / Math.max(1, totalR)).toFixed(1).padStart(5)}%  ${String(v.calls).padStart(6)} calls  ${k}  | ${v.q.slice(0, 90)}`);
console.log('top sources by rows written:');
for (const [k, v] of [...by].sort((a, b) => b[1].written - a[1].written).slice(0, 20)) { if (!v.written) break; console.log(`  ${v.written.toLocaleString().padStart(9)} ${(100 * v.written / Math.max(1, totalW)).toFixed(1).padStart(5)}%  ${String(v.calls).padStart(6)} calls  ${k}  | ${v.q.slice(0, 90)}`); }
