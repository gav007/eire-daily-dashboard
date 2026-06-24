# Backend notes — Cloudflare Worker API (next step)

The frontend calls the backend **only** (never RSS/OpenWeather directly):
`app.js` → `API_BASE + /api/news` and `API_BASE + /api/weather`.
On any failure the frontend falls back to mock data, so the kiosk never breaks.

## Weather — OpenWeather

- **Location (fixed):** lat `53.37644855902749`, lon `-6.214687313622119`, elev ~30 m (north Dublin).
  City label shown on the dashboard is the static string "Dublin".
- **API key:** stored in `openweather.txt` locally (`OPENWEATHER_KEY=...`) — **gitignored, never committed**.
  In the Worker, set it as a secret: `wrangler secret put OPENWEATHER_KEY`. Do NOT hardcode it.
- Suggested source: OpenWeather *One Call 3.0* (`/data/3.0/onecall?lat=..&lon=..&units=metric&appid=KEY`)
  — gives current + daily in one call. Map to the response shape below.

### `/api/weather` response shape (what the frontend expects)
```json
{
  "location": "Dublin",
  "temperature": 14,
  "condition": "Cloudy",
  "rainChance": 40,
  "precipitation": 0.4,
  "windSpeed": 18,
  "updatedAt": "ISO date string",
  "today":    { "max": 17, "min": 10, "rainChance": 50 },
  "tomorrow": { "max": 16, "min": 9,  "rainChance": 35 }
}
```
- `rainChance` = OpenWeather `pop` * 100 (rounded). `precipitation` in mm. `windSpeed` km/h (OpenWeather m/s × 3.6).

## News — RSS normalisation

Sources (Worker fetches + cleans these; frontend never touches RSS):
- RTÉ News — `https://www.rte.ie/feeds/rss/?index=/news/`
- TheJournal — `https://www.thejournal.ie/feed/`
- Dublin Live — `https://www.dublinlive.ie/?service=rss`

### Image key extraction (RSS varies a lot — try in this order, first hit wins)
1. `<media:content url="...">` (Media RSS) — RTÉ uses this.
2. `<media:thumbnail url="...">`.
3. `<enclosure url="..." type="image/*">` — common on WordPress feeds (TheJournal/Reach).
4. `<image><url>...</url></image>` (channel-level fallback only).
5. First `<img src="...">` parsed out of `<content:encoded>` / `<description>` HTML.
6. As a last resort fetch the article and read `<meta property="og:image">`.
7. If still nothing → set `image: null`. The frontend then shows the bundled
   **Dublin stock image** (`assets/dublin.svg`), and only the source glyph if even that fails.

Strip tracking/size query params and upgrade `http:` → `https:` so images load on the tablet.

### `/api/news` response shape
```json
{
  "items": [
    { "source": "RTÉ News", "title": "…", "summary": "…",
      "url": "…", "published": "ISO date string", "image": "URL or null" }
  ],
  "updatedAt": "ISO date string"
}
```

## CORS
If the Worker serves the API on a different origin than the page, add
`Access-Control-Allow-Origin` (or serve page + API from the same Worker/Pages project,
in which case keep `API_BASE = ""`).
