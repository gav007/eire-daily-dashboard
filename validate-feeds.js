/* ============================================================
   validate-feeds.js — RSS feed validation (standalone, no deps)
   Run:  node validate-feeds.js
   Node 18+ (global fetch). Pure JS, no npm install required.

   Purpose: confirm which RSS URLs are live, valid XML, and usable
   BEFORE building the Cloudflare Worker /api/news endpoint.
   This does NOT touch the dashboard or use any frontend mock data.
   ============================================================ */
"use strict";

var FEEDS = [
  { name: "RTÉ News",                 url: "https://www.rte.ie/feeds/rss/?index=/news/&limit=100" },
  { name: "TheJournal",               url: "https://www.thejournal.ie/feed/" },
  { name: "Dublin Live — News",       url: "https://www.dublinlive.ie/news/?service=rss" },
  { name: "Dublin Live — Dublin news", url: "https://www.dublinlive.ie/news/dublin-news/?service=rss" }
];

var TIMEOUT_MS = 15000;
var SHOW_ITEMS = 10;

/* ---------- tiny XML/RSS helpers (regex-based, validation only) ---------- */
function decodeEntities(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(block, names) {
  for (var i = 0; i < names.length; i++) {
    var re = new RegExp("<" + names[i] + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + names[i] + ">", "i");
    var m = block.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return "";
}

// Link is special: RSS uses <link>text</link>, Atom uses <link href="..."/>
function findLink(block) {
  var rss = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss && rss[1] && rss[1].trim()) return decodeEntities(rss[1]);
  var atom = block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i);
  if (atom) return decodeEntities(atom[1]);
  // Some feeds use <guid isPermaLink="true">URL</guid>
  var guid = block.match(/<guid(?:\s[^>]*)?>([\s\S]*?)<\/guid>/i);
  if (guid && /^https?:\/\//i.test(guid[1].trim())) return decodeEntities(guid[1]);
  return "";
}

function findImage(block) {
  var m =
    block.match(/<media:content\b[^>]*\burl\s*=\s*["']([^"']+)["']/i) ||
    block.match(/<media:thumbnail\b[^>]*\burl\s*=\s*["']([^"']+)["']/i) ||
    block.match(/<enclosure\b[^>]*\burl\s*=\s*["']([^"']+)["'][^>]*type\s*=\s*["']image/i) ||
    block.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function extractBlocks(xml, tag) {
  var re = new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">", "gi");
  var out = [], m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function looksLikeHtml(body) {
  var head = body.slice(0, 600).toLowerCase();
  if (/<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]/.test(head)) return false;
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/.test(head);
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }

/* ---------- fetch one feed ---------- */
async function checkFeed(feed) {
  var line = "═".repeat(72);
  console.log("\n" + line);
  console.log("FEED: " + feed.name);
  console.log("URL : " + feed.url);
  console.log(line);

  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  var res, body;
  try {
    res = await fetch(feed.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) FeedValidator/1.0",
        "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5"
      }
    });
  } catch (e) {
    clearTimeout(timer);
    var why = (e && e.name === "AbortError") ? "TIMEOUT after " + TIMEOUT_MS + "ms" : (e && e.message) || String(e);
    console.log("RESULT: ❌ NETWORK ERROR — " + why);
    return { name: feed.name, url: feed.url, verdict: "NETWORK ERROR", detail: why, count: 0 };
  }

  try { body = await res.text(); }
  catch (e) { clearTimeout(timer); console.log("RESULT: ❌ could not read body — " + e.message);
    return { name: feed.name, url: feed.url, verdict: "READ ERROR", detail: e.message, count: 0 }; }
  clearTimeout(timer);

  var ctype = res.headers.get("content-type") || "(none)";
  var redirected = res.redirected || (res.url && res.url !== feed.url);

  console.log("HTTP status : " + res.status + " " + res.statusText);
  console.log("Content-Type: " + ctype);
  console.log("Final URL   : " + res.url + (redirected ? "   ⚠️  REDIRECTED" : ""));
  console.log("Body size   : " + body.length + " bytes");

  if (!res.ok) {
    var blocked = (res.status === 403 || res.status === 429) ? " (looks BLOCKED)" : "";
    console.log("RESULT: ❌ HTTP " + res.status + blocked);
    return { name: feed.name, url: feed.url, verdict: "HTTP " + res.status + blocked, detail: ctype, count: 0, redirected: redirected };
  }

  if (looksLikeHtml(body)) {
    console.log("RESULT: ❌ Returned HTML, not RSS/XML (block page, redirect, or wrong URL)");
    console.log("  First 200 chars: " + body.slice(0, 200).replace(/\s+/g, " ").trim());
    return { name: feed.name, url: feed.url, verdict: "HTML (not XML)", detail: ctype, count: 0, redirected: redirected };
  }

  // parse items (RSS <item> or Atom <entry>)
  var isAtom = /<feed[\s>]/i.test(body.slice(0, 600)) && !/<rss[\s>]/i.test(body.slice(0, 600));
  var blocks = extractBlocks(body, isAtom ? "entry" : "item");
  if (!blocks.length && !isAtom) blocks = extractBlocks(body, "entry"); // mixed/odd feeds

  console.log("Format      : " + (isAtom ? "Atom" : "RSS") + "   Items found: " + blocks.length);

  if (!blocks.length) {
    console.log("RESULT: ⚠️  ZERO items parsed (valid-looking XML but no <item>/<entry>)");
    return { name: feed.name, url: feed.url, verdict: "ZERO ITEMS", detail: ctype, count: 0, redirected: redirected };
  }

  var withImg = 0, badDates = 0;
  var n = Math.min(SHOW_ITEMS, blocks.length);
  console.log("\nFirst " + n + " items:");
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var img = findImage(b);
    if (img) withImg++;
    var rawDate = firstTag(b, ["pubDate", "dc:date", "published", "updated"]);
    var parsed = rawDate ? new Date(rawDate) : null;
    var dateOk = parsed && !isNaN(parsed.getTime());
    if (!dateOk) badDates++;
    if (i < n) {
      var title = firstTag(b, ["title"]) || "(no title)";
      var url = findLink(b) || "(no link)";
      console.log("\n  " + (i + 1) + ". " + title);
      console.log("     date : " + (rawDate || "(none)") + (dateOk ? "" : "   ⚠️ unparseable"));
      console.log("     url  : " + url);
      console.log("     image: " + (img ? img : "(none — would use Dublin stock)"));
    }
  }

  console.log("\nImages: " + withImg + "/" + blocks.length + " items have an image key" +
              (badDates ? "   |   ⚠️ " + badDates + " unparseable dates" : ""));
  console.log("RESULT: ✅ OK — " + blocks.length + " items" + (redirected ? " (note: redirected)" : ""));
  return {
    name: feed.name, url: feed.url, verdict: "OK", count: blocks.length,
    withImg: withImg, badDates: badDates, redirected: redirected, finalUrl: res.url
  };
}

/* ---------- run all ---------- */
(async function main() {
  console.log("RSS FEED VALIDATION — " + new Date().toISOString());
  console.log("Testing " + FEEDS.length + " feeds (timeout " + TIMEOUT_MS + "ms each)\n");

  var results = [];
  for (var i = 0; i < FEEDS.length; i++) {
    /* sequential so the output stays readable */
    results.push(await checkFeed(FEEDS[i]));
  }

  console.log("\n\n" + "█".repeat(72));
  console.log("SUMMARY");
  console.log("█".repeat(72));
  console.log(pad("FEED", 26) + pad("ITEMS", 7) + pad("REDIR", 7) + "VERDICT");
  console.log("-".repeat(72));
  for (var j = 0; j < results.length; j++) {
    var r = results[j];
    console.log(
      pad(r.name, 26) +
      pad(r.count != null ? r.count : "-", 7) +
      pad(r.redirected ? "yes" : "no", 7) +
      r.verdict
    );
  }
  console.log("-".repeat(72));
  var ok = results.filter(function (r) { return r.verdict === "OK"; }).length;
  console.log(ok + " / " + results.length + " feeds usable.");
  console.log("\nNext: copy these results into BACKEND_NOTES.md, then build /api/news.");
})();
