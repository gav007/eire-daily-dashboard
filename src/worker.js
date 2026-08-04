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

/* ---------- Rolling baseline for the mood score ----------
   The raw score is almost always negative, because news is. Measured against
   the fixed bands in moodLabel() that made the gauge a constant: a typical day
   scores about -20, which lands in "Bit heavy" every single time, and four of
   the six labels are unreachable in practice.

   So we log every score we compute and report today RELATIVE to its own recent
   history — "heavier than usual" beats "negative", because the first one moves
   and the second one never does.

   The log lives in a KV namespace bound as MOOD_LOG. If that binding is absent
   the whole feature degrades quietly: no log, no baseline, and /api/mood keeps
   returning exactly what it returns today. Same graceful-fallback contract as
   a missing GEMINI_API_KEY. */
const MOOD_HISTORY_KEY = "mood:history";  // single KV key holding the whole log
const MOOD_BASELINE_DAYS = 14;            // trailing window the baseline is computed over
const MOOD_HISTORY_MAX = 400;             // hard cap on stored readings (~7 weeks at 8/day)
// Below this many readings the baseline is not trustworthy, so we report
// ready:false and the frontend falls back to the raw label. At a 3h cache
// that's roughly two days of warm-up.
const MOOD_BASELINE_MIN_SAMPLES = 16;
// Scale factor that puts MAD on the same footing as a standard deviation for
// normally-distributed data, so the z-like number reads at a familiar size.
const MAD_TO_SIGMA = 1.4826;

/* ---------- Spoken headline (Gemini text-to-speech) ----------
   /api/headline-audio returns a WAV of the current top story read aloud, so
   the kiosk can say the actual news rather than only how it feels.

   Gemini hands back RAW PCM with no container — a browser won't play that, so
   we bolt a 44-byte WAV header on before serving it.

   Generation is the expensive part, so each line is generated ONCE and cached
   in KV keyed by a hash of the text. The headline only changes every so often,
   so in practice this is a handful of calls a day no matter how often the
   kiosk plays it. Cached entries self-delete after TTS_CACHE_TTL. */
const TTS_MODEL = "gemini-3.1-flash-tts-preview";
const TTS_VOICE = "Charon"; // 30 available; Charon is a clear, informative read

/* How the headline is performed. Google only ever receives the headline text
   itself, so the character has to live entirely in the delivery — it is never
   allowed to invent or reword anything. */
const TTS_STYLE =
  "Read the headline exactly as written. Speak as Deco, a working-class North " +
  "Dublin man in his forties. Use a low, slightly gravelly voice with an " +
  "unmistakable natural Dublin accent—not British, Scottish, posh, or generic " +
  "'Irish'. Deliver it conversationally, like a dry observation made across a " +
  "kitchen table. Sound mildly sceptical and quietly amused, as though none of " +
  "this nonsense surprises you anymore. Keep the humour understated: no acting, " +
  "fake laughter, shouting or exaggerated accent. Use a relaxed medium pace, " +
  "short natural pauses and a slight downward inflection at the end. Do not " +
  "add, remove or rewrite any words.";
const TTS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" + TTS_MODEL + ":generateContent";
const TTS_CACHE_PREFIX = "tts:";     // shares the MOOD_LOG namespace, separate key space
const TTS_CACHE_TTL = 6 * 60 * 60;   // drop cached audio after ~6h
const TTS_TIMEOUT_MS = 30000;        // voice generation is slower than text
const TTS_TITLE_MAX = 240;           // keep the spoken line short

/* Reading "whatever is newest" sounds fair but isn't: TheJournal publishes far
   more often than RTÉ, so it took the top slot most of the time even though
   RTÉ supplies the bigger share of the feed. So we take turns between sources
   instead, and read the newest story from whichever source is up. */
const HEADLINE_TURN_KEY = "tts:srcturn";

/* ---------- The Reckoning: a spoken digest of the whole day's news ----------
   Completely separate from the Deco headline reading above, which is unchanged.

   Two stages: Gemini reads ALL of today's headlines and writes one short
   paragraph surveying them; ElevenLabs then speaks that paragraph in the
   user's own cloned voice.

   COST is the thing to watch here — unlike Gemini's free tier, ElevenLabs
   charges roughly one credit per character. So:
     - a new paragraph is written at most once every DIGEST_TTL (6h) = 4 a day
     - DIGEST_MAX_CHARS is a hard ceiling on what is ever sent for synthesis
     - the audio is cached, so replaying it costs nothing
   At ~500 characters, 4 times a day, that is ~60k credits a month against a
   121k Creator allowance. */
const DIGEST_VOICE_ID = "Z04mOjzpvViB47dvVUg4";
const DIGEST_ELEVEN_MODEL = "eleven_multilingual_v2"; // best fidelity for a cloned voice
const DIGEST_ELEVEN_URL = "https://api.elevenlabs.io/v1/text-to-speech/" + DIGEST_VOICE_ID;
const DIGEST_TEXT_KEY = "digest:text:";
const DIGEST_AUDIO_KEY = "digest:audio:";
/* TWO generations a day, no matter how often it is played. The bulletin is
   written and spoken at the two times below and the finished MP3 is cached;
   EVERY other play — the kiosk now asks for it once an hour — is served from
   that cache and costs nothing.

   These are Dublin wall-clock times, deliberately, because the kiosk plays on
   Dublin time. The previous version bucketed by UTC half-day, which put a
   boundary at 13:00 Dublin: harmless when the digest only played twice a day,
   but with hourly plays the 13:40 play would have crossed it and paid for a
   third generation. */
const DIGEST_GEN_TIMES = [
  { hour: 9, minute: 40, label: "am" },
  { hour: 16, minute: 40, label: "pm" },
];
const DIGEST_TTL = 26 * 60 * 60;     // outlives the longest gap (16:40 -> 09:40) with room to spare
const DIGEST_STORY_COUNT = 20;       // how many headlines to survey
const DIGEST_MAX_CHARS = 900;        // hard cost ceiling on what gets synthesised
const DIGEST_TIMEOUT_MS = 60000;     // ElevenLabs is slower than Gemini

/* Pauses. ElevenLabs honours break tags in the text, which is far more reliable
   than hoping punctuation lands — the first version ran sentences together. */
const DIGEST_BREAK_LONG = '<break time="0.9s" />';   // around the intro and outro
const DIGEST_BREAK_SHORT = '<break time="0.45s" />'; // between stories

/* Written in three parts so the pauses can be placed exactly. */
const DIGEST_SCHEMA = {
  type: "object",
  properties: {
    intro: { type: "string" },
    stories: { type: "array", items: { type: "string" } },
    outro: { type: "string" },
  },
  required: ["intro", "stories", "outro"],
  propertyOrdering: ["intro", "stories", "outro"],
};

/* Delivery. Kept as a constant because it forms part of the audio cache key —
   change a setting and the next play is regenerated rather than replaying the
   old performance. */
const DIGEST_VOICE_SETTINGS = {
  stability: 0.50,        // a shade looser, which lets more character through
  similarity_boost: 0.85, // hold the cloned voice's character
  style: 0.40,            // more expressive than before, still not theatrical
  use_speaker_boost: true,
  speed: 0.82,            // 0.78 was a drag; nudged back up. 1.0 is normal pace
};

/* The written register.

   The first version was pure atmosphere — "old sins in high places are finally
   reckoned with" — and told a listener nothing about what had actually
   happened. The tone now has to sit on top of real facts, not replace them:
   grave in the PHRASING, concrete in the CONTENT.

   Still deliberately not impersonating any real person — it reports the news,
   it never speaks as anybody. */
const DIGEST_PROMPT =
  "You are writing a short spoken news bulletin for a kitchen dashboard in Ireland. It is read " +
  "aloud by a low, weary male voice. Return JSON with three parts.\n\n" +
  "intro — ONE line, 8 to 16 words, spoken to one listener, whose name is Gav. Say his name " +
  "exactly once, at the start — 'Gav.' standing alone, or worked into the opening words. Not " +
  "'Hey Gav', not a greeting, not a weather report. After the name, an aphorism: a flat, " +
  "declarative fragment of dark wisdom about the world and the people in it. Present tense. " +
  "Unsettling, certain of itself, faintly menacing. It should sound like the opening of " +
  "something he is not sure he wants to hear. State no OTHER name — not your own, not the " +
  "programme's.\n\n" +
  "stories — THREE OR FOUR sentences, one per story, covering the most significant headlines. " +
  "These must be CLEAR and CONCRETE, and completely plain — no character, no colour, no " +
  "commentary. Name the real people, places and events. If someone died, say who and how. If a " +
  "warning was issued, say what kind and where. Someone listening once while making tea must be " +
  "able to say afterwards what happened. Never let a metaphor stand in for a fact. Write " +
  "numbers as words.\n\n" +
  "outro — ONE line, 8 to 16 words. A verdict on THIS day's news specifically, drawn from the " +
  "stories you just wrote — not a generic sign-off. Fatalistic, aphoristic, and final. It should " +
  "land like a lid closing.\n\n" +
  "Character: all of the personality lives in the intro and the outro. There, the voice is a " +
  "roadside preacher who has stopped expecting anything of anyone — cryptic, fatalistic, " +
  "unimpressed by cruelty because he considers it ordinary. Plain hard words, no ornament, no " +
  "jokes, never theatrical. Between those two lines the delivery goes completely straight: the " +
  "stories are read as bare fact, which is what makes the framing land.\n\n" +
  "Hesitation — in the intro and the outro ONLY. He is not a smooth talker. He loses the thread " +
  "and picks it up again. In those two lines use a LITTLE of this: an ellipsis for a beat " +
  "mid-sentence, or a phrase broken off and restarted, or one word repeated. About one stumble " +
  "per line. Never more than two. It should sound like a man thinking, not a man malfunctioning, " +
  "and the line must still parse as a sentence. The stories get NONE of this — they stay " +
  "completely fluent, because a stumble in the middle of a fact makes the fact harder to hear.\n\n" +
  "Rules:\n" +
  "- Refer ONLY to what is in the headlines. Invent no events, names, numbers or facts.\n" +
  "- No source names, no bullet points, no quotation marks, no headings.\n" +
  "- Do not speak as any real person. Address the listener only as described above.\n\n" +
  "Headlines:\n";

/* Reader-engagement filler that shouldn't be read out as the top story.
   TheJournal in particular puts quizzes and polls in its news feed. */
const HEADLINE_SKIP_PREFIX = /^\s*(quiz|poll|competition|sponsored|advertisement|win a\b)/i;
const HEADLINE_SKIP_QUESTION = /^\s*(should|do you|how much do you|can you|are you|what'?s your)\b/i;

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

    if (url.pathname === "/api/digest-audio") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      return handleDigestAudio(request, env, ctx);
    }

    if (url.pathname === "/api/headline-audio") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      return handleHeadlineAudio(request, env, ctx);
    }

    // Read-only view of the mood log, for checking the baseline is filling up.
    if (url.pathname === "/api/mood/history") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }
      return handleMoodHistory(request, env);
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

    // Baseline is computed from the log as it stands BEFORE today's reading is
    // added, so the current score is never compared against itself.
    const history = await loadMoodHistory(env);
    const baseline = computeBaseline(history);
    const relative = computeRelative(mood.score, history, baseline);

    const payload = Object.assign(
      { available: true, source: "gemini", model: MOOD_MODEL, updatedAt: new Date().toISOString() },
      mood,
      { baseline: baseline, relative: relative }
    );
    if (debug) payload.stories = classifications;

    // Append after responding — the log is for the NEXT reading's baseline, so
    // nothing here needs to block the response.
    ctx.waitUntil(appendMoodReading(env, {
      t: Date.now(),
      score: mood.score,
      avg: mood.avgSentiment,
      med: mood.medianSentiment,
      neg: mood.counts ? mood.counts.negative : null,
      heavy: mood.heavyCount,
      n: mood.analyzed
    }));

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

/* ============================================================
   /api/digest-audio  —  the whole day's news as one spoken paragraph
   ------------------------------------------------------------
   ?text=1     the written paragraph as JSON (no ElevenLabs credits spent)
   ?refresh=1  rewrite now instead of reusing the 6-hour cached one
   ============================================================ */
async function handleDigestAudio(request, env, ctx) {
  const url = new URL(request.url);
  const preview = url.searchParams.get("text") === "1";
  const force = url.searchParams.get("refresh") === "1";

  const geminiKey = env && env.GEMINI_API_KEY;
  const elevenKey = env && env.ELEVENLABS_API_KEY;

  /* ?voices=1 lists the voices on the ElevenLabs account (names + ids only —
     never the key). Needed because a voice id copied from the wrong place, or
     a Voice Library voice that was never added to the account, fails with a
     confusing "voice_not_found". */
  if (url.searchParams.get("voices") === "1") {
    if (!elevenKey) return json({ available: false, reason: "no_elevenlabs_key" }, 503);
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/voices", {
        signal: AbortSignal.timeout(DIGEST_TIMEOUT_MS),
        headers: { "xi-api-key": elevenKey, Accept: "application/json" },
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return json({ available: false, reason: "voices_http_" + r.status, detail: t.slice(0, 200) }, 503);
      }
      const d = await r.json();
      return json({
        available: true,
        configured: DIGEST_VOICE_ID,
        voices: (d.voices || []).map((v) => ({
          name: v.name,
          voice_id: v.voice_id,
          category: v.category,
          matches: v.voice_id === DIGEST_VOICE_ID,
        })),
      });
    } catch (e) {
      return json({ available: false, reason: "voices_error", detail: String(e).slice(0, 200) }, 503);
    }
  }

  if (!geminiKey) return json({ available: false, reason: "no_gemini_key" }, 503);

  try {
    const paragraph = await getDigestText(request, env, geminiKey, force);
    if (!paragraph) return json({ available: false, reason: "no_news" }, 503);

    if (preview) {
      return json({
        available: !!elevenKey,
        voiceId: DIGEST_VOICE_ID,
        model: DIGEST_ELEVEN_MODEL,
        characters: paragraph.length,
        creditsApprox: paragraph.length,
        text: paragraph,
      });
    }
    if (!elevenKey) return json({ available: false, reason: "no_elevenlabs_key" }, 503);

    // Voice settings are part of what produced the audio, so they belong in the
    // key — otherwise changing the speed would keep replaying the old pace.
    const cacheKey =
      DIGEST_AUDIO_KEY +
      hashText(
        paragraph + "|" + DIGEST_VOICE_ID + "|" + DIGEST_ELEVEN_MODEL + "|" +
        JSON.stringify(DIGEST_VOICE_SETTINGS)
      );

    if (env.MOOD_LOG) {
      try {
        const hit = await env.MOOD_LOG.get(cacheKey, "arrayBuffer");
        if (hit && hit.byteLength > 512) return mp3Response(hit, "HIT");
      } catch (e) {
        console.warn("Digest audio cache read failed:", String(e));
      }
    }

    const mp3 = await synthesizeEleven(paragraph, elevenKey);
    if (env.MOOD_LOG) {
      ctx.waitUntil(
        env.MOOD_LOG.put(cacheKey, mp3, { expirationTtl: DIGEST_TTL }).catch((e) =>
          console.warn("Digest audio cache write failed:", String(e))
        )
      );
    }
    return mp3Response(mp3, "MISS");
  } catch (err) {
    console.warn("Digest failed:", String(err));
    return json(
      { available: false, reason: "digest_error", detail: String((err && err.message) || err).slice(0, 200) },
      503
    );
  }
}

/* The written paragraph, cached for DIGEST_TTL so ElevenLabs is only ever
   asked to speak a handful of distinct paragraphs a day. */
async function getDigestText(request, env, geminiKey, force) {
  // The prompt is keyed in too, so rewording it takes effect on the next play
  // instead of serving the previous wording for up to six hours.
  const slot = digestSlot(new Date());
  const key = DIGEST_TEXT_KEY + hashText(DIGEST_PROMPT) + ":" + slot;

  if (!force && env && env.MOOD_LOG) {
    try {
      const hit = await env.MOOD_LOG.get(key);
      if (hit) return hit;
    } catch (e) {
      console.warn("Digest text cache read failed:", String(e));
    }
  }

  const items = await getNewsItems(request);
  const usable = (items || []).filter(isReadableStory).slice(0, DIGEST_STORY_COUNT);
  if (usable.length < 3) return null;

  const written = await writeDigest(usable, geminiKey);
  if (!written) return null;

  if (env && env.MOOD_LOG) {
    await env.MOOD_LOG.put(key, written, { expirationTtl: DIGEST_TTL }).catch((e) =>
      console.warn("Digest text cache write failed:", String(e))
    );
  }
  return written;
}

/* Dublin wall-clock date and time-of-day. Workers run in UTC, but the two
   generation times are fixed points on the kiosk's clock, so the comparison
   has to happen in Dublin time or it drifts by an hour every summer. */
function dublinClock(d) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return {
    date: get("year") + "-" + get("month") + "-" + get("day"),
    // Some ICU builds render midnight as "24" under hour12:false.
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/* Which generation the current moment belongs to — the most recent one that
   has already passed. Everything between two generation times shares a slot
   id, which is what makes the hourly replays free: same id, same cache key,
   same MP3 handed straight back. */
function digestSlot(now) {
  const t = dublinClock(now);
  for (let i = DIGEST_GEN_TIMES.length - 1; i >= 0; i--) {
    const g = DIGEST_GEN_TIMES[i];
    if (t.minutes >= g.hour * 60 + g.minute) return t.date + "-" + g.label;
  }
  // Before the morning generation: still on last night's bulletin.
  const y = dublinClock(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return y.date + "-" + DIGEST_GEN_TIMES[DIGEST_GEN_TIMES.length - 1].label;
}

async function writeDigest(items, apiKey) {
  const list = items.map((s) => "- " + String(s.title || "").trim()).join("\n");

  const res = await fetch(MOOD_API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(MOOD_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: DIGEST_PROMPT + list }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: DIGEST_SCHEMA,
      },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Digest HTTP " + res.status + (t ? ": " + t.slice(0, 200) : ""));
  }

  const raw = extractGeminiText(await res.json());
  if (!raw) throw new Error("Digest returned no text");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("Digest JSON parse failed");
  }

  const tidy = (s) => String(s || "").replace(/\s+/g, " ").replace(/^["'\s]+|["'\s]+$/g, "").trim();
  const intro = tidy(parsed.intro);
  const outro = tidy(parsed.outro);
  const stories = (Array.isArray(parsed.stories) ? parsed.stories : []).map(tidy).filter(Boolean);
  if (!stories.length) throw new Error("Digest returned no stories");

  return assembleDigest(intro, stories, outro);
}

/* Stitch the three parts together with explicit pauses, then enforce the hard
   cost ceiling. Stories are dropped whole rather than truncated mid-sentence,
   and the outro is always kept so the bulletin still lands properly. */
function assembleDigest(intro, stories, outro) {
  const build = (list) => {
    const parts = [];
    if (intro) parts.push(intro, DIGEST_BREAK_LONG);
    parts.push(list.join(" " + DIGEST_BREAK_SHORT + " "));
    if (outro) parts.push(DIGEST_BREAK_LONG, outro);
    return parts.join(" ");
  };

  let kept = stories.slice();
  let out = build(kept);
  while (out.length > DIGEST_MAX_CHARS && kept.length > 1) {
    kept.pop();
    out = build(kept);
  }
  // Still over with a single story: trim that one back to a sentence end.
  if (out.length > DIGEST_MAX_CHARS) out = out.slice(0, DIGEST_MAX_CHARS);
  return out;
}

/* ElevenLabs returns a finished MP3, so unlike Gemini there's no header to
   add — browsers play it directly. */
async function synthesizeEleven(text, apiKey) {
  const res = await fetch(DIGEST_ELEVEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(DIGEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: text,
      model_id: DIGEST_ELEVEN_MODEL,
      voice_settings: DIGEST_VOICE_SETTINGS,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("ElevenLabs HTTP " + res.status + (t ? ": " + t.slice(0, 200) : ""));
  }
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength < 512) throw new Error("ElevenLabs returned empty audio");
  return buf;
}

function mp3Response(buf, cacheState) {
  return new Response(buf, {
    status: 200,
    headers: Object.assign(
      {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "public, max-age=1800",
        "X-Digest-Cache": cacheState,
      },
      corsHeaders()
    ),
  });
}

/* ============================================================
   /api/headline-audio  —  the top story, read aloud
   ------------------------------------------------------------
   ?text=1 returns the line as JSON instead of audio (handy for
           checking what it would say without burning a generation)
   ============================================================ */
async function handleHeadlineAudio(request, env, ctx) {
  const url = new URL(request.url);
  const apiKey = env && env.GEMINI_API_KEY;

  const items = await getNewsItems(request);
  const preview = url.searchParams.get("text") === "1";
  const picked = await pickHeadlineItem(env, items);
  if (!picked) {
    return json({ available: false, reason: "no_news" }, 503);
  }

  const line = buildHeadlineLine(picked.item);
  if (preview) {
    return json({
      available: !!apiKey,
      voice: TTS_VOICE,
      model: TTS_MODEL,
      source: picked.item.source,
      nextSource: picked.nextSource,
      line: line,
    });
  }

  // Advance the source rotation only for real reads, so previewing the line
  // doesn't quietly skip a source.
  if (picked.advance) ctx.waitUntil(picked.advance());
  // No key -> tell the caller plainly. The frontend treats any non-audio
  // response as "fall back to a recorded clip".
  if (!apiKey) return json({ available: false, reason: "no_key" }, 503);

  // The style instruction is part of what produced the audio, so it has to be
  // part of the key. Without it, changing the delivery would keep serving the
  // previous performance of the same headline until the 6h TTL expired.
  const cacheKey =
    TTS_CACHE_PREFIX + hashText(line + "|" + TTS_VOICE + "|" + TTS_MODEL + "|" + TTS_STYLE);

  // Already generated this exact line? Serve it straight back.
  if (env.MOOD_LOG) {
    try {
      const hit = await env.MOOD_LOG.get(cacheKey, "arrayBuffer");
      if (hit && hit.byteLength > 44) return wavResponse(hit, "HIT");
    } catch (e) {
      console.warn("TTS cache read failed:", String(e));
    }
  }

  try {
    const wav = await synthesizeSpeech(line, apiKey);
    if (env.MOOD_LOG) {
      // Store after responding — a failed write only costs one regeneration.
      ctx.waitUntil(
        env.MOOD_LOG.put(cacheKey, wav, { expirationTtl: TTS_CACHE_TTL }).catch((e) =>
          console.warn("TTS cache write failed:", String(e))
        )
      );
    }
    return wavResponse(wav, "MISS");
  } catch (err) {
    console.warn("TTS failed:", String(err));
    return json(
      { available: false, reason: "tts_error", detail: String((err && err.message) || err).slice(0, 200) },
      503
    );
  }
}

/* Is this a real story, or reader-engagement filler? */
function isReadableStory(item) {
  if (!item || !item.title) return false;
  const t = String(item.title);
  if (HEADLINE_SKIP_PREFIX.test(t)) return false;
  // "Should drivers be able to…?" style poll prompts — only when it's actually
  // phrased as a question, so a genuine headline beginning "Should" survives.
  if (/\?\s*$/.test(t) && HEADLINE_SKIP_QUESTION.test(t)) return false;
  return true;
}

/* Choose which story to read, taking turns between sources.

   Rotating by SOURCE rather than taking the newest item overall is the whole
   point: the busiest publisher would otherwise dominate the slot permanently.
   Within the chosen source we still take its newest story. If that source has
   nothing usable right now we move on to the next rather than going silent. */
async function pickHeadlineItem(env, items) {
  const usable = (items || []).filter(isReadableStory);
  if (!usable.length) return null;

  // Distinct sources, in the order they're configured.
  const sources = [];
  FEEDS.forEach((f) => {
    if (sources.indexOf(f.source) === -1) sources.push(f.source);
  });

  let turn = 0;
  if (env && env.MOOD_LOG) {
    try {
      const n = parseInt((await env.MOOD_LOG.get(HEADLINE_TURN_KEY)) || "0", 10);
      if (isFinite(n) && n >= 0) turn = n % sources.length;
    } catch (e) {
      console.warn("Headline turn read failed:", String(e));
    }
  }

  for (let i = 0; i < sources.length; i++) {
    const idx = (turn + i) % sources.length;
    const hit = usable.find((it) => it.source === sources[idx]);
    if (!hit) continue; // nothing usable from that source right now
    const next = (idx + 1) % sources.length;
    return {
      item: hit,
      nextSource: sources[next],
      advance: env && env.MOOD_LOG
        ? () =>
            env.MOOD_LOG.put(HEADLINE_TURN_KEY, String(next)).catch((e) =>
              console.warn("Headline turn write failed:", String(e))
            )
        : null,
    };
  }

  // Every source came up empty on the filter — fall back to the newest usable.
  return { item: usable[0], nextSource: sources[0], advance: null };
}

/* The sentence the newsreader actually says. Kept short: one source, one
   headline, no summary — a kiosk voice line, not a bulletin. */
function buildHeadlineLine(item) {
  let title = String(item.title || "").trim().replace(/\s+/g, " ");
  if (title.length > TTS_TITLE_MAX) {
    title = title.slice(0, TTS_TITLE_MAX - 1).replace(/\s+\S*$/, "") + "…";
  }
  // Only add a full stop if the headline doesn't already end in punctuation —
  // plenty of them end in "?" and "Butterflies?." reads badly aloud.
  title = title.replace(/\s+$/, "");
  if (!/[.!?…]$/.test(title)) title += ".";
  const source = item.source ? String(item.source).trim() : "";
  return (source ? "Top story from " + source + ". " : "Top story. ") + title;
}

async function synthesizeSpeech(line, apiKey) {
  const body = {
    contents: [
      {
        parts: [
          {
            // The style instruction is part of the prompt for Gemini TTS.
            text: TTS_STYLE + "\n\n" + line,
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
    },
  };

  const res = await fetch(TTS_URL, {
    method: "POST",
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error("TTS HTTP " + res.status + (errText ? ": " + errText.slice(0, 200) : ""));
  }

  const data = await res.json();
  const part =
    data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts.find((p) => p && p.inlineData && p.inlineData.data);

  if (!part) throw new Error("TTS returned no audio");

  const pcm = base64ToBytes(part.inlineData.data);
  if (!pcm.byteLength) throw new Error("TTS returned empty audio");

  // Gemini documents 24kHz/mono/16-bit, and states the rate in the mimeType
  // (e.g. "audio/L16;codec=pcm;rate=24000"). Read it rather than assume, so a
  // change upstream doesn't silently play everything at the wrong pitch.
  const rate = parseRateFromMime(part.inlineData.mimeType) || 24000;
  return pcmToWav(pcm, rate, 1, 16);
}

function parseRateFromMime(mime) {
  const m = /rate=(\d+)/i.exec(String(mime || ""));
  return m ? parseInt(m[1], 10) : 0;
}

function base64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Wrap raw PCM in a standard 44-byte RIFF/WAVE header. Without this the
   browser has no idea what the bytes are and refuses to play them. */
function pcmToWav(pcm, sampleRate, channels, bitsPerSample) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  let o = 0;
  const ascii = (s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o++, s.charCodeAt(i));
  };

  ascii("RIFF");
  dv.setUint32(o, 36 + pcm.byteLength, true); o += 4;
  ascii("WAVE");
  ascii("fmt ");
  dv.setUint32(o, 16, true); o += 4;   // PCM chunk size
  dv.setUint16(o, 1, true);  o += 2;   // format 1 = uncompressed PCM
  dv.setUint16(o, channels, true); o += 2;
  dv.setUint32(o, sampleRate, true); o += 4;
  dv.setUint32(o, byteRate, true); o += 4;
  dv.setUint16(o, blockAlign, true); o += 2;
  dv.setUint16(o, bitsPerSample, true); o += 2;
  ascii("data");
  dv.setUint32(o, pcm.byteLength, true); o += 4;
  new Uint8Array(buf, 44).set(pcm);
  return buf;
}

function wavResponse(buf, cacheState) {
  return new Response(buf, {
    status: 200,
    headers: Object.assign(
      {
        "Content-Type": "audio/wav",
        "Content-Length": String(buf.byteLength),
        // The line changes with the headline, so let the browser reuse it only
        // briefly — the Worker-side KV cache is what actually saves the money.
        "Cache-Control": "public, max-age=600",
        "X-TTS-Cache": cacheState,
      },
      corsHeaders()
    ),
  });
}

/* Small stable hash (FNV-1a) for cache keys — not security, just a short
   deterministic id for a given line of text. */
function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/* ============================================================
   Mood log + rolling baseline
   ------------------------------------------------------------
   Everything below no-ops safely when env.MOOD_LOG is missing.
   ============================================================ */

/* Read the whole log. Any problem (no binding, unparseable value, wrong shape)
   returns an empty log rather than throwing — a broken baseline must never take
   the mood gauge down with it. */
async function loadMoodHistory(env) {
  if (!env || !env.MOOD_LOG) return [];
  try {
    const raw = await env.MOOD_LOG.get(MOOD_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r) => r && isNumber(r.t) && isNumber(r.score));
  } catch (e) {
    console.warn("Mood history read failed:", String(e));
    return [];
  }
}

/* Append one reading and prune. Read-modify-write is not atomic, so two
   datacentres recomputing in the same instant can cost one reading — harmless
   at ~8 writes a day, and not worth a Durable Object to avoid. */
async function appendMoodReading(env, reading) {
  if (!env || !env.MOOD_LOG) return;
  try {
    const history = await loadMoodHistory(env);
    history.push(reading);
    await env.MOOD_LOG.put(MOOD_HISTORY_KEY, JSON.stringify(pruneMoodHistory(history)));
  } catch (e) {
    // A failed write just means one missing data point. Never surface it.
    console.warn("Mood history write failed:", String(e));
  }
}

/* Keep the log bounded by both age and count, oldest dropped first. */
function pruneMoodHistory(history) {
  const cutoff = Date.now() - MOOD_BASELINE_DAYS * 86400000;
  const fresh = history
    .filter((r) => r && isNumber(r.t) && r.t >= cutoff)
    .sort((a, b) => a.t - b.t);
  return fresh.length > MOOD_HISTORY_MAX ? fresh.slice(-MOOD_HISTORY_MAX) : fresh;
}

/* Describe the trailing window: where the score normally sits, and how much it
   normally moves.

   Deliberately median + MAD rather than mean + standard deviation. A single
   atrocity day is a genuine outlier that would inflate an SD enough to flatten
   every reading for the following fortnight; the median barely notices it. */
function computeBaseline(history) {
  const cutoff = Date.now() - MOOD_BASELINE_DAYS * 86400000;
  const scores = (history || [])
    .filter((r) => r && isNumber(r.t) && r.t >= cutoff && isNumber(r.score))
    .map((r) => r.score);

  if (scores.length < MOOD_BASELINE_MIN_SAMPLES) {
    return { ready: false, samples: scores.length, needed: MOOD_BASELINE_MIN_SAMPLES, days: MOOD_BASELINE_DAYS };
  }

  const med = median(scores);
  const spread = median(scores.map((s) => Math.abs(s - med))) * MAD_TO_SIGMA;

  return {
    ready: true,
    samples: scores.length,
    days: MOOD_BASELINE_DAYS,
    median: Math.round(med),
    spread: Math.round(spread * 10) / 10,
    min: Math.min.apply(null, scores),
    max: Math.max.apply(null, scores)
  };
}

/* Place today's score inside that window: a z-like deviation and a percentile
   rank. Percentile is the one worth showing a human — "in the bottom 15% of the
   last fortnight" needs no explanation. */
function computeRelative(score, history, baseline) {
  if (!baseline || !baseline.ready || !isNumber(score)) return null;

  const cutoff = Date.now() - MOOD_BASELINE_DAYS * 86400000;
  const scores = (history || [])
    .filter((r) => r && isNumber(r.t) && r.t >= cutoff && isNumber(r.score))
    .map((r) => r.score);

  // A flat log (spread 0) means every reading so far was identical — treat the
  // deviation as zero rather than dividing by nothing.
  const z = baseline.spread > 0 ? (score - baseline.median) / baseline.spread : 0;

  const atOrBelow = scores.filter((s) => s <= score).length;
  const percentile = Math.round((atOrBelow / scores.length) * 100);

  return {
    z: Math.round(z * 100) / 100,
    percentile: percentile,
    vsMedian: Math.round(score - baseline.median),
    label: relativeLabel(z)
  };
}

/* Relative bands. Unlike the absolute ones these are symmetric around the
   baseline, so every label is genuinely reachable — that was the whole point. */
function relativeLabel(z) {
  if (z >= 1.5) return "Grand for once";
  if (z >= 0.5) return "Lighter than usual";
  if (z > -0.5) return "About normal";
  if (z > -1.5) return "Heavier than usual";
  return "Grim even for us";
}

/* GET /api/mood/history — inspect the log while the baseline fills up.
   ?days=N narrows the window. Never cached: the point is to see it change. */
async function handleMoodHistory(request, env) {
  if (!env || !env.MOOD_LOG) {
    return json({ available: false, reason: "no_kv_binding", readings: [] });
  }
  const url = new URL(request.url);
  const days = clampNum(parseInt(url.searchParams.get("days") || "", 10) || MOOD_BASELINE_DAYS, 1, 60);
  const cutoff = Date.now() - days * 86400000;

  const history = await loadMoodHistory(env);
  const readings = history
    .filter((r) => r.t >= cutoff)
    .map((r) => Object.assign({ at: new Date(r.t).toISOString() }, r));

  return json({
    available: true,
    days: days,
    count: readings.length,
    baseline: computeBaseline(history),
    readings: readings
  }, 200, { "Cache-Control": "no-store" });
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
