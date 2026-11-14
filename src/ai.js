// Free AI providers for titles, alt text, keywords and location guessing.
//  - "builtin": runs an image-captioning model inside the browser (Transformers.js). No key, no account, private.
//  - "gemini":  Google Gemini with the user's own free API key (aistudio.google.com).
//  - "openai":  any OpenAI-compatible endpoint (OpenRouter free models, Groq free tier, local Ollama, ...).
// Keys stay in this browser's localStorage and are sent only to the provider the user picked.

const LS_KEY = 'gts.ai.settings';
export const PRESETS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'google/gemma-3-27b-it:free', keyUrl: 'https://openrouter.ai/keys' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'qwen/qwen3.8-27b', keyUrl: 'https://console.groq.com/keys' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llava', keyUrl: 'https://ollama.com' },
};
export const GROQ_MODELS = ['qwen/qwen3.8-27b', 'meta-models/muse-spark-open'];
const DEFAULTS = {
  provider: 'builtin',
  groqKey: '',
  groqModel: GROQ_MODELS[0],
  geminiKey: '',
  geminiModel: 'gemini-2.5-flash',
  openaiBase: PRESETS.openrouter.baseUrl,
  openaiKey: '',
  openaiModel: PRESETS.openrouter.model,
  business: '',
  focus: '',
  language: 'English',
};

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
export function hasSavedSettings() {
  try { return !!localStorage.getItem(LS_KEY); } catch { return false; }
}

// Does this site have a server-side Groq key (GROQ_API_KEY on Vercel)?
let groqServerPromise = null;
export function groqServerStatus() {
  if (!groqServerPromise) {
    groqServerPromise = fetch('/api/groq', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : { configured: false }))
      .catch(() => ({ configured: false }));
  }
  return groqServerPromise;
}
export function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

// Downscale an image URL to a JPEG data URL (keeps requests small & fast)
export async function toDataUrl(src, max = 768) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

// ---------- built-in (in-browser) ----------
let captionerPromise = null;
async function getCaptioner(onProgress) {
  if (!captionerPromise) {
    captionerPromise = (async () => {
      const url = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
      const tf = await import(/* @vite-ignore */ url);
      tf.env.allowLocalModels = false;
      return tf.pipeline('image-to-text', 'Xenova/vit-gpt2-image-captioning', {
        progress_callback: (p) => {
          if (p.status === 'progress' && onProgress) onProgress(`Downloading AI model (one-time) ${Math.round(p.progress)}%`);
        },
      });
    })().catch((e) => { captionerPromise = null; throw e; });
  }
  return captionerPromise;
}

const STOP = new Set('a an the of and or with in on at to is are be its it this that there their his her for from by as into onto over under near some two three several group couple very while has have sitting standing'.split(' '));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const uniq = (arr) => {
  const seen = new Set();
  return arr.map((s) => s.trim()).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
};

function placeBits(place) {
  if (!place) return [];
  return uniq([place.sublocation, place.city, place.state, place.country].filter(Boolean));
}

async function builtinDescribe(src, ctx, onProgress) {
  const captioner = await getCaptioner(onProgress);
  onProgress?.('Analyzing image…');
  const data = await toDataUrl(src, 512);
  const out = await captioner(data, { max_new_tokens: 24, no_repeat_ngram_size: 3, repetition_penalty: 1.4 });
  let caption = (out?.[0]?.generated_text || 'photo').trim().replace(/\s+/g, ' ');
  // collapse any remaining repeated phrases ("a b a b a b" -> "a b") and trailing fragments
  caption = caption.replace(/\b(.{3,}?)(?:\s+\1\b)+/gi, '$1').replace(/\s+(and|with|of|a|the)$/i, '').replace(/\.$/, '');
  const where = placeBits(ctx.place);
  const city = ctx.place?.city || ctx.place?.state || '';
  const biz = ctx.business?.trim();
  const words = caption.toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  const nouns = uniq(words);
  const focus = (ctx.focus || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  const keywords = uniq([
    ...focus,
    ...(biz ? [biz] : []),
    ...(biz && city ? [`${biz} ${city}`] : []),
    ...focus.slice(0, 3).flatMap((f) => (city ? [`${f} ${city}`, `${f} near me`] : [])),
    ...nouns,
    ...where,
  ]).slice(0, 15);
  const title = cap(`${focus[0] ? focus[0] + ' – ' : ''}${caption}${city ? ' in ' + city : ''}${biz ? ' | ' + biz : ''}`).slice(0, 100);
  const description = cap(`${caption}${where.length ? ', photographed in ' + where.slice(-3).join(', ') : ''}.${biz ? ' ' + biz + '.' : ''}`);
  return { title, description, keywords };
}

// ---------- LLM helpers ----------
function parseJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('AI did not return JSON');
  return JSON.parse(t.slice(s, e + 1));
}

function describePrompt(ctx) {
  const where = placeBits(ctx.place).join(', ');
  return `You write SEO metadata for a photo that will be geotagged and uploaded to a website / Google Business Profile.
${ctx.business ? `Business: ${ctx.business}\n` : ''}${ctx.focus ? `Focus keywords/services: ${ctx.focus}\n` : ''}${where ? `Photo location: ${where}\n` : ''}Language: ${ctx.language || 'English'}
Look at the image and return ONLY a JSON object:
{"title": "<descriptive, keyword-rich title, max 70 chars>",
 "description": "<natural alt text describing what is visible, 1-2 sentences, max 200 chars, mention location if known>",
 "keywords": ["<8-15 relevant keywords: subjects, services, local SEO phrases with the city>"]}`;
}
const LOCATE_PROMPT = `Act as an expert geolocator (like a GeoGuessr pro). Study this photo: architecture, signs, language, vegetation, terrain, vehicles, road markings, landmarks.
Return ONLY a JSON object:
{"place": "<most likely specific place, city, country>", "latitude": <number>, "longitude": <number>, "confidence": "<low|medium|high>", "reasoning": "<one short sentence of the clues used>"}`;

async function gemini(settings, prompt, dataUrl) {
  if (!settings.geminiKey) throw new Error('Add your free Gemini API key in AI settings');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.geminiModel)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.geminiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: dataUrl.split(',')[1] } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `Gemini error ${res.status}`);
  return parseJson(j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '');
}

async function openaiCompat(settings, prompt, dataUrl) {
  const base = settings.openaiBase.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (settings.openaiKey) headers.Authorization = `Bearer ${settings.openaiKey}`;
  if (base.includes('openrouter.ai')) { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'GeoTag Studio'; }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.openaiModel,
      temperature: 0.4,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `AI error ${res.status}`);
  return parseJson(j?.choices?.[0]?.message?.content || '');
}

// Groq: with the user's own key -> straight from the browser; otherwise -> this site's /api/groq proxy.
async function groq(settings, prompt, dataUrl) {
  const model = settings.groqModel || GROQ_MODELS[0];
  if (settings.groqKey) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.groqKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_completion_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error?.message || `Groq error ${res.status}`);
    return parseJson(j?.choices?.[0]?.message?.content || '');
  }
  const res = await fetch('/api/groq', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image: dataUrl, model }),
  });
  const isJson = /json/.test(res.headers.get('content-type') || '');
  if (!isJson || res.status === 404) throw new Error('Groq server proxy is not available here. Add your own Groq key in AI settings.');
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error || `Groq error ${res.status}`);
  return parseJson(j.content);
}

const PROVIDERS = { gemini, groq, openai: openaiCompat };

function clean(r) {
  const kws = Array.isArray(r.keywords) ? r.keywords : String(r.keywords || '').split(/[,;]/);
  return {
    title: String(r.title || '').trim().slice(0, 120),
    description: String(r.description || '').trim().slice(0, 400),
    keywords: uniq(kws.map(String)).slice(0, 20),
  };
}

// ---------- public ----------
export async function describeImage(src, ctx, settings, onProgress) {
  if (settings.provider === 'builtin') return builtinDescribe(src, ctx, onProgress);
  onProgress?.('Asking AI…');
  const dataUrl = await toDataUrl(src, 768);
  const fn = PROVIDERS[settings.provider] || openaiCompat;
  return clean(await fn(settings, describePrompt(ctx), dataUrl));
}

export async function guessLocation(src, settings) {
  if (settings.provider === 'builtin') throw new Error('Location guessing needs Groq, Gemini or an OpenAI-compatible provider (all have free tiers). Open AI settings.');
  const dataUrl = await toDataUrl(src, 1024);
  const fn = PROVIDERS[settings.provider] || openaiCompat;
  const r = await fn(settings, LOCATE_PROMPT, dataUrl);
  const lat = Number(r.latitude), lon = Number(r.longitude);
  if (!isFinite(lat) || !isFinite(lon)) throw new Error('AI could not determine a location');
  return { lat, lon, place: r.place, confidence: r.confidence, reasoning: r.reasoning };
}
