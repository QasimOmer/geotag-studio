// Metadata engine: writes EXIF (incl. GPS + Windows XP tags) and XMP into JPEG, PNG and WebP,
// fully in the browser. No server, no uploads.
import piexif from 'piexifjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- helpers ----------
const toBin = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
};
const fromBin = (s) => {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
};
const concat = (parts) => {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const startsWith = (u8, off, str) => {
  for (let i = 0; i < str.length; i++) if (u8[off + i] !== str.charCodeAt(i)) return false;
  return true;
};
// UTF-8 bytes packed into a "binary string" for piexif ASCII fields
const utf8Bin = (s) => toBin(enc.encode(s || ''));
// UCS-2 LE byte array for XP* tags (Windows Explorer shows these)
const ucs2 = (s) => {
  const out = [];
  for (const ch of String(s || '')) {
    const c = ch.charCodeAt(0);
    out.push(c & 0xff, c >> 8);
  }
  out.push(0, 0);
  return out;
};
const xmlEsc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function detectType(u8) {
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'jpeg';
  if (u8[0] === 0x89 && startsWith(u8, 1, 'PNG')) return 'png';
  if (startsWith(u8, 0, 'RIFF') && startsWith(u8, 8, 'WEBP')) return 'webp';
  if (startsWith(u8, 4, 'ftyp')) return 'heic';
  return 'unknown';
}

// ---------- EXIF building ----------
const pad2 = (n) => String(n).padStart(2, '0');
export function exifDate(d) {
  return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
const toRational = (x, den = 10000) => [Math.round(x * den), den];
const dmsRational = (deg) => {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return [[d, 1], [m, 1], [Math.round(s * 10000), 10000]];
};

function buildExifObj(existingExifPayload, m) {
  let ex = null;
  if (existingExifPayload) {
    try { ex = piexif.load(toBin(existingExifPayload)); } catch { ex = null; }
  }
  if (!ex) ex = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
  ex['0th'] = ex['0th'] || {}; ex.Exif = ex.Exif || {}; ex.GPS = ex.GPS || {};
  const I = piexif.ImageIFD, E = piexif.ExifIFD, G = piexif.GPSIFD;
  const z = ex['0th'];

  if (m.title !== undefined) {
    if (m.title) { z[I.XPTitle] = ucs2(m.title); z[I.DocumentName] = utf8Bin(m.title); }
    else { delete z[I.XPTitle]; delete z[I.DocumentName]; }
  }
  if (m.description !== undefined) {
    if (m.description) {
      z[I.ImageDescription] = utf8Bin(m.description);
      z[I.XPComment] = ucs2(m.description);
      z[I.XPSubject] = ucs2(m.description);
      ex.Exif[E.UserComment] = 'ASCII\0\0\0' + m.description.replace(/[^\x20-\x7e]/g, ' ');
    } else {
      delete z[I.ImageDescription]; delete z[I.XPComment]; delete z[I.XPSubject]; delete ex.Exif[E.UserComment];
    }
  }
  if (m.keywords !== undefined) {
    const kw = m.keywords.join('; ');
    if (kw) z[I.XPKeywords] = ucs2(kw); else delete z[I.XPKeywords];
  }
  if (m.author !== undefined) {
    if (m.author) { z[I.Artist] = utf8Bin(m.author); z[I.XPAuthor] = ucs2(m.author); }
    else { delete z[I.Artist]; delete z[I.XPAuthor]; }
  }
  if (m.copyright !== undefined) {
    if (m.copyright) z[I.Copyright] = utf8Bin(m.copyright); else delete z[I.Copyright];
  }
  if (m.date) {
    const d = exifDate(m.date);
    z[I.DateTime] = d; ex.Exif[E.DateTimeOriginal] = d; ex.Exif[E.DateTimeDigitized] = d;
  }
  z[I.Software] = 'GeoTag Studio';

  if (m.lat != null && m.lon != null && isFinite(m.lat) && isFinite(m.lon)) {
    const gps = {};
    gps[G.GPSVersionID] = [2, 3, 0, 0];
    gps[G.GPSLatitudeRef] = m.lat < 0 ? 'S' : 'N';
    gps[G.GPSLatitude] = dmsRational(m.lat);
    gps[G.GPSLongitudeRef] = m.lon < 0 ? 'W' : 'E';
    gps[G.GPSLongitude] = dmsRational(m.lon);
    if (m.alt != null && m.alt !== '' && isFinite(m.alt)) {
      gps[G.GPSAltitudeRef] = m.alt < 0 ? 1 : 0;
      gps[G.GPSAltitude] = toRational(Math.abs(Number(m.alt)), 100);
    }
    gps[G.GPSMapDatum] = 'WGS-84';
    if (m.date) {
      const u = m.date;
      gps[G.GPSDateStamp] = `${u.getUTCFullYear()}:${pad2(u.getUTCMonth() + 1)}:${pad2(u.getUTCDate())}`;
      gps[G.GPSTimeStamp] = [[u.getUTCHours(), 1], [u.getUTCMinutes(), 1], [u.getUTCSeconds(), 1]];
    }
    ex.GPS = gps;
  } else if (m.clearGps) {
    ex.GPS = {};
  }
  return ex;
}

function dumpExif(ex) {
  // Returns "Exif\0\0" + TIFF bytes. Drops bulky parts if the segment would be too big for JPEG.
  const attempts = [
    (e) => e,
    (e) => ({ ...e, thumbnail: null, '1st': {} }),
    (e) => { const c = { ...e, thumbnail: null, '1st': {}, Interop: {} }; c.Exif = { ...e.Exif }; delete c.Exif[piexif.ExifIFD.MakerNote]; return c; },
    (e) => { // last resort: keep only what we wrote + basic camera info
      const keep0 = {}; const z = e['0th'];
      for (const k of Object.keys(z)) if (typeof z[k] !== 'object' || Array.isArray(z[k])) keep0[k] = z[k];
      const exifKeep = {};
      const E = piexif.ExifIFD;
      for (const k of [E.DateTimeOriginal, E.DateTimeDigitized, E.UserComment]) if (e.Exif[k]) exifKeep[k] = e.Exif[k];
      return { '0th': keep0, Exif: exifKeep, GPS: e.GPS, Interop: {}, '1st': {}, thumbnail: null };
    },
  ];
  let lastErr;
  for (const f of attempts) {
    try {
      const bytes = fromBin(piexif.dump(f(ex)));
      if (bytes.length < 65000) return bytes;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('EXIF block too large');
}

// ---------- XMP ----------
function xmpLatLon(v, pos, neg) {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = (a - d) * 60;
  return `${d},${m.toFixed(6)}${v < 0 ? neg : pos}`;
}
function buildXmp(m) {
  const alt = (v) => `<rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(v)}</rdf:li></rdf:Alt>`;
  const p = [];
  if (m.title) p.push(`<dc:title>${alt(m.title)}</dc:title>`);
  if (m.description) p.push(`<dc:description>${alt(m.description)}</dc:description>`);
  if (m.keywords?.length) p.push(`<dc:subject><rdf:Bag>${m.keywords.map((k) => `<rdf:li>${xmlEsc(k)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`);
  if (m.author) p.push(`<dc:creator><rdf:Seq><rdf:li>${xmlEsc(m.author)}</rdf:li></rdf:Seq></dc:creator>`);
  if (m.copyright) p.push(`<dc:rights>${alt(m.copyright)}</dc:rights>`);
  if (m.description) p.push(`<Iptc4xmpCore:AltTextAccessibility>${alt(m.description)}</Iptc4xmpCore:AltTextAccessibility>`);
  if (m.lat != null && m.lon != null && isFinite(m.lat)) {
    p.push(`<exif:GPSLatitude>${xmpLatLon(m.lat, 'N', 'S')}</exif:GPSLatitude>`);
    p.push(`<exif:GPSLongitude>${xmpLatLon(m.lon, 'E', 'W')}</exif:GPSLongitude>`);
    p.push(`<exif:GPSMapDatum>WGS-84</exif:GPSMapDatum><exif:GPSVersionID>2.3.0.0</exif:GPSVersionID>`);
    if (m.alt != null && m.alt !== '' && isFinite(m.alt)) {
      p.push(`<exif:GPSAltitude>${Math.round(Math.abs(m.alt) * 100)}/100</exif:GPSAltitude><exif:GPSAltitudeRef>${m.alt < 0 ? 1 : 0}</exif:GPSAltitudeRef>`);
    }
  }
  if (m.place) {
    if (m.place.city) p.push(`<photoshop:City>${xmlEsc(m.place.city)}</photoshop:City>`);
    if (m.place.state) p.push(`<photoshop:State>${xmlEsc(m.place.state)}</photoshop:State>`);
    if (m.place.country) p.push(`<photoshop:Country>${xmlEsc(m.place.country)}</photoshop:Country>`);
    if (m.place.countryCode) p.push(`<Iptc4xmpCore:CountryCode>${xmlEsc(m.place.countryCode.toUpperCase())}</Iptc4xmpCore:CountryCode>`);
    if (m.place.sublocation) p.push(`<Iptc4xmpCore:Location>${xmlEsc(m.place.sublocation)}</Iptc4xmpCore:Location>`);
  }
  if (m.date) {
    const iso = new Date(m.date.getTime() - m.date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    p.push(`<photoshop:DateCreated>${iso}</photoshop:DateCreated><exif:DateTimeOriginal>${iso}</exif:DateTimeOriginal>`);
  }
  // Windows Explorer's "Date acquired" is read only from this Microsoft XMP tag.
  // Use the explicit acquired date, else the date taken, else now.
  const acq = m.dateAcquired || m.date || new Date();
  const acqIso = new Date(acq.getTime() - acq.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  p.push(`<MicrosoftPhoto:DateAcquired>${acqIso}</MicrosoftPhoto:DateAcquired>`);
  p.push(`<xmp:CreatorTool>GeoTag Studio</xmp:CreatorTool><xmp:MetadataDate>${new Date().toISOString()}</xmp:MetadataDate>`);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/">
${p.join('\n')}
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
}

// ---------- JPEG ----------
const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
function jpegSegments(u8) {
  const segs = [];
  let i = 2;
  while (i < u8.length) {
    if (u8[i] !== 0xff) throw new Error('Corrupt JPEG');
    const marker = u8[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xda || marker === 0xd9) { segs.push({ marker, start: i, end: u8.length, rest: true }); break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { segs.push({ marker, start: i, end: i + 2 }); i += 2; continue; }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    segs.push({ marker, start: i, end: i + 2 + len });
    i += 2 + len;
  }
  return segs;
}
const app1 = (payload) => concat([new Uint8Array([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);

function processJpeg(u8, m, strip) {
  const segs = jpegSegments(u8);
  let exifPayload = null;
  const kept = [];
  for (const s of segs) {
    const isApp1 = s.marker === 0xe1;
    const payloadOff = s.start + 4;
    if (isApp1 && startsWith(u8, payloadOff, 'Exif\0\0')) { exifPayload = u8.subarray(payloadOff, s.end); continue; }
    if (isApp1 && startsWith(u8, payloadOff, XMP_NS)) continue;
    if (strip && (isApp1 || s.marker === 0xed || s.marker === 0xfe)) continue; // APP1/APP13 (IPTC)/COM
    kept.push(u8.subarray(s.start, s.end));
  }
  const out = [new Uint8Array([0xff, 0xd8])];
  let idx = 0;
  if (kept[0] && kept[0][1] === 0xe0) out.push(kept[idx++]); // keep JFIF APP0 first
  if (!strip) {
    out.push(app1(dumpExif(buildExifObj(exifPayload, m))));
    out.push(app1(concat([enc.encode(XMP_NS), enc.encode(buildXmp(m))])));
  } else if (exifPayload) {
    // keep only orientation so the image doesn't rotate after stripping
    try {
      const old = piexif.load(toBin(exifPayload));
      const o = old['0th']?.[piexif.ImageIFD.Orientation];
      if (o && o !== 1) out.push(app1(fromBin(piexif.dump({ '0th': { [piexif.ImageIFD.Orientation]: o }, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null }))));
    } catch { /* ignore */ }
  }
  for (; idx < kept.length; idx++) out.push(kept[idx]);
  return concat(out);
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const td = concat([enc.encode(type), data]);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(td, 4);
  dv.setUint32(8 + data.length, crc32(td));
  return out;
}
function processPng(u8, m, strip) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const chunks = [];
  let exifPayload = null;
  let i = 8;
  while (i < u8.length) {
    const len = dv.getUint32(i);
    const type = dec.decode(u8.subarray(i + 4, i + 8));
    const data = u8.subarray(i + 8, i + 8 + len);
    const whole = u8.subarray(i, i + 12 + len);
    i += 12 + len;
    if (type === 'eXIf') { exifPayload = concat([enc.encode('Exif\0\0'), data]); continue; }
    if (type === 'iTXt' && startsWith(data, 0, 'XML:com.adobe.xmp')) continue;
    if (strip && (type === 'tEXt' || type === 'zTXt' || type === 'iTXt' || type === 'tIME')) continue;
    chunks.push({ type, whole });
    if (type === 'IEND') break;
  }
  const out = [u8.subarray(0, 8)];
  for (const c of chunks) {
    out.push(c.whole);
    if (c.type === 'IHDR' && !strip) {
      const tiff = dumpExif(buildExifObj(exifPayload, m)).subarray(6);
      out.push(pngChunk('eXIf', tiff));
      const xmp = enc.encode(buildXmp(m));
      out.push(pngChunk('iTXt', concat([enc.encode('XML:com.adobe.xmp'), new Uint8Array([0, 0, 0, 0, 0]), xmp])));
    }
  }
  return concat(out);
}

// ---------- WebP ----------
function riffChunk(fourcc, data) {
  const padded = data.length % 2 ? 1 : 0;
  const out = new Uint8Array(8 + data.length + padded);
  out.set(enc.encode(fourcc), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}
function webpDims(chunks) {
  for (const c of chunks) {
    const d = c.data;
    if (c.fourcc === 'VP8 ') {
      return { w: (d[6] | (d[7] << 8)) & 0x3fff, h: (d[8] | (d[9] << 8)) & 0x3fff, alpha: false };
    }
    if (c.fourcc === 'VP8L') {
      const b = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, alpha: !!((b >> 28) & 1) };
    }
  }
  return null;
}
function processWebp(u8, m, strip) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const chunks = [];
  let exifPayload = null;
  let i = 12;
  while (i + 8 <= u8.length) {
    const fourcc = dec.decode(u8.subarray(i, i + 4));
    const len = dv.getUint32(i + 4, true);
    const data = u8.subarray(i + 8, i + 8 + len);
    i += 8 + len + (len % 2);
    if (fourcc === 'EXIF') {
      exifPayload = startsWith(data, 0, 'Exif\0\0') ? data : concat([enc.encode('Exif\0\0'), data]);
      continue;
    }
    if (fourcc === 'XMP ') continue;
    chunks.push({ fourcc, data });
  }
  let vp8x = chunks.find((c) => c.fourcc === 'VP8X');
  if (!vp8x) {
    const dims = webpDims(chunks);
    if (!dims) throw new Error('Unsupported WebP');
    const d = new Uint8Array(10);
    d[0] = dims.alpha ? 0x10 : 0;
    const w = dims.w - 1, h = dims.h - 1;
    d[4] = w & 0xff; d[5] = (w >> 8) & 0xff; d[6] = (w >> 16) & 0xff;
    d[7] = h & 0xff; d[8] = (h >> 8) & 0xff; d[9] = (h >> 16) & 0xff;
    vp8x = { fourcc: 'VP8X', data: d };
    chunks.unshift(vp8x);
  } else {
    vp8x.data = new Uint8Array(vp8x.data);
  }
  if (strip) vp8x.data[0] &= ~0x0c;
  else vp8x.data[0] |= 0x0c; // EXIF + XMP flags
  const parts = chunks.map((c) => riffChunk(c.fourcc, c.data));
  if (!strip) {
    parts.push(riffChunk('EXIF', dumpExif(buildExifObj(exifPayload, m)).subarray(6)));
    parts.push(riffChunk('XMP ', enc.encode(buildXmp(m))));
  }
  const body = concat(parts);
  const head = new Uint8Array(12);
  head.set(enc.encode('RIFF'), 0);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set(enc.encode('WEBP'), 8);
  return concat([head, body]);
}

/** Returns the raw TIFF (EXIF) bytes stored in a WebP file, or null. */
export function webpExifTiff(buf) {
  const u8 = new Uint8Array(buf);
  if (detectType(u8) !== 'webp') return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = 12;
  while (i + 8 <= u8.length) {
    const fourcc = dec.decode(u8.subarray(i, i + 4));
    const len = dv.getUint32(i + 4, true);
    if (fourcc === 'EXIF') {
      const d = u8.slice(i + 8, i + 8 + len);
      return startsWith(d, 0, 'Exif\0\0') ? d.slice(6) : d;
    }
    i += 8 + len + (len % 2);
  }
  return null;
}

// ---------- public API ----------
/**
 * @param {ArrayBuffer} buf  image bytes (jpeg/png/webp)
 * @param {object} m  { title, description, keywords[], author, copyright, date(Date), lat, lon, alt, place }
 * @param {boolean} strip  remove all metadata instead of writing
 * @returns {{bytes: Uint8Array, type: string}}
 */
export function writeMetadata(buf, m, strip = false) {
  const u8 = new Uint8Array(buf);
  const type = detectType(u8);
  if (type === 'jpeg') return { bytes: processJpeg(u8, m, strip), type };
  if (type === 'png') return { bytes: processPng(u8, m, strip), type };
  if (type === 'webp') return { bytes: processWebp(u8, m, strip), type };
  throw new Error(`Unsupported format (${type}). Convert to JPG first.`);
}
