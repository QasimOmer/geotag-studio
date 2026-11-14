// Vercel serverless function: proxies vision requests to Groq using the site owner's key.
// Set GROQ_API_KEY in Vercel → Project → Settings → Environment Variables.
// GET  /api/groq  -> { configured: boolean, model }
// POST /api/groq  { prompt, image: "data:image/jpeg;base64,...", model? } -> { content }

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';
const ALLOWED_MODELS = new Set([DEFAULT_MODEL, 'qwen/qwen3.8-27b', 'meta-models/muse-spark-open']);
const MAX_IMAGE_CHARS = 3_000_000; // ~2.2 MB base64; the app sends ~100 KB
const MAX_PROMPT_CHARS = 4000;

// Best-effort per-IP rate limit (per warm instance) to protect the free quota.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.GROQ_RATE_LIMIT || 15);
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.GROQ_API_KEY;

  if (req.method === 'GET') {
    return res.status(200).json({ configured: Boolean(key), model: DEFAULT_MODEL });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!key) return res.status(503).json({ error: 'Groq is not configured on this site. Add your own Groq key in AI settings.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ error: 'Too many AI requests — please wait a minute.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const { prompt, image, model } = body || {};
  if (typeof prompt !== 'string' || !prompt || prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: 'Invalid prompt' });
  }
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > MAX_IMAGE_CHARS) {
    return res.status(400).json({ error: 'Invalid image' });
  }
  const useModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;

  try {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: useModel,
        temperature: 0.4,
        max_completion_tokens: 800,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] }],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status === 429 ? 429 : 502).json({ error: j?.error?.message || `Groq error ${r.status}` });
    return res.status(200).json({ content: j?.choices?.[0]?.message?.content || '' });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach Groq: ${e.message}` });
  }
}
