# Backend notes - Cloudflare Worker API

The frontend calls the backend only. It does not fetch RSS, Open-Meteo, or Gemini directly.

`app.js` uses same-origin endpoints:

- `/api/news`
- `/api/weather`
- `/api/mood`
- `/api/health`

On browser-side failure, the kiosk falls back quietly so the screen does not look broken.

## Architecture

`wrangler.toml` configures one Cloudflare Worker (`src/worker.js`) that:

- Serves the static frontend from the repo root via the `[assets]` binding.
- Handles API routes in Worker code.
- Keeps `API_BASE = ""` in the frontend because the site and API share one origin.

Production Worker:
https://eire-daily-dashboard.gav-s-may.workers.dev

## Deploy

```bash
npm install
npm run dev
npm run deploy
npm run tail
npm run validate-feeds
```

`wrangler.toml` is the live config. A Cloudflare bot PR from June 24, 2026 added a separate `wrangler.jsonc`, but that config is not needed for the current Worker setup and should not be merged blindly.

## Static asset safety

`wrangler.toml` serves assets from `.`. That makes `.assetsignore` important.

`.assetsignore` blocks public upload of:

- `.git`, `.wrangler`, `node_modules`
- Worker source and config files
- `.env`, `.dev.vars`, key files, and secret-looking files
- Markdown docs and validation scripts
- scratch/evidence/screenshots/tmp folders
- stray Python files such as the previously exposed `ip.py` type of mistake

Only the real frontend files should be public: `index.html`, `app.js`, `styles.css`, and `assets/**`.

## `/api/health`

Returns a small JSON health response:

```json
{ "status": "ok", "time": "ISO date string" }
```

## `/api/news`

Built and verified against live feeds on June 24, 2026.

Sources:

- RTÉ News: `https://www.rte.ie/feeds/rss/?index=/news/&limit=100`
- RTÉ Business: `https://www.rte.ie/feeds/rss/?index=/news/business/&limit=100`
- RTÉ Technology: `https://www.rte.ie/feeds/rss/?index=/news/technology/&limit=100`
- TheJournal: `https://www.thejournal.ie/feed/`
- Dublin Live local: `https://www.dublinlive.ie/news/dublin-news/?service=rss`

Behaviour:

- Fetches feeds in parallel.
- One failed feed does not sink the others.
- All feeds failed returns `502` and is not cached.
- Merges, sorts newest-first, de-dupes by article URL.
- Caches successful responses for 10 minutes.

Response shape:

```json
{
  "items": [
    {
      "source": "RTÉ News",
      "title": "...",
      "summary": "...",
      "url": "...",
      "published": "ISO date string",
      "image": "URL or null"
    }
  ],
  "updatedAt": "ISO date string"
}
```

Image preference order:

1. `media:content`
2. `media:thumbnail`
3. `enclosure` image URL
4. first `<img src="...">` inside the feed body
5. `null`, where the frontend uses `assets/dublin.svg`

The Dublin Live thumbnail can be tiny, so `media:content` is preferred when present.

## `/api/weather`

Live and wired. Uses Open-Meteo, so no OpenWeather API key is required.

Location:

- Label: Dublin
- Latitude: `53.37645`
- Longitude: `-6.21469`
- Timezone: `Europe/Dublin`

Upstream:

`https://api.open-meteo.com/v1/forecast`

Requested fields:

- current temperature
- current precipitation
- current weather code
- current wind speed
- daily max/min temperature
- daily max precipitation probability

Behaviour:

- Caches successful responses for 10 minutes.
- Upstream failure returns `502` and is not cached.
- Maps WMO weather codes into simple kiosk labels such as `Clear`, `Partly cloudy`, `Rain`, and `Heavy rain`.

Response shape:

```json
{
  "location": "Dublin",
  "temperature": 14,
  "condition": "Cloudy",
  "rainChance": 40,
  "precipitation": 0.4,
  "windSpeed": 18,
  "updatedAt": "ISO date string",
  "today": { "max": 17, "min": 10, "rainChance": 50 },
  "tomorrow": { "max": 16, "min": 9, "rainChance": 35 }
}
```

## `/api/mood` - The State of It

Live and wired when `GEMINI_API_KEY` is set as a Cloudflare secret.

The browser never calls Gemini directly. The Worker sends compact story data to Gemini and returns a small mood object for the dashboard.

Behaviour:

- Missing key returns `{ "available": false, "reason": "no_key" }`.
- Gemini failure returns `{ "available": false, "reason": "gemini_error" }` with HTTP 200 so the dashboard can hide the gauge quietly.
- Successful mood responses are cached for about 3 hours.
- Failure responses are cached briefly to avoid hammering Gemini.
- `?refresh=1` forces a fresh compute.
- `?debug=1` includes story-level classifications.

Current model in `src/worker.js`:

```js
const MOOD_MODEL = "gemini-3.1-flash-lite";
```

Expected successful response shape:

```json
{
  "available": true,
  "source": "gemini",
  "model": "gemini-3.1-flash-lite",
  "updatedAt": "ISO date string",
  "label": "Bit heavy",
  "score": -17,
  "avgSentiment": -19,
  "medianSentiment": -15,
  "counts": {
    "positive": 21,
    "neutral": 29,
    "negative": 50
  },
  "topTopics": ["economy", "world", "sport"],
  "heavyCount": 3,
  "analyzed": 24
}
```

## CORS

The current app is same-origin, so CORS is mostly harmless belt-and-braces. If the frontend is ever served from a different origin, keep `Access-Control-Allow-Origin` enabled or set `API_BASE` deliberately.
