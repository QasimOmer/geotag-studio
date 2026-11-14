// Vercel serverless function: expands Google Maps / Business Profile share links
// (maps.app.goo.gl, share.google, g.page, goo.gl, ?cid= links) so the app can read the coordinates.
// GET /api/resolve?url=<link>  ->  { url: <final url>, lat?, lon? }
// Only Google hosts are ever fetched (no open proxy / SSRF).

const ALLOWED = [
  /^maps\.app\.goo\.gl$/i, /^goo\.gl$/i, /^app\.goo\.gl$/i, /^g\.co$/i, /^g\.page$/i, /^share\.google$/i,
  /^(www\.|maps\.|search\.|consent\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/i,
];
const allowed = (u) => u.protocol === 'https:' && ALLOWED.some((re) => re.test(u.hostname));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function coordsFromText(t) {
  const d = (() => { try { return decodeURIComponent(t); } catch { return t; } })();
  let m = d.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2] };
  m = d.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2] };
  m = d.match(/[?&](?:q|ll|query|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2] };
  return null;
}
function coordsFromHtml(html) {
  // static map preview in the page's meta tags: ...staticmap?center=40.74%2C-73.98...
  let m = html.match(/staticmap\?center=(-?\d+\.\d+)(?:%2C|,)(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lon: +m[2] };
  // window.APP_INITIALIZATION_STATE=[[[zoom,lng,lat]
  m = html.match(/APP_INITIALIZATION_STATE=\[\[\[\s*[\d.]+\s*,\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*\]/);
  if (m) return { lat: +m[2], lon: +m[1] };
  return coordsFromText(html.slice(0, 200000));
}
const ok = (c) => c && isFinite(c.lat) && isFinite(c.lon) && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  let url;
  try { url = new URL(String(req.query?.url || '')); } catch { return res.status(400).json({ error: 'Invalid link' }); }
  if (!allowed(url)) return res.status(400).json({ error: 'Only Google Maps / Business Profile links can be expanded' });

  try {
    for (let hop = 0; hop < 8; hop++) {
      const c = coordsFromText(url.href);
      if (ok(c)) return res.status(200).json({ url: url.href, ...c });
      // consent interstitial: the real target is in ?continue=
      if (/^consent\./i.test(url.hostname) && url.searchParams.get('continue')) {
        url = new URL(url.searchParams.get('continue'));
        if (!allowed(url)) break;
        continue;
      }
      const r = await fetch(url.href, { redirect: 'manual', headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        const next = new URL(loc, url);
        if (!allowed(next)) break;
        url = next;
        continue;
      }
      if (r.ok && /html/.test(r.headers.get('content-type') || '')) {
        const html = (await r.text()).slice(0, 3_000_000);
        const c2 = coordsFromHtml(html);
        if (ok(c2)) return res.status(200).json({ url: url.href, ...c2 });
        // some short links use a JS/meta redirect
        const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>]+)/i) || html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)/);
        if (meta) {
          const next = new URL(meta[1].replace(/&amp;/g, '&'), url);
          if (allowed(next) && next.href !== url.href) { url = next; continue; }
        }
      }
      break;
    }
    return res.status(200).json({ url: url.href });
  } catch (e) {
    return res.status(502).json({ error: `Could not open link: ${e.message}` });
  }
}
