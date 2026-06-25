/* ============================================================
   Éire Daily — Cloudflare Worker backend
   ------------------------------------------------------------
   One Worker does two jobs:

   1. Serves the static dashboard (index.html, app.js, styles.css,
      assets/…) straight from the repo via the ASSETS binding
      (configured in wrangler.toml -> [assets]).
   2. Handles the API routes the frontend calls:
        GET /api/news    -> live, normalised Irish headlines
        GET /api/weather -> live Dublin weather from Open-Meteo
        GET /api/health  -> { status: "ok", time: ISO }

   Because the site and the API share ONE origin, the frontend can
   keep API_BASE = "" and just call "/api/news" — nothing to change
   on the frontend.

   Request flow (with [assets] configured):
     - A request for a real file (e.g. /app.js) is served by the
       asset server directly and never reaches this code.
     - A request that is NOT a file (e.g. /api/news) runs fetch()
       below. Anything we don't recognise we hand back to ASSETS
       (so the 404 page / index.html still works).

   ============================================================ */

/* ---------- Config ---------- */
// Validated, healthy feeds (see validate-feeds.js / BACKEND_NOTES.md).
// `limit` = how many of each feed's items to keep BEFORE merging.
const FEEDS = [
  { source: "RTÉ News",    url: "https://www.rte.ie/feeds/rss/?index=/news/&limit=100", limit: 10 },
  // Extra RTÉ sections to widen the pool. Same "RTÉ News" badge so they share the
  // src-rte styling on the frontend; merge+sort+dedupe-by-URL handles any overlap
  // with the main /news/ feed. Both verified 100% media:content image coverage.
  { source: "RTÉ News",    url: "https://www.rte.ie/feeds/rss/?index=/news/business/&limit=100",   limit: 5 },
  { source: "RTÉ News",    url: "https://www.rte.ie/feeds/rss/?index=/news/technology/&limit=100", limit: 5 },
  { source: "TheJournal",  url: "https://www.thejournal.ie/feed/",                       limit: 10 },
  // Dublin-local only. We deliberately do NOT also pull /news/ — it overlaps
  // heavily with this feed and would create duplicates.
  { source: "Dublin Live", url: "https://www.dublinlive.ie/news/dublin-news/?service=rss", limit: 5 }
];

const CACHE_SECONDS = 600;   // 10 minutes — how long a good API response is reused
const FEED_TIMEOUT_MS = 8000; // give up on a slow feed after 8s (others still return)
const WEATHER_TIMEOUT_MS = 8000; // give up on slow weather data after 8s
const SUMMARY_MAX = 220;     // trim summaries so cards stay tidy

// Dublin coordinates used by the kiosk weather card.
const WEATHER_URL =
  "https://api.open-meteo.com/v1/forecast" +
  "?latitude=53.37645" +
  "&longitude=-6.21469" +
  "&current=temperature_2m,precipitation,weather_code,wind_speed_10m" +
  "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
  "&timezone=Europe%2FDublin";

/* ---------- "The State of It" — AI news-mood (Gemini) ----------
   A lightweight classify-only feature. The Worker (never the browser) asks
   Gemini to label the top stories, then the Worker does the maths and returns
   a small mood object. The API key lives ONLY in env.GEMINI_API_KEY (a
   Cloudflare secret in prod / .dev.vars locally) — never in code or the frontend.
   If the key is missing or Gemini fails, /api/mood returns { available:false }
   and the dashboard simply hides the gauge. */
const MOOD_MODEL = "gemini-3.1-flash-lite";  // change here if you switch models
const MOOD_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" + MOOD_MODEL + ":generateContent";
const MOOD_CACHE_SECONDS = 3 * 60 * 60;   // reuse a computed mood for ~3 hours
const MOOD_FAIL_CACHE_SECONDS = 30 * 60;  // after a failure, wait ~30 min before retrying Gemini
const MOOD_STORY_COUNT = 24;              // analyse up to the top 24 stories
const MOOD_SUMMARY_MAX = 160;             // trim each summary we send to Gemini (less data)
const MOOD_TIMEOUT_MS = 20000;            // give Gemini up to 20s, then fall back quietly

// Allowed values mirrored in the prompt. Topic list matches the frontend legend.
const MOOD_TOPICS = ["politics","crime","economy","housing","transport","weather","world","local","sport","culture","other"];

// Strict JSON contract for Gemini (OpenAPI subset). responseMimeType + this
// schema force the model to return exactly this shape — no prose, no markdown.
const MOOD_SCHEMA = {
  type: "object",
  properties: {
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i:              { type: "integer" },
          sentiment:      { type: "string", enum: ["positive", "neutral", "negative"] },
          sentimentScore: { type: "integer" },
          severity:       { type: "string", enum: ["light", "normal", "serious", "heavy"] },
          severityScore:  { type: "integer" },
          topic:          { type: "string", enum: MOOD_TOPICS },
          confidence:     { type: "number" }
        },
        required: ["i", "sentiment", "sentimentScore", "severity", "severityScore", "topic", "confidence"],
        propertyOrdering: ["i", "sentiment", "sentimentScore", "severity", "severityScore", "topic", "confidence"]
      }
    }
  },
  required: ["stories"]
};

/* ---------- Entry point ---------- */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS pre-flight (harmless even though we're same-origin today).
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/api/health") {
      return json({ status: "ok", time: new Date().toISOString() });
    }

    if (url.pathname === "/api/news") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      return handleNews(request, ctx);
    }

    if (url.pathname === "/api/weather") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      return handleWeather(request, ctx);
    }

    if (url.pathname === "/api/mood") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      return handleMood(request, env, ctx);
    }

    // Not an API route -> let the static asset server handle it.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
};

/* ============================================================
   /api/news
   ============================================================ */
async function handleNews(request, ctx) {
  // --- 1. Edge cache: reuse a recent response if we have one ---------------
  // We key the cache on a clean URL (no query string) so every visitor shares
  // the same cached payload for CACHE_SECONDS.
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/news", request.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // --- 2. Build the merged, sorted, de-duped item list --------------------
  const { items, okCount } = await buildNewsItems();

  // --- 3. All feeds down -> 502 (do NOT cache this) ------------------------
  if (okCount === 0) {
    return json(
      { error: "All news feeds failed", items: [], updatedAt: new Date().toISOString() },
      502
    );
  }

  // --- 4. Build response + store in the edge cache for 10 minutes ----------
  const payload = { items, updatedAt: new Date().toISOString() };
  const response = json(payload, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`
  });
  // cache.put must not block the response, so do it in the background.
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* Fetch all feeds in parallel, merge, sort newest-first, de-dupe by URL.
   One failing feed must not sink the rest. Shared by /api/news and /api/mood. */
async function buildNewsItems() {
  const settled = await Promise.allSettled(FEEDS.map(fetchFeed));

  let items = [];
  let okCount = 0;
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") {
      okCount++;
      items = items.concat(res.value);
    } else {
      // Visible via `wrangler tail`. We swallow the error and carry on.
      console.warn("Feed failed:", FEEDS[i].source, String(res.reason));
    }
  });

  if (okCount === 0) return { items: [], okCount: 0 };

  items.sort((a, b) => dateValue(b.published) - dateValue(a.published));
  items = dedupeByUrl(items);
  return { items, okCount };
}

/* Get the current news items for analysis. Prefers the already-cached
   /api/news payload (the frontend loads it too, so it's usually warm) and only
   rebuilds from the live feeds on a cache miss — so the mood feature does not
   add an extra round of feed fetches in the common case. */
async function getNewsItems(request) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/news", request.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    try {
      const data = await hit.json();
      if (data && Array.isArray(data.items) && data.items.length) return data.items;
    } catch (e) {
      /* fall through to a fresh build */
    }
  }
  const built = await buildNewsItems();
  return built.items;
}

/* ============================================================
   /api/weather
   ============================================================ */
async function handleWeather(request, ctx) {
  // Weather changes slowly enough for a dashboard, so we reuse a good response
  // for the same 10-minute window as news. Failed upstream responses are not
  // cached, because a temporary outage should not become the saved forecast.
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/weather", request.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const payload = await fetchWeather();
    const response = json(payload, 200, {
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    console.warn("Weather failed:", String(err));
    return json(
      { error: "Weather data unavailable", updatedAt: new Date().toISOString() },
      502
    );
  }
}

async function fetchWeather() {
  const res = await fetch(WEATHER_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS),
    headers: {
      "Accept": "application/json"
    }
  });

  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);

  const data = await res.json();
  return mapOpenMeteoWeather(data);
}

function mapOpenMeteoWeather(data) {
  const current = data && data.current;
  const daily = data && data.daily;

  if (!current || !daily) {
    throw new Error("Open-Meteo response missing current or daily data");
  }

  const temperature = current.temperature_2m;
  const precipitation = current.precipitation;
  const weatherCode = current.weather_code;
  const windSpeed = current.wind_speed_10m;

  const todayMax = numberAt(daily.temperature_2m_max, 0);
  const todayMin = numberAt(daily.temperature_2m_min, 0);
  const todayRain = numberAt(daily.precipitation_probability_max, 0);
  const tomorrowMax = numberAt(daily.temperature_2m_max, 1);
  const tomorrowMin = numberAt(daily.temperature_2m_min, 1);
  const tomorrowRain = numberAt(daily.precipitation_probability_max, 1);

  // The frontend expects one small, friendly object. Open-Meteo gives us
  // separate `current` and `daily` sections, so this is where we translate:
  //   - current temperature/wind/precipitation -> top weather card
  //   - today's daily rain probability -> current rain chance
  //   - daily arrays at index 0 and 1 -> today/tomorrow mini forecast
  if (
    !isNumber(temperature) ||
    !isNumber(precipitation) ||
    !isNumber(weatherCode) ||
    !isNumber(windSpeed) ||
    !isNumber(todayMax) ||
    !isNumber(todayMin) ||
    !isNumber(todayRain) ||
    !isNumber(tomorrowMax) ||
    !isNumber(tomorrowMin) ||
    !isNumber(tomorrowRain)
  ) {
    throw new Error("Open-Meteo response had missing or invalid weather numbers");
  }

  return {
    location: "Dublin",
    temperature: Math.round(temperature),
    condition: weatherCodeToCondition(weatherCode),
    rainChance: Math.round(todayRain),
    precipitation: round1(precipitation),
    windSpeed: Math.round(windSpeed),
    updatedAt: new Date().toISOString(),
    today: {
      max: Math.round(todayMax),
      min: Math.round(todayMin),
      rainChance: Math.round(todayRain)
    },
    tomorrow: {
      max: Math.round(tomorrowMax),
      min: Math.round(tomorrowMin),
      rainChance: Math.round(tomorrowRain)
    }
  };
}

function weatherCodeToCondition(code) {
  // Open-Meteo weather_code is a numeric WMO code. The kiosk does not need
  // every meteorological nuance, so we collapse it into plain English labels.
  if (code === 0) return "Clear";
  if (code === 1 || code === 2) return "Partly cloudy";
  if (code === 3) return "Cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code === 51 || code === 53 || code === 55 || code === 56 || code === 57) return "Drizzle";
  if (code === 61 || code === 63 || code === 66 || code === 80 || code === 81) return "Rain";
  if (code === 65 || code === 67 || code === 82) return "Heavy rain";
  if (code === 71 || code === 73 || code === 75 || code === 77 || code === 85 || code === 86) return "Snow";
  if (code === 95 || code === 96 || code === 99) return "Thunderstorm";
  return "Cloudy";
}

function numberAt(values, index) {
  return Array.isArray(values) ? values[index] : undefined;
}

function isNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/* ============================================================
   /api/mood  —  "The State of It" AI news mood
   ------------------------------------------------------------
   Debug flags (query string):
     ?refresh=1  -> skip the cache and recompute now (test without waiting 3h)
     ?debug=1    -> also include the raw per-story classifications
   ============================================================ */
async function handleMood(request, env, ctx) {
  const url = new URL(request.url);
  const force = url.searchParams.get("refresh") === "1";
  const debug = url.searchParams.get("debug") === "1";

  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/mood", request.url).toString(), { method: "GET" });

  // 1) Serve a fresh cached mood unless a manual refresh was requested. This is
  //    what keeps Gemini from being called on every page poll — once computed,
  //    the same mood is reused for MOOD_CACHE_SECONDS (~3h).
  if (!force) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  // 2) No key configured -> the dashboard works normally, the gauge just hides.
  //    Not cached, so it starts working immediately once a key is added.
  const apiKey = env && env.GEMINI_API_KEY;
  if (!apiKey) {
    return json({ available: false, reason: "no_key", updatedAt: new Date().toISOString() });
  }

  try {
    const items = await getNewsItems(request);
    const top = (items || []).slice(0, MOOD_STORY_COUNT);
    if (top.length < 3) {
      return json({ available: false, reason: "not_enough_news", updatedAt: new Date().toISOString() });
    }

    const classifications = await classifyWithGemini(top, apiKey);
    const mood = aggregateMood(classifications);
    if (!mood) throw new Error("No usable classifications returned");

    const payload = Object.assign(
      { available: true, source: "gemini", model: MOOD_MODEL, updatedAt: new Date().toISOString() },
      mood
    );
    if (debug) payload.stories = classifications;

    const response = json(payload, 200, { "Cache-Control": `public, max-age=${MOOD_CACHE_SECONDS}` });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    // Quiet fallback — never break the dashboard. Cache the failure briefly so a
    // bad key / outage doesn't hammer Gemini on every poll (use ?refresh=1 to retry now).
    console.warn("Mood failed:", String(err));
    const response = json(
      {
        available: false,
        reason: "gemini_error",
        detail: String((err && err.message) || err).slice(0, 200),
        updatedAt: new Date().toISOString()
      },
      200,
      { "Cache-Control": `public, max-age=${MOOD_FAIL_CACHE_SECONDS}` }
    );
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
}

/* Ask Gemini to classify the stories. Returns an array of per-story objects.
   Sends only index/source/title/short-summary/day — no images, no full bodies. */
async function classifyWithGemini(stories, apiKey) {
  const compact = stories.map((s, i) => ({
    i,
    source: s.source || "",
    title: s.title || "",
    summary: s.summary ? String(s.summary).slice(0, MOOD_SUMMARY_MAX) : "",
    date: s.published ? String(s.published).slice(0, 10) : ""
  }));

  const prompt =
    "You are a newsroom classifier for an Irish news dashboard. " +
    "Judge each story by the substance of its headline and summary, not by sensational wording. " +
    "Return ONLY JSON matching the schema — no commentary, no markdown.\n" +
    "For each story keep its \"i\" index and set:\n" +
    "- sentiment: positive | neutral | negative (overall tone for a general reader)\n" +
    "- sentimentScore: integer from -100 (very negative) to 100 (very positive)\n" +
    "- severity: light | normal | serious | heavy (how grave the subject is)\n" +
    "- severityScore: integer from 0 (trivial) to 100 (death, disaster, war, tragedy)\n" +
    "- topic: one of " + MOOD_TOPICS.join(", ") + "\n" +
    "- confidence: number from 0 to 1\n\n" +
    "Stories:\n" + JSON.stringify(compact);

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: MOOD_SCHEMA
      // Temperature deliberately omitted: Gemini 3 can loop if it's lowered, and
      // the schema already forces deterministic structure. No thinking field is
      // sent either (avoids 3.x 400s); flash-lite is fast enough for ~24 items.
    }
  };

  const res = await fetch(MOOD_API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(MOOD_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      // Key travels in a header, not the URL, so it never lands in any log line.
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error("Gemini HTTP " + res.status + (errText ? ": " + errText.slice(0, 200) : ""));
  }

  const data = await res.json();
  const text = extractGeminiText(data);
  if (!text) throw new Error("Gemini returned no text");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("Gemini JSON parse failed");
  }
  const arr = parsed && Array.isArray(parsed.stories)
    ? parsed.stories
    : (Array.isArray(parsed) ? parsed : null);
  if (!arr) throw new Error("Gemini JSON missing 'stories' array");
  return arr;
}

/* Pull the JSON text out of a generateContent response, skipping any Gemini-3
   "thought" parts and surfacing a safety block as an error. */
function extractGeminiText(data) {
  const cand = data && data.candidates && data.candidates[0];
  if (!cand) {
    const fb = data && data.promptFeedback;
    if (fb && fb.blockReason) throw new Error("Gemini blocked: " + fb.blockReason);
    return "";
  }
  const parts = cand.content && cand.content.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
}

/* Turn per-story classifications into the small mood object the frontend shows.
   All maths happens here in the Worker (Gemini only classifies). */
function aggregateMood(classifications) {
  const valid = (classifications || []).filter(
    (c) => c && typeof c.sentimentScore === "number" && typeof c.sentiment === "string"
  );
  const n = valid.length;
  if (!n) return null;

  const sScores = valid.map((c) => clampNum(c.sentimentScore, -100, 100));
  const avg = sScores.reduce((a, b) => a + b, 0) / n;
  const med = median(sScores);

  let pos = 0, neu = 0, neg = 0;
  valid.forEach((c) => {
    if (c.sentiment === "positive") pos++;
    else if (c.sentiment === "negative") neg++;
    else neu++;
  });

  const topicCounts = {};
  valid.forEach((c) => {
    const t = c.topic || "other";
    topicCounts[t] = (topicCounts[t] || 0) + 1;
  });
  const topTopics = Object.keys(topicCounts)
    .sort((a, b) => topicCounts[b] - topicCounts[a])
    .slice(0, 3);

  const heavyCount = valid.filter((c) => c.severity === "heavy").length;

  // Mood score = blend of average + median sentiment (median dampens a single
  // wild outlier), clamped to -100..100. Severity/heavy count is reported as
  // context but kept out of the headline score to keep it simple and legible.
  let score = Math.round(0.6 * avg + 0.4 * med);
  score = clampNum(score, -100, 100);

  return {
    label: moodLabel(score),
    score,
    avgSentiment: Math.round(avg),
    medianSentiment: Math.round(med),
    counts: pctSumTo100(pos, neu, neg, n),
    topTopics,
    heavyCount,
    analyzed: n
  };
}

/* Score -> label, using the ranges from the spec. */
function moodLabel(s) {
  if (s >= 40) return "Bright enough";
  if (s >= 10) return "Grand-ish";
  if (s >= -9) return "Mixed bag";
  if (s >= -39) return "Bit heavy";
  if (s >= -69) return "Grim enough";
  return "Full doom scroll";
}

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/* Round positive/neutral/negative to whole percentages that always total 100
   (the rounding remainder is given to the largest bucket). */
function pctSumTo100(pos, neu, neg, n) {
  const rounded = {
    positive: Math.round((pos / n) * 100),
    neutral: Math.round((neu / n) * 100),
    negative: Math.round((neg / n) * 100)
  };
  const diff = 100 - (rounded.positive + rounded.neutral + rounded.negative);
  if (diff !== 0) {
    const largest = Object.keys(rounded).sort((a, b) => rounded[b] - rounded[a])[0];
    rounded[largest] += diff;
  }
  return rounded;
}

/* Fetch one feed, parse it, and keep only its first `limit` items. */
async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; EireDailyBot/1.0; +https://eire-daily)",
      "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml, feed.source).slice(0, feed.limit);
}

/* ============================================================
   RSS parsing — small, dependency-free, regex based.
   Good enough for these three well-formed feeds. If a feed ever
   changes shape, validate-feeds.js will catch it.
   ============================================================ */
function parseFeed(xml, source) {
  const out = [];
  // RSS uses <item>…</item>; Atom uses <entry>…</entry>. These feeds are RSS,
  // but we support both just in case.
  const blocks = matchAll(xml, /<item\b[\s\S]*?<\/item>/gi);
  const entries = blocks.length ? blocks : matchAll(xml, /<entry\b[\s\S]*?<\/entry>/gi);

  for (const block of entries) {
    const title = clean(rawTag(block, "title"));
    if (!title) continue; // skip junk rows with no title

    out.push({
      source: source,
      title: title,
      summary: truncate(clean(rawTag(block, "description") || rawTag(block, "content:encoded") || rawTag(block, "summary")), SUMMARY_MAX),
      url: getLink(block),
      published: toIso(firstOf(block, ["pubDate", "dc:date", "published", "updated"])),
      image: getImage(block)
    });
  }
  return out;
}

/* Image preference order (as requested):
   media:content  ->  media:thumbnail  ->  enclosure(image)  ->  <img> in body.
   Note: Dublin Live's media:thumbnail is a tiny 98px crop, but media:content
   (≈615px) appears first on every item, so the big image wins in practice. */
function getImage(block) {
  let m =
    block.match(/<media:content\b[^>]*\burl\s*=\s*["']([^"']+)["']/i) ||
    block.match(/<media:thumbnail\b[^>]*\burl\s*=\s*["']([^"']+)["']/i) ||
    block.match(/<enclosure\b[^>]*\burl\s*=\s*["']([^"']+)["'][^>]*\btype\s*=\s*["']image/i) ||
    block.match(/<enclosure\b[^>]*\btype\s*=\s*["']image[^>]*\burl\s*=\s*["']([^"']+)["']/i);
  if (m) return upgradeHttps(m[1]);

  // Fallback: first <img src> inside the article body HTML.
  const body = stripCdata(rawTag(block, "content:encoded") || rawTag(block, "description"));
  const img = body.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return img ? upgradeHttps(img[1]) : null; // null -> frontend shows Dublin stock image
}

/* RSS link is <link>URL</link>; Atom is <link href="URL"/>; guid can be a URL. */
function getLink(block) {
  const rss = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss && rss[1] && rss[1].trim()) return clean(rss[1]);
  const atom = block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
  if (atom) return atom[1];
  const guid = block.match(/<guid(?:\s[^>]*)?>([\s\S]*?)<\/guid>/i);
  if (guid && /^https?:\/\//i.test(guid[1].trim())) return clean(guid[1]);
  return "";
}

/* ---------- small text helpers ---------- */
function matchAll(str, re) {
  const out = []; let m;
  while ((m = re.exec(str)) !== null) out.push(m[0]);
  return out;
}
function rawTag(block, name) {
  const re = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i");
  const m = block.match(re);
  return m ? m[1] : "";
}
function firstOf(block, names) {
  for (const n of names) { const v = rawTag(block, n); if (v) return v; }
  return "";
}
function stripCdata(s) { return (s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); }
function stripTags(s)  { return (s || "").replace(/<[^>]+>/g, " "); }
function decodeEntities(s) {
  return (s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}
// Full clean: drop CDATA + tags, decode entities, collapse whitespace.
function clean(s) {
  return decodeEntities(stripTags(stripCdata(s))).replace(/\s+/g, " ").trim();
}
function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "").trim() + "…" : s;
}
function upgradeHttps(u) { return (u || "").replace(/^http:\/\//i, "https://"); }
function toIso(raw) {
  if (!raw) return null;
  const d = new Date(clean(raw));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function dateValue(iso) { const t = iso ? Date.parse(iso) : NaN; return isNaN(t) ? 0 : t; }

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.url || "").replace(/\/+$/, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/* ---------- response helpers ---------- */
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      corsHeaders(),
      extra
    )
  });
}
