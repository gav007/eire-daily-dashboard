/* ============================================================
   Éire Daily — countertop news dashboard
   Plain ES5-friendly JS for older Android WebView. No frameworks.
   Replace MOCK_NEWS + fetchNews() with a real backend call later.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Config ---------- */
  var BUILD_ID    = "clean-weather-ready-001"; // internal version marker (not shown on screen)
  var ROTATE_MS   = 12000;          // dwell time per headline
  var REFRESH_MS  = 5 * 60 * 1000;  // how often we re-poll the backend

  /* Backend endpoints. The frontend NEVER fetches RSS directly — it calls these
     Cloudflare Worker endpoints, which normalise RSS + weather into clean JSON.
     API_BASE = "" means same-origin (the Worker/Pages serves this page too).
     Point a local/preview build at the live API by setting API_BASE to the
     Worker origin, e.g. "https://eire-daily.<you>.workers.dev". */
  var API_BASE         = "";
  var NEWS_ENDPOINT    = "/api/news";
  var WEATHER_ENDPOINT = "/api/weather";

  /* Stock Dublin image, used when an article has no image OR its image fails to
     load. Bundled SVG always renders (offline-safe) so the kiosk never shows a
     broken image; swap for any reachable Dublin photo URL if you prefer. */
  var DUBLIN_STOCK_IMAGE = "assets/dublin.svg";

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

  /* ---------- Mock weather (preview / offline fallback) ---------- */
  var MOCK_WEATHER = {
    location: "Dublin",
    temperature: 14,
    condition: "Cloudy",
    rainChance: 40,
    precipitation: 0.4,
    windSpeed: 18,
    updatedAt: new Date(now).toISOString(),
    today:    { max: 17, min: 10, rainChance: 50 },
    tomorrow: { max: 16, min: 9,  rainChance: 35 }
  };

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
  // Weather card
  var weatherTemp    = $("weatherTemp");
  var weatherCond    = $("weatherCond");
  var weatherRain    = $("weatherRain");
  var weatherPrecip  = $("weatherPrecip");
  var weatherWind    = $("weatherWind");
  var fcTodayTemp    = $("fcTodayTemp");
  var fcTodayRain    = $("fcTodayRain");
  var fcTomorrowTemp = $("fcTomorrowTemp");
  var fcTomorrowRain = $("fcTomorrowRain");

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

  /* ---------- Hero image: article image -> Dublin stock -> source glyph ---------- */
  function applyMedia(item) {
    if (item.image) {
      loadHeroImage(item, item.image, function () { useStockImage(item); });
    } else {
      useStockImage(item);
    }
  }
  function useStockImage(item) {
    if (DUBLIN_STOCK_IMAGE) {
      loadHeroImage(item, DUBLIN_STOCK_IMAGE, function () { showGlyph(item); });
    } else {
      showGlyph(item);
    }
  }
  // Probe a URL off-screen; only paint it if it actually loads, else run onFail.
  // The items[idx] guard prevents a slow image from overwriting a newer card.
  function loadHeroImage(item, url, onFail) {
    var probe = new Image();
    probe.onload = function () {
      if (items[idx] !== item) return;
      heroImg.style.backgroundImage = "url('" + url + "')";
      hero.className = hero.className.replace(/\s*no-image/, "");
    };
    probe.onerror = function () {
      if (items[idx] === item) onFail();
    };
    probe.src = url;
  }
  function showGlyph(item) {
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
  // Frontend calls the backend only (never RSS directly). On any failure it
  // falls back to mock data so the kiosk never appears broken.
  function apiUrl(path) { return API_BASE ? (API_BASE + path) : path; }

  function fetchNews(cb) {
    if (typeof fetch === "undefined") { cb(new Error("no fetch"), MOCK_NEWS.slice(), null); return; }
    fetch(apiUrl(NEWS_ENDPOINT)).then(function (r) { return r.json(); })
      .then(function (data) {
        var list = (data && data.items) ? data.items : data;
        if (Array.isArray(list) && list.length) {
          cb(null, list, (data && data.updatedAt) || null);
        } else {
          cb(new Error("empty news"), MOCK_NEWS.slice(), null);
        }
      })
      .catch(function (e) { cb(e, MOCK_NEWS.slice(), null); });
  }

  function fetchWeather(cb) {
    if (typeof fetch === "undefined") { cb(new Error("no fetch"), MOCK_WEATHER); return; }
    fetch(apiUrl(WEATHER_ENDPOINT)).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && typeof data.temperature !== "undefined") cb(null, data);
        else cb(new Error("bad weather"), MOCK_WEATHER);
      })
      .catch(function (e) { cb(e, MOCK_WEATHER); });
  }

  function loadAndRender(isInitial) {
    fetchNews(function (err, data, updatedAt) {
      items = (data || []).filter(function (d) { return d && d.title; });
      if (!items.length) return;            // mock fallback makes this near-impossible
      if (idx >= items.length) idx = 0;     // keep index in range across refreshes
      setUpdated(updatedAt, err);
      if (isInitial) startRotation(); else { renderSide(); }
    });
  }

  /* ---------- Weather ---------- */
  function loadWeather() {
    fetchWeather(function (err, w) {
      renderWeather(w);
      setUpdated(w && w.updatedAt, err);
    });
  }

  function fmtTemp(t) {
    return (typeof t === "number" && !isNaN(t)) ? Math.round(t) + "°" : "--°";
  }
  function pct(v)  { return (v === 0 || v) ? v + "%" : "--"; }
  function setText(el, s) { if (el) el.textContent = s; }

  function renderWeather(w) {
    if (!w) return;
    setText(weatherTemp,   fmtTemp(w.temperature));
    setText(weatherCond,   w.condition || "—");
    setText(weatherRain,   pct(w.rainChance));
    setText(weatherPrecip, ((w.precipitation === 0 || w.precipitation) ? w.precipitation + " mm" : "--"));
    setText(weatherWind,   ((w.windSpeed === 0 || w.windSpeed) ? w.windSpeed + " km/h" : "--"));
    if (w.today) {
      setText(fcTodayTemp, fmtTemp(w.today.max) + " / " + fmtTemp(w.today.min));
      setText(fcTodayRain, pct(w.today.rainChance));
    }
    if (w.tomorrow) {
      setText(fcTomorrowTemp, fmtTemp(w.tomorrow.max) + " / " + fmtTemp(w.tomorrow.min));
      setText(fcTomorrowRain, pct(w.tomorrow.rainChance));
    }
  }

  // Single small "Updated HH:MM" label, shared by news + weather refreshes.
  function setUpdated(iso, err) {
    if (!updatedTime) return;
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    updatedTime.textContent = fmtClock(d) + (err ? " · cached" : "");
  }

  /* ---------- Scale-to-fit (use the LAYOUT viewport) ----------
     The <meta name="viewport" content="width=1280"> pins the layout viewport
     to 1280x800 — that is what the dashboard is actually laid out against, and
     it is reported by document.documentElement.clientWidth/clientHeight.
     window.innerWidth / screen.width / visualViewport report the smaller
     *visual* viewport (e.g. 962x602 after the tablet's 1.33 DPR), which would
     wrongly shrink the design. So we size off clientWidth/clientHeight.
     When client == 1280x800 the scale is exactly 1; we only shrink if the
     layout viewport is genuinely smaller than the 1280x800 design. */
  function scaleToFit() {
    var fit = document.getElementById("fit");
    if (!fit) return;

    var de = document.documentElement || {};
    var vw = de.clientWidth  || window.innerWidth  || 1280;
    var vh = de.clientHeight || window.innerHeight || 800;

    // Largest scale that shows the whole 1280x800 canvas with nothing clipped.
    var s = Math.min(vw / 1280, vh / 800);

    // Don't upscale past the design (keeps it crisp; exactly 1 at 1280x800).
    if (s > 1) s = 1;
    if (s < 0.4) s = 0.4;   // sane floor if the viewport is truly tiny

    fit.style.webkitTransform = "scale(" + s + ")";
    fit.style.transform = "scale(" + s + ")";
  }

  /* ---------- Tablet-kiosk compact layout ----------
     On the Lenovo Yoga Tab 3 in Fully Kiosk, the LAYOUT viewport is the full
     1280x800 design (clientWidth/clientHeight), but the visible glass
     (window.innerWidth/innerHeight, ~962x602) is smaller and anchored top-left
     with no scroll — so the right column and bottom strip fall off-screen.
     We don't touch the scale (stays 1). Instead we add body.tablet-compact,
     which re-sizes the canvas to the visible window and tightens spacing so the
     whole dashboard fits. CSS lives in styles.css under body.tablet-compact. */
  function setBodyClass(name, on) {
    var b = document.body;
    if (!b) return;
    var wrapped = " " + b.className + " ";
    var has = wrapped.indexOf(" " + name + " ") !== -1;
    if (on && !has) {
      b.className = (b.className + " " + name).replace(/^\s+/, "");
    } else if (!on && has) {
      b.className = wrapped.split(" " + name + " ").join(" ").replace(/^\s+|\s+$/g, "");
    }
  }

  function applyTabletMode() {
    var de = document.documentElement || {};
    var cw = de.clientWidth  || 0;
    var ch = de.clientHeight || 0;
    var iw = window.innerWidth || 0;
    // Compact when the layout viewport is the full ~1280x800 design but the
    // visible window is meaningfully narrower than it (the Lenovo case ~962).
    var isCompact = (cw >= 1260 && cw <= 1300 && ch >= 780 && ch <= 820 &&
                     iw > 0 && iw < cw - 80);
    setBodyClass("tablet-compact", isCompact);
  }

  // Re-evaluate compact mode first (it changes the canvas size), then re-fit.
  function onViewportChange() {
    applyTabletMode();
    scaleToFit();
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
    // Internal version marker — not shown on screen, but readable in devtools
    // / view-source as <html data-build="..."> to confirm the live build.
    if (document.documentElement) {
      document.documentElement.setAttribute("data-build", BUILD_ID);
    }
    applyTabletMode();      // toggle compact kiosk layout before first paint
    scaleToFit();
    if (window.addEventListener) {
      window.addEventListener("resize", onViewportChange, false);
      window.addEventListener("orientationchange", onViewportChange, false);
      // visualViewport fires on pinch-zoom / on-screen keyboard / URL-bar changes
      if (window.visualViewport && window.visualViewport.addEventListener) {
        window.visualViewport.addEventListener("resize", onViewportChange, false);
      }
    }

    tickClock();
    setInterval(tickClock, 1000);

    loadAndRender(true);
    loadWeather();
    refreshTimer = setInterval(function () {
      loadAndRender(false);
      loadWeather();
    }, REFRESH_MS);

    // tap the hero to skip to the next headline (touch-friendly)
    hero.addEventListener("click", function () {
      advance();
      if (rotateTimer) clearInterval(rotateTimer);
      rotateTimer = setInterval(advance, ROTATE_MS);
    }, false);

    // test audio button (temporary proof-of-audio test)
    var testBtn = $("testAudioBtn");
    if (testBtn) {
      testBtn.addEventListener("click", function () {
        var audio = $("testAudio");
        if (!audio) {
          console.warn("Test audio element not found");
          return;
        }
        audio.volume = 0.3;
        audio.play().catch(function (e) {
          console.warn("Audio playback failed:", e.message);
        });
      }, false);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, false);
  } else {
    init();
  }
})();
