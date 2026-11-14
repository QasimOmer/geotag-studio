# GeoTag Studio

Free, private, browser-only photo geotagger with AI.

## Features
- **Batch upload** JPG, PNG, WebP and HEIC (HEIC is converted to JPG), drag & drop, paste from clipboard
- **Map** (OpenStreetMap + Esri satellite): click or drag the pin, search places/addresses, paste `lat,lng`, DMS or Google Maps links, use your current location, recent-locations history
- **See existing geotags** of uploaded photos on the map
- **Writes EXIF + XMP**: GPS (lat/lng/altitude), title, description/alt text, keywords, author, copyright, date taken, city/state/country
  - JPG: EXIF APP1 + XMP · PNG: `eXIf` + XMP `iTXt` · WebP: `EXIF` + `XMP ` chunks
  - Windows XP tags so keywords/title show in Explorer → Properties → Details
- **Spread** multiple photos randomly around the pin (±15/50/150 m)
- **SEO filenames** from titles, **ZIP download** for batches
- **Inspect** before/after metadata per photo
- **Strip metadata** (privacy) while keeping orientation
- **Free AI**
  - Built-in: in-browser image captioning (Transformers.js), no key, nothing leaves your device
  - Google Gemini (free API key): SEO titles, alt text, keywords + **AI location guessing**
  - Any OpenAI-compatible API: OpenRouter free models, Groq free tier, local Ollama
- Light/dark theme, mobile friendly

## Develop
```bash
npm install
npm run dev
```

## Build
```bash
npm run build   # outputs to dist/
```

Deploys to Vercel as a static Vite site with zero configuration.
