// Index every SQL string in src/ by file and line, normalized for matching against Cloudflare's statement text.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = '/home/user/Fantasy-Analyst/src';
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
walk(root);
const out = [];
const re = /(`|'|")\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b[\s\S]*?\1/gi;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(text))) {
    const sql = m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, '?').replace(/\s+/g, ' ').trim();
    if (sql.length < 15) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ file: f.replace(root + '/', 'src/'), line, sql });
  }
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log(`${out.length} SQL strings in ${files.length} files`);
