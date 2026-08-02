/* ============================================================
   Éire Daily — countertop news dashboard
   Plain ES5-friendly JS for older Android WebView. No frameworks.
   Replace MOCK_NEWS + fetchNews() with a real backend call later.
   ============================================================ */
(function () {
  "use strict";

  /* ---------- Config ---------- */
  var BUILD_ID = "clean-weather-ready-001"; // internal version marker (not shown on screen)
  var ROTATE_MS = 12000; // dwell time per headline
  var REFRESH_MS = 5 * 60 * 1000; // how often we re-poll the backend

  /* Weather ambience (V1) — see the "Weather ambience" section lower down. */
  var AMBIENCE_DIR = "assets/audio/"; // where the loop MP3s live
  var AMBIENCE_VOLUME = 0.3; // base level for tracks that already sound fine
  // Per-track volume overrides. Any track listed here plays at its OWN level;
  // anything not listed falls back to AMBIENCE_VOLUME above. To boost another
  // track, add a line (key = its .mp3 filename); to drop it back, delete the line.
  var AMBIENCE_VOLUMES = {
    "background-peace.mp3": 1,
    "day-clear.mp3": 1, // the quiet default track — boosted so it's audible
    "MidnightDone.mp3": 0.8, // kept for the retired evening track (see below)
  };
  var WIND_VERY_KMH = 30; // "very windy" threshold
  var WIND_MOD_KMH = 20; // "windy" threshold
  // Which MP3 plays for each weather/time situation.
  // Retired: `evening: "MidnightDone.mp3"` used to hijack 18:00–21:59 and play
  // regardless of the weather. The evening now follows the weather like every
  // other part of the day. The file is still in assets/audio/ if it's wanted back.
  var AMBIENCE_TRACKS = {
    rain: "rain.mp3", // any rain / drizzle / thunder
    veryWindy: "windy-beach.mp3", // windSpeed >= 35
    windy: "soft-wind.mp3", // windSpeed >= 20
    night: "night.mp3", // 22:00–05:59
    morning: "bird.mp3", // 06:00–11:00 + clear/partly cloudy
    clearDay: "day-clear.mp3", // clear during the day
    calm: "background-peace.mp3", // default: cloudy / fog / snow / unknown
  };

  /* Dublin voice clips (V1) — a SECOND audio layer that plays on TOP of the
     ambience (the ambience above is never paused or replaced). Short one-shot
     clips on a fixed timetable — weather and news alternating every
     VOICE_BLOCK_MIN minutes, 08:00–21:59 only, never at night, and never if the
     ambience sound isn't running. Full rules + tests in the section below. */
  var VOICE_DIR = "assets/voices/"; // where the one-shot voice WAVs live
  var VOICE_VOLUME = 0.8; // audible over the 0.3 ambience, not blasting
  var VOICE_START_HOUR = 8; // first hour a voice may play (08:00)
  var VOICE_END_HOUR = 22; // stop before this hour (last play 21:00–21:59)
  /* Fixed timetable, alternating weather and news:

       13:00 weather   13:15 news   13:30 weather   13:45 news   …

     VOICE_BLOCK_MIN is the only dial. 15 = four clips an hour (the current
     setting), 30 = two an hour, 60 = one. It must divide 60 evenly, and it
     should stay an even division so the weather/news alternation lines up the
     same way every hour.

     Each block fires at most once and is claimed in localStorage, so a refresh
     or kiosk reload can't replay it. If the tablet was asleep at the boundary
     the clip still fires at the first opportunity inside that block rather
     than being skipped. */
  var VOICE_BLOCK_MIN = 15;
  var VOICE_SLOT_KEY = "eireVoiceSlot"; // localStorage: last block played
  var VOICE_ROT_PREFIX = "eireVoiceRot:"; // localStorage: per-set rotation index
  var VOICE_TICK_MS = 30000; // how often we check whether a clip is due

  /* The clip library. Two families:

       WEATHER sets — picked from the live Open-Meteo conditions.
       MOOD sets    — picked from "The State of It" sentiment reading.

     Each set rotates through its clips in order, and the position is persisted,
     so you hear every clip in a set before any of them repeats. */
  var VOICE_SETS = {
    // Weather
    rain: ["rain1.wav", "rain2.wav", "rain3.wav", "rain4.wav", "rain5.wav", "rain6.wav"],
    frost: ["frost1.wav", "frost2.wav"], // snow, or genuinely cold
    sun: ["sun1.wav", "sun2.wav", "sun3.wav", "sun4.wav", "sun5.wav"], // properly clear
    wind: [
      "wind.wav",
      "wind1.wav",
      "wind2.wav",
      "wind3.wav",
      "wind4.wav",
      "wind5.wav",
      "wind6.wav",
      "wind7.wav",
    ],
    // Overcast / fog — the most common Dublin weather there is.
    cloudy: [
      "cloud1.wav",
      "cloud2.wav",
      "cloud3.wav",
      "cloud4.wav",
      "default_dublin1.wav",
      "default_dublin2.wav",
    ],
    // Partly cloudy — a bit of sun about, but not a clear day.
    partly: ["some_sun1.wav", "normal1.wav", "normal2.wav"],

    // Mood — one set per sentiment tier, brightest first
    goodnews: ["goodnews1.wav", "goodnews2.wav", "goodnews3.wav"],
    grand: ["grand1.wav", "grand2.wav", "grand3.wav"],
    // Biggest set by design: normalising the score means most days land on
    // "about normal", so this one comes up roughly 38% of the time.
    mixed: [
      "mixed1.wav",
      "mixed2.wav",
      "mixed3.wav",
      "mixed4.wav",
      "mixed5.wav",
      "mixed6.wav",
      "mixed7.wav",
      "mixed8.wav",
      "mixed9.wav",
      "mixed10.wav",
      "mixed11.wav",
      "mixed12.wav",
      "mixed13.wav",
      "mixed14.wav",
      "mixed15.wav",
      "mixed16.wav",
    ],
    heavy: ["heavy1.wav", "heavy2.wav", "heavy3.wav"],
    grim: ["grim1.wav", "grim2.wav", "grim3.wav"],
    doom: ["doom1.wav", "doom2.wav", "doom3.wav"],
  };

  // Fallback map used only before the mood baseline has warmed up, keyed on the
  // absolute label from the Worker.
  var VOICE_ABS_LABEL_SETS = {
    "Bright enough": "goodnews",
    "Grand-ish": "grand",
    "Mixed bag": "mixed",
    "Bit heavy": "heavy",
    "Grim enough": "grim",
    "Full doom scroll": "doom",
  };

  /* Backend endpoints. The frontend NEVER fetches RSS directly — it calls these
     Cloudflare Worker endpoints, which normalise RSS + weather into clean JSON.
     API_BASE = "" means same-origin (the Worker/Pages serves this page too).
     Point a local/preview build at the live API by setting API_BASE to the
     Worker origin, e.g. "https://eire-daily.<you>.workers.dev". */
  var API_BASE = "";
  var NEWS_ENDPOINT = "/api/news";
  var WEATHER_ENDPOINT = "/api/weather";
  var MOOD_ENDPOINT = "/api/mood"; // "The State of It" AI news-mood (Worker-side Gemini)
  // The top story read aloud by Gemini, served as a WAV by the Worker. If it's
  // unavailable for any reason the news slot quietly plays a recorded clip.
  var HEADLINE_ENDPOINT = "/api/headline-audio";
  var NEWS_TURN_KEY = "eireNewsTurn"; // localStorage: headline <-> recorded clip
  var MOOD_REFRESH_MS = 30 * 60 * 1000; // re-poll mood every 30 min (Worker caches it ~3h)

  /* Stock Dublin image, used when an article has no image OR its image fails to
     load. Bundled SVG always renders (offline-safe) so the kiosk never shows a
     broken image; swap for any reachable Dublin photo URL if you prefer. */
  var DUBLIN_STOCK_IMAGE = "assets/dublin.svg";

  /* ---------- Source styling map ---------- */
  var SOURCES = {
    "RTÉ News": { cls: "src-rte", glyph: "R" },
    TheJournal: { cls: "src-journal", glyph: "J" },
    "Dublin Live": { cls: "src-dublin", glyph: "D" },
  };
  function srcMeta(name) {
    return SOURCES[name] || { cls: "src-default", glyph: (name || "?").charAt(0) };
  }

  /* ---------- Mock data (preview before backend) ---------- */
  var now = Date.now();
  var mins = function (m) {
    return new Date(now - m * 60000).toISOString();
  };

  var MOCK_NEWS = [
    {
      source: "RTÉ News",
      title: "Government unveils €1.4bn housing package aimed at first-time buyers",
      summary:
        "The plan expands shared-equity supports and fast-tracks delivery of 12,000 cost-rental homes across the State by 2027.",
      url: "https://www.rte.ie/news/",
      published: mins(8),
      image: "https://picsum.photos/seed/dublin-housing/1200/640",
    },
    {
      source: "TheJournal",
      title: "Met Éireann issues yellow rain warning for Leinster and east Munster",
      summary:
        "Forecasters expect heavy, persistent rain through the evening with localised flooding possible on low-lying routes.",
      url: "https://www.thejournal.ie/",
      published: mins(21),
      image: "https://picsum.photos/seed/eire-rain/1200/640",
    },
    {
      source: "Dublin Live",
      title: "Luas Green Line to run extended late services for summer festival season",
      summary:
        "Transport for Ireland confirms trams until 1am on weekends through August to ease city-centre crowds.",
      url: "https://www.dublinlive.ie/",
      published: mins(34),
      image: null,
    },
    {
      source: "RTÉ News",
      title: "Irish economy grows faster than expected as exports rebound",
      summary:
        "Modified domestic demand rose 2.6% in the quarter, with strong pharma and tech shipments leading the recovery.",
      url: "https://www.rte.ie/news/business/",
      published: mins(52),
      image: "https://picsum.photos/seed/eire-economy/1200/640",
    },
    {
      source: "TheJournal",
      title: "New cycle network linking Phoenix Park to the docklands opens to the public",
      summary:
        "The 9km segregated route is the first phase of a wider plan to connect the city's main green corridors.",
      url: "https://www.thejournal.ie/",
      published: mins(68),
      image: null,
    },
    {
      source: "Dublin Live",
      title: "Beloved Camden Street record shop saved after community buy-out campaign",
      summary:
        "Hundreds of locals pledged support to keep the four-decade-old store trading in its original premises.",
      url: "https://www.dublinlive.ie/",
      published: mins(95),
      image: "https://picsum.photos/seed/dublin-records/1200/640",
    },
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
    today: { max: 17, min: 10, rainChance: 50 },
    tomorrow: { max: 16, min: 9, rainChance: 35 },
  };

  /* ---------- State ---------- */
  var items = [];
  var idx = 0;
  var rotateTimer = null;
  var refreshTimer = null;

  /* ---------- DOM refs ---------- */
  var $ = function (id) {
    return document.getElementById(id);
  };
  var hero = $("hero");
  var heroFill = $("heroFill");
  var heroImg = $("heroImg");
  var heroImgBg = $("heroImgBg"); // darkened/zoomed ambient fill behind the contained image
  var fallbackG = $("fallbackGlyph");
  var heroBadge = $("heroBadge");
  var heroTime = $("heroTime");
  var heroTitle = $("heroTitle");
  var heroSummary = $("heroSummary");
  var heroBody = $("heroBody"); // copy column — measured to detect summary clipping
  var heroDots = $("heroDots");
  var upnext = $("upnext");
  var sideCount = $("sideCount");
  var updatedTime = $("updatedTime");
  // Weather card
  var weatherTemp = $("weatherTemp");
  var weatherCond = $("weatherCond");
  var weatherRain = $("weatherRain");
  var weatherPrecip = $("weatherPrecip");
  var weatherWind = $("weatherWind");
  var fcTodayTemp = $("fcTodayTemp");
  var fcTodayRain = $("fcTodayRain");
  var fcTomorrowTemp = $("fcTomorrowTemp");
  var fcTomorrowRain = $("fcTomorrowRain");
  // "The State of It" mood gauge
  var stateEl = $("stateOfIt");
  var stateLabel = $("stateLabel");
  var stateScore = $("stateScore");
  var stateBreakdown = $("stateBreakdown");
  var stateBaseline = $("stateBaseline");
  var stateWeight = $("stateWeight");

  /* ---------- Helpers ---------- */
  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

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
  function fmtClockSec(date) {
    return fmtClock(date) + ":" + pad(date.getSeconds());
  }

  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  function fmtDate(date) {
    return DAYS[date.getDay()] + ", " + date.getDate() + " " + MONTHS[date.getMonth()];
  }

  /* ---------- Hero image: article image -> Dublin stock -> source glyph ---------- */
  function applyMedia(item) {
    if (item.image) {
      loadHeroImage(item, item.image, function () {
        useStockImage(item);
      });
    } else {
      useStockImage(item);
    }
  }
  function useStockImage(item) {
    if (DUBLIN_STOCK_IMAGE) {
      loadHeroImage(item, DUBLIN_STOCK_IMAGE, function () {
        showGlyph(item);
      });
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
      // Foreground = the FULL image (contain). Background = same image as a
      // darkened, zoomed cover fill, so wide/tall photos never leave empty bars.
      heroImg.style.backgroundImage = "url('" + url + "')";
      if (heroImgBg) heroImgBg.style.backgroundImage = "url('" + url + "')";
      hero.className = hero.className.replace(/\s*no-image/, "");
    };
    probe.onerror = function () {
      if (items[idx] === item) onFail();
    };
    probe.src = url;
  }
  function showGlyph(item) {
    heroImg.style.backgroundImage = "none";
    if (heroImgBg) heroImgBg.style.backgroundImage = "none";
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
    fitHeroCopy(); // measure the summary and pick the roomiest fit for THIS story
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

  /* ---------- Dynamic hero-copy fitting ----------
     Most summaries fit fine at the default "roomy" spacing (clamped to 2 lines),
     so the common case is left exactly as designed — we never shrink every card.
     But some explainers need more room. After each hero render we MEASURE whether
     the summary is actually being clipped and, only for that one story, step the
     hero up to a tighter copy layout that first spends the spare space under the
     text, then trims gaps + the image band a touch so the explainer gets a
     3rd/4th line — without ever pushing the progress dots out of the card.

     How clipping is detected: a -webkit-line-clamp + overflow:hidden box reports
     its FULL text height as scrollHeight and its visible (clamped) height as
     clientHeight, so scrollHeight > clientHeight means the summary is cut off.
     Reading those properties also forces a reflow, so each measurement taken
     right after a class change is accurate. We additionally check the body
     doesn't overflow (which would clip the dots) before settling on level 1.

     Levels (set on #hero only; mirrored for desktop + tablet-compact in CSS):
       0  (no class)       default look — summary up to 2 lines
       1  hero-copy-tight  gentle — summary up to 3 lines, slightly tighter gaps
       2  hero-copy-extra  roomiest — smaller image band, up to 4 lines, slight
                           summary shrink; sized to always fit (dots stay visible) */
  function setHeroCopyLevel(level) {
    var cn = hero.className.replace(/\s*hero-copy-tight/g, "").replace(/\s*hero-copy-extra/g, "");
    if (level === 1) cn += " hero-copy-tight";
    else if (level >= 2) cn += " hero-copy-extra";
    hero.className = cn.replace(/\s+/g, " ");
  }
  // +2px tolerance so sub-pixel line metrics never read as a false clip.
  function isClipped(el) {
    return el ? el.scrollHeight - el.clientHeight > 2 : false;
  }
  function fitHeroCopy() {
    if (!heroSummary) return;

    // Always start from the default look (the previous story may have tightened
    // it). Each isClipped() read below forces a reflow, so the next measurement
    // reflects the class we just set.
    setHeroCopyLevel(0);
    if (!isClipped(heroSummary)) return; // fits in 2 lines — leave it roomy

    // Level 1: spend the spare space under the copy on a 3rd summary line.
    // Settle here only if the summary now fits AND the dots aren't pushed out.
    setHeroCopyLevel(1);
    if (!isClipped(heroSummary) && !isClipped(heroBody)) return;

    // Level 2: trim the image band + gaps for a 4th line. Bounded and safe by
    // design — even a 3-line headline + 4-line summary fits with the dots still
    // visible, so anything longer simply clamps here.
    setHeroCopyLevel(2);
  }

  // Console/debug helper (no on-screen clutter), handy for checking the fit on
  // the tablet: eireFit.status() reports the measurements + current level;
  // eireFit.level(0|1|2) forces a level; eireFit.refit() re-runs the auto fit.
  function exposeFitApi() {
    window.eireFit = {
      status: function () {
        return {
          level: /hero-copy-extra/.test(hero.className)
            ? 2
            : /hero-copy-tight/.test(hero.className)
              ? 1
              : 0,
          summaryScrollH: heroSummary && heroSummary.scrollHeight,
          summaryClientH: heroSummary && heroSummary.clientHeight,
          summaryClipped: isClipped(heroSummary),
          bodyScrollH: heroBody && heroBody.scrollHeight,
          bodyClientH: heroBody && heroBody.clientHeight,
          bodyOverflow: isClipped(heroBody),
        };
      },
      level: function (n) {
        setHeroCopyLevel(n);
        return "forced hero-copy level " + n;
      },
      refit: function () {
        fitHeroCopy();
        return "re-fit hero copy";
      },
    };
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
      var current = k === 1;
      // No vertical rail anymore — a small source-coloured dot marks the source,
      // and the "current" (next-up) row is shown with a subtle background instead.
      html +=
        '<li class="' +
        (current ? "current" : "") +
        '">' +
        '<span class="up-body">' +
        '<span class="up-src ' +
        meta.cls +
        '"><i class="up-dot"></i>' +
        escapeHtml(it.source) +
        "</span>" +
        '<span class="up-title">' +
        escapeHtml(it.title) +
        "</span>" +
        "</span>" +
        "</li>";
    }
    upnext.innerHTML = html;
    sideCount.textContent = idx + 1 + " / " + items.length;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
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
  function apiUrl(path) {
    return API_BASE ? API_BASE + path : path;
  }

  function fetchNews(cb) {
    if (typeof fetch === "undefined") {
      cb(new Error("no fetch"), MOCK_NEWS.slice(), null);
      return;
    }
    fetch(apiUrl(NEWS_ENDPOINT))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var list = data && data.items ? data.items : data;
        if (Array.isArray(list) && list.length) {
          cb(null, list, (data && data.updatedAt) || null);
        } else {
          cb(new Error("empty news"), MOCK_NEWS.slice(), null);
        }
      })
      .catch(function (e) {
        cb(e, MOCK_NEWS.slice(), null);
      });
  }

  function fetchWeather(cb) {
    if (typeof fetch === "undefined") {
      cb(new Error("no fetch"), MOCK_WEATHER);
      return;
    }
    fetch(apiUrl(WEATHER_ENDPOINT))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && typeof data.temperature !== "undefined") cb(null, data);
        else cb(new Error("bad weather"), MOCK_WEATHER);
      })
      .catch(function (e) {
        cb(e, MOCK_WEATHER);
      });
  }

  function loadAndRender(isInitial) {
    fetchNews(function (err, data, updatedAt) {
      items = (data || []).filter(function (d) {
        return d && d.title;
      });
      if (!items.length) return; // mock fallback makes this near-impossible
      if (idx >= items.length) idx = 0; // keep index in range across refreshes
      setUpdated(updatedAt, err);
      if (isInitial) startRotation();
      else {
        renderSide();
      }
    });
  }

  /* ---------- Weather ---------- */
  function loadWeather() {
    fetchWeather(function (err, w) {
      renderWeather(w);
      setUpdated(w && w.updatedAt, err);
      lastWeather = w || lastWeather; // remember for ambience + voice selection
      applyAmbience(); // pick + (maybe) play the background track
      maybePlayVoice(); // and (maybe) play this half-hour block's clip on top
    });
  }

  function fmtTemp(t) {
    return typeof t === "number" && !isNaN(t) ? Math.round(t) + "°" : "--°";
  }
  function pct(v) {
    return v === 0 || v ? v + "%" : "--";
  }
  function setText(el, s) {
    if (el) el.textContent = s;
  }

  function renderWeather(w) {
    if (!w) return;
    setText(weatherTemp, fmtTemp(w.temperature));
    setText(weatherCond, w.condition || "—");
    setText(weatherRain, pct(w.rainChance));
    setText(
      weatherPrecip,
      w.precipitation === 0 || w.precipitation ? w.precipitation + " mm" : "--"
    );
    setText(weatherWind, w.windSpeed === 0 || w.windSpeed ? w.windSpeed + " km/h" : "--");
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

  /* ---------- "The State of It" — AI news-mood gauge ----------
     The Worker calls Gemini server-side and returns a finished mood object; the
     browser never touches Gemini or the key. We just fetch /api/mood and paint
     a small editorial metric. If the result isn't available (no key, Gemini
     down, too little news), we hide the gauge entirely — never an error state.
     The Worker caches the mood for ~3h, so polling here is cheap. */
  function loadMood(force) {
    if (typeof fetch === "undefined") return; // ancient WebView: skip silently
    var url = apiUrl(MOOD_ENDPOINT) + (force ? "?refresh=1" : "");
    fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(function (m) {
        renderMood(m);
      })
      .catch(function () {
        renderMood(null);
      }); // any failure -> just hide it
  }

  function moodTone(label) {
    // Absolute bands (used during baseline warm-up).
    if (label === "Bright enough" || label === "Grand-ish") return "tone-bright";
    if (label === "Mixed bag") return "tone-mixed";
    // Relative bands (used once the baseline is ready).
    if (label === "Grand for once" || label === "Lighter than usual") return "tone-bright";
    if (label === "About normal") return "tone-mixed";
    return "tone-heavy"; // Bit heavy / Grim enough / Heavier than usual / …
  }

  /* The headline number, rephrased for a human.

     The raw score is a sentiment average from -100 to +100, and because news
     is relentlessly negative it is ALWAYS a minus — a perfectly ordinary day
     reads "-31", which tells a passer-by nothing and looks alarming.

     So the screen shows the percentile instead: 0-100, where 50 is a typical
     day and higher is better news. Same information, no minus signs, and it
     needs no explaining. The raw score is still what the Worker logs and does
     the maths on — this is purely how it's presented. */
  function moodOutOf100(m) {
    return m.relative && typeof m.relative.percentile === "number" ? m.relative.percentile : null;
  }

  /* Third line of the gauge: today's place in the trailing window in plain
     English, or how far the baseline still has to warm up. */
  function baselineLine(m) {
    var p = moodOutOf100(m);
    if (p !== null) {
      // Always phrase it the way round that reads naturally.
      return p >= 50
        ? "Calmer than " + p + "% of the last fortnight"
        : "Heavier than " + (100 - p) + "% of the last fortnight";
    }
    if (m.baseline && m.baseline.ready === false) {
      return (
        "Still learning what normal looks like · " +
        m.baseline.samples +
        " of " +
        m.baseline.needed
      );
    }
    return "";
  }

  function renderMood(m) {
    if (!stateEl) return;
    if (!m || !m.available || typeof m.score !== "number") {
      stateEl.style.display = "none"; // quiet fallback: no gauge at all
      return;
    }
    lastMood = m; // remember it for the mood voice clips

    /* Lead with the RELATIVE reading when we have a baseline. The absolute
       score lands in the same band nearly every day — news is reliably
       negative — so on its own it reads as broken rather than informative.
       Until the log warms up we fall back to the old absolute label. */
    var headline = m.relative && m.relative.label ? m.relative.label : m.label || "—";

    stateEl.className = "state " + moodTone(headline);
    setText(stateLabel, headline);

    // 0-100 where 50 is an ordinary day and higher is better news. No minus
    // signs. Blank until there's a baseline to measure against.
    var outOf100 = moodOutOf100(m);
    setText(stateScore, outOf100 === null ? "" : "· " + outOf100 + "/100");

    var c = m.counts || {};
    var n = function (v) {
      return v === 0 || v ? v : 0;
    };
    setText(
      stateBreakdown,
      n(c.negative) + "% bad news · " + n(c.neutral) + "% neutral · " + n(c.positive) + "% good"
    );

    setText(stateBaseline, baselineLine(m));

    var tops = m.topTopics && m.topTopics.length ? m.topTopics.join(" · ") : "—";
    setText(stateWeight, "Mostly " + tops);

    stateEl.style.display = "block";
  }

  // Console/debug helpers (no UI clutter on the tablet):
  //   eireMood.refresh()  -> force a fresh Gemini compute now (bypasses 3h cache)
  //   eireMood.reload()   -> re-fetch whatever the Worker currently has cached
  //   eireMood.status()   -> log the latest /api/mood payload (add ?debug=1 detail)
  //   eireMood.history()  -> log the mood log + current baseline (?days=N)
  function exposeMoodApi() {
    window.eireMood = {
      refresh: function () {
        loadMood(true);
        return "forcing a fresh mood compute…";
      },
      reload: function () {
        loadMood(false);
        return "reloading mood…";
      },
      status: function () {
        fetch(apiUrl(MOOD_ENDPOINT) + "?debug=1")
          .then(function (r) {
            return r.json();
          })
          .then(function (m) {
            console.log("[eireMood]", m);
          })
          .catch(function (e) {
            console.warn("[eireMood] failed:", e && e.message);
          });
        return "fetching /api/mood?debug=1 — see console";
      },
      history: function (days) {
        fetch(apiUrl(MOOD_ENDPOINT) + "/history" + (days ? "?days=" + days : ""))
          .then(function (r) {
            return r.json();
          })
          .then(function (h) {
            console.log("[eireMood] baseline:", h.baseline);
            console.log("[eireMood] " + h.count + " readings over " + h.days + "d", h.readings);
          })
          .catch(function (e) {
            console.warn("[eireMood] history failed:", e && e.message);
          });
        return "fetching /api/mood/history — see console";
      },
    };
  }

  /* ---------- Weather ambience (V1) ----------
     One looping background track at a time, chosen from the live weather
     condition + the tablet's local time. No layering, no extra APIs — it just
     reuses the /api/weather data we already fetch for the weather card.

     No on-screen control: the sound simply autoplays at low volume. On Fully
     Kiosk autoplay is allowed, so it just works. As a safety net for ordinary
     browsers that block autoplay until a gesture, the first tap/touch/key
     anywhere on the page starts it. Adjust/silence with the tablet's volume. */

  var ambienceEl = null; // the <audio> element (assigned in init)
  var currentTrack = ""; // filename currently loaded, so we don't restart it
  var currentTrackHour = null; // clock hour that track was chosen in (hold it for the hour)
  var lastWeather = null; // most recent weather object, for re-picks on refresh
  var lastMood = null; // most recent /api/mood payload, for mood voice picks
  var audioUnlocked = false; // true once playback has actually started

  /* Decide which track fits the weather + time. First match wins (priority). */
  function pickAmbienceTrack(weather, date) {
    if (!weather) return AMBIENCE_TRACKS.calm;

    var cond = (weather.condition || "").toLowerCase();
    var wind = typeof weather.windSpeed === "number" ? weather.windSpeed : 0;
    var hour = date.getHours(); // tablet's local hour (same clock as the display)

    var isRainy =
      cond.indexOf("rain") !== -1 || // Rain / Heavy rain
      cond.indexOf("drizzle") !== -1 ||
      cond.indexOf("thunder") !== -1;
    var isNight = hour >= 22 || hour < 6;
    var isMorning = hour >= 6 && hour < 11;
    var isClearish = cond === "clear" || cond === "partly cloudy";

    // No evening override any more — 18:00–21:59 now follows the same
    // weather-driven rules as the rest of the day. (To bring the old fixed
    // evening track back, re-add an `evening` entry to AMBIENCE_TRACKS and
    // return it here for hour >= 18 && hour < 22.)
    if (isRainy) return AMBIENCE_TRACKS.rain; // 1
    if (wind >= WIND_VERY_KMH) return AMBIENCE_TRACKS.veryWindy; // 2
    if (wind >= WIND_MOD_KMH) return AMBIENCE_TRACKS.windy; // 3
    if (isNight) return AMBIENCE_TRACKS.night; // 4
    if (isMorning && isClearish) return AMBIENCE_TRACKS.morning; // 5
    if (cond === "clear") return AMBIENCE_TRACKS.clearDay; // 6
    return AMBIENCE_TRACKS.calm; // 7 (default)
  }

  /* Try to start playback at low volume. The browser may refuse (autoplay
     policy); if so, the gesture fallback below will start it on the first tap. */
  function tryPlayAmbience() {
    if (!ambienceEl || !currentTrack) return;
    // Per-track volume: use the override for this track if one is set, else the base.
    var vol = AMBIENCE_VOLUMES[currentTrack];
    ambienceEl.volume = typeof vol === "number" ? vol : AMBIENCE_VOLUME;
    var p = ambienceEl.play();
    if (p && p.then) {
      p.then(function () {
        audioUnlocked = true;
        removeGestureUnlock(); // playing now, stop listening for a gesture
        maybePlayVoice(); // audio is live now — a due voice clip may fire
      }).catch(function (e) {
        // Most common case: autoplay blocked until a real tap. Stay quiet;
        // the gesture fallback (still attached) will start it on first touch.
        console.warn("Ambience autoplay blocked; will start on first tap:", e && e.message);
      });
    } else {
      // Very old WebView: play() returns undefined — assume it started.
      audioUnlocked = true;
      removeGestureUnlock();
      maybePlayVoice();
    }
  }

  /* Gesture fallback: if autoplay was blocked, the first interaction anywhere
     counts as the user gesture browsers require, so we retry play() then. */
  function gestureUnlock() {
    if (!audioUnlocked) tryPlayAmbience();
  }
  function addGestureUnlock() {
    if (!document.addEventListener) return;
    document.addEventListener("click", gestureUnlock, true);
    document.addEventListener("touchstart", gestureUnlock, true);
    document.addEventListener("keydown", gestureUnlock, true);
  }
  function removeGestureUnlock() {
    if (!document.removeEventListener) return;
    document.removeEventListener("click", gestureUnlock, true);
    document.removeEventListener("touchstart", gestureUnlock, true);
    document.removeEventListener("keydown", gestureUnlock, true);
  }

  /* Pick the right track and (try to) play it.

     Called after every weather load, i.e. every 5 minutes — but the track is
     only RE-PICKED once per clock hour. Re-picking on every refresh made the
     background flap: conditions sitting near a threshold (wind hovering around
     the 20 km/h line, or the sky flicking between Cloudy and Partly cloudy)
     would swap the music every five minutes. The weather card still updates on
     its normal 5-minute cycle; only the audio is held steady.

     A genuine change — rain starting, or nightfall — is picked up at the next
     hourly checkpoint, which lands within 5 minutes of the hour turning. */
  function applyAmbience() {
    if (!ambienceEl) return;

    var now = new Date();
    var hourId =
      now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + "-" + pad(now.getHours());

    // Already chose a track this hour — leave it looping, just make sure it's
    // actually playing (the autoplay retry is cheap and idempotent).
    if (currentTrack && currentTrackHour === hourId) {
      tryPlayAmbience();
      return;
    }
    currentTrackHour = hourId;

    var file = pickAmbienceTrack(lastWeather, now);

    // Only swap the source when the track actually changes, so an unchanged
    // track keeps looping smoothly instead of restarting harshly.
    if (file !== currentTrack) {
      currentTrack = file;
      ambienceEl.src = AMBIENCE_DIR + file;
    }

    tryPlayAmbience();
  }

  /* ---------- Dublin voice clips (V1) ----------
     A SECOND audio layer on TOP of the ambience above. The ambience is never
     paused or replaced — short one-shot Dublin voice clips play alongside it
     through their own <audio id="voice"> element.

     A fixed timetable alternating two families of clip, every
     VOICE_BLOCK_MIN minutes (15 = four an hour):
       even blocks   WEATHER — rain / frost / wind / sun / partly / cloudy
       odd blocks    NEWS    — alternating between the REAL top headline read
                               aloud by Gemini, and one of the recorded mood
                               clips (goodnews / grand / mixed / heavy / grim /
                               doom, from how today's sentiment compares to the
                               trailing fortnight)

     Rules:
       • each block fires at most once, claimed in localStorage so a
         refresh or kiosk reload can't replay it
       • only 08:00–21:59 (daytime/evening) — never during night mode
       • only when the ambience sound is actually running (audioUnlocked) AND the
         voice layer isn't muted — so "sound off" means no voice either
       • if the tablet was asleep at the boundary, the clip fires at the first
         opportunity inside that block rather than being skipped

     Each set rotates through its clips in order and remembers its position, so
     every clip in a set is heard before any of them repeats.

     Test without waiting — open the browser console:
       eireVoice.play()          // play what this block would play, now
       eireVoice.test("rain")    // next clip from a set, or an exact filename
       eireVoice.headline()      // read the current top story aloud, now
       eireVoice.says()          // print what it would read, without generating
       eireVoice.sets()          // list the sets and how many clips each has
       eireVoice.reset()         // let this block fire again
       eireVoice.status()        // the current block, what it plays, and why
       eireVoice.mute()          // turn the voice layer off (ambience keeps playing)
       eireVoice.unmute()
     …or load the page with ?voicetest=1 for an on-screen button per set. */

  var voiceEl = null; // the one-shot <audio> element (assigned in init)
  var voiceEnabled = true; // software mute for the voice layer only

  // localStorage with an in-memory fallback (Fully Kiosk / private mode safe).
  var voiceMem = {};
  function vGet(k) {
    try {
      return window.localStorage.getItem(k);
    } catch (e) {
      return k in voiceMem ? voiceMem[k] : null;
    }
  }
  function vSet(k, v) {
    try {
      window.localStorage.setItem(k, v);
    } catch (e) {
      voiceMem[k] = v;
    }
  }

  /* Which block of the hour we're in, and what should play in it. Even-numbered
     blocks are weather, odd are news — so at 15-minute blocks that's
     weather / news / weather / news across the hour. */
  function voiceSlot(date) {
    var idx = Math.floor(date.getMinutes() / VOICE_BLOCK_MIN);
    return {
      id:
        date.getFullYear() +
        "-" +
        pad(date.getMonth() + 1) +
        "-" +
        pad(date.getDate()) +
        "-" +
        pad(date.getHours()) +
        "-" +
        idx,
      family: idx % 2 === 0 ? "weather" : "news",
    };
  }

  /* Take the next clip from a set and advance that set's rotation. Persisting
     the index is what stops the same clip being picked over and over — you get
     rain1, rain2, rain3… then back around. */
  function nextFromSet(setName) {
    var list = VOICE_SETS[setName];
    if (!list || !list.length) return null;
    var key = VOICE_ROT_PREFIX + setName;
    var i = parseInt(vGet(key) || "0", 10);
    if (!isFinite(i) || i < 0) i = 0;
    i = i % list.length;
    vSet(key, "" + ((i + 1) % list.length));
    return list[i];
  }

  // Which WEATHER set fits the current conditions. First match wins.
  function weatherVoiceSet(weather) {
    var cond = (weather && weather.condition ? weather.condition : "").toLowerCase();
    var wind = weather && typeof weather.windSpeed === "number" ? weather.windSpeed : 0;
    var temp = weather && typeof weather.temperature === "number" ? weather.temperature : null;

    if (cond.indexOf("rain") !== -1 || cond.indexOf("drizzle") !== -1 || cond.indexOf("thunder") !== -1) {
      return "rain";
    }
    if (cond.indexOf("snow") !== -1 || (temp !== null && temp <= 3)) return "frost";
    if (wind >= WIND_MOD_KMH) return "wind";
    if (
      cond.indexOf("clear") !== -1 ||
      cond.indexOf("sunny") !== -1 ||
      cond.indexOf("fair") !== -1
    ) {
      return "sun";
    }
    // "Partly cloudy" gets its own set — there IS some sun about, so the fully
    // overcast clips would be wrong. Checked before `cloudy` because the
    // condition string contains "cloudy" either way.
    if (cond.indexOf("partly") !== -1) return "partly";
    return "cloudy"; // overcast / fog / anything else
  }

  /* Which MOOD set fits the current news sentiment.

     Driven off the RELATIVE reading (how today compares to the trailing
     fortnight), not the absolute score. The absolute score sits in the same
     band nearly every day, so keying off it would mean hearing the "heavy"
     clips essentially forever and never the other fifteen. Until the baseline
     warms up we fall back to the absolute label. */
  function moodVoiceSet(mood) {
    if (!mood || !mood.available) return null;

    if (mood.relative && typeof mood.relative.z === "number") {
      var z = mood.relative.z;
      if (z >= 1.5) return "goodnews";
      if (z >= 0.5) return "grand";
      if (z > -0.5) return "mixed";
      if (z > -1.5) return "heavy";
      if (z > -2.5) return "grim";
      return "doom";
    }
    return VOICE_ABS_LABEL_SETS[mood.label] || null;
  }

  /* Pick a clip for a given family. The news slot falls back to a weather clip
     if the mood gauge isn't available at all (no Gemini key, or the API is
     down) — better a voice than an unexplained silence on the half hour. */
  function pickVoiceFile(family) {
    var set = family === "news" ? moodVoiceSet(lastMood) : null;
    if (!set) set = weatherVoiceSet(lastWeather);
    return nextFromSet(set);
  }

  // Actually play a clip over the ambience. The ambience element is untouched,
  // so the background loop keeps going underneath the voice.
  function playVoiceFile(file) {
    if (!voiceEl || !file) return;
    voiceEl.onerror = null; // clear any fallback armed by the headline player
    voiceEl.src = VOICE_DIR + file;
    voiceEl.volume = VOICE_VOLUME;
    try {
      voiceEl.currentTime = 0;
    } catch (e) {}
    var p = voiceEl.play();
    if (p && p.catch) {
      p.catch(function (e) {
        console.warn("Voice clip blocked (needs a tap first?):", e && e.message);
      });
    }
  }

  /* The news slot alternates between the REAL headline read aloud and one of
     the recorded mood clips, so you get both the substance and the character.
     The alternation is persisted, so it survives a refresh. */
  function playNewsVoice() {
    var wantHeadline = vGet(NEWS_TURN_KEY) !== "clip";
    vSet(NEWS_TURN_KEY, wantHeadline ? "clip" : "headline");
    if (wantHeadline) return playHeadlineAudio();
    playVoiceFile(pickVoiceFile("news"));
  }

  /* Stream the spoken headline from the Worker. Anything that goes wrong —
     no Gemini key, rate limit, outage — makes the <audio> element fire an
     error, and we quietly drop back to a recorded clip. The kiosk must never
     just go silent because a cloud service had a bad minute. */
  function playHeadlineAudio() {
    if (!voiceEl) return;
    voiceEl.onerror = function () {
      voiceEl.onerror = null;
      console.warn("Headline audio unavailable — using a recorded clip instead");
      playVoiceFile(pickVoiceFile("news"));
    };
    voiceEl.src = apiUrl(HEADLINE_ENDPOINT);
    voiceEl.volume = VOICE_VOLUME;
    try {
      voiceEl.currentTime = 0;
    } catch (e) {}
    var p = voiceEl.play();
    if (p && p.catch) {
      p.catch(function (e) {
        console.warn("Headline blocked (needs a tap first?):", e && e.message);
      });
    }
  }

  // The scheduled gate: one clip per half-hour block, daytime only, sound on.
  // Safe to call as often as we like — it no-ops unless a play is actually due.
  function maybePlayVoice() {
    if (!voiceEl || !voiceEnabled) return;
    if (!audioUnlocked) return; // ambience isn't running -> sound is "off"

    var d = new Date();
    var hour = d.getHours();
    if (hour < VOICE_START_HOUR || hour >= VOICE_END_HOUR) return; // night / too early

    var slot = voiceSlot(d);
    if (vGet(VOICE_SLOT_KEY) === slot.id) return; // this block already played

    if (slot.family === "news") {
      vSet(VOICE_SLOT_KEY, slot.id); // claim the block BEFORE playing (no double-fire)
      playNewsVoice();
      return;
    }

    var file = pickVoiceFile("weather");
    if (!file) return;
    vSet(VOICE_SLOT_KEY, slot.id);
    playVoiceFile(file);
  }

  /* ---------- Voice test helpers ----------
     Test plays IGNORE the hour/slot and mute gates (a console call or button
     tap is itself the user gesture browsers need), so every clip can be heard
     immediately without waiting for the top of an hour. */
  /* voiceTest("rain") plays the next clip from a set; voiceTest("rain3.wav")
     plays that exact file. Passing nothing plays whatever is currently due. */
  function voiceTest(which) {
    if (!which) return playVoiceFile(pickVoiceFile(voiceSlot(new Date()).family));
    if (VOICE_SETS[which]) return playVoiceFile(nextFromSet(which));
    playVoiceFile(/\.wav$/i.test(which) ? which : which + ".wav");
  }

  function exposeVoiceApi() {
    window.eireVoice = {
      play: function () {
        playVoiceFile(pickVoiceFile(voiceSlot(new Date()).family));
      }, // whatever this half-hour block would play, now
      test: voiceTest, // a named set or exact filename, now
      headline: function () {
        playHeadlineAudio();
        return "fetching + playing the spoken headline…";
      },
      says: function () {
        fetch(apiUrl(HEADLINE_ENDPOINT) + "?text=1")
          .then(function (r) {
            return r.json();
          })
          .then(function (d) {
            console.log("[eireVoice] would say:", d.line, "(voice: " + d.voice + ")");
          })
          .catch(function (e) {
            console.warn("[eireVoice] says failed:", e && e.message);
          });
        return "checking what it would read out — see console";
      },
      sets: function () {
        var out = {};
        for (var k in VOICE_SETS) {
          if (VOICE_SETS.hasOwnProperty(k)) out[k] = VOICE_SETS[k].length + " clips";
        }
        return out;
      },
      reset: function () {
        vSet(VOICE_SLOT_KEY, "");
        return "block cleared — this half-hour's clip will fire again";
      },
      mute: function () {
        voiceEnabled = false;
        return "voice muted";
      },
      unmute: function () {
        voiceEnabled = true;
        return "voice on";
      },
      status: function () {
        var d = new Date();
        var slot = voiceSlot(d);
        return {
          time: pad(d.getHours()) + ":" + pad(d.getMinutes()),
          inWindow: d.getHours() >= VOICE_START_HOUR && d.getHours() < VOICE_END_HOUR,
          block: slot.id,
          blockPlays: slot.family,
          blockDone: vGet(VOICE_SLOT_KEY) === slot.id,
          weatherSet: weatherVoiceSet(lastWeather),
          moodSet: moodVoiceSet(lastMood),
          audioUnlocked: audioUnlocked,
          voiceEnabled: voiceEnabled,
          weatherCond: lastWeather && lastWeather.condition,
          temperature: lastWeather && lastWeather.temperature,
          windSpeed: lastWeather && lastWeather.windSpeed,
          moodLabel: lastMood && lastMood.label,
          moodZ: lastMood && lastMood.relative && lastMood.relative.z,
        };
      },
    };
  }

  // Tiny fixed-position test panel, ONLY when the URL has ?voicetest=1.
  // position:fixed means it overlays the kiosk without touching the 1280x800
  // layout, so it can never shift or clip the dashboard.
  function injectVoiceTestPanel() {
    if (!/[?&]voicetest=1/.test(location.search || "")) return;
    if (!document.body) return;
    var bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:99999;max-width:640px;" +
      "background:rgba(11,17,15,0.92);border:1px solid #d8a44a;border-radius:8px;" +
      "padding:6px 8px;font:12px 'IBM Plex Sans',sans-serif;color:#e7d3a0;" +
      "-webkit-box-shadow:0 2px 10px rgba(0,0,0,0.5);box-shadow:0 2px 10px rgba(0,0,0,0.5);";

    // One button per clip set, built straight from VOICE_SETS so adding a set
    // above automatically adds its button here. Each tap plays the next clip in
    // that set, so repeated taps walk through all of them.
    var defs = [
      [
        "Pick now",
        function () {
          window.eireVoice.play();
        },
      ],
      [
        "★ Headline",
        function () {
          playHeadlineAudio();
        },
      ],
    ];
    for (var s in VOICE_SETS) {
      if (!VOICE_SETS.hasOwnProperty(s)) continue;
      (function (name) {
        defs.push([
          name + " (" + VOICE_SETS[name].length + ")",
          function () {
            voiceTest(name);
          },
        ]);
      })(s);
    }

    var label = document.createElement("span");
    label.textContent = "Voice test:";
    label.style.cssText = "margin-right:4px;opacity:0.8;";
    bar.appendChild(label);
    for (var i = 0; i < defs.length; i++) {
      (function (d) {
        var b = document.createElement("button");
        b.textContent = d[0];
        b.style.cssText =
          "margin:2px;padding:4px 8px;border:1px solid #4fb583;" +
          "background:#13201b;color:#e7d3a0;border-radius:5px;cursor:pointer;font:12px inherit;";
        b.onclick = d[1];
        bar.appendChild(b);
      })(defs[i]);
    }
    document.body.appendChild(bar);
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
    var vw = de.clientWidth || window.innerWidth || 1280;
    var vh = de.clientHeight || window.innerHeight || 800;

    // Largest scale that shows the whole 1280x800 canvas with nothing clipped.
    var s = Math.min(vw / 1280, vh / 800);

    // Don't upscale past the design (keeps it crisp; exactly 1 at 1280x800).
    if (s > 1) s = 1;
    if (s < 0.4) s = 0.4; // sane floor if the viewport is truly tiny

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
      b.className = wrapped
        .split(" " + name + " ")
        .join(" ")
        .replace(/^\s+|\s+$/g, "");
    }
  }

  function applyTabletMode() {
    var de = document.documentElement || {};
    var cw = de.clientWidth || 0;
    var ch = de.clientHeight || 0;
    var iw = window.innerWidth || 0;
    // Compact when the layout viewport is the full ~1280x800 design but the
    // visible window is meaningfully narrower than it (the Lenovo case ~962).
    var isCompact = cw >= 1260 && cw <= 1300 && ch >= 780 && ch <= 820 && iw > 0 && iw < cw - 80;
    setBodyClass("tablet-compact", isCompact);
  }

  // Re-evaluate compact mode first (it changes the canvas size), then re-fit.
  function onViewportChange() {
    applyTabletMode();
    scaleToFit();
    // Toggling compact mode changes the hero geometry — re-fit the current copy.
    if (items.length) fitHeroCopy();
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
    applyTabletMode(); // toggle compact kiosk layout before first paint
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

    // Weather ambience: grab the <audio> element and arm the gesture fallback
    // BEFORE the first weather load, so applyAmbience() is ready to play.
    ambienceEl = $("ambience");
    addGestureUnlock();

    // Voice clips: grab the one-shot <audio>, expose the console test API, and
    // (only with ?voicetest=1) draw the tiny on-screen test panel.
    voiceEl = $("voice");
    exposeVoiceApi();
    injectVoiceTestPanel();
    // Clips are due on a minutes-scale gap now, so check far more often than
    // the 5-minute weather poll. maybePlayVoice() no-ops unless one is due.
    setInterval(maybePlayVoice, VOICE_TICK_MS);

    // "The State of It": expose the debug API, then fetch the mood once at boot.
    // The Worker caches it ~3h, so this and the 30-min poll below are cheap.
    exposeMoodApi();

    // Hero-copy auto-fit: expose its debug helper (eireFit.*) for tablet testing.
    exposeFitApi();

    loadAndRender(true);
    loadWeather();
    loadMood(false);
    refreshTimer = setInterval(function () {
      loadAndRender(false);
      loadWeather();
    }, REFRESH_MS);
    setInterval(function () {
      loadMood(false);
    }, MOOD_REFRESH_MS);

    // Google Fonts can arrive AFTER first paint, which changes text metrics and
    // could leave the first card mis-fitted. Re-fit once they're ready. Guarded
    // so ancient WebViews (no document.fonts) simply skip this and rely on the
    // next 12s rotation to re-measure.
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        if (items.length) fitHeroCopy();
      });
    }

    // tap the hero to skip to the next headline (touch-friendly)
    hero.addEventListener(
      "click",
      function () {
        advance();
        if (rotateTimer) clearInterval(rotateTimer);
        rotateTimer = setInterval(advance, ROTATE_MS);
      },
      false
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, false);
  } else {
    init();
  }
})();
