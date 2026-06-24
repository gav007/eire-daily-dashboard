/* ============================================================
   Éire Daily — Cloudflare Worker backend
   ------------------------------------------------------------
   One Worker does two jobs:

   1. Serves the static dashboard (index.html, app.js, styles.css,
      assets/…) straight from the repo via the ASSETS binding
      (configured in wrangler.toml -> [assets]).
   2. Handles the API routes the frontend calls:
        GET /api/news    -> live, normalised Irish headlines
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

   Weather is intentionally NOT wired here yet (separate task).
   ============================================================ */

/* ---------- Config ---------- */
// Validated, healthy feeds (see validate-feeds.js / BACKEND_NOTES.md).
// `limit` = how many of each feed's items to keep BEFORE merging.
const FEEDS = [
  { source: "RTÉ News",    url: "https://www.rte.ie/feeds/rss/?index=/news/&limit=100", limit: 10 },
  { source: "TheJournal",  url: "https://www.thejournal.ie/feed/",                       limit: 10 },
  // Dublin-local only. We deliberately do NOT also pull /news/ — it overlaps
  // heavily with this feed and would create duplicates.
  { source: "Dublin Live", url: "https://www.dublinlive.ie/news/dublin-news/?service=rss", limit: 5 }
];

const CACHE_SECONDS = 600;   // 10 minutes — how long an /api/news response is reused
const FEED_TIMEOUT_MS = 8000; // give up on a slow feed after 8s (others still return)
const SUMMARY_MAX = 220;     // trim summaries so cards stay tidy

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

  // --- 2. Fetch all feeds in parallel; one failure must not sink the rest --
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

  // --- 3. All feeds down -> 502 (do NOT cache this) ------------------------
  if (okCount === 0) {
    return json(
      { error: "All news feeds failed", items: [], updatedAt: new Date().toISOString() },
      502
    );
  }

  // --- 4. Sort newest-first, then de-dupe by article URL ------------------
  items.sort((a, b) => dateValue(b.published) - dateValue(a.published));
  items = dedupeByUrl(items);

  // --- 5. Build response + store in the edge cache for 10 minutes ----------
  const payload = { items, updatedAt: new Date().toISOString() };
  const response = json(payload, 200, {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}`
  });
  // cache.put must not block the response, so do it in the background.
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
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
