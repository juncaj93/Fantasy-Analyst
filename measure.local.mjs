import { chromium } from '@playwright/test';
const B = process.argv[2];
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const out = {};
for (const [w,h] of [[390,844],[360,800]]) {
  const ctx = await br.newContext({ viewport:{width:w,height:h}, isMobile:true, hasTouch:true });
  const page = await ctx.newPage();
  await page.goto(B);
  await page.evaluate(async () => { await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passphrase:'e2e-passphrase'})}); });
  await page.reload();
  await page.waitForSelector('[data-testid="tab-draft"]');
  const count = async (sel) => page.evaluate(([s,vh]) => {
    const rows=[...document.querySelectorAll(s)];
    return rows.filter(r=>{const b=r.getBoundingClientRect(); return b.top>=0 && b.bottom <= vh-50;}).length;
  }, [sel, h]);
  const firstY = async (sel) => page.evaluate((s)=>{const r=document.querySelector(s); return r?Math.round(r.getBoundingClientRect().top):null;}, sel);

  await page.getByTestId('tab-draft').click(); await page.waitForTimeout(900);
  out[`draft@${w}`] = { rows: await count('[data-testid="recommendation-row"]'), firstRowY: await firstY('[data-testid="recommendation-row"]') };
  await page.getByTestId('tab-players').click(); await page.waitForTimeout(1200);
  out[`players@${w}`] = { rows: await count('[data-testid="player-search-row"]'), firstRowY: await firstY('[data-testid="player-search-row"]') };
  await page.getByTestId('tab-trades').click(); await page.waitForTimeout(900);
  out[`trades@${w}`] = { rows: await count('[data-testid="trade-row"]'), firstRowY: await firstY('[data-testid="trade-row"]') };
  await page.getByTestId('tab-setup').click(); await page.waitForTimeout(900);
  out[`setup@${w}`] = { rows: await count('[data-testid^="setup-step-"]'), lastStepBottom: await page.evaluate(()=>{const r=document.querySelector('[data-testid="setup-step-vegas"]'); return r?Math.round(r.getBoundingClientRect().bottom):null;}) };
  await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
await br.close();
