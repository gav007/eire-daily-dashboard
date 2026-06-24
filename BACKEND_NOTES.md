# Backend notes — Cloudflare Worker API

The frontend calls the backend **only** (never RSS/OpenWeather directly):
`app.js` → `API_BASE + /api/news` and `API_BASE + /api/weather`.
On any failure the frontend falls back to mock data, so the kiosk never breaks.

## Architecture — one Worker serves site + API

`wrangler.toml` configures a single Worker (`src/worker.js`) that:
- Serves the static frontend from the repo root via the `[assets]` binding
  (index.html, app.js, styles.css, assets/**).
- Handles `GET /api/news` and `GET /api/health` in code.

Because the site and API share **one origin**, the frontend keeps `API_BASE = ""`
and calls `/api/news` — nothing to change on the frontend. Point the tablet at the
Worker's URL (`https://eire-daily-dashboard.<account>.workers.dev`, or a custom domain).

### `/api/news` — DONE ✅ (built + verified against live feeds 2026-06-24)
- Fetches RTÉ (10), TheJournal (10), Dublin Live *Dublin-local* (5) in parallel.
- Image order: `media:content` → `media:thumbnail` → `enclosure` → `<img>` in body.
- Merges → sorts newest-first → de-dupes by article URL → caches **10 min** (Cache API).
- One feed down ⇒ others still return. **All** feeds down ⇒ `502` JSON (not cached).
- Verified: 25 items, sorted, 0 missing fields, 0 null images, JSON matches the shape below.
- `/api/health` ⇒ `{ "status": "ok", "time": "ISO" }`.

### Deploy (wrangler)
```
npm install            # gets wrangler (devDependency)
npx wrangler login     # once, to authorise your Cloudflare account
npx wrangler deploy    # publishes the Worker + static assets
npx wrangler tail      # live logs (see feed failures, etc.)
```
- **Asset-upload fix:** `.assetsignore` (next to `wrangler.toml`) stops `.git`, `.wrangler`,
  `node_modules`, `src`, `openweather.txt`, `.env`, `.dev.vars`, configs and docs from being
  uploaded as public files. Only the real frontend files are published.
- Weather endpoint is **not** wired yet — frontend uses MOCK_WEATHER until `/api/weather` exists.

## Weather — OpenWeather (NOT wired yet)

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
- RTÉ News — `https://www.rte.ie/feeds/rss/?index=/news/&limit=100`
- TheJournal — `https://www.thejournal.ie/feed/`
- Dublin Live (Dublin-local) — `https://www.dublinlive.ie/news/dublin-news/?service=rss`
- Dublin Live (general) — `https://www.dublinlive.ie/news/?service=rss` *(optional, see note)*

### ✅ Validation results — run `node validate-feeds.js` (last run 2026-06-24)

| Feed | URL | HTTP | Format | Items | Images | Verdict |
|------|-----|------|--------|-------|--------|---------|
| RTÉ News | `.../feeds/rss/?index=/news/&limit=100` | 200 `application/rss+xml` | RSS | **60** | 60/60 | ✅ OK |
| TheJournal | `.../feed/` | 200 `application/rss+xml` | RSS | **40** | 40/40 | ✅ OK |
| Dublin Live — News | `.../news/?service=rss` | 200 `application/rss+xml` | RSS | **25** | 25/25 | ✅ OK |
| Dublin Live — Dublin news | `.../news/dublin-news/?service=rss` | 200 `application/rss+xml` | RSS | **25** | 25/25 | ✅ OK |

All four: HTTP 200, no redirects, valid RSS, real current headlines, `<pubDate>` (RFC-822)
parses cleanly, and **100% of items carry an image key** — so the Dublin stock fallback
should rarely be needed for live data.

**Notes / decisions for the Worker:**
- **RTÉ `limit=100` actually returns 60** items (the feed caps there). Fine — 60 is plenty.
- **The two Dublin Live feeds overlap heavily** — the general `/news/` feed already contains the
  `/news/dublin-news/` items (first ~5 were identical on the test run). **Pick ONE** (recommend the
  Dublin-local `dublin-news` feed for this dashboard) **or merge + de-dupe by article URL.** Do not
  ingest both blindly or you'll get duplicate cards.
- TheJournal item URLs end in `-<id>-MonYYYY/`; Dublin Live end in `-<numericId>`; both are stable
  for de-duping across sources.
- Dates: RTÉ/TheJournal use `+0100` (IST), Dublin Live uses `+0000` (UTC) — all parse via `new Date()`.

### Image key extraction — VERIFIED per feed (2026-06-24)
What each feed's first `<item>` actually carries:
- **RTÉ** → `<media:content … width="800">` only. Clean 800px JPEGs (`rte.ie/images/*.jpg`).
- **TheJournal** → `<media:content>` **and** `<media:thumbnail>`. Use `media:content` (≈630px).
- **Dublin Live** → `<media:content>`, `<media:thumbnail>`, **and** `<enclosure>`.
  ⚠️ `media:thumbnail` is a tiny **98px** crop (`/ALTERNATES/s98/`); `media:content`/`enclosure`
  give the usable ~615px (`/ALTERNATES/s615/`). **Prefer `media:content`, not the thumbnail.**

Extraction order (first hit wins — prefers the largest image):
1. `<media:content url="...">`  ← all three feeds; best quality. **Primary.**
2. `<enclosure url="..." type="image/*">`  ← Dublin Live full-size fallback.
3. `<media:thumbnail url="...">`  ← last resort (may be tiny — see above).
4. First `<img src="...">` in `<content:encoded>` / `<description>` HTML.
5. `<image><url>...</url></image>` (channel-level) — generic, avoid if possible.
6. If still nothing → `image: null`; the frontend shows the bundled **Dublin stock image**
   (`assets/dublin.svg`), then the source glyph if even that fails.

In practice **100% of live items across all four feeds already have `media:content`**, so the
stock fallback is essentially never hit with real data. Upgrade any `http:` → `https:` so images
load on the tablet's WebView.

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
