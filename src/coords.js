// Understands every common way people copy a location (Google Business Profile, Google Maps,
// Apple Maps, OSM, GPS apps). Pure functions, no network — easy to unit test.
//
// parseLocation(text) returns one of:
//   { lat, lon }                         exact coordinates
//   { plus, locality }                   Google Plus Code (short codes need a locality/reference)
//   { shortUrl }                         maps.app.goo.gl / goo.gl / share.google … (resolve server-side)
//   { query }                            a place name/address pulled out of a Maps link
//   null                                 nothing recognised

const SHORT_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.co|g\.page|share\.google|app\.goo\.gl|search\.google\.com)$/i;

const valid = (lat, lon) => isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
const pair = (lat, lon) => {
  lat = Number(lat); lon = Number(lon);
  if (valid(lat, lon)) return { lat, lon };
  if (valid(lon, lat)) return { lat: lon, lon: lat }; // swapped (lng, lat)
  return null;
};

function safeDecode(s) {
  let out = s;
  for (let i = 0; i < 2; i++) { try { const d = decodeURIComponent(out.replace(/\+/g, ' ')); if (d === out) break; out = d; } catch { break; } }
  return out;
}

// ---------- Plus Codes (Open Location Code) ----------
const OLC = '23456789CFGHJMPQRVWX';
const PLUS_RE = /(?:^|[\s,(])([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,7})(?=$|[\s,)])/i;

export function decodePlusCode(code) {
  code = code.toUpperCase().replace('+', '').replace(/0+$/, '');
  let lat = -90, lon = -180, latRes = 400, lonRes = 400;
  const pairs = code.slice(0, 10);
  for (let i = 0; i < pairs.length; i += 2) {
    latRes /= 20; lonRes /= 20;
    lat += OLC.indexOf(pairs[i]) * latRes;
    if (pairs[i + 1]) lon += OLC.indexOf(pairs[i + 1]) * lonRes;
  }
  for (const ch of code.slice(10)) {
    const d = OLC.indexOf(ch);
    latRes /= 5; lonRes /= 4;
    lat += Math.floor(d / 4) * latRes;
    lon += (d % 4) * lonRes;
  }
  return { lat: lat + latRes / 2, lon: lon + lonRes / 2 };
}
function encodePrefix(lat, lon, len) {
  lat = Math.min(Math.max(lat, -90), 89.9999999) + 90;
  lon = ((((lon + 180) % 360) + 360) % 360);
  let out = '';
  for (let pv = 20; out.length < len; pv /= 20) {
    const dl = Math.floor(lat / pv); lat -= dl * pv;
    const dn = Math.floor(lon / pv); lon -= dn * pv;
    out += OLC[dl] + OLC[dn];
  }
  return out.slice(0, len);
}
/** Full or short Plus Code -> {lat, lon}. Short codes need a nearby reference point. */
export function plusCodeToLatLon(code, ref) {
  const sep = code.indexOf('+');
  if (sep === 8) return decodePlusCode(code);
  if (!ref) return null;
  const pad = 8 - sep;
  const res = Math.pow(20, 2 - pad / 2);
  const half = res / 2;
  const c = decodePlusCode(encodePrefix(ref.lat, ref.lon, pad) + code.toUpperCase());
  let { lat, lon } = c;
  if (ref.lat + half < lat && lat - res >= -90) lat -= res;
  else if (ref.lat - half > lat && lat + res <= 90) lat += res;
  if (ref.lon + half < lon) lon -= res;
  else if (ref.lon - half > lon) lon += res;
  return { lat, lon };
}

// ---------- main parser ----------
function fromUrl(s) {
  const d = safeDecode(s);
  // place pin (most precise) beats viewport centre
  let m = d.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (m) return pair(m[1], m[2]);
  m = d.match(/[?&](?:q|ll|query|sll|center|destination|daddr|saddr|coordinates|mlat)=\s*(?:loc:)?\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/i);
  if (m) return pair(m[1], m[2]);
  m = d.match(/[?&]mlat=(-?\d+\.\d+)&mlon=(-?\d+\.\d+)/i);
  if (m) return pair(m[1], m[2]);
  m = d.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return pair(m[1], m[2]);
  m = d.match(/[#&]map=\d+(?:\.\d+)?\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
  if (m) return pair(m[1], m[2]);
  m = d.match(/\/maps\/(?:search|dir|place)\/(-?\d+\.\d+)\s*,\s*\+?(-?\d+\.\d+)/);
  if (m) return pair(m[1], m[2]);
  return null;
}
function placeFromUrl(s) {
  const d = safeDecode(s);
  let m = d.match(/\/maps\/place\/([^/@?]+)/);
  if (m) return m[1].trim();
  m = d.match(/[?&](?:q|query|address|daddr)=([^&]+)/i);
  if (m && !/^-?\d+\.\d+\s*,/.test(m[1])) return m[1].trim();
  return null;
}

function fromDms(s) {
  // 40°44'54.3"N 73°59'08.4"W   |   N 40° 44.905' W 073° 59.140'
  // hemisphere letter either before every number ("N 40° … W 73° …") or after it ("40° … N 73° … W")
  const lead = /^\s*[NSEW]/i.test(s);
  const num = String.raw`(\d{1,3}(?:\.\d+)?)\s*[°º˚d]\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’m]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″”]|''|s)\s*)?`;
  const re = lead ? new RegExp(String.raw`([NSEW])\s*${num}()`, 'gi') : new RegExp(String.raw`()${num}([NSEW])?`, 'gi');
  const parts = [...s.matchAll(re)];
  if (parts.length < 2) return null;
  const conv = (p) => {
    let v = Number(p[2]) + Number(p[3] || 0) / 60 + Number(p[4] || 0) / 3600;
    const h = (p[1] || p[5] || '').toUpperCase();
    if (h === 'S' || h === 'W') v = -v;
    return { v, h };
  };
  const a = conv(parts[0]), b = conv(parts[1]);
  if (a.h === 'E' || a.h === 'W' || b.h === 'N' || b.h === 'S') return pair(b.v, a.v);
  return pair(a.v, b.v);
}

function fromDecimals(s) {
  // European decimal commas: "40,7484; -73,9857" / "40,7484 -73,9857"
  const eu = s.match(/^\s*\(?\s*(-?\d{1,3}),(\d+)\s*[;\s|/]\s*(-?\d{1,3}),(\d+)\s*\)?\s*$/);
  if (eu) return pair(`${eu[1]}.${eu[2]}`, `${eu[3]}.${eu[4]}`);
  const nums = [...s.matchAll(/(?<![\d.])([NSEW]\s*)?([-+−–]?\s?\d{1,3}(?:\.\d+)?)(\s*°)?(\s*[NSEW](?![a-z]))?/gi)]
    .filter((m) => /\./.test(m[2]) || m[1] || m[4]);
  if (nums.length < 2) {
    const ints = s.match(/^\s*\(?\s*(-?\d{1,3})\s*[,;\s]\s*(-?\d{1,3})\s*\)?\s*$/);
    return ints ? pair(ints[1], ints[2]) : null;
  }
  const conv = (m) => {
    let v = Number(m[2].replace(/[−–]/, '-').replace(/\s/g, ''));
    const h = ((m[1] || m[4] || '').trim()).toUpperCase();
    if ((h === 'S' || h === 'W') && v > 0) v = -v;
    return { v, h };
  };
  const a = conv(nums[0]), b = conv(nums[1]);
  if (a.h === 'E' || a.h === 'W' || b.h === 'N' || b.h === 'S') return pair(b.v, a.v);
  return pair(a.v, b.v);
}

export function parseLocation(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/[‎‏ ]/g, ' ');
  if (!s) return null;

  const urlMatch = s.match(/https?:\/\/[^\s]+|(?:www\.)?(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl|share\.google|g\.page|maps\.apple\.com|openstreetmap\.org)[^\s]*/i);
  if (urlMatch) {
    const url = urlMatch[0].startsWith('http') ? urlMatch[0] : `https://${urlMatch[0]}`;
    const c = fromUrl(url);
    if (c) return c;
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    // short links and Google Business "cid"/place-id links carry no coordinates: resolve server-side
    if (SHORT_HOSTS.test(host) || /[?&](cid|ludocid|place_id|ftid)=/i.test(url)) return { shortUrl: url };
    const place = placeFromUrl(url);
    if (place) return { query: place };
    return null;
  }

  const plus = s.match(PLUS_RE);
  if (plus) {
    const locality = s.replace(plus[1], '').replace(/^[\s,]+|[\s,]+$/g, '');
    return { plus: plus[1].toUpperCase(), locality };
  }

  if (/[°º˚'′"″]/.test(s)) { const c = fromDms(s); if (c) return c; }
  return fromDecimals(s);
}

/** Parse a single coordinate typed into the Lat or Lng box ("40.7484", "40.7484° N", "73°59'8\" W"). */
export function parseSingle(text, axis) {
  if (text == null) return NaN;
  const s = String(text).trim().replace(/[−–]/g, '-').replace(/,/g, '.');
  if (!s) return NaN;
  const h = (s.match(/[NSEW]/i)?.[0] || '').toUpperCase();
  const m = s.match(/(-?\d+(?:\.\d+)?)(?:\s*[°º˚d]\s*(\d+(?:\.\d+)?)?\s*['′’m]?\s*(\d+(?:\.\d+)?)?)?/);
  if (!m) return NaN;
  let v = Math.abs(Number(m[1])) + Number(m[2] || 0) / 60 + Number(m[3] || 0) / 3600;
  if (m[1].startsWith('-') || h === 'S' || h === 'W') v = -v;
  if (axis === 'lat' && Math.abs(v) > 90) return NaN;
  if (axis === 'lon' && Math.abs(v) > 180) return NaN;
  return v;
}
