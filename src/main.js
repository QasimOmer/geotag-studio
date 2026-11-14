import 'leaflet/dist/leaflet.css';
import './style.css';
import L from 'leaflet';
import exifr from 'exifr';
import JSZip from 'jszip';
import { writeMetadata, detectType, webpExifTiff } from './meta.js';
import { loadSettings, saveSettings, describeImage, guessLocation, PRESETS } from './ai.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------------- state ----------------
/** @type {Array<any>} */
const photos = [];
let nextId = 1;
let aiSettings = loadSettings();
let pin = null; // {lat, lon, place}
const defaults = store.get('gts.defaults', { author: '', copyright: '' });

// ---------------- toasts ----------------
function toast(msg, type = '', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---------------- theme ----------------
$('#btn-theme').onclick = () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('gts.theme', next); } catch { /* ignore */ }
};

// ---------------- map ----------------
const map = L.map('map', { worldCopyJump: true }).setView([25, 10], 2);
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Imagery © Esri',
});
const labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 });
L.control.layers({ Streets: streets, Satellite: L.layerGroup([satellite, labels]) }, null, { position: 'topright' }).addTo(map);
L.control.scale().addTo(map);

const existingLayer = L.layerGroup().addTo(map);
const assignedLayer = L.layerGroup().addTo(map);
const pinIcon = L.divIcon({ className: '', html: '<div class="pin main"></div>', iconSize: [26, 26], iconAnchor: [13, 30] });
const dotIcon = (cls) => L.divIcon({ className: '', html: `<div class="dot ${cls}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });
let marker = null;

map.on('click', (e) => setLocation(e.latlng.lat, e.latlng.lng));

function placeMarker(lat, lon) {
  if (!marker) {
    marker = L.marker([lat, lon], { icon: pinIcon, draggable: true, zIndexOffset: 1000 }).addTo(map);
    marker.on('dragend', () => { const p = marker.getLatLng(); setLocation(p.lat, p.lng); });
  } else marker.setLatLng([lat, lon]);
}

function jitter(lat, lon, meters) {
  if (!meters) return [lat, lon];
  const r = meters * Math.sqrt(Math.random());
  const t = Math.random() * 2 * Math.PI;
  return [lat + (r * Math.cos(t)) / 111320, lon + (r * Math.sin(t)) / (111320 * Math.cos((lat * Math.PI) / 180))];
}

async function setLocation(lat, lon, opts = {}) {
  lat = Number(lat); lon = Number(lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) { toast('Invalid coordinates', 'error'); return; }
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  placeMarker(lat, lon);
  if (opts.fly) map.flyTo([lat, lon], Math.max(map.getZoom(), opts.zoom || 16), { duration: 0.8 });
  $('#in-lat').value = lat.toFixed(6);
  $('#in-lon').value = lon.toFixed(6);
  pin = { lat, lon, place: opts.place || null };
  $('#place-label').textContent = opts.place?.display || 'Looking up address…';

  const sel = selected();
  const alt = $('#in-alt').value;
  const spread = Number($('#sel-jitter').value);
  for (const p of sel) {
    const [la, lo] = sel.length > 1 ? jitter(lat, lon, spread) : [lat, lon];
    p.lat = la; p.lon = lo;
    if (alt !== '') p.alt = Number(alt);
    p.place = opts.place || p.place;
  }
  if (sel.length) toast(`📍 Location set for ${sel.length} photo${sel.length > 1 ? 's' : ''}`, 'ok', 2200);
  else if (photos.length) toast('Pin placed. Select photos to apply this location.', '', 2500);
  renderGallery(); renderAssigned(); renderEditor();

  if (!opts.place) {
    const place = await reverseGeocode(lat, lon);
    if (pin && pin.lat === lat && pin.lon === lon) {
      pin.place = place;
      $('#place-label').textContent = place?.display || '';
      for (const p of sel) if (p.lat != null) p.place = place;
    }
  }
  if (opts.fly && opts.remember !== false && pin?.place) addHistory({ name: opts.label || pin.place.display, lat, lon });
}

// ---------------- geocoding (OpenStreetMap Nominatim) ----------------
const NOMINATIM = 'https://nominatim.openstreetmap.org';
function toPlace(r) {
  const a = r.address || {};
  return {
    display: r.display_name,
    sublocation: a.neighbourhood || a.suburb || a.quarter || a.road || '',
    city: a.city || a.town || a.village || a.municipality || a.hamlet || a.county || '',
    state: a.state || a.region || '',
    country: a.country || '',
    countryCode: a.country_code || '',
  };
}
let lastNominatim = 0;
async function nominatim(path) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const res = await fetch(`${NOMINATIM}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}
async function reverseGeocode(lat, lon) {
  try {
    const r = await nominatim(`/reverse?format=jsonv2&addressdetails=1&zoom=16&lat=${lat}&lon=${lon}`);
    return r && !r.error ? toPlace(r) : null;
  } catch { return null; }
}

// Parse "lat, lng", DMS, or Google Maps / Apple Maps / OSM links
function parseCoords(q) {
  q = q.trim();
  let m = q.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (m) return [Number(m[1]), Number(m[2])];
  m = q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
    || q.match(/[?&](?:q|ll|query|sll|center|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i)
    || q.match(/[#&]map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
  if (m) return [Number(m[1]), Number(m[2])];
  const dms = /(\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)?\s*['′]?\s*(\d+(?:\.\d+)?)?\s*["″]?\s*([NSEW])/gi;
  const parts = [...q.matchAll(dms)];
  if (parts.length === 2) {
    const conv = (p) => { let v = Number(p[1]) + Number(p[2] || 0) / 60 + Number(p[3] || 0) / 3600; if (/[SW]/i.test(p[4])) v = -v; return { v, ax: /[NS]/i.test(p[4]) ? 'lat' : 'lon' }; };
    const a = conv(parts[0]), b = conv(parts[1]);
    return a.ax === 'lat' ? [a.v, b.v] : [b.v, a.v];
  }
  return null;
}

const resultsEl = $('#search-results');
async function doSearch() {
  const q = $('#search').value.trim();
  if (!q) return;
  const c = parseCoords(q);
  if (c) { resultsEl.hidden = true; setLocation(c[0], c[1], { fly: true }); return; }
  resultsEl.innerHTML = '<li class="muted">Searching…</li>';
  resultsEl.hidden = false;
  try {
    const rs = await nominatim(`/search?format=jsonv2&addressdetails=1&limit=7&q=${encodeURIComponent(q)}`);
    if (!rs.length) { resultsEl.innerHTML = '<li class="muted">No places found</li>'; return; }
    resultsEl.innerHTML = '';
    for (const r of rs) {
      const li = document.createElement('li');
      const [first, ...rest] = r.display_name.split(', ');
      li.innerHTML = `<b></b><small></small>`;
      li.querySelector('b').textContent = first;
      li.querySelector('small').textContent = rest.join(', ');
      li.onclick = () => {
        resultsEl.hidden = true;
        $('#search').value = r.display_name;
        setLocation(Number(r.lat), Number(r.lon), { fly: true, place: toPlace(r), label: r.display_name, zoom: 17 });
      };
      resultsEl.append(li);
    }
  } catch (e) { resultsEl.innerHTML = `<li class="muted">${e.message}</li>`; }
}
$('#btn-search').onclick = doSearch;
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } if (e.key === 'Escape') resultsEl.hidden = true; });
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-wrap') && e.target.id !== 'btn-search') resultsEl.hidden = true;
  if (!e.target.closest('.history-wrap')) $('#history-list').hidden = true;
});

$('#btn-locate').onclick = () => {
  if (!navigator.geolocation) return toast('Geolocation is not available', 'error');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (pos.coords.altitude != null) $('#in-alt').value = pos.coords.altitude.toFixed(1);
      setLocation(pos.coords.latitude, pos.coords.longitude, { fly: true });
    },
    (err) => toast(err.message || 'Could not get your location', 'error'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
};
$('#btn-set-coords').onclick = () => setLocation($('#in-lat').value, $('#in-lon').value, { fly: true });
for (const id of ['#in-lat', '#in-lon']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-set-coords').click(); });

// history
function addHistory(h) {
  const list = store.get('gts.history', []).filter((x) => Math.abs(x.lat - h.lat) > 1e-5 || Math.abs(x.lon - h.lon) > 1e-5);
  list.unshift(h);
  store.set('gts.history', list.slice(0, 12));
}
$('#btn-history').onclick = () => {
  const el = $('#history-list');
  const list = store.get('gts.history', []);
  el.innerHTML = list.length ? '' : '<li class="muted">No recent locations yet</li>';
  for (const h of list) {
    const li = document.createElement('li');
    li.innerHTML = '<b></b><small></small>';
    li.querySelector('b').textContent = h.name.split(', ').slice(0, 2).join(', ');
    li.querySelector('small').textContent = `${h.lat.toFixed(5)}, ${h.lon.toFixed(5)}`;
    li.onclick = () => { el.hidden = true; setLocation(h.lat, h.lon, { fly: true, remember: false }); };
    el.append(li);
  }
  el.hidden = !el.hidden;
};

$('#chk-existing').onchange = (e) => { if (e.target.checked) existingLayer.addTo(map); else existingLayer.remove(); };

// ---------------- uploads ----------------
const dz = $('#dropzone');
const fileInput = $('#file-input');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); });
fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };
// allow dropping anywhere on the page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { if (!e.target.closest('#dropzone')) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
// paste images from clipboard
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) addFiles(files);
});

const str = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(str).join(', ');
  if (typeof v === 'object') return str(v.value ?? Object.values(v)[0]);
  return String(v).replace(/\0+$/, '').trim();
};

async function readExisting(file) {
  try {
    let src = file;
    if (/webp/i.test(file.type) || /\.webp$/i.test(file.name || '')) {
      // exifr can't open WebP containers: pull the EXIF (TIFF) chunk out ourselves
      src = webpExifTiff(await file.arrayBuffer());
      if (!src) return {};
    }
    const d = await exifr.parse(src, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, ifd1: false, mergeOutput: true, translateValues: true, reviveValues: true });
    if (!d) return {};
    let kw = d.subject ?? d.Keywords ?? d.XPKeywords ?? '';
    kw = Array.isArray(kw) ? kw.map(str) : str(kw).split(/[;,]/);
    return {
      lat: typeof d.latitude === 'number' ? d.latitude : null,
      lon: typeof d.longitude === 'number' ? d.longitude : null,
      alt: typeof d.GPSAltitude === 'number' ? d.GPSAltitude * (d.GPSAltitudeRef === 1 ? -1 : 1) : null,
      title: str(d.title ?? d.XPTitle ?? d.ObjectName ?? d.DocumentName),
      description: str(d.description ?? d.ImageDescription ?? d.XPComment ?? d.Caption),
      keywords: kw.map((s) => s.trim()).filter(Boolean),
      author: str(d.Artist ?? d.creator ?? d.XPAuthor ?? d.Byline),
      copyright: str(d.Copyright ?? d.rights ?? d.CopyrightNotice),
      date: d.DateTimeOriginal instanceof Date ? d.DateTimeOriginal : (d.CreateDate instanceof Date ? d.CreateDate : null),
      raw: d,
    };
  } catch { return {}; }
}

const isHeic = (f) => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
const isSupported = (f) => /image\/(jpeg|png|webp)/i.test(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name) || isHeic(f);

async function addFiles(fileList) {
  const files = [...fileList].filter(isSupported);
  const skipped = fileList.length - files.length;
  if (skipped) toast(`Skipped ${skipped} unsupported file(s). Use JPG, PNG, WebP or HEIC.`, 'error');
  if (!files.length) return;
  for (const p of photos) p.selected = false;
  const tLoad = files.length > 3 ? toast(`Loading ${files.length} photos…`, '', 60000) : null;
  for (const file of files) {
    const existing = await readExisting(file);
    let blob = file;
    let name = file.name;
    let converted = false;
    if (isHeic(file)) {
      try {
        const { default: heic2any } = await import('heic2any');
        const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
        blob = Array.isArray(out) ? out[0] : out;
        name = name.replace(/\.hei[cf]$/i, '') + '.jpg';
        converted = true;
      } catch (e) { toast(`Could not convert ${file.name}: ${e.message || e}`, 'error'); continue; }
    } else {
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (detectType(head) === 'unknown') { toast(`${file.name} is not a valid image`, 'error'); continue; }
    }
    photos.push({
      id: nextId++, name, origName: file.name, blob, size: blob.size, converted,
      url: URL.createObjectURL(blob),
      existing,
      title: existing.title || '',
      description: existing.description || '',
      keywords: existing.keywords || [],
      author: existing.author || defaults.author || '',
      copyright: existing.copyright || defaults.copyright || '',
      date: existing.date || null,
      alt: existing.alt ?? null,
      lat: null, lon: null, place: null,
      selected: true, status: converted ? 'converted' : '',
    });
  }
  tLoad?.remove();
  // apply current pin to new uploads if there is one
  if (pin) for (const p of selected()) { p.lat = pin.lat; p.lon = pin.lon; p.place = pin.place; }
  renderAll();
  const withGps = photos.filter((p) => p.existing.lat != null);
  if (withGps.length && !pin) {
    map.fitBounds(L.latLngBounds(withGps.map((p) => [p.existing.lat, p.existing.lon])).pad(0.3), { maxZoom: 15 });
  }
  toast(`Added ${files.length} photo${files.length > 1 ? 's' : ''}${pin ? ' — current pin applied' : ' — now click the map or search a place'}`, 'ok');
}

// ---------------- selection & rendering ----------------
const selected = () => photos.filter((p) => p.selected);
const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const extOf = (n) => (n.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

function renderAll() { renderGallery(); renderExisting(); renderAssigned(); renderEditor(); }

function renderGallery() {
  const g = $('#gallery');
  if (!photos.length) {
    g.innerHTML = '<div class="empty">☝ No images uploaded yet — drop some photos above.</div>';
  } else {
    g.innerHTML = '';
    for (const p of photos) {
      const t = document.createElement('div');
      t.className = `tile${p.selected ? ' sel' : ''}`;
      t.dataset.id = p.id;
      t.innerHTML = `
        <img loading="lazy" alt="" />
        <input class="sel-box" type="checkbox" ${p.selected ? 'checked' : ''} aria-label="Select" />
        <div class="tools">
          <button data-act="inspect" title="Inspect metadata">ⓘ</button>
          <button data-act="download" title="Download this photo">⬇</button>
          <button data-act="remove" title="Remove">✕</button>
        </div>
        <div class="info">
          <div class="name"></div>
          <div class="ttl"></div>
          <div class="badges"></div>
        </div>`;
      t.querySelector('img').src = p.url;
      t.querySelector('img').alt = p.description || p.name;
      t.querySelector('.name').textContent = p.name;
      t.querySelector('.name').title = p.name;
      t.querySelector('.ttl').textContent = p.title || '—';
      const b = t.querySelector('.badges');
      const add = (txt, cls = '') => { const s = document.createElement('span'); s.className = `badge ${cls}`; s.textContent = txt; b.append(s); };
      add(`${extOf(p.name).toUpperCase()} · ${fmtSize(p.size)}`);
      if (p.converted) add('from HEIC');
      if (p.existing.lat != null) add('had GPS', 'old');
      if (p.lat != null) add(`📍 ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`, 'new');
      if (p.status === 'ai') add('AI working…', 'busy');
      if (p.status === 'error') add('error', 'err');
      if (p.status === 'done') add('✓ saved', 'new');
      g.append(t);
    }
  }
  const n = selected().length;
  $('#gallery-count').textContent = photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''} · ${n} selected` : 'No images uploaded yet';
  $('#chk-all').checked = photos.length > 0 && n === photos.length;
  $('#chk-all').indeterminate = n > 0 && n < photos.length;
  $('#btn-remove').disabled = !n;
}

$('#gallery').addEventListener('click', async (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const p = photos.find((x) => x.id === Number(tile.dataset.id));
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'remove') return removePhotos([p]);
  if (act === 'download') return downloadPhotos([p]);
  if (act === 'inspect') return inspect(p);
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.target.classList.contains('sel-box')) p.selected = !p.selected;
  else {
    // plain click: select only this one (click again to toggle)
    const only = p.selected && selected().length === 1;
    for (const x of photos) x.selected = false;
    p.selected = !only;
  }
  if (p.selected && p.lat != null) { placeMarker(p.lat, p.lon); map.panTo([p.lat, p.lon]); }
  renderGallery(); renderEditor(); renderAssigned();
});

$('#chk-all').onchange = (e) => { for (const p of photos) p.selected = e.target.checked; renderGallery(); renderEditor(); renderAssigned(); };
$('#btn-remove').onclick = () => removePhotos(selected());
function removePhotos(list) {
  for (const p of list) { URL.revokeObjectURL(p.url); photos.splice(photos.indexOf(p), 1); }
  renderAll();
}

function renderExisting() {
  existingLayer.clearLayers();
  for (const p of photos) {
    if (p.existing.lat == null) continue;
    L.marker([p.existing.lat, p.existing.lon], { icon: dotIcon('old') })
      .bindTooltip(`${p.name} (existing geotag)`).addTo(existingLayer);
  }
}
function renderAssigned() {
  assignedLayer.clearLayers();
  for (const p of photos) {
    if (p.lat == null) continue;
    L.marker([p.lat, p.lon], { icon: dotIcon('new'), opacity: p.selected ? 1 : 0.6 })
      .bindTooltip(`${p.name} (new geotag)`).addTo(assignedLayer);
  }
}

// ---------------- editor ----------------
const toLocalInput = (d) => (d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19) : '');
const fieldGet = {
  title: (p) => p.title, description: (p) => p.description, author: (p) => p.author, copyright: (p) => p.copyright,
  keywords: (p) => p.keywords.join(', '), date: (p) => toLocalInput(p.date), alt: (p) => (p.alt ?? '') + '',
};
const fieldSet = {
  title: (p, v) => { p.title = v; }, description: (p, v) => { p.description = v; },
  author: (p, v) => { p.author = v; }, copyright: (p, v) => { p.copyright = v; },
  keywords: (p, v) => { p.keywords = v.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean); },
  date: (p, v) => { p.date = v ? new Date(v) : null; },
  alt: (p, v) => { p.alt = v === '' ? null : Number(v); },
};

function renderEditor() {
  const sel = selected();
  const n = sel.length;
  $('#fields').disabled = !n;
  for (const id of ['#btn-ai-fill', '#btn-download', '#btn-strip']) $(id).disabled = !n;
  $('#btn-ai-locate').disabled = n === 0;
  $('#editor-title').textContent = n ? `Editing ${n} photo${n > 1 ? 's' : ''}` : 'Select photos to edit';
  const located = sel.filter((p) => p.lat != null).length;
  $('#editor-sub').textContent = !n ? 'Upload photos, pick a location on the map, fill in details, then download.'
    : `${located}/${n} have a new location${located < n ? ' — click the map to set one' : ''}. Changes apply to all selected photos.`;
  $('#btn-download').textContent = n > 1 ? `⬇ Write tags & download ${n} (ZIP)` : '⬇ Write tags & download';
  for (const el of $$('[data-field]')) {
    if (document.activeElement === el) continue;
    const f = el.dataset.field;
    const vals = [...new Set(sel.map(fieldGet[f]))];
    el.value = vals.length === 1 ? vals[0] : '';
    el.placeholder = vals.length > 1 ? '(multiple values — typing overwrites all)' : '';
  }
  updateCounts();
}
function updateCounts() {
  const t = $('[data-field=title]').value.length;
  const d = $('[data-field=description]').value.length;
  const k = $('[data-field=keywords]').value.split(/[,;\n]/).filter((s) => s.trim()).length;
  const set = (name, txt, warn) => { const el = $(`[data-count=${name}]`); el.textContent = txt; el.classList.toggle('warn', warn); };
  set('title', `${t}/70`, t > 70);
  set('description', `${d}/125 recommended`, d > 125);
  set('keywords', `${k} keywords`, k > 25);
}
for (const el of $$('[data-field]')) {
  el.addEventListener('input', () => {
    const f = el.dataset.field;
    for (const p of selected()) fieldSet[f](p, el.value);
    if (f === 'author' || f === 'copyright') { defaults[f] = el.value; store.set('gts.defaults', defaults); }
    updateCounts();
    clearTimeout(el._t);
    el._t = setTimeout(renderGallery, 300);
  });
}
$('#btn-add-place-kw').onclick = () => {
  let added = 0;
  for (const p of selected()) {
    const pl = p.place || pin?.place;
    if (!pl) continue;
    const extra = [pl.sublocation, pl.city, pl.state, pl.country].filter(Boolean);
    const have = new Set(p.keywords.map((k) => k.toLowerCase()));
    for (const k of extra) if (!have.has(k.toLowerCase())) { p.keywords.push(k); added++; }
  }
  if (!added) toast('Set a location on the map first (place names come from the pin).', 'error');
  renderEditor();
};

// ---------------- output ----------------
const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };

async function buildOutput(p, strip = false) {
  const buf = await p.blob.arrayBuffer();
  const { bytes, type } = writeMetadata(buf, {
    title: p.title, description: p.description, keywords: p.keywords, author: p.author, copyright: p.copyright,
    date: p.date, lat: p.lat, lon: p.lon, alt: p.alt, place: p.place,
  }, strip);
  let base = p.name.replace(/\.[^.]+$/, '');
  if ($('#chk-rename').checked && p.title && !strip) base = slug(p.title) || base;
  if (strip) base += '-clean';
  return { blob: new Blob([bytes], { type: MIME[type] }), filename: `${base}.${EXT[type]}` };
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function downloadPhotos(list, strip = false) {
  if (!list.length) return;
  const missing = list.filter((p) => p.lat == null && p.existing.lat == null).length;
  if (!strip && missing) toast(`${missing} photo(s) have no location — only text tags will be written.`, '', 3500);
  try {
    if (list.length === 1) {
      const { blob, filename } = await buildOutput(list[0], strip);
      saveBlob(blob, filename);
      list[0].status = 'done';
    } else {
      const zip = new JSZip();
      const used = new Set();
      for (const p of list) {
        const out = await buildOutput(p, strip);
        let fn = out.filename; let i = 2;
        while (used.has(fn.toLowerCase())) fn = out.filename.replace(/(\.[^.]+)$/, `-${i++}$1`);
        used.add(fn.toLowerCase());
        zip.file(fn, out.blob);
        p.status = 'done';
      }
      const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      saveBlob(blob, strip ? 'photos-clean.zip' : 'geotagged-photos.zip');
    }
    toast(strip ? 'Metadata removed ✓' : `Saved ${list.length} geotagged photo${list.length > 1 ? 's' : ''} ✓`, 'ok');
  } catch (e) {
    console.error(e);
    toast(`Could not write tags: ${e.message}`, 'error', 6000);
  }
  renderGallery();
}
$('#btn-download').onclick = () => downloadPhotos(selected());
$('#btn-strip').onclick = () => downloadPhotos(selected(), true);

// ---------------- inspect ----------------
async function inspect(p) {
  $('#inspect-title').textContent = p.name;
  const body = $('#inspect-body');
  body.innerHTML = '<p class="muted">Reading metadata…</p>';
  $('#dlg-inspect').showModal();
  let after = {};
  try {
    const { blob } = await buildOutput(p);
    after = await readExisting(blob);
  } catch (e) { after = { error: e.message }; }
  const b = p.existing;
  const fmtLL = (o) => (o.lat != null ? `${o.lat.toFixed(6)}, ${o.lon.toFixed(6)}` : '—');
  const rows = [
    ['GPS', fmtLL(b), fmtLL(after)],
    ['Altitude', b.alt != null ? `${b.alt.toFixed(1)} m` : '—', after.alt != null ? `${after.alt.toFixed(1)} m` : '—'],
    ['Title', b.title, after.title],
    ['Description', b.description, after.description],
    ['Keywords', (b.keywords || []).join(', '), (after.keywords || []).join(', ')],
    ['Author', b.author, after.author],
    ['Copyright', b.copyright, after.copyright],
    ['Date taken', b.date?.toLocaleString(), after.date?.toLocaleString()],
    ['Camera', [b.raw?.Make, b.raw?.Model].filter(Boolean).join(' '), [after.raw?.Make, after.raw?.Model].filter(Boolean).join(' ')],
  ];
  const t = document.createElement('table');
  t.className = 'meta-table';
  t.innerHTML = '<thead><tr><th>Field</th><th>Original</th><th>After writing</th></tr></thead><tbody></tbody>';
  for (const [k, v1, v2] of rows) {
    const tr = document.createElement('tr');
    const cells = [k, v1 || '—', v2 || '—'];
    cells.forEach((c, i) => { const el = document.createElement(i ? 'td' : 'th'); el.textContent = c; if (i === 2 && (v2 || '') !== (v1 || '')) el.className = 'changed'; tr.append(el); });
    t.tBodies[0].append(tr);
  }
  body.innerHTML = '';
  if (after.error) body.innerHTML = `<p class="muted">Could not build output: ${after.error}</p>`;
  body.append(t);
  const ll = after.lat != null ? after : (b.lat != null ? b : null);
  if (ll) {
    const a = document.createElement('p');
    a.innerHTML = `<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${ll.lat},${ll.lon}">Open location in Google Maps ↗</a>`;
    body.append(a);
  }
}

// ---------------- AI ----------------
const providerName = () => ({ builtin: 'Built-in', gemini: 'Gemini', openai: 'OpenAI-compatible' }[aiSettings.provider]);
$('#ai-provider-label').textContent = providerName();

const dlgAi = $('#dlg-ai');
const aiForm = $('#ai-form');
function syncProviderGroups() {
  const v = aiForm.provider.value;
  for (const g of $$('.pgroup', aiForm)) g.hidden = g.dataset.for !== v;
}
$('#btn-ai-settings').onclick = () => {
  for (const [k, v] of Object.entries(aiSettings)) {
    const el = aiForm.elements[k];
    if (!el) continue;
    if (el instanceof RadioNodeList) el.value = v; else el.value = v;
  }
  syncProviderGroups();
  dlgAi.showModal();
};
aiForm.addEventListener('change', (e) => { if (e.target.name === 'provider') syncProviderGroups(); });
for (const b of $$('[data-preset]', aiForm)) {
  b.onclick = () => {
    const pr = PRESETS[b.dataset.preset];
    aiForm.openaiBase.value = pr.baseUrl;
    aiForm.openaiModel.value = pr.model;
    $('#preset-key-link').href = pr.keyUrl;
  };
}
dlgAi.addEventListener('close', () => {
  if (dlgAi.returnValue !== 'save') return;
  const fd = new FormData(aiForm);
  aiSettings = { ...aiSettings, ...Object.fromEntries(fd.entries()) };
  saveSettings(aiSettings);
  $('#ai-provider-label').textContent = providerName();
  toast('AI settings saved', 'ok', 2000);
});

$('#btn-ai-fill').onclick = async () => {
  const list = selected();
  if (!list.length) return;
  const btn = $('#btn-ai-fill');
  btn.disabled = true;
  const status = toast(`✨ AI is writing metadata for ${list.length} photo(s)…`, '', 600000);
  let ok = 0;
  for (const [i, p] of list.entries()) {
    p.status = 'ai'; renderGallery();
    try {
      const r = await describeImage(p.url, {
        place: p.place || pin?.place, business: aiSettings.business, focus: aiSettings.focus, language: aiSettings.language,
      }, aiSettings, (msg) => { status.textContent = `✨ ${i + 1}/${list.length}: ${msg}`; });
      if (r.title) p.title = r.title;
      if (r.description) p.description = r.description;
      if (r.keywords?.length) p.keywords = r.keywords;
      p.status = '';
      ok++;
    } catch (e) {
      console.error(e);
      p.status = 'error';
      toast(`AI failed for ${p.name}: ${e.message}`, 'error', 7000);
      if (/key|401|403|quota|rate/i.test(e.message)) break;
    }
    renderGallery(); renderEditor();
  }
  status.remove();
  if (ok) toast(`✨ AI filled ${ok} photo${ok > 1 ? 's' : ''}. Review & edit before downloading.`, 'ok');
  btn.disabled = false;
  renderEditor();
};

$('#btn-ai-locate').onclick = async () => {
  const p = selected()[0];
  if (!p) return;
  if (aiSettings.provider === 'builtin') {
    toast('Location guessing needs a vision LLM. Opening AI settings — Gemini has a free key.', '', 5000);
    $('#btn-ai-settings').click();
    return;
  }
  const btn = $('#btn-ai-locate');
  btn.disabled = true;
  const t = toast(`🌍 Analyzing ${p.name} for location clues…`, '', 120000);
  try {
    const r = await guessLocation(p.url, aiSettings);
    t.remove();
    await setLocation(r.lat, r.lon, { fly: true, zoom: r.confidence === 'high' ? 15 : 11 });
    marker.bindPopup(`<b>${escapeHtml(r.place || 'AI guess')}</b><br>Confidence: ${escapeHtml(r.confidence || '?')}<br><small>${escapeHtml(r.reasoning || '')}</small><br><small class="muted">Drag the pin to correct it.</small>`).openPopup();
  } catch (e) {
    t.remove();
    toast(`AI location failed: ${e.message}`, 'error', 7000);
  }
  btn.disabled = false;
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

renderAll();
