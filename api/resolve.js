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
// NOTE: never read coordinates from the Maps page HTML: its map centre / static preview is the
// server's IP-based default view, not the place. Only the (redirected) link itself is trusted.

// Place name / address carried by the link (used for an approximate address lookup)
function placeQuery(u) {
  const d = (() => { try { return decodeURIComponent(u.href.replace(/\+/g, ' ')); } catch { return u.href; } })();
  const m = d.match(/\/maps\/place\/([^/@?]+)/) || d.match(/[?&](?:q|query|daddr)=([^&]+)/i);
  if (!m) return null;
  const q = m[1].trim();
  return /^-?\d+\.\d+\s*,/.test(q) || /^place_id:/i.test(q) ? null : q;
}
const ok = (c) => c && isFinite(c.lat) && isFinite(c.lon) && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  let url;
  try { url = new URL(String(req.query?.url || '').trim()); } catch { return res.status(400).json({ error: 'Invalid link' }); }
  if (url.protocol === 'http:') url.protocol = 'https:';
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
      if (r.ok && /html/.test(r.headers.get('content-type') || '') && !/google\.[a-z.]+$/i.test(url.hostname)) {
        const html = (await r.text()).slice(0, 500_000);
        // some short-link pages use a JS/meta redirect
        const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>]+)/i) || html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)/);
        if (meta) {
          const next = new URL(meta[1].replace(/&amp;/g, '&'), url);
          if (allowed(next) && next.href !== url.href) { url = next; continue; }
        }
      }
      break;
    }
    // share.google links for a Business Profile land on a Google *Search* knowledge panel (?kgmid=…):
    // no coordinates are available without running Google's JS, so tell the client which business it is.
    const kind = /^\/search/.test(url.pathname) ? 'search' : 'maps';
    return res.status(200).json({ url: url.href, query: placeQuery(url), kind });
  } catch (e) {
    return res.status(502).json({ error: `Could not open link: ${e.message}` });
  }
}
