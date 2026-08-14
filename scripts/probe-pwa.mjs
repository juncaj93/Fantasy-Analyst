/**
 * Can the deployed site be installed to an iPhone Home Screen?
 *
 *   node scripts/probe-pwa.mjs https://fantasy-analyst.example.workers.dev
 *
 * iOS makes this decision silently: it reads the page, the manifest and the
 * icons, and if any of them is wrong it produces a bookmark that opens in a
 * Safari tab instead of an app — with no error anywhere. Every prerequisite it
 * checks is checked here, over HTTP, against the real deployment, because the
 * failure modes that matter (an icon that 404s, a manifest served as HTML by a
 * single-page-app fallback, a lost content type) exist only once it is hosted.
 *
 * Run by the deploy workflow after every release. Exits non-zero on failure.
 */

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!base) {
  console.error('usage: node scripts/probe-pwa.mjs <site url>');
  process.exit(2);
}

let failures = 0;

function check(ok, label, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

async function get(path) {
  const res = await fetch(`${base}${path}`, { redirect: 'follow' });
  return { res, type: res.headers.get('content-type') ?? '' };
}

/** A PNG says its own dimensions in the IHDR chunk, at a fixed offset. */
function pngSize(buffer) {
  const view = new DataView(buffer);
  const signature = new Uint8Array(buffer, 1, 3);
  if (String.fromCharCode(...signature) !== 'PNG') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

console.log(`Home Screen web app checks for ${base}`);

check(base.startsWith('https://'), 'served over HTTPS', 'iOS will not install an app from plain HTTP');

/* -- the page ------------------------------------------------------------- */

const home = await get('/');
check(home.res.status === 200, 'the app loads', `HTTP ${home.res.status}`);
const html = await home.res.text();

check(/<link[^>]+rel="manifest"[^>]+href="\/manifest\.webmanifest"/.test(html), 'the page links its manifest');
check(/rel="apple-touch-icon"/.test(html), 'the page names an apple-touch-icon');
check(/name="apple-mobile-web-app-capable" content="yes"/.test(html), 'iOS web-app capability is declared');
check(/name="mobile-web-app-capable" content="yes"/.test(html), 'the standard capability tag is present');
check(/viewport-fit=cover/.test(html), 'the viewport covers the display');

/* -- the manifest --------------------------------------------------------- */

const manifestRes = await get('/manifest.webmanifest');
check(manifestRes.res.status === 200, 'the manifest is served', `HTTP ${manifestRes.res.status}`);
check(
  /manifest\+json|application\/json/.test(manifestRes.type),
  'the manifest has a JSON content type',
  manifestRes.type || 'none',
);

let manifest = null;
try {
  manifest = JSON.parse(await manifestRes.res.text());
  check(true, 'the manifest parses');
} catch (err) {
  // The single-page-app fallback answering with index.html looks exactly like
  // this, and is the most likely way for the file to go missing in production.
  check(false, 'the manifest parses', String(err));
}

if (manifest) {
  check(manifest.display === 'standalone', 'display is standalone', `got ${manifest.display}`);
  check(manifest.start_url === '/', 'start_url is the app root', `got ${manifest.start_url}`);
  check(manifest.scope === '/', 'scope covers the whole site', `got ${manifest.scope}`);
  check(typeof manifest.name === 'string' && manifest.name.length > 0, 'the app is named', manifest.name);
  check(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'it declares icons');

  const start = await get(manifest.start_url);
  check(start.res.status === 200, 'start_url resolves', `HTTP ${start.res.status}`);

  for (const icon of manifest.icons ?? []) {
    const { res, type } = await get(icon.src);
    if (!check(res.status === 200, `icon ${icon.src} resolves`, `HTTP ${res.status}`)) continue;
    check(type.includes('image/png'), `icon ${icon.src} is served as PNG`, type || 'none');
    const size = pngSize(await res.arrayBuffer());
    check(
      size !== null && `${size.width}x${size.height}` === icon.sizes,
      `icon ${icon.src} is ${icon.sizes}`,
      size ? `${size.width}x${size.height}` : 'not a PNG',
    );
  }
}

/* -- the Home Screen icon Safari actually uses ---------------------------- */

const touchHref = html.match(/rel="apple-touch-icon"[^>]*href="([^"]+)"/)?.[1] ?? '/apple-touch-icon.png';
const touch = await get(touchHref);
if (check(touch.res.status === 200, `${touchHref} resolves`, `HTTP ${touch.res.status}`)) {
  check(touch.type.includes('image/png'), `${touchHref} is served as PNG`, touch.type || 'none');
  const size = pngSize(await touch.res.arrayBuffer());
  check(size?.width === 180 && size?.height === 180, `${touchHref} is 180×180`, size ? `${size.width}×${size.height}` : '');
}

console.log(
  failures === 0
    ? '\nInstallable: adding this to an iPhone Home Screen produces a standalone app.'
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
