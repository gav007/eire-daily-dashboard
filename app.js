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

  /* Build tag — bump this string whenever you ship, so you can confirm the
     tablet actually loaded the newest code (shown bottom-right + in overlay). */
  var BUILD_ID = "layout-viewport-fix-001";

  /* Temporary viewport debug overlay. Flip to false (or delete the block) once
     the tablet sizing is sorted. */
  var DEBUG_VIEWPORT = true;

  /* Tablet sizing knob. The dashboard is designed at a fixed 1280x800 and
     scaled to fit the screen. On the Lenovo tablet the plain fit can look a
     touch "zoomed out" because of letterbox bars, so this multiplier pushes
     the canvas to fill more of the visible area. Tune it by hand: try 1.05,
     1.10, 1.15 (1.00 = exact letterbox fit, no zoom).
     It is self-limiting: scaleToFit() never zooms past the point where the
     empty outer padding has bled off the edges, so headlines, summary and
     the side column are never clipped — even on a smaller screen. */
  var TABLET_SCALE_MULTIPLIER = 1.12;

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
    // TABLET_SCALE_MULTIPLIER is intentionally NOT applied here — the layout
    // viewport already matches the design, so no zoom nudge is needed.
    if (s > 1) s = 1;
    if (s < 0.4) s = 0.4;   // sane floor if the viewport is truly tiny

    fit.style.webkitTransform = "scale(" + s + ")";
    fit.style.transform = "scale(" + s + ")";

    lastScale = s;          // expose to the debug overlay
    updateDebug();
  }

  /* ---------- Temporary viewport debug overlay ---------- */
  /* Plain JS, no modern CSS. Both boxes are appended straight to <body> so the
     #fit scale transform never touches them. Remove DEBUG_VIEWPORT/this block
     once tablet sizing is fixed. */
  var lastScale = 1;
  var dbgBox = null;

  function num(v) {
    return (typeof v === "number" && !isNaN(v)) ? Math.round(v * 1000) / 1000 : "n/a";
  }

  function buildDebugOverlay() {
    if (!DEBUG_VIEWPORT || !document.body) return;

    // Top-left readout panel
    dbgBox = document.createElement("div");
    dbgBox.id = "dbgViewport";
    dbgBox.style.position = "fixed";
    dbgBox.style.top = "0";
    dbgBox.style.left = "0";
    dbgBox.style.zIndex = "99999";
    dbgBox.style.background = "rgba(0,0,0,0.82)";
    dbgBox.style.color = "#5dff7a";
    dbgBox.style.font = "11px/1.35 monospace";
    dbgBox.style.padding = "6px 8px";
    dbgBox.style.margin = "0";
    dbgBox.style.whiteSpace = "pre";
    dbgBox.style.pointerEvents = "none";
    dbgBox.style.maxWidth = "300px";
    document.body.appendChild(dbgBox);

    // Tiny build tag, bottom-right
    var tag = document.createElement("div");
    tag.id = "dbgBuild";
    tag.style.position = "fixed";
    tag.style.right = "0";
    tag.style.bottom = "0";
    tag.style.zIndex = "99999";
    tag.style.background = "rgba(0,0,0,0.6)";
    tag.style.color = "#9fe8a8";
    tag.style.font = "10px monospace";
    tag.style.padding = "2px 6px";
    tag.style.pointerEvents = "none";
    tag.textContent = BUILD_ID;
    document.body.appendChild(tag);

    updateDebug();
  }

  function updateDebug() {
    if (!dbgBox) return;
    var de = document.documentElement || {};
    var vv = window.visualViewport;
    var lines = [
      "BUILD: " + BUILD_ID,
      "innerW/H:    " + num(window.innerWidth) + " x " + num(window.innerHeight),
      "screen W/H:  " + num(screen.width) + " x " + num(screen.height),
      "DPR:         " + num(window.devicePixelRatio),
      "clientW/H:   " + num(de.clientWidth) + " x " + num(de.clientHeight),
      "visualVP:    " + (vv ? (num(vv.width) + " x " + num(vv.height)) : "n/a"),
      "scale:       " + num(lastScale)
    ];
    dbgBox.textContent = lines.join("\n");
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
    buildDebugOverlay();    // temporary — see DEBUG_VIEWPORT
    scaleToFit();
    if (window.addEventListener) {
      window.addEventListener("resize", scaleToFit, false);
      window.addEventListener("orientationchange", scaleToFit, false);
      // visualViewport fires on pinch-zoom / on-screen keyboard / URL-bar changes
      if (window.visualViewport && window.visualViewport.addEventListener) {
        window.visualViewport.addEventListener("resize", updateDebug, false);
      }
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
