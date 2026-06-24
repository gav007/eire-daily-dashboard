/* ============================================================
   Éire Daily — countertop news dashboard
   Plain ES5-friendly JS for older Android WebView. No frameworks.
   Replace MOCK_NEWS + fetchNews() with a real backend call later.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Config ---------- */
  var ROTATE_MS   = 12000;   // dwell time per headline
  var REFRESH_MS  = 5 * 60 * 1000; // how often we'd re-poll the backend
  var API_URL     = null;    // e.g. "/api/news" — when set, fetchNews() uses it

  /* ---------- Source styling map ---------- */
  var SOURCES = {
    "RTÉ News":    { cls: "src-rte",     glyph: "R" },
    "TheJournal":  { cls: "src-journal", glyph: "J" },
    "Dublin Live": { cls: "src-dublin",  glyph: "D" }
  };
  function srcMeta(name) {
    return SOURCES[name] || { cls: "src-default", glyph: (name || "?").charAt(0) };
  }

  /* ---------- Mock data (preview before backend) ---------- */
  var now = Date.now();
  var mins = function (m) { return new Date(now - m * 60000).toISOString(); };

  var MOCK_NEWS = [
    {
      source: "RTÉ News",
      title: "Government unveils €1.4bn housing package aimed at first-time buyers",
      summary: "The plan expands shared-equity supports and fast-tracks delivery of 12,000 cost-rental homes across the State by 2027.",
      url: "https://www.rte.ie/news/",
      published: mins(8),
      image: "https://picsum.photos/seed/dublin-housing/1200/640"
    },
    {
      source: "TheJournal",
      title: "Met Éireann issues yellow rain warning for Leinster and east Munster",
      summary: "Forecasters expect heavy, persistent rain through the evening with localised flooding possible on low-lying routes.",
      url: "https://www.thejournal.ie/",
      published: mins(21),
      image: "https://picsum.photos/seed/eire-rain/1200/640"
    },
    {
      source: "Dublin Live",
      title: "Luas Green Line to run extended late services for summer festival season",
      summary: "Transport for Ireland confirms trams until 1am on weekends through August to ease city-centre crowds.",
      url: "https://www.dublinlive.ie/",
      published: mins(34),
      image: null
    },
    {
      source: "RTÉ News",
      title: "Irish economy grows faster than expected as exports rebound",
      summary: "Modified domestic demand rose 2.6% in the quarter, with strong pharma and tech shipments leading the recovery.",
      url: "https://www.rte.ie/news/business/",
      published: mins(52),
      image: "https://picsum.photos/seed/eire-economy/1200/640"
    },
    {
      source: "TheJournal",
      title: "New cycle network linking Phoenix Park to the docklands opens to the public",
      summary: "The 9km segregated route is the first phase of a wider plan to connect the city's main green corridors.",
      url: "https://www.thejournal.ie/",
      published: mins(68),
      image: null
    },
    {
      source: "Dublin Live",
      title: "Beloved Camden Street record shop saved after community buy-out campaign",
      summary: "Hundreds of locals pledged support to keep the four-decade-old store trading in its original premises.",
      url: "https://www.dublinlive.ie/",
      published: mins(95),
      image: "https://picsum.photos/seed/dublin-records/1200/640"
    }
  ];

  /* ---------- State ---------- */
  var items = [];
  var idx = 0;
  var rotateTimer = null;
  var refreshTimer = null;

  /* ---------- DOM refs ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var hero        = $("hero");
  var heroFill    = $("heroFill");
  var heroImg     = $("heroImg");
  var fallbackG   = $("fallbackGlyph");
  var heroBadge   = $("heroBadge");
  var heroTime    = $("heroTime");
  var heroTitle   = $("heroTitle");
  var heroSummary = $("heroSummary");
  var heroDots    = $("heroDots");
  var upnext      = $("upnext");
  var sideCount   = $("sideCount");
  var updatedTime = $("updatedTime");
  var rotationStatus = $("rotationStatus");

  /* ---------- Helpers ---------- */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function timeAgo(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return "";
    var diff = Math.round((Date.now() - t) / 60000); // minutes
    if (diff < 1) return "just now";
    if (diff < 60) return diff + " min ago";
    var h = Math.floor(diff / 60);
    if (h < 24) return h + (h === 1 ? " hr ago" : " hrs ago");
    var d = Math.floor(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  function fmtClock(date) {
    return pad(date.getHours()) + ":" + pad(date.getMinutes());
  }
  function fmtClockSec(date) { return fmtClock(date) + ":" + pad(date.getSeconds()); }

  var DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function fmtDate(date) {
    return DAYS[date.getDay()] + ", " + date.getDate() + " " + MONTHS[date.getMonth()];
  }

  /* ---------- Image preloading with graceful fallback ---------- */
  function applyMedia(item) {
    if (item.image) {
      // probe the image; only show it if it actually loads
      var probe = new Image();
      probe.onload = function () {
        if (items[idx] === item) {
          heroImg.style.backgroundImage = "url('" + item.image + "')";
          hero.className = hero.className.replace(/\s*no-image/, "");
        }
      };
      probe.onerror = function () {
        if (items[idx] === item) showFallback(item);
      };
      probe.src = item.image;
      // optimistic: set immediately, fallback handler will swap if it fails
      heroImg.style.backgroundImage = "url('" + item.image + "')";
      hero.className = hero.className.replace(/\s*no-image/, "");
    } else {
      showFallback(item);
    }
  }
  function showFallback(item) {
    heroImg.style.backgroundImage = "none";
    fallbackG.textContent = srcMeta(item.source).glyph;
    if (hero.className.indexOf("no-image") === -1) hero.className += " no-image";
  }

  /* ---------- Render the hero card ---------- */
  var firstPaint = true;
  function fillHero(item, meta) {
    heroBadge.className = "badge " + meta.cls;
    heroBadge.textContent = item.source;
    heroTime.textContent = timeAgo(item.published);
    heroTitle.textContent = item.title;
    heroSummary.textContent = item.summary || "";
    applyMedia(item);
    renderDots();
  }
  function renderHero() {
    if (!items.length) return;
    var item = items[idx];
    var meta = srcMeta(item.source);

    // First paint: show content immediately, no fade-out gating visibility.
    if (firstPaint) {
      firstPaint = false;
      fillHero(item, meta);
      return;
    }

    // Subsequent rotations: fade out, swap content, fade back in.
    hero.className = (hero.className + " swapping").replace(/\s+/g, " ");
    setTimeout(function () {
      fillHero(item, meta);
      // rAF guarantees the reverse (0->1) transition actually fires
      requestAnimationFrame(function () {
        hero.className = hero.className.replace(/\s*swapping/, "");
      });
    }, 240);
  }

  function renderDots() {
    var html = "";
    for (var i = 0; i < items.length; i++) {
      html += '<i class="' + (i === idx ? "on" : "") + '"></i>';
    }
    heroDots.innerHTML = html;
  }

  /* ---------- Render the side "Up Next" column ---------- */
  function renderSide() {
    var html = "";
    var count = Math.min(items.length, 5);
    for (var k = 1; k <= count; k++) {
      var i = (idx + k) % items.length;
      if (i === idx) break;
      var it = items[i];
      var meta = srcMeta(it.source);
      var current = (k === 1);
      html += '<li class="' + (current ? "current" : "") + '">' +
                '<span class="up-rail"></span>' +
                '<span class="up-body">' +
                  '<span class="up-src ' + meta.cls + '">' + it.source + '</span>' +
                  '<span class="up-title">' + escapeHtml(it.title) + '</span>' +
                '</span>' +
              '</li>';
    }
    upnext.innerHTML = html;
    sideCount.textContent = (idx + 1) + " / " + items.length;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, function (c) {
      return { "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c];
    });
  }

  /* ---------- Progress bar animation ---------- */
  function runProgress() {
    heroFill.className = "hero-progress-fill";
    heroFill.style.transition = "none";
    heroFill.style.width = "0%";
    // force reflow so the reset takes before we animate
    void heroFill.offsetWidth;
    heroFill.className = "hero-progress-fill run";
    heroFill.style.transition = "width " + ROTATE_MS + "ms linear";
    heroFill.style.width = "100%";
  }

  /* ---------- Rotation ---------- */
  function advance() {
    idx = (idx + 1) % items.length;
    paint();
  }
  function paint() {
    renderHero();
    renderSide();
    runProgress();
  }
  function startRotation() {
    if (rotateTimer) clearInterval(rotateTimer);
    rotateTimer = setInterval(advance, ROTATE_MS);
    paint();
  }

  /* ---------- Data loading ---------- */
  function fetchNews(cb) {
    // When API_URL is set, swap mock data for a real fetch.
    if (!API_URL || typeof fetch === "undefined") {
      cb(null, MOCK_NEWS.slice());
      return;
    }
    fetch(API_URL).then(function (r) { return r.json(); })
      .then(function (data) {
        var list = (data && data.items) ? data.items : data;
        cb(null, Array.isArray(list) && list.length ? list : MOCK_NEWS.slice());
      })
      .catch(function (e) { cb(e, MOCK_NEWS.slice()); });
  }

  function loadAndRender(isInitial) {
    fetchNews(function (err, data) {
      items = (data || []).filter(function (d) { return d && d.title; });
      if (!items.length) {
        rotationStatus.textContent = "No headlines available";
        return;
      }
      // keep current index in range across refreshes
      if (idx >= items.length) idx = 0;
      rotationStatus.textContent = "Rotating " + items.length + " headlines";
      updatedTime.textContent = fmtClock(new Date()) + (err ? " · cached" : "");
      if (isInitial) startRotation(); else { renderSide(); }
    });
  }

  /* ---------- Scale-to-fit (tolerate browser UI bars) ---------- */
  function scaleToFit() {
    var fit = document.getElementById("fit");
    if (!fit) return;
    var sw = window.innerWidth || 1280;
    var sh = window.innerHeight || 800;
    var s = Math.min(sw / 1280, sh / 800);
    if (s > 1) s = 1;          // never upscale (avoids blur on the native panel)
    if (s < 0.4) s = 0.4;      // sane floor
    fit.style.webkitTransform = "scale(" + s + ")";
    fit.style.transform = "scale(" + s + ")";
  }

  /* ---------- Clock ---------- */
  function tickClock() {
    var d = new Date();
    $("clockTime").textContent = fmtClock(d);
    $("clockDate").textContent = fmtDate(d);
    // refresh the relative "x min ago" label live without re-rendering all
    if (items.length) heroTime.textContent = timeAgo(items[idx].published);
  }

  /* ---------- Boot ---------- */
  function init() {
    scaleToFit();
    if (window.addEventListener) {
      window.addEventListener("resize", scaleToFit, false);
      window.addEventListener("orientationchange", scaleToFit, false);
    }

    tickClock();
    setInterval(tickClock, 1000);

    loadAndRender(true);
    refreshTimer = setInterval(function () { loadAndRender(false); }, REFRESH_MS);

    // tap the hero to skip to the next headline (touch-friendly)
    hero.addEventListener("click", function () {
      advance();
      if (rotateTimer) clearInterval(rotateTimer);
      rotateTimer = setInterval(advance, ROTATE_MS);
    }, false);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, false);
  } else {
    init();
  }
})();
